import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHookProcessRunner } from "../automation/hooks/process.ts";
import type { ActorRole, CapabilityPolicy } from "../core/policy/index.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import type { PlatformPlanConfiguration } from "../config.ts";
import {
  PLAN_BODY_MAX_BYTES,
  PLAN_MODE_ENTRY_TYPE,
  createPlanMode,
  type PlanMode,
  type PlanModeSnapshot,
  type PlanSessionEntry,
  type PlanToolMetadata,
} from "../plan/index.ts";
import { containsLikelySecret } from "./secrets.ts";
import {
  createFilesystemPlanPersistence,
  type FilesystemPlanPersistence,
} from "../plan/filesystem.ts";

export const PLAN_GIT_TOOLS = [
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_list_files",
] as const;

interface PlanCapabilityOptions {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly actor: ActorRole;
  readonly policy: CapabilityPolicy;
  readonly configuration: PlatformPlanConfiguration;
}

interface PlanSessionContext {
  readonly project: ResolvedProjectIdentity;
  readonly projectTrusted: boolean;
  readonly ctx: ExtensionContext;
}

function projectRoot(project: ResolvedProjectIdentity) {
  if (project.kind === "git") return project.currentWorktree;
  return project.canonicalCwd;
}

interface AssistantLike {
  readonly role: "assistant";
  readonly stopReason?: string;
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}

function isAssistantMessage(message: unknown): message is AssistantLike {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "content" in message &&
    Array.isArray(message.content)
  );
}

function assistantText(messages: readonly unknown[]) {
  const message = [...messages].reverse().find(isAssistantMessage);
  if (
    !message ||
    message.stopReason === "error" ||
    message.stopReason === "aborted"
  ) {
    return undefined;
  }
  return message.content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function asPlanToolMetadata(
  tool: ReturnType<ExtensionAPI["getAllTools"]>[number],
): PlanToolMetadata {
  return {
    name: tool.name,
    sourceInfo: tool.sourceInfo,
  };
}

function planEntries(ctx: ExtensionContext) {
  return ctx.sessionManager.getEntries() as unknown as PlanSessionEntry[];
}

function samePlan(left: PlanModeSnapshot, right: PlanModeSnapshot) {
  return (
    left.state === right.state &&
    left.planId === right.planId &&
    left.planHash === right.planHash &&
    left.destination?.path === right.destination?.path
  );
}

function describePlan(snapshot: PlanModeSnapshot) {
  const location = snapshot.destination?.path
    ? `\nFile: ${snapshot.destination.path}`
    : "";
  return `Plan mode: ${snapshot.state}${location}`;
}

function safeGitPath(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  if (
    value.length > 4_096 ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Git path must be a bounded project-relative path.");
  }
  return value.replaceAll("\\", "/");
}

function safeRevision(value: string) {
  const revision = value.trim();
  if (
    revision.length === 0 ||
    revision.length > 256 ||
    revision.startsWith("-") ||
    /[\0\r\n\s]/.test(revision)
  ) {
    throw new Error("Git revision is invalid.");
  }
  return revision;
}

export function createPlanCapability(options: PlanCapabilityOptions) {
  const { pi, agentDir, actor, policy, configuration } = options;
  let gitRunner: ReturnType<typeof createHookProcessRunner> | undefined =
    createHookProcessRunner();
  const persistence: FilesystemPlanPersistence =
    createFilesystemPlanPersistence();
  const authorityValue = randomUUID();
  let session: PlanSessionContext | undefined;
  let mode: PlanMode | undefined;

  const tools = () => pi.getAllTools().map(asPlanToolMetadata);

  const persistSnapshot = () => {
    if (!mode) return;
    pi.appendEntry(PLAN_MODE_ENTRY_TYPE, mode.snapshot());
  };

  const applyTools = (snapshot: PlanModeSnapshot) => {
    pi.setActiveTools([...snapshot.activeTools]);
  };

  const updateUi = (ctx: ExtensionContext) => {
    if (!mode) return;
    const snapshot = mode.snapshot();
    if (snapshot.state === "off") {
      ctx.ui.setStatus("platform-plan", undefined);
      ctx.ui.setWidget("platform-plan", undefined);
      return;
    }
    const label =
      snapshot.state === "planning"
        ? "plan: planning"
        : snapshot.state === "approval-pending"
          ? "plan: approval pending"
          : "plan: executing";
    ctx.ui.setStatus("platform-plan", ctx.ui.theme.fg("warning", label));
    const lines = [
      label,
      ...(snapshot.destination?.path
        ? [`file: ${snapshot.destination.path}`]
        : []),
    ];
    ctx.ui.setWidget("platform-plan", lines, { placement: "belowEditor" });
  };

  const applyResult = (
    result: ReturnType<PlanMode["enter"]>,
    ctx: ExtensionContext,
    append = true,
  ) => {
    applyTools(result.snapshot);
    updateUi(ctx);
    if (append) persistSnapshot();
    if (!result.ok && result.reason) ctx.ui.notify(result.reason, "warning");
    return result;
  };

  async function readApprovedPlan(snapshot = mode?.snapshot()) {
    if (!snapshot?.destination || !snapshot.planHash) {
      return {
        ok: false as const,
        reason: "Approved plan metadata is unavailable.",
      };
    }
    return persistence.readVerified({
      destination: snapshot.destination,
      expectedHash: snapshot.planHash,
      maxBytes: PLAN_BODY_MAX_BYTES,
    });
  }

  async function approve(ctx: ExtensionContext) {
    if (!mode || mode.status().state !== "approval-pending") {
      ctx.ui.notify("No recorded plan is awaiting approval.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Plan approval requires direct interactive user confirmation.",
        "warning",
      );
      return;
    }
    const candidate = mode.status();
    const confirmed = await ctx.ui.confirm(
      "Approve plan?",
      describePlan(candidate),
    );
    if (!confirmed) return;
    const current = mode.status();
    if (
      current.state !== "approval-pending" ||
      current.planId !== candidate.planId ||
      current.planHash !== candidate.planHash
    ) {
      ctx.ui.notify(
        "Plan changed while approval was open; approval was discarded.",
        "warning",
      );
      return;
    }
    const plan = await readApprovedPlan(candidate);
    if (!plan.ok) {
      ctx.ui.notify(`Plan could not be verified: ${plan.reason}`, "error");
      return;
    }
    const afterVerification = mode.status();
    if (
      afterVerification.state !== "approval-pending" ||
      afterVerification.planId !== candidate.planId ||
      afterVerification.planHash !== candidate.planHash
    ) {
      ctx.ui.notify(
        "Plan changed during verification; approval was discarded.",
        "warning",
      );
      return;
    }
    const result = applyResult(
      mode.approve({ kind: "user-authority", value: authorityValue }, tools()),
      ctx,
    );
    if (!result.ok) return;
    pi.sendUserMessage(
      `Execute the approved plan. Read it from ${result.snapshot.destination?.path} and verify SHA-256 ${result.snapshot.planHash} before acting.`,
      { deliverAs: "followUp" },
    );
  }

  async function executeGit(
    args: readonly string[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
    filename: string,
  ) {
    const hardenedArgs = [
      "--no-pager",
      "--no-optional-locks",
      "--no-lazy-fetch",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-c",
      "diff.trustExitCode=false",
      "-c",
      "credential.helper=",
      "-c",
      `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      ...args,
    ];
    const spillDirectory = await mkdtemp(
      path.join(tmpdir(), `pi-plan-${filename.replace(/[^a-z0-9.-]/gi, "-")}-`),
    );
    const stdoutPath = path.join(spillDirectory, "stdout.log");
    const stderrPath = path.join(spillDirectory, "stderr.log");
    const stdoutHandle = await open(stdoutPath, "wx", 0o600);
    const stderrHandle = await open(stderrPath, "wx", 0o600);
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
    environment.GIT_OPTIONAL_LOCKS = "0";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GCM_INTERACTIVE = "Never";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL =
      process.platform === "win32" ? "NUL" : "/dev/null";
    let sensitiveOutput = false;
    const tails = { stdout: "", stderr: "" };
    try {
      const runner = gitRunner;
      if (!runner) throw new Error("Plan Git runner is not active.");
      const result = await runner.run({
        executable: "git",
        args: hardenedArgs,
        cwd: ctx.cwd,
        env: environment,
        timeoutMs: 15_000,
        outputCapBytes: 50 * 1024,
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
      const output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (result.code !== 0 || result.killed || result.spillLimitExceeded) {
        await rm(spillDirectory, { recursive: true, force: true });
        throw new Error(
          result.spillLimitExceeded
            ? "git output exceeded the 16 MiB spill limit"
            : output || `git exited with code ${result.code}`,
        );
      }
      const retainOutput = result.truncated && !sensitiveOutput;
      if (!retainOutput) {
        await rm(spillDirectory, { recursive: true, force: true });
      }
      let text = output || "(no output)";
      if (result.truncated) {
        text += `\n\n[Output truncated to 50 KiB of ${result.totalBytes} byte(s).`;
        text += retainOutput
          ? ` Full stdout/stderr stored under ${spillDirectory}.]`
          : " Likely-sensitive full output was not persisted.]";
      }
      return {
        content: [{ type: "text" as const, text }],
        details: {
          args: hardenedArgs,
          outputPath: retainOutput ? spillDirectory : undefined,
        },
      };
    } catch (error) {
      await Promise.all([
        stdoutHandle.close().catch(() => undefined),
        stderrHandle.close().catch(() => undefined),
      ]);
      await rm(spillDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  pi.registerTool({
    name: "git_status",
    label: "Git Status (Read-only)",
    description: "Show bounded read-only Git status for the current project.",
    parameters: Type.Object({}),
    execute: (_id, _params, signal, _update, ctx) =>
      executeGit(
        ["status", "--short", "--branch"],
        signal,
        ctx,
        "git-status.txt",
      ),
  });
  pi.registerTool({
    name: "git_diff",
    label: "Git Diff (Read-only)",
    description:
      "Show a bounded read-only working-tree Git diff, optionally for one project-relative path.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: (_id, params, signal, _update, ctx) => {
      const target = safeGitPath(params.path);
      return executeGit(
        target
          ? ["diff", "--no-ext-diff", "--no-textconv", "--", target]
          : ["diff", "--no-ext-diff", "--no-textconv"],
        signal,
        ctx,
        "git-diff.txt",
      );
    },
  });
  pi.registerTool({
    name: "git_log",
    label: "Git Log (Read-only)",
    description: "Show a bounded read-only Git commit log.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: (_id, params, signal, _update, ctx) =>
      executeGit(
        ["log", `--max-count=${params.limit ?? 20}`, "--oneline", "--decorate"],
        signal,
        ctx,
        "git-log.txt",
      ),
  });
  pi.registerTool({
    name: "git_show",
    label: "Git Show (Read-only)",
    description:
      "Show one bounded read-only Git revision without invoking a shell.",
    parameters: Type.Object({ revision: Type.String() }),
    execute: (_id, params, signal, _update, ctx) =>
      executeGit(
        [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          "--stat",
          "--oneline",
          safeRevision(params.revision),
        ],
        signal,
        ctx,
        "git-show.txt",
      ),
  });
  pi.registerTool({
    name: "git_list_files",
    label: "Git Files (Read-only)",
    description:
      "List bounded tracked Git files, optionally under one project-relative path.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: (_id, params, signal, _update, ctx) => {
      const target = safeGitPath(params.path);
      return executeGit(
        target ? ["ls-files", "--", target] : ["ls-files"],
        signal,
        ctx,
        "git-files.txt",
      );
    },
  });

  const gitToolFingerprints = new Map(
    tools()
      .filter((tool) =>
        PLAN_GIT_TOOLS.includes(tool.name as (typeof PLAN_GIT_TOOLS)[number]),
      )
      .map((tool) => [
        tool.name,
        { source: tool.sourceInfo.source, path: tool.sourceInfo.path },
      ]),
  );
  const availablePlanningGitTools = () =>
    tools()
      .filter((tool) => {
        const expected = gitToolFingerprints.get(tool.name);
        return (
          expected !== undefined &&
          expected.source === tool.sourceInfo.source &&
          expected.path === tool.sourceInfo.path
        );
      })
      .map(({ name }) => name);

  pi.setActiveTools(
    pi
      .getActiveTools()
      .filter(
        (name) =>
          !PLAN_GIT_TOOLS.includes(name as (typeof PLAN_GIT_TOOLS)[number]),
      ),
  );

  pi.registerCommand("plan", {
    description:
      "Create, inspect, approve, or cancel a host-enforced read-only plan.",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) {
        throw new Error("Plan commands require TUI or RPC UI mode.");
      }
      if (!mode) {
        ctx.ui.notify("Plan mode is not initialized.", "error");
        return;
      }
      let args = rawArgs.trim();
      if (args === "status") {
        ctx.ui.notify(describePlan(mode.status()), "info");
        return;
      }
      if (args === "cancel") {
        applyResult(mode.cancel(), ctx);
        return;
      }
      if (args === "approve") {
        await approve(ctx);
        return;
      }
      let destination: "user" | "project" | undefined;
      const scope = /^(user|project)(?:\s+|$)/.exec(args);
      if (scope) {
        destination = scope[1] as "user" | "project";
        args = args.slice(scope[0].length).trim();
      }
      if (!args && ctx.hasUI) {
        args =
          (await ctx.ui.editor("What should the plan cover?", ""))?.trim() ??
          "";
      }
      const result = applyResult(
        mode.enter({
          prompt: args,
          destination,
          activeTools: pi.getActiveTools(),
          planningTools: availablePlanningGitTools(),
          tools: tools(),
        }),
        ctx,
      );
      if (!result.ok) return;
      try {
        pi.sendUserMessage(
          `${args}\n\nProduce a concrete implementation plan only. Do not mutate files, run processes, invoke agents, publish, or perform remote writes.`,
          ctx.isIdle() ? undefined : { deliverAs: "followUp" },
        );
      } catch (error) {
        applyResult(mode.cancel(), ctx);
        ctx.ui.notify(
          `Could not queue planning prompt: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!mode) return;
    const snapshot = mode.status();
    if (
      snapshot.state === "planning" ||
      snapshot.state === "approval-pending"
    ) {
      const reconciled = mode.reconcileTools({
        activeTools: pi.getActiveTools(),
        tools: tools(),
      });
      applyTools(reconciled.snapshot);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## PLAN MODE\nHost-enforced read-only planning is active. Use only available read operations. Do not mutate local or remote state. Unknown and side-effecting tools are blocked by policy. Produce or refine a concrete plan for direct user approval.`,
      };
    }
    if (snapshot.state === "executing") {
      return {
        systemPrompt: `${event.systemPrompt}\n\n## EXECUTING APPROVED PLAN\nAn approved plan is executing with the exact tool set that was active before planning. Continue only within the approved plan.`,
      };
    }
  });

  pi.on("tool_call", (event) => {
    if (!mode) return;
    const state = mode.status().state;
    if (state !== "planning" && state !== "approval-pending") return;
    const currentTools = tools();
    if (
      PLAN_GIT_TOOLS.includes(event.toolName as (typeof PLAN_GIT_TOOLS)[number])
    ) {
      const expected = gitToolFingerprints.get(event.toolName);
      const current = currentTools.find((tool) => tool.name === event.toolName);
      if (
        !expected ||
        !current ||
        expected.source !== current.sourceInfo.source ||
        expected.path !== current.sourceInfo.path
      ) {
        return {
          block: true,
          reason: "Dedicated Git tool identity changed during planning.",
        };
      }
    }
    const metadata = currentTools.find(
      (tool) => tool.name === event.toolName,
    ) ?? {
      name: event.toolName,
      sourceInfo: {
        path: `<unknown:${event.toolName}>`,
        source: "unknown",
        scope: "temporary" as const,
        origin: "top-level" as const,
      },
    };
    const authorization = mode.authorize(metadata);
    if (authorization.decision.kind !== "allow") {
      return { block: true, reason: authorization.decision.reason };
    }
  });

  pi.on("user_bash", () => {
    if (!mode) return;
    const state = mode.status().state;
    if (state !== "planning" && state !== "approval-pending") return;
    return {
      result: {
        output: "Plan mode blocks direct shell commands.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!mode || mode.status().state !== "planning") return;
    const plan = assistantText(event.messages);
    if (!plan) {
      ctx.ui.notify("Planning ended without a recordable plan.", "warning");
      return;
    }
    const recorded = await mode.recordPlan({ plan, signal: ctx.signal });
    applyResult(recorded, ctx);
    if (!recorded.ok) return;
    await approve(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!mode) return;
    let restored = mode.restore({
      entries: planEntries(ctx),
      leafId: ctx.sessionManager.getLeafId(),
      activeTools: pi.getActiveTools(),
      tools: tools(),
    });
    if (restored.ok && restored.snapshot.state === "executing") {
      const candidate = restored.snapshot;
      const verified = await readApprovedPlan(candidate);
      if (!samePlan(mode.status(), candidate)) return;
      if (!verified.ok) {
        restored = mode.revokeExecution(tools());
        ctx.ui.notify(
          `Selected plan could not be verified and requires reapproval: ${verified.reason}`,
          "error",
        );
      }
    }
    applyResult(restored, ctx, false);
  });

  return {
    async start(input: PlanSessionContext) {
      gitRunner ??= createHookProcessRunner();
      session = input;
      const root = projectRoot(input.project);
      mode = createPlanMode({
        policy,
        actor,
        authority: {
          verify: (token) =>
            token.kind === "user-authority" && token.value === authorityValue,
        },
        persistence,
        destinations: {
          defaultScope: configuration.defaultScope,
          user: {
            root: agentDir,
            directory: configuration.userDirectory,
          },
          ...(root
            ? {
                project: {
                  root,
                  directory: configuration.projectDirectory,
                  trusted: input.projectTrusted,
                },
              }
            : {}),
        },
        createPlanId: () => `${Date.now()}-${randomUUID()}`,
      });
      let restored = mode.restore({
        entries: planEntries(input.ctx),
        leafId: input.ctx.sessionManager.getLeafId(),
        activeTools: pi.getActiveTools(),
        tools: tools(),
        preferRuntimeToolsWhenOff: true,
      });
      if (restored.ok && restored.snapshot.state === "executing") {
        const candidate = restored.snapshot;
        const verified = await readApprovedPlan(candidate);
        if (!samePlan(mode.status(), candidate)) return restored;
        if (!verified.ok) {
          restored = mode.revokeExecution(tools());
          input.ctx.ui.notify(
            `Restored plan could not be verified and requires reapproval: ${verified.reason}`,
            "error",
          );
        }
      }
      applyResult(restored, input.ctx, false);
      return restored;
    },
    async stop() {
      await gitRunner?.shutdown(2_000);
      gitRunner = undefined;
      if (session) {
        session.ctx.ui.setStatus("platform-plan", undefined);
        session.ctx.ui.setWidget("platform-plan", undefined);
      }
      session = undefined;
      mode = undefined;
    },
    mode: () => mode,
  };
}
