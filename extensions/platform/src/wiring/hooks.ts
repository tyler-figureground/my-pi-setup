import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHookProcessRunner } from "../automation/hooks/process.ts";
import type { ActorRole, CapabilityPolicy } from "../core/policy/index.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import { containsLikelySecret } from "./secrets.ts";
import {
  createTriggerEngine,
  hookEvents,
  type HookConfigSource,
  type HookEffect,
  type HookEvent,
  type HookLogEntry,
  type HookMode,
  type PlainData,
  type TriggerEngine,
} from "../automation/hooks/index.ts";

interface HooksCapabilityOptions {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly actor: ActorRole;
  readonly policy: CapabilityPolicy;
  readonly mode: () => HookMode;
}

interface HooksSessionContext {
  readonly project: ResolvedProjectIdentity;
  readonly projectTrusted: boolean;
  readonly ctx: ExtensionContext;
}

interface HostHookLog {
  readonly sequence: number;
  readonly effectId: string;
  readonly hookId: string;
  readonly outcome: "ok" | "failed" | "blocked" | "truncated";
  readonly message: string;
  readonly outputPath?: string;
}

const sensitiveKey =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const sensitiveAssignment =
  /\b(authorization|cookie|password|passwd|secret|token|api[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearerValue = /\bbearer\s+[a-z0-9._~+\-/]+=*/gi;

function redactHostMessage(message: string) {
  return message
    .replace(sensitiveAssignment, "$1=[REDACTED]")
    .replace(bearerValue, "Bearer [REDACTED]");
}
const HOST_DISPATCH_TIMEOUT_MS = 30_000;

const interceptableEvents = new Set<HookEvent>([
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_before_tree",
  "context",
  "tool_call",
  "user_bash",
  "input",
]);

function projectRoot(project: ResolvedProjectIdentity) {
  if (project.kind === "git") return project.currentWorktree;
  return project.canonicalCwd;
}

interface PayloadBudget {
  nodes: number;
  bounded: boolean;
}

function boundedPlain(
  value: unknown,
  depth = 0,
  budget: PayloadBudget = { nodes: 0, bounded: false },
): PlainData {
  budget.nodes += 1;
  if (budget.nodes > 512 || depth > 6) {
    budget.bounded = true;
    return "[BOUNDED]";
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : "[NON_FINITE]";
  if (typeof value === "string") {
    if (value.length > 8_192) budget.bounded = true;
    return value.slice(0, 8_192);
  }
  if (Array.isArray(value)) {
    if (value.length > 64) budget.bounded = true;
    return value
      .slice(0, 64)
      .map((item) => boundedPlain(item, depth + 1, budget));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, PlainData> = {};
    const entries = Object.entries(value);
    if (entries.length > 64) budget.bounded = true;
    for (const [key, entry] of entries.slice(0, 64)) {
      output[key] = sensitiveKey.test(key)
        ? "[REDACTED]"
        : boundedPlain(entry, depth + 1, budget);
    }
    return output;
  }
  return `[${typeof value}]`;
}

function eventPayload(event: unknown): {
  readonly payload: Readonly<Record<string, PlainData>>;
  readonly bounded: boolean;
} {
  if (typeof event !== "object" || event === null) {
    return { payload: {}, bounded: false };
  }
  const budget: PayloadBudget = { nodes: 0, bounded: false };
  const plain = boundedPlain(event, 0, budget);
  if (typeof plain !== "object" || plain === null || Array.isArray(plain)) {
    return { payload: {}, bounded: budget.bounded };
  }
  const record = plain as Readonly<Record<string, PlainData>>;
  const { type: _type, ...payload } = record;
  return { payload, bounded: budget.bounded };
}

function engineLogs(engine: TriggerEngine, hostLogs: readonly HostHookLog[]) {
  const dispatch = engine
    .inspect()
    .logs.map(
      (entry: HookLogEntry) =>
        `${entry.sequence} ${entry.event} ${entry.hookId ?? "-"} ${entry.outcome}: ${entry.message}`,
    );
  const host = hostLogs.map(
    (entry) =>
      `host-${entry.sequence} ${entry.hookId} ${entry.outcome}: ${entry.message}${entry.outputPath ? ` output=${entry.outputPath}` : ""}`,
  );
  return [...dispatch, ...host];
}

export function createHooksCapability(options: HooksCapabilityOptions) {
  const { pi, agentDir, actor, policy } = options;
  const engine = createTriggerEngine({ instanceId: "platform-hooks" });
  let processRunner: ReturnType<typeof createHookProcessRunner> | undefined =
    createHookProcessRunner();
  const activeHookCommands = new Set<string>();
  const commandControllers = new Set<AbortController>();
  const statusKeys = new Set<string>();
  const hostLogs: HostHookLog[] = [];
  let nextHostLog = 0;
  let sources: readonly HookConfigSource[] = [];
  let currentContext: ExtensionContext | undefined;

  const appendHostLog = (entry: Omit<HostHookLog, "sequence">) => {
    hostLogs.push({
      ...entry,
      hookId: sensitiveKey.test(entry.hookId) ? "[REDACTED]" : entry.hookId,
      message: redactHostMessage(entry.message).slice(0, 2_000),
      sequence: ++nextHostLog,
    });
    if (hostLogs.length > 256) hostLogs.splice(0, hostLogs.length - 256);
  };

  async function executeCommand(
    effect: Extract<HookEffect, { type: "command" }>,
    ctx: ExtensionContext,
    timeoutMs: number,
  ) {
    const policyDecision = policy.decide(
      { kind: "operation", name: "process" },
      actor,
      { kind: options.mode() },
    );
    if (policyDecision.kind !== "allow") {
      appendHostLog({
        effectId: effect.effectId,
        hookId: effect.hookId,
        outcome: "blocked",
        message: policyDecision.reason,
      });
      return { ok: false, reason: policyDecision.reason } as const;
    }
    if (activeHookCommands.has(effect.hookId) || activeHookCommands.size >= 8) {
      const reason = "Hook command concurrency limit reached.";
      appendHostLog({
        effectId: effect.effectId,
        hookId: effect.hookId,
        outcome: "blocked",
        message: reason,
      });
      return { ok: false, reason } as const;
    }

    const controller = new AbortController();
    activeHookCommands.add(effect.hookId);
    commandControllers.add(controller);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    const spillDirectory = await mkdtemp(
      path.join(tmpdir(), `pi-hook-output-${randomUUID()}-`),
    );
    const stdoutPath = path.join(spillDirectory, "stdout.log");
    const stderrPath = path.join(spillDirectory, "stderr.log");
    const stdoutHandle = await open(stdoutPath, "wx", 0o600);
    const stderrHandle = await open(stderrPath, "wx", 0o600);
    let sensitiveOutput = false;
    const tails = { stdout: "", stderr: "" };
    try {
      const environment: Record<string, string> = {};
      for (const key of [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
      ]) {
        const value = process.env[key];
        if (value !== undefined) environment[key] = value;
      }
      const runner = processRunner;
      if (!runner) throw new Error("Hook process runner is not active.");
      const result = await runner.run({
        executable: effect.executable,
        args: effect.args,
        cwd: ctx.cwd,
        env: environment,
        timeoutMs: Math.min(effect.timeoutMs, timeoutMs),
        outputCapBytes: effect.outputCapBytes,
        spillCapBytes: 16 * 1024 * 1024,
        signal,
        async onSpill({ stream, chunk }) {
          const handle = stream === "stdout" ? stdoutHandle : stderrHandle;
          await handle.write(chunk);
          const probe = `${tails[stream]}${chunk.toString("utf8")}`;
          sensitiveOutput ||= containsLikelySecret(probe);
          tails[stream] = probe.slice(-256);
        },
      });
      await Promise.all([stdoutHandle.sync(), stderrHandle.sync()]);
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
      const ok =
        result.code === 0 && !result.killed && !result.spillLimitExceeded;
      const retainOutput = result.truncated && !sensitiveOutput;
      appendHostLog({
        effectId: effect.effectId,
        hookId: effect.hookId,
        outcome: ok ? (result.truncated ? "truncated" : "ok") : "failed",
        message: ok
          ? sensitiveOutput
            ? `Command completed with ${result.totalBytes} output byte(s); likely-sensitive output was not persisted.`
            : `Command completed with ${result.totalBytes} output byte(s).`
          : result.spillLimitExceeded
            ? "Command exceeded the 16 MiB spill limit and was terminated."
            : `Command failed with code ${result.code}${result.killed ? " after termination" : ""}.`,
        ...(retainOutput ? { outputPath: spillDirectory } : {}),
      });
      if (!retainOutput)
        await rm(spillDirectory, { recursive: true, force: true });
      return ok
        ? ({ ok: true } as const)
        : ({
            ok: false,
            reason: `Hook ${effect.hookId} command failed.`,
          } as const);
    } catch (error) {
      await Promise.all([
        stdoutHandle.close().catch(() => undefined),
        stderrHandle.close().catch(() => undefined),
      ]);
      await rm(spillDirectory, { recursive: true, force: true });
      const reason = error instanceof Error ? error.message : String(error);
      appendHostLog({
        effectId: effect.effectId,
        hookId: effect.hookId,
        outcome: "failed",
        message: reason.slice(0, 500),
      });
      return {
        ok: false,
        reason: `Hook ${effect.hookId} command failed.`,
      } as const;
    } finally {
      await Promise.all([
        stdoutHandle.close().catch(() => undefined),
        stderrHandle.close().catch(() => undefined),
      ]);
      activeHookCommands.delete(effect.hookId);
      commandControllers.delete(controller);
    }
  }

  async function applyEffects(
    event: HookEvent,
    effects: readonly HookEffect[],
    ctx: ExtensionContext,
  ) {
    const context: string[] = [];
    let blockReason: string | undefined;
    const deadline =
      Date.now() +
      (event === "session_shutdown" ? 2_000 : HOST_DISPATCH_TIMEOUT_MS);
    for (const effect of effects) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        blockReason ??= "Hook effect dispatch exceeded its host deadline.";
        break;
      }
      if (effect.type === "command") {
        const result = await executeCommand(effect, ctx, remainingMs);
        if (!result.ok && effect.failurePolicy === "closed") {
          blockReason ??= result.reason;
        }
        continue;
      }
      if (effect.type === "notify") {
        ctx.ui.notify(effect.message, effect.level);
        continue;
      }
      if (effect.type === "status") {
        const key = `platform-hook:${effect.key}`;
        ctx.ui.setStatus(key, effect.text ?? undefined);
        if (effect.text === null) statusKeys.delete(key);
        else statusKeys.add(key);
        continue;
      }
      if (effect.type === "context") {
        context.push(effect.content);
        continue;
      }
      if (effect.decision === "deny") {
        blockReason ??= effect.reason;
        continue;
      }
      if (effect.decision === "require-user-confirmation") {
        const confirmed =
          ctx.hasUI &&
          (await ctx.ui.confirm(
            `Hook ${effect.hookId} requests confirmation`,
            effect.reason,
            { timeout: Math.min(effect.timeoutMs, remainingMs) },
          ));
        if (!confirmed) blockReason ??= effect.reason;
      }
      // An allow effect is advisory. CapabilityPolicy remains authoritative.
    }
    return { event, context, blockReason };
  }

  async function dispatch(
    eventName: HookEvent,
    event: unknown,
    ctx: ExtensionContext,
  ) {
    const converted = eventPayload(event);
    if (converted.bounded && interceptableEvents.has(eventName)) {
      return {
        event: eventName,
        context: [],
        blockReason:
          "Hook policy input exceeded safety bounds and was denied closed.",
      };
    }
    const result = await engine.dispatch({
      event: eventName,
      mode: options.mode(),
      payload: converted.payload,
    });
    const applied = await applyEffects(eventName, result.effects, ctx);
    if (result.status === "bounded" && interceptableEvents.has(eventName)) {
      applied.blockReason ??= "Hook dispatch reached a safety bound.";
    }
    return applied;
  }

  pi.registerCommand("hooks", {
    description:
      "Inspect, validate, reload, or show bounded declarative-hook logs.",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("Hook commands require TUI or RPC UI mode.");
      }
      const args = rawArgs.trim();
      if (args === "validate") {
        const result = await engine.validate(sources);
        ctx.ui.notify(
          result.valid
            ? `Hook configuration valid: ${result.hooks.length} hook(s).`
            : result.diagnostics
                .map((entry) => `[${entry.code}] ${entry.message}`)
                .join("\n"),
          result.valid ? "info" : "error",
        );
        return;
      }
      if (args === "reload") {
        const result = await engine.reload(sources);
        ctx.ui.notify(
          result.applied
            ? `Reloaded ${result.hooks.length} hook(s).`
            : `Hook reload rejected; last known-good configuration retained.\n${result.diagnostics
                .map((entry) => `[${entry.code}] ${entry.message}`)
                .join("\n")}`,
          result.applied ? "info" : "error",
        );
        return;
      }
      if (args === "logs") {
        ctx.ui.notify(
          engineLogs(engine, hostLogs).join("\n") || "No hook activity.",
          "info",
        );
        return;
      }
      const inspection = engine.inspect();
      ctx.ui.notify(
        inspection.hooks
          .map(
            (hook) =>
              `${hook.id} ${hook.event} ${hook.action} ${hook.failurePolicy} - ${hook.source}`,
          )
          .join("\n") || "No declarative hooks configured.",
        inspection.diagnostics.length > 0 ? "warning" : "info",
      );
    },
  });

  const genericOn = pi.on.bind(pi) as (
    event: HookEvent,
    handler: (event: unknown, ctx: ExtensionContext) => unknown,
  ) => void;
  const special = new Set<HookEvent>([
    "session_start",
    "session_shutdown",
    "before_agent_start",
    "context",
    "tool_call",
    "input",
    "user_bash",
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_before_tree",
  ]);
  for (const eventName of hookEvents) {
    if (special.has(eventName)) continue;
    genericOn(eventName, async (event, ctx) => {
      await dispatch(eventName, event, ctx);
    });
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const applied = await dispatch("before_agent_start", event, ctx);
    if (applied.context.length > 0) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Declarative hook context\n${applied.context.join("\n\n")}`,
      };
    }
  });

  pi.on("context", async (event, ctx) => {
    const applied = await dispatch(
      "context",
      { messageCount: event.messages.length },
      ctx,
    );
    if (applied.blockReason) {
      ctx.ui.notify(applied.blockReason, "error");
      ctx.abort();
    }
    if (applied.context.length > 0) {
      return {
        messages: [
          ...event.messages,
          ...applied.context.map((content) => ({
            role: "custom" as const,
            customType: "platform-hook-context",
            content,
            display: false,
            timestamp: Date.now(),
          })),
        ],
      };
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const applied = await dispatch("tool_call", event, ctx);
    if (applied.blockReason)
      return { block: true, reason: applied.blockReason };
  });

  pi.on("input", async (event, ctx) => {
    const applied = await dispatch("input", event, ctx);
    if (applied.blockReason) {
      ctx.ui.notify(applied.blockReason, "warning");
      return { action: "handled" as const };
    }
  });

  pi.on("user_bash", async (event, ctx) => {
    const applied = await dispatch("user_bash", event, ctx);
    if (applied.blockReason) {
      return {
        result: {
          output: applied.blockReason,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  for (const eventName of [
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_before_tree",
  ] as const) {
    genericOn(eventName, async (event, ctx) => {
      const applied = await dispatch(eventName, event, ctx);
      if (applied.blockReason) {
        ctx.ui.notify(applied.blockReason, "warning");
        return { cancel: true };
      }
    });
  }

  return {
    async start(input: HooksSessionContext, startEvent: unknown) {
      processRunner ??= createHookProcessRunner();
      currentContext = input.ctx;
      const root = projectRoot(input.project);
      sources = [
        {
          scope: "global",
          path: path.join(agentDir, "hooks.yaml"),
          root: agentDir,
          optional: true,
        },
        ...(root
          ? [
              {
                scope: "project" as const,
                path: path.join(root, CONFIG_DIR_NAME, "hooks.yaml"),
                root,
                trusted: input.projectTrusted,
                optional: true,
              },
            ]
          : []),
      ];
      const result = await engine.start(sources);
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === "error") {
          input.ctx.ui.notify(
            `[${diagnostic.code}] ${diagnostic.message}`,
            "error",
          );
        }
      }
      await dispatch("session_start", startEvent, input.ctx);
      return result;
    },
    async stop(reason: string, event: unknown) {
      for (const controller of commandControllers) controller.abort();
      if (currentContext) {
        await dispatch("session_shutdown", event, currentContext);
      }
      for (const controller of commandControllers) controller.abort();
      await processRunner?.shutdown(2_000);
      processRunner = undefined;
      commandControllers.clear();
      if (currentContext) {
        for (const key of statusKeys)
          currentContext.ui.setStatus(key, undefined);
      }
      statusKeys.clear();
      currentContext = undefined;
      return engine.stop(reason);
    },
    engine: () => engine,
  };
}
