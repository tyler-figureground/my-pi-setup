import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { isProxy } from "node:util/types";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createHookProcessRunner,
  createHooks,
  declarativeHookEvents,
  nativeHookEvents,
  platformHookEvents,
  type HookAgentAdapter,
  type HookConfigSource,
  type HookHttpAdapter,
  type HookMcpAdapter,
  type HookMode,
  type HookProcessRequest,
  type HookProcessRunner,
  type HookResponse,
  type Hooks,
  type PlainData,
} from "../automation/hooks/index.ts";
import type { ActorRole, CapabilityPolicy } from "../core/policy/index.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import type {
  TriggerEngineRuntime,
  TriggerSourcePublisher,
} from "../automation/triggers/model.ts";

export type PlatformHookEvent = (typeof platformHookEvents)[number];
export type PlatformHookPayload = Readonly<Record<string, unknown>>;

type NativeHookEventName = (typeof nativeHookEvents)[number];
type NativeHookEvent<E extends NativeHookEventName = NativeHookEventName> =
  Extract<ExtensionEvent, { type: E }>;
type Dynamic<T> = T | (() => T);

export interface HooksCapabilityOptions {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly actor: Dynamic<ActorRole>;
  readonly policy: Dynamic<CapabilityPolicy>;
  readonly mode: () => HookMode;
  readonly triggers?: TriggerEngineRuntime;
  readonly adapters?: {
    readonly http?: HookHttpAdapter;
    readonly mcp?: HookMcpAdapter;
    readonly agent?: HookAgentAdapter;
  };
}

interface HooksSessionContext {
  readonly project: ResolvedProjectIdentity;
  readonly projectTrusted: boolean;
  readonly ctx: ExtensionContext;
  readonly triggers?: TriggerEngineRuntime;
}

interface PayloadBudget {
  nodes: number;
  bytes: number;
  bounded: boolean;
  readonly seen: WeakSet<object>;
}

interface ActiveHooksRuntime {
  readonly hooks: Hooks;
  readonly process: HookProcessRunner;
  readonly ctx: ExtensionContext;
  readonly project: ResolvedProjectIdentity;
  readonly statusKeys: Set<string>;
  readonly suspensionNotices: Set<string>;
  triggerRuntime?: TriggerEngineRuntime;
  triggerPublisher?: TriggerSourcePublisher;
  triggerOwnerId?: string;
  triggerGeneration: number;
  acceptingEffects: boolean;
  stopPromise?: Promise<{
    readonly status: "stopped";
    readonly reason: string;
  }>;
}

const MAX_PAYLOAD_NODES = 512;
const MAX_PAYLOAD_DEPTH = 6;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_COLLECTION_ENTRIES = 64;
const STATUS_PREFIX = "platform-hook:";
const CONFIGURATION_STATUS_KEY = `${STATUS_PREFIX}configuration`;
const sensitiveKey =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const gateEvents = new Set<NativeHookEventName>([
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_before_tree",
  "context",
  "tool_call",
  "user_bash",
  "input",
]);

function resolveDynamic<T>(value: Dynamic<T>) {
  return typeof value === "function" ? (value as () => T)() : value;
}

function projectRoot(project: ResolvedProjectIdentity) {
  if (project.kind === "git") return project.currentWorktree;
  return project.canonicalCwd;
}

function supportsHookUi(ctx: ExtensionContext) {
  return (ctx.mode === "tui" || ctx.mode === "rpc") && ctx.hasUI;
}

function nativeEventIsUnattended(
  event: NativeHookEvent,
  ctx: ExtensionContext,
) {
  if (ctx.mode === "json" || ctx.mode === "print") return true;
  const directUserGate = new Set<NativeHookEventName>([
    "input",
    "user_bash",
    "tool_call",
    "session_before_switch",
    "session_before_fork",
    "session_before_compact",
    "session_before_tree",
  ]);
  if (!directUserGate.has(event.type)) return true;
  return event.type === "input" && event.source === "extension";
}

function accountText(text: string, budget: PayloadBudget) {
  const remaining = Math.max(0, MAX_PAYLOAD_BYTES - budget.bytes);
  const byteLimit = Math.min(MAX_STRING_BYTES, remaining);
  if (Buffer.byteLength(text) <= byteLimit) {
    budget.bytes += Buffer.byteLength(text);
    return text;
  }
  budget.bounded = true;
  let output = text.slice(0, byteLimit);
  while (Buffer.byteLength(output) > byteLimit) output = output.slice(0, -1);
  budget.bytes += Buffer.byteLength(output);
  return output || "[BOUNDED]";
}

function boundedPlain(
  value: unknown,
  budget: PayloadBudget,
  depth = 0,
): PlainData {
  budget.nodes += 1;
  if (
    budget.nodes > MAX_PAYLOAD_NODES ||
    depth > MAX_PAYLOAD_DEPTH ||
    budget.bytes >= MAX_PAYLOAD_BYTES
  ) {
    budget.bounded = true;
    return "[BOUNDED]";
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : "[NON_FINITE]";
  if (typeof value === "string") return accountText(value, budget);
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return `[${typeof value}]`;
  }
  if (isProxy(value)) {
    budget.bounded = true;
    return "[PROXY]";
  }
  if (budget.seen.has(value)) {
    budget.bounded = true;
    return "[CYCLE]";
  }
  budget.seen.add(value);

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    budget.bounded = true;
    return "[UNREADABLE]";
  }

  if (Array.isArray(value)) {
    const output: PlainData[] = [];
    const length = Math.min(value.length, MAX_COLLECTION_ENTRIES);
    if (value.length > length) budget.bounded = true;
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      output.push(
        descriptor && "value" in descriptor
          ? boundedPlain(descriptor.value, budget, depth + 1)
          : "[ACCESSOR]",
      );
      if (!descriptor || !("value" in descriptor)) budget.bounded = true;
    }
    return output;
  }

  const output: Record<string, PlainData> = {};
  const entries = Object.entries(descriptors).filter(
    ([key, descriptor]) => key !== "type" && descriptor.enumerable,
  );
  if (entries.length > MAX_COLLECTION_ENTRIES) budget.bounded = true;
  for (const [rawKey, descriptor] of entries.slice(0, MAX_COLLECTION_ENTRIES)) {
    const key = accountText(rawKey.slice(0, 256), budget);
    if (rawKey.length > 256) budget.bounded = true;
    if (sensitiveKey.test(rawKey)) output[key] = "[REDACTED]";
    else if ("value" in descriptor)
      output[key] = boundedPlain(descriptor.value, budget, depth + 1);
    else {
      budget.bounded = true;
      output[key] = "[ACCESSOR]";
    }
  }
  return output;
}

function eventPayload(event: unknown) {
  const budget: PayloadBudget = {
    nodes: 0,
    bytes: 0,
    bounded: false,
    seen: new WeakSet(),
  };
  const converted = boundedPlain(event, budget);
  if (
    typeof converted !== "object" ||
    converted === null ||
    Array.isArray(converted)
  ) {
    return { payload: {}, bounded: budget.bounded } as const;
  }
  return {
    payload: converted as Readonly<Record<string, PlainData>>,
    bounded: budget.bounded,
  } as const;
}

function sourcesFor(
  agentDir: string,
  project: ResolvedProjectIdentity,
  ctx: ExtensionContext,
): readonly HookConfigSource[] {
  const root = projectRoot(project);
  return [
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
            trusted: ctx.isProjectTrusted(),
            optional: true,
          },
        ]
      : []),
  ];
}

function boundedNotice(message: string) {
  return message.slice(0, 50 * 1024);
}

function decodeHookResponse(value: unknown): HookResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).some(
      (key) => key !== "context" && key !== "block",
    ) ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return;
  const context = descriptors.context?.value;
  if (
    !Array.isArray(context) ||
    context.length > 64 ||
    context.some((entry) => typeof entry !== "string")
  )
    return;
  const block = descriptors.block?.value;
  if (block !== undefined) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return;
    const blockFields = Object.getOwnPropertyDescriptors(block);
    if (
      Object.keys(blockFields).length !== 1 ||
      !("value" in (blockFields.reason ?? {})) ||
      typeof blockFields.reason?.value !== "string"
    )
      return;
  }
  return {
    context: [...context],
    ...(block === undefined
      ? {}
      : { block: { reason: block.reason as string } }),
  };
}

export function createHooksCapability(options: HooksCapabilityOptions) {
  const { pi, agentDir } = options;
  const eventContexts = new AsyncLocalStorage<ExtensionContext>();
  let active: ActiveHooksRuntime | undefined;

  const contextForAdapter = (runtime: ActiveHooksRuntime) =>
    eventContexts.getStore() ?? runtime.ctx;

  const setHostStatus = (
    runtime: ActiveHooksRuntime,
    key: string,
    text: string | undefined,
  ) => {
    const ctx = contextForAdapter(runtime);
    if (!supportsHookUi(ctx)) return;
    ctx.ui.setStatus(key, text);
    if (text === undefined) runtime.statusKeys.delete(key);
    else runtime.statusKeys.add(key);
  };

  const reportSuspensions = (runtime: ActiveHooksRuntime) => {
    if (active !== runtime || !runtime.acceptingEffects) return;
    const ctx = contextForAdapter(runtime);
    if (!supportsHookUi(ctx)) return;
    const suspended = runtime.hooks
      .inspect()
      .sources.filter(({ status }) => status === "suspended");
    if (suspended.length === 0) {
      if (runtime.statusKeys.has(CONFIGURATION_STATUS_KEY))
        setHostStatus(runtime, CONFIGURATION_STATUS_KEY, undefined);
      runtime.suspensionNotices.clear();
      return;
    }
    setHostStatus(
      runtime,
      CONFIGURATION_STATUS_KEY,
      `${suspended.length} hook source(s) suspended`,
    );
    for (const source of suspended) {
      const notice = `${source.path}:${source.reason ?? "Hook source suspended."}`;
      if (runtime.suspensionNotices.has(notice)) continue;
      runtime.suspensionNotices.add(notice);
      ctx.ui.notify(
        boundedNotice(
          `Hook source suspended: ${source.path}\n${source.reason ?? "Configuration or trust changed. Run /hooks inspect, then /hooks reload."}`,
        ),
        "warning",
      );
    }
  };

  const handle = async (
    eventName: NativeHookEventName | PlatformHookEvent,
    event: unknown,
    ctx: ExtensionContext,
    unattended: boolean,
  ): Promise<HookResponse> => {
    const runtime = active;
    if (!runtime || !runtime.acceptingEffects) return { context: [] };
    const converted = eventPayload(event);
    if (converted.bounded && gateEvents.has(eventName as NativeHookEventName)) {
      return {
        context: [],
        block: {
          reason:
            "Hook policy input exceeded safety bounds and was denied closed.",
        },
      };
    }
    const invocation = {
      event: eventName,
      payload: converted.payload,
      cwd: ctx.cwd,
      unattended,
    };
    if (runtime.triggerPublisher) {
      const published = await eventContexts.run(ctx, () =>
        runtime.triggerPublisher!.publish({
          type: `hook:${eventName}`,
          payload: invocation,
        }),
      );
      if (active !== runtime || !runtime.acceptingEffects)
        return { context: [] };
      reportSuspensions(runtime);
      const response = published.ok
        ? published.value.deliveries
            .map(({ output }) => decodeHookResponse(output))
            .find((value) => value !== undefined)
        : undefined;
      if (response) return response;
      if (
        !published.ok ||
        published.value.deliveries.some(({ status }) => status !== "delivered")
      ) {
        const reason =
          "Hook dispatch failed within TriggerEngine safety bounds.";
        if (supportsHookUi(ctx)) ctx.ui.notify(reason, "error");
        return gateEvents.has(eventName as NativeHookEventName)
          ? { context: [], block: { reason } }
          : { context: [] };
      }
      return { context: [] };
    }
    const result = await eventContexts.run(ctx, () =>
      runtime.hooks.handle(invocation, ctx.signal),
    );
    if (active !== runtime || !runtime.acceptingEffects) return { context: [] };
    reportSuspensions(runtime);
    if (!result.ok) {
      if (supportsHookUi(ctx)) ctx.ui.notify(result.error.message, "error");
      return gateEvents.has(eventName as NativeHookEventName)
        ? { context: [], block: { reason: result.error.message } }
        : { context: [] };
    }
    return result.value;
  };

  const handleNative = (event: NativeHookEvent, ctx: ExtensionContext) =>
    handle(event.type, event, ctx, nativeEventIsUnattended(event, ctx));

  pi.registerCommand("hooks", {
    description:
      "Inspect, validate, reload, or show bounded declarative-hook logs.",
    handler: async (rawArgs, ctx) => {
      if (!supportsHookUi(ctx))
        throw new Error("/hooks requires TUI or RPC mode.");
      const runtime = active;
      if (!runtime || !runtime.acceptingEffects) {
        ctx.ui.notify("Hooks runtime is inactive.", "warning");
        return;
      }
      const args = rawArgs.trim();
      if (!["", "inspect", "validate", "reload", "logs"].includes(args)) {
        throw new Error("Usage: /hooks [inspect|validate|reload|logs]");
      }
      if (args === "validate" || args === "reload") {
        const command =
          args === "validate"
            ? {
                type: "validate" as const,
                sources: sourcesFor(agentDir, runtime.project, ctx),
              }
            : {
                type: "apply" as const,
                expectedRevision: runtime.hooks.inspect().revision,
                sources: sourcesFor(agentDir, runtime.project, ctx),
              };
        const result = await eventContexts.run(ctx, () =>
          runtime.hooks.configure(command),
        );
        if (active !== runtime || !runtime.acceptingEffects) return;
        reportSuspensions(runtime);
        if (result.ok) {
          ctx.ui.notify(
            args === "validate"
              ? `Hook configuration valid: ${result.value.hookCount} hook(s).`
              : `Reloaded ${result.value.hookCount} hook(s) at revision ${result.value.revision}.`,
            "info",
          );
        } else {
          const diagnostics =
            result.error.diagnostics
              ?.map((entry) => `[${entry.code}] ${entry.message}`)
              .join("\n") ?? "";
          ctx.ui.notify(
            boundedNotice(
              `${result.error.message}${diagnostics ? `\n${diagnostics}` : ""}`,
            ),
            "error",
          );
        }
        return;
      }

      const inspection = runtime.hooks.inspect();
      if (args === "logs") {
        ctx.ui.notify(
          boundedNotice(
            inspection.history
              .map(
                (entry) =>
                  `${entry.sequence} ${entry.type} ${entry.hookId ?? "-"} ${entry.outcome}: ${entry.message}`,
              )
              .join("\n") || "No hook activity.",
          ),
          "info",
        );
        return;
      }
      const hooks = inspection.hooks.map(
        (hook) =>
          `${hook.id} ${hook.event} [${hook.actions.join(", ")}] - ${hook.source}`,
      );
      const sourceState = inspection.sources.map(
        (source) =>
          `${source.scope} ${source.status} - ${source.path}${source.reason ? ` (${source.reason})` : ""}`,
      );
      const diagnostics = inspection.diagnostics.map(
        (entry) => `[${entry.code}] ${entry.message}`,
      );
      ctx.ui.notify(
        boundedNotice(
          [...hooks, ...sourceState, ...diagnostics].join("\n") ||
            "No declarative hooks configured.",
        ),
        diagnostics.length > 0 ? "warning" : "info",
      );
    },
  });

  const registerObserver = <E extends NativeHookEventName>(eventName: E) => {
    const on = pi.on as unknown as (
      event: E,
      handler: (
        event: NativeHookEvent<E>,
        ctx: ExtensionContext,
      ) => Promise<void>,
    ) => void;
    on(eventName, async (event, ctx) => {
      await handleNative(event, ctx);
    });
  };

  for (const eventName of [
    "resources_discover",
    "session_info_changed",
    "session_compact",
    "session_compact_failed",
    "session_tree",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "before_provider_headers",
    "before_provider_request",
    "after_provider_response",
    "model_select",
    "thinking_level_select",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "tool_result",
  ] as const) {
    registerObserver(eventName);
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.context.length > 0) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Declarative hook context\n${response.context.join("\n\n")}`,
      };
    }
  });

  pi.on("context", async (event, ctx) => {
    const response = await handle(
      "context",
      { messageCount: event.messages.length },
      ctx,
      nativeEventIsUnattended(event, ctx),
    );
    if (response.block) {
      if (supportsHookUi(ctx)) ctx.ui.notify(response.block.reason, "error");
      ctx.abort();
    }
    if (response.context.length > 0) {
      return {
        messages: [
          ...event.messages,
          ...response.context.map((content) => ({
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
    const response = await handleNative(event, ctx);
    if (response.block) return { block: true, reason: response.block.reason };
  });

  pi.on("input", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.block) {
      if (supportsHookUi(ctx)) ctx.ui.notify(response.block.reason, "warning");
      return { action: "handled" as const };
    }
  });

  pi.on("user_bash", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.block) {
      return {
        result: {
          output: response.block.reason,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.block) {
      if (supportsHookUi(ctx)) ctx.ui.notify(response.block.reason, "warning");
      return { cancel: true };
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.block) {
      if (supportsHookUi(ctx)) ctx.ui.notify(response.block.reason, "warning");
      return { cancel: true };
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.block) {
      if (supportsHookUi(ctx)) ctx.ui.notify(response.block.reason, "warning");
      return { cancel: true };
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const response = await handleNative(event, ctx);
    if (response.block) {
      if (supportsHookUi(ctx)) ctx.ui.notify(response.block.reason, "warning");
      return { cancel: true };
    }
  });

  const start = async (input: HooksSessionContext, startEvent: unknown) => {
    const processRunner = createHookProcessRunner();
    let runtime!: ActiveHooksRuntime;
    const commandAdapter = {
      run(request: HookProcessRequest) {
        return processRunner.run({
          ...request,
          args: [...request.args],
          env: { ...request.env },
        });
      },
      async shutdown() {
        // Wiring owns process shutdown so close and host shutdown errors aggregate.
      },
    } satisfies HookProcessRunner;
    const policyAdapter: CapabilityPolicy = {
      decide(operation, actor, mode) {
        return resolveDynamic(options.policy).decide(operation, actor, mode);
      },
    };
    const hooks = createHooks({
      actor: () => resolveDynamic(options.actor),
      mode: options.mode,
      policy: policyAdapter,
      trust: {
        isTrusted(source) {
          if (source.scope === "global") return true;
          return active === runtime && runtime.ctx.isProjectTrusted();
        },
      },
      adapters: {
        command: commandAdapter,
        ui: {
          notify(message, level) {
            if (
              active !== runtime ||
              !runtime.acceptingEffects ||
              !supportsHookUi(contextForAdapter(runtime))
            )
              return;
            contextForAdapter(runtime).ui.notify(message, level);
          },
          setStatus(key, text) {
            if (active !== runtime && text !== undefined) return;
            if (!runtime.acceptingEffects && text !== undefined) return;
            setHostStatus(runtime, `${STATUS_PREFIX}${key}`, text);
          },
          async confirm(title, message, timeoutMs) {
            const ctx = contextForAdapter(runtime);
            if (
              active !== runtime ||
              !runtime.acceptingEffects ||
              !supportsHookUi(ctx)
            )
              return false;
            return ctx.ui.confirm(title, message, { timeout: timeoutMs });
          },
        },
        ...(options.adapters?.http ? { http: options.adapters.http } : {}),
        ...(options.adapters?.mcp ? { mcp: options.adapters.mcp } : {}),
        ...(options.adapters?.agent ? { agent: options.adapters.agent } : {}),
      },
    });
    const triggerRuntime = input.triggers ?? options.triggers;
    runtime = {
      hooks,
      process: processRunner,
      ctx: input.ctx,
      project: input.project,
      statusKeys: new Set(),
      suspensionNotices: new Set(),
      ...(triggerRuntime ? { triggerRuntime } : {}),
      triggerGeneration: 0,
      acceptingEffects: true,
    };
    active = runtime;
    if (triggerRuntime) {
      const ownerSuffix = createHash("sha256")
        .update(input.project.projectId)
        .digest("hex")
        .slice(0, 16);
      runtime.triggerOwnerId = `hooks-${ownerSuffix}`;
      const bound = triggerRuntime.bindSource({
        kind: "pi-hooks",
        id: runtime.triggerOwnerId,
        projectId: input.project.projectId,
        sessionId: input.ctx.sessionManager.getSessionId(),
        trust: "managed",
      });
      if (!bound.ok) {
        runtime.acceptingEffects = false;
        active = undefined;
        await Promise.allSettled([
          hooks.close(),
          processRunner.shutdown(2_000),
        ]);
        return {
          ok: false as const,
          error: {
            code: "INVALID_CONFIG" as const,
            message: "TriggerEngine source binding failed for Hooks.",
            retryable: bound.error.retryable,
          },
        };
      }
      runtime.triggerPublisher = bound.value;
      runtime.triggerGeneration += 1;
      const reconciled = await triggerRuntime.engine.reconcile({
        ownerId: runtime.triggerOwnerId,
        generation: runtime.triggerGeneration,
        bindings: [
          {
            id: "dispatch",
            eventTypes: declarativeHookEvents.map((event) => `hook:${event}`),
            concurrency: 8,
            deadlineMs: 30_000,
            async deliver(delivery) {
              const event = delivery.events[0];
              const invocation = event?.payload as
                | {
                    event?: unknown;
                    payload?: unknown;
                    cwd?: unknown;
                    unattended?: unknown;
                  }
                | undefined;
              if (
                !invocation ||
                typeof invocation.event !== "string" ||
                !declarativeHookEvents.some(
                  (candidate) => candidate === invocation.event,
                ) ||
                !invocation.payload ||
                typeof invocation.payload !== "object" ||
                Array.isArray(invocation.payload) ||
                typeof invocation.cwd !== "string" ||
                typeof invocation.unattended !== "boolean"
              ) {
                throw new Error(
                  "TriggerEngine supplied an invalid Hook event.",
                );
              }
              const result = await hooks.handle(
                {
                  event:
                    invocation.event as (typeof declarativeHookEvents)[number],
                  payload: invocation.payload as Readonly<
                    Record<string, PlainData>
                  >,
                  cwd: invocation.cwd,
                  unattended: invocation.unattended,
                },
                delivery.signal,
              );
              if (!result.ok) throw new Error("Hook execution failed.");
              return result.value as unknown as import("../core/result.ts").JsonObject;
            },
          },
        ],
      });
      if (!reconciled.ok) {
        runtime.acceptingEffects = false;
        active = undefined;
        await Promise.allSettled([
          hooks.close(),
          processRunner.shutdown(2_000),
        ]);
        return {
          ok: false as const,
          error: {
            code: "INVALID_CONFIG" as const,
            message: "TriggerEngine reconciliation failed for Hooks.",
            retryable: reconciled.error.retryable,
          },
        };
      }
    }
    const configured = await eventContexts.run(input.ctx, () =>
      hooks.configure({
        type: "apply",
        expectedRevision: 0,
        sources: sourcesFor(agentDir, input.project, input.ctx),
      }),
    );
    if (active !== runtime || !runtime.acceptingEffects) return configured;
    if (!configured.ok && supportsHookUi(input.ctx)) {
      const diagnostics =
        configured.error.diagnostics
          ?.map((entry) => `[${entry.code}] ${entry.message}`)
          .join("\n") ?? "";
      input.ctx.ui.notify(
        boundedNotice(
          `${configured.error.message}${diagnostics ? `\n${diagnostics}` : ""}`,
        ),
        "error",
      );
    }
    await handle(
      "session_start",
      startEvent,
      input.ctx,
      input.ctx.mode === "json" || input.ctx.mode === "print",
    );
    return configured;
  };

  const stop = async (reason: string, event: unknown) => {
    const runtime = active;
    if (!runtime) return { status: "stopped" as const, reason };
    if (runtime.stopPromise) return runtime.stopPromise;
    runtime.stopPromise = (async () => {
      const failures: unknown[] = [];
      try {
        await handle(
          "session_shutdown",
          event,
          runtime.ctx,
          runtime.ctx.mode === "json" || runtime.ctx.mode === "print",
        );
      } catch (error) {
        failures.push(error);
      }
      runtime.acceptingEffects = false;
      if (active === runtime) active = undefined;
      const triggerStop =
        runtime.triggerRuntime && runtime.triggerOwnerId
          ? runtime.triggerRuntime.engine.reconcile({
              ownerId: runtime.triggerOwnerId,
              generation: ++runtime.triggerGeneration,
              bindings: [],
            })
          : Promise.resolve({ ok: true as const, value: undefined });
      const settled = await Promise.allSettled([
        triggerStop.then((result) => {
          if (!result.ok) throw new Error("Hooks TriggerEngine stop failed.");
        }),
        runtime.hooks.close(),
        runtime.process.shutdown(2_000),
      ]);
      for (const result of settled) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      for (const key of [...runtime.statusKeys]) {
        try {
          runtime.ctx.ui.setStatus(key, undefined);
          runtime.statusKeys.delete(key);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Hooks shutdown failed.");
      return { status: "stopped" as const, reason };
    })();
    return runtime.stopPromise;
  };

  return {
    start,
    stop,
    inspect: () =>
      active?.hooks.inspect() ?? {
        revision: 0,
        hooks: [],
        history: [],
        diagnostics: [],
        sources: [],
      },
    async handlePlatformEvent(
      event: PlatformHookEvent,
      payload: PlatformHookPayload,
    ) {
      const runtime = active;
      if (!runtime || !runtime.acceptingEffects) return { context: [] };
      return handle(event, payload, runtime.ctx, true);
    },
  };
}
