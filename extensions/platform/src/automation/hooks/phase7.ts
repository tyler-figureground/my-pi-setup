import { resolve } from "node:path";
import type {
  ActorRole,
  CapabilityOperation,
  CapabilityPolicy,
  OperationKind,
} from "../../core/policy/index.ts";
import type { Outcome } from "../../core/result.ts";
import { validateConfigSources } from "./config.ts";
import { declarativeHookEvents } from "./model.ts";
import type {
  DeclarativeHookAction,
  HookConfigSource,
  HookDefinition,
  HookDiagnostic,
  HookEvent,
  HookMode,
  HookRegistration,
  PlainData,
  ValidationResult,
} from "./model.ts";
import type { HookProcessRunner } from "./process.ts";
import {
  containsSensitiveKey,
  isPlainPayload,
  isRecord,
  redact,
  resolveLimits,
} from "./validation.ts";

export type HookErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CONFIG"
  | "CONFIG_CHANGED"
  | "STALE_REVISION"
  | "ACTION_BLOCKED";

export interface HookError {
  readonly code: HookErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly diagnostics?: readonly HookDiagnostic[];
}

export type HookOutcome<T> = Outcome<T, HookError>;

export interface HookConfigurationCommand {
  readonly type: "validate" | "apply";
  readonly sources: readonly HookConfigSource[];
  readonly expectedRevision?: number;
}

export interface HookConfigurationResult {
  readonly applied: boolean;
  readonly revision: number;
  readonly hookCount: number;
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookInvocation {
  readonly event: HookEvent;
  readonly payload: Readonly<Record<string, PlainData>>;
  readonly cwd: string;
  readonly unattended: boolean;
}

export interface HookResponse {
  readonly context: readonly string[];
  readonly block?: { readonly reason: string };
}

export interface HookAdapterResult {
  readonly output?: string;
}

export interface HookNamedAdapterRequest {
  readonly name: string;
  readonly input?: PlainData;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly outputCapBytes: number;
}

export interface HookHttpAdapter {
  classify(name: string): OperationKind | undefined;
  invoke(request: HookNamedAdapterRequest): Promise<HookAdapterResult>;
}

export interface HookMcpAdapter {
  invoke(request: HookNamedAdapterRequest): Promise<HookAdapterResult>;
}

export interface HookAgentAdapter {
  run(
    request: Omit<HookNamedAdapterRequest, "input"> & {
      readonly prompt: string;
    },
  ): Promise<HookAdapterResult>;
}

export interface HookUiAdapter {
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  confirm(title: string, message: string, timeoutMs: number): Promise<boolean>;
}

export interface HookTrustAdapter {
  isTrusted(source: HookConfigSource): boolean | Promise<boolean>;
}

export interface HookHistoryEntry {
  readonly sequence: number;
  readonly type:
    "configured" | "config-changed" | "action" | "blocked" | "failed";
  readonly hookId?: string;
  readonly action?: DeclarativeHookAction["type"];
  readonly outcome: string;
  readonly message: string;
}

export interface HooksOptions {
  readonly actor: () => ActorRole;
  readonly mode: () => HookMode;
  readonly policy: CapabilityPolicy;
  readonly trust: HookTrustAdapter;
  readonly adapters?: {
    readonly command?: HookProcessRunner;
    readonly ui?: HookUiAdapter;
    readonly http?: HookHttpAdapter;
    readonly mcp?: HookMcpAdapter;
    readonly agent?: HookAgentAdapter;
  };
  readonly maxHistoryEntries?: number;
  readonly maxHistoryBytes?: number;
  readonly maxContextBytes?: number;
}

export interface HookQuery {
  readonly historyLimit?: number;
}

export interface Hooks {
  configure(
    command: HookConfigurationCommand,
  ): Promise<HookOutcome<HookConfigurationResult>>;
  handle(
    invocation: HookInvocation,
    signal?: AbortSignal,
  ): Promise<HookOutcome<HookResponse>>;
  close(): Promise<void>;
  inspect(query?: HookQuery): {
    readonly revision: number;
    readonly hooks: readonly {
      readonly id: string;
      readonly event: HookEvent;
      readonly actions: readonly DeclarativeHookAction["type"][];
      readonly source: string;
    }[];
    readonly history: readonly HookHistoryEntry[];
    readonly diagnostics: readonly HookDiagnostic[];
    readonly sources: readonly {
      readonly scope: HookConfigSource["scope"];
      readonly path: string;
      readonly status: "active" | "missing" | "suspended";
      readonly digest?: string;
      readonly reason?: string;
    }[];
  };
}

interface AppliedSource {
  readonly source: HookConfigSource;
  readonly expectedStatus: "valid" | "missing";
  readonly identity?: {
    readonly canonicalPath: string;
    readonly device: number;
    readonly inode: number;
    readonly digest: string;
  };
  status: "active" | "missing" | "suspended";
  reason?: string;
}

function valueAtPath(value: Readonly<Record<string, unknown>>, path: string) {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return { exists: false, value: undefined };
    }
    current = current[segment];
  }
  return { exists: true, value: current };
}

function matches(
  hook: HookDefinition,
  payload: Readonly<Record<string, unknown>>,
) {
  return Object.entries(hook.match).every(([path, matcher]) => {
    const actual = valueAtPath(payload, path);
    if (
      matcher === null ||
      typeof matcher === "string" ||
      typeof matcher === "number" ||
      typeof matcher === "boolean"
    ) {
      return actual.exists && actual.value === matcher;
    }
    if ("exists" in matcher) return actual.exists === matcher.exists;
    if ("equals" in matcher)
      return actual.exists && actual.value === matcher.equals;
    if (typeof actual.value !== "string") return false;
    if ("contains" in matcher)
      return actual.value.includes(matcher.contains ?? "");
    if ("startsWith" in matcher)
      return actual.value.startsWith(matcher.startsWith ?? "");
    if ("endsWith" in matcher)
      return actual.value.endsWith(matcher.endsWith ?? "");
    return false;
  });
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRegistrations(left: HookRegistration, right: HookRegistration) {
  return (
    left.hook.priority - right.hook.priority ||
    compareText(left.provenance.source, right.provenance.source) ||
    compareText(left.hook.id, right.hook.id)
  );
}

function actions(hook: HookDefinition) {
  return hook.actions ?? [hook.action];
}

function operationFor(
  action: DeclarativeHookAction,
  http: HookHttpAdapter | undefined,
): CapabilityOperation {
  switch (action.type) {
    case "command":
      return { kind: "operation", name: "process" };
    case "http":
      return {
        kind: "operation",
        name: http?.classify(action.name) ?? "remote-write",
      };
    case "mcp":
      return { kind: "tool", name: "mcp_tools", source: "custom" };
    case "agent":
      return { kind: "operation", name: "orchestration" };
    case "notify":
    case "status":
      return { kind: "operation", name: "local-write" };
    case "context":
    case "policy":
      return { kind: "operation", name: "read" };
  }
}

function deniedInPlanMode(operation: CapabilityOperation) {
  if (operation.kind === "tool") return true;
  return !new Set<OperationKind>(["read", "network-read"]).has(operation.name);
}

function sanitizeDecision(decision: ReturnType<CapabilityPolicy["decide"]>) {
  return { ...decision, reason: redact(decision.reason) };
}

function safeEnvironment() {
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
  return environment;
}

function sameIdentity(
  left: AppliedSource["identity"],
  right: AppliedSource["identity"],
) {
  if (!left || !right) return left === right;
  return (
    resolve(left.canonicalPath) === resolve(right.canonicalPath) &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.digest === right.digest
  );
}

function sameConfigurationSnapshot(
  left: ValidationResult,
  right: ValidationResult,
) {
  if (left.sources.length !== right.sources.length) return false;
  return left.sources.every((source) => {
    const current = right.sources.find(
      (candidate) =>
        candidate.scope === source.scope &&
        resolve(candidate.path) === resolve(source.path),
    );
    return (
      current !== undefined &&
      current.status === source.status &&
      sameIdentity(source.identity, current.identity)
    );
  });
}

type DeadlineResult<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "timed-out"; readonly settled: Promise<void> }
  | { readonly kind: "aborted"; readonly settled: Promise<void> };

async function beforeDeadline<T>(
  promise: Promise<T>,
  remainingMs: number,
  controller: AbortController,
  signal: AbortSignal = controller.signal,
): Promise<DeadlineResult<T>> {
  const settled = promise.then(
    (value) => ({ kind: "completed", value }) as const,
    (error: unknown) => ({ kind: "failed", error }) as const,
  );
  let timer: NodeJS.Timeout | undefined;
  let removeAbort: () => void = () => {};
  const timeout = new Promise<{ readonly kind: "timed-out" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timed-out" }), remainingMs);
  });
  const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
  });
  const result = await Promise.race([settled, timeout, aborted]);
  if (timer) clearTimeout(timer);
  removeAbort();
  if (result.kind === "completed" || result.kind === "failed") return result;
  if (result.kind === "timed-out") {
    controller.abort(new Error("Hook deadline exceeded."));
  }
  return {
    kind: result.kind,
    settled:
      result.kind === "aborted"
        ? Promise.resolve()
        : settled.then(() => undefined),
  };
}

function waitAtMost(promise: Promise<unknown>, milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export function createHooks(options: HooksOptions): Hooks {
  const limits = resolveLimits({});
  const maxHistoryEntries = options.maxHistoryEntries ?? 256;
  const maxHistoryBytes = options.maxHistoryBytes ?? 128 * 1024;
  const maxContextBytes = options.maxContextBytes ?? 64 * 1024;
  let revision = 0;
  let generation = 0;
  let closed = false;
  let transitioning = false;
  let closePromise: Promise<void> | undefined;
  let configured: HookRegistration[] = [];
  let diagnostics: readonly HookDiagnostic[] = [];
  let appliedSources: AppliedSource[] = [];
  let history: HookHistoryEntry[] = [];
  let historyBytes = 0;
  let nextHistory = 0;
  let activeActions = 0;
  let configurationQueue = Promise.resolve();
  const activeHooks = new Map<string, number>();
  const ownedStatuses = new Set<string>();
  const activeExecutions = new Set<{
    readonly generation: number;
    readonly controller: AbortController;
    readonly settled: Promise<void>;
    resolveSettled(): void;
  }>();

  const closedOutcome = () =>
    ({
      ok: false,
      error: {
        code: "ACTION_BLOCKED",
        message: "Hooks runtime is closed.",
        retryable: false,
      },
    }) as const;

  const appendHistory = (
    entry: Omit<HookHistoryEntry, "sequence" | "message"> & {
      message: string;
    },
  ) => {
    const safe = {
      ...entry,
      ...(entry.hookId && containsSensitiveKey(entry.hookId)
        ? { hookId: "[REDACTED]" }
        : {}),
      sequence: ++nextHistory,
      message: redact(entry.message).slice(0, 1_000),
    } satisfies HookHistoryEntry;
    const bytes = Buffer.byteLength(JSON.stringify(safe));
    if (bytes > maxHistoryBytes) return;
    history.push(safe);
    historyBytes += bytes;
    while (
      history.length > maxHistoryEntries ||
      historyBytes > maxHistoryBytes
    ) {
      const removed = history.shift();
      if (removed) historyBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  };

  const fenceGeneration = async (reason: string) => {
    generation++;
    const active = [...activeExecutions];
    for (const execution of active) {
      execution.controller.abort(new Error(reason));
    }
    await waitAtMost(Promise.all(active.map(({ settled }) => settled)), 250);
  };

  const runConfiguration = async (command: HookConfigurationCommand) => {
    const candidate: unknown = command;
    if (
      !isPlainPayload(candidate) ||
      !isRecord(candidate) ||
      (candidate.type !== "validate" && candidate.type !== "apply") ||
      !Array.isArray(candidate.sources) ||
      Object.keys(candidate).some(
        (key) => !["type", "sources", "expectedRevision"].includes(key),
      ) ||
      (candidate.expectedRevision !== undefined &&
        (!Number.isSafeInteger(candidate.expectedRevision) ||
          Number(candidate.expectedRevision) < 0))
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Hook configuration command is invalid.",
          retryable: false,
        },
      } as const;
    }
    command = candidate as unknown as HookConfigurationCommand;
    if (closed) return closedOutcome();
    const requestedSources = structuredClone(command.sources);
    if (
      command.expectedRevision !== undefined &&
      command.expectedRevision !== revision
    ) {
      return {
        ok: false,
        error: {
          code: "STALE_REVISION",
          message: "Hook configuration revision is stale.",
          retryable: true,
        },
      } as const;
    }
    const trustResults = await Promise.all(
      requestedSources.map(async (source) => ({
        source,
        trusted:
          (source.scope !== "project" || source.trusted === true) &&
          (await options.trust.isTrusted(source)),
      })),
    );
    if (closed) return closedOutcome();
    const untrusted = trustResults.find(({ trusted }) => !trusted);
    if (untrusted) {
      const trustDiagnostic: HookDiagnostic = {
        severity: "error",
        code: "untrusted-source",
        source: untrusted.source.path,
        message: "Hook source is not trusted by current host state.",
      };
      diagnostics = [trustDiagnostic];
      const applied = appliedSources.find(
        ({ source }) => resolve(source.path) === resolve(untrusted.source.path),
      );
      if (command.type === "apply" && applied) {
        await suspendSource(applied, trustDiagnostic.message);
      }
      return {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message: "Hook configuration source is untrusted.",
          retryable: false,
          diagnostics,
        },
      } as const;
    }
    let result = await validateConfigSources(
      requestedSources,
      limits,
      new Set(),
    );
    if (closed) return closedOutcome();
    if (!result.valid) {
      diagnostics = result.diagnostics;
      if (command.type === "apply") {
        for (const current of result.sources) {
          const applied = appliedSources.find(
            ({ source }) => resolve(source.path) === resolve(current.path),
          );
          if (
            applied &&
            (current.status !== applied.expectedStatus ||
              !sameIdentity(applied.identity, current.identity))
          ) {
            await suspendSource(
              applied,
              "Hook config changed and failed validation.",
            );
          }
        }
      }
      return {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message: "Hook configuration is invalid.",
          retryable: false,
          diagnostics: result.diagnostics,
        },
      } as const;
    }
    if (command.type === "apply") {
      const commitTrust = await Promise.all(
        requestedSources.map(
          async (source) =>
            (source.scope !== "project" || source.trusted === true) &&
            (await options.trust.isTrusted(source)),
        ),
      );
      const commitResult = await validateConfigSources(
        requestedSources,
        limits,
        new Set(),
      );
      if (closed) return closedOutcome();
      if (
        commitTrust.some((trusted) => !trusted) ||
        !commitResult.valid ||
        !sameConfigurationSnapshot(result, commitResult)
      ) {
        const changedDiagnostic: HookDiagnostic = {
          severity: "error",
          code: "config-changed-during-apply",
          source: "Hooks",
          message:
            "Hook config identity, digest, or trust changed during apply; configuration was not committed.",
        };
        diagnostics = [changedDiagnostic];
        for (const applied of appliedSources) {
          if (
            requestedSources.some(
              (source) => resolve(source.path) === resolve(applied.source.path),
            )
          ) {
            await suspendSource(
              applied,
              "Hook config changed during apply; source suspended.",
            );
          }
        }
        appendHistory({
          type: "config-changed",
          outcome: "apply-rejected",
          message: changedDiagnostic.message,
        });
        return {
          ok: false,
          error: {
            code: "CONFIG_CHANGED",
            message: changedDiagnostic.message,
            retryable: true,
            diagnostics,
          },
        } as const;
      }
      if (closed) return closedOutcome();
      result = commitResult;
      transitioning = true;
      try {
        await fenceGeneration("Hook configuration revision changed.");
        if (closed) return closedOutcome();
        configured = result.hooks.map((registration) =>
          structuredClone(registration),
        );
        appliedSources = requestedSources.map((source) => {
          const current = result.sources.find(
            (candidate) => resolve(candidate.path) === resolve(source.path),
          );
          const expectedStatus =
            current?.status === "missing" ? "missing" : "valid";
          return {
            source: structuredClone(source),
            expectedStatus,
            ...(current?.identity
              ? { identity: structuredClone(current.identity) }
              : {}),
            status: expectedStatus === "missing" ? "missing" : "active",
          } satisfies AppliedSource;
        });
        diagnostics = result.diagnostics;
        revision++;
        appendHistory({
          type: "configured",
          outcome: "applied",
          message: `Applied ${configured.length} hook(s) at revision ${revision}.`,
        });
      } finally {
        transitioning = false;
      }
    }
    return {
      ok: true,
      value: {
        applied: command.type === "apply",
        revision,
        hookCount: result.hooks.length,
        diagnostics: result.diagnostics,
      },
    } as const;
  };

  const configure = (command: HookConfigurationCommand) => {
    const result = configurationQueue.then(() => runConfiguration(command));
    configurationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const suspendSource = async (source: AppliedSource, reason: string) => {
    if (source.status === "suspended") return;
    source.status = "suspended";
    source.reason = redact(reason);
    appendHistory({
      type: "config-changed",
      outcome: "suspended",
      message: reason,
    });
    await fenceGeneration("Hook source was suspended.");
  };

  const sourceIsCurrent = async (
    source: AppliedSource,
    expectedGeneration: number,
  ) => {
    if (source.status === "suspended" || generation !== expectedGeneration) {
      return false;
    }
    const trusted =
      (source.source.scope !== "project" || source.source.trusted === true) &&
      (await options.trust.isTrusted(source.source));
    if (closed || generation !== expectedGeneration) return false;
    if (!trusted) {
      await suspendSource(
        source,
        "Hook source trust changed; source suspended.",
      );
      return false;
    }
    const checked = await validateConfigSources(
      [source.source],
      limits,
      new Set(),
    );
    if (closed || generation !== expectedGeneration) return false;
    const current = checked.sources[0];
    if (
      !checked.valid ||
      !current ||
      current.status !== source.expectedStatus ||
      !sameIdentity(source.identity, current.identity)
    ) {
      await suspendSource(
        source,
        "Hook config identity or digest changed; source suspended.",
      );
      return false;
    }
    return true;
  };

  const handle = async (invocation: HookInvocation, signal?: AbortSignal) => {
    const candidate: unknown = invocation;
    const plain = isPlainPayload(candidate);
    const valid =
      plain &&
      isRecord(candidate) &&
      typeof candidate.event === "string" &&
      declarativeHookEvents.some((event) => event === candidate.event) &&
      isPlainPayload(candidate.payload) &&
      typeof candidate.cwd === "string" &&
      candidate.cwd.length > 0 &&
      candidate.cwd.length <= 32_768 &&
      typeof candidate.unattended === "boolean" &&
      Object.keys(candidate).every((key) =>
        ["event", "payload", "cwd", "unattended"].includes(key),
      );
    let payloadBytes = Number.POSITIVE_INFINITY;
    if (valid) {
      try {
        payloadBytes = Buffer.byteLength(JSON.stringify(candidate.payload));
      } catch {
        payloadBytes = Number.POSITIVE_INFINITY;
      }
    }
    if (!valid || payloadBytes > 256 * 1024) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Hook invocation is invalid.",
          retryable: false,
        },
      } as const;
    }
    invocation = candidate as unknown as HookInvocation;
    signal?.throwIfAborted();
    if (closed || transitioning) {
      return {
        ok: false,
        error: {
          code: "ACTION_BLOCKED",
          message: closed
            ? "Hooks runtime is closed."
            : "Hooks runtime is changing configuration.",
          retryable: !closed,
        },
      } as const;
    }
    const handleGeneration = generation;
    const context: string[] = [];
    let contextBytes = 0;
    let block: HookResponse["block"];
    let transitionBlock: HookResponse["block"];
    const matched = configured
      .filter(
        ({ hook }) =>
          hook.event === invocation.event && matches(hook, invocation.payload),
      )
      .sort(compareRegistrations);
    for (const registration of matched) {
      if (closed || transitioning || generation !== handleGeneration) break;
      const concurrency = registration.hook.concurrency ?? 1;
      const active = activeHooks.get(registration.hook.id) ?? 0;
      if (active >= concurrency) {
        const reason = `Hook ${registration.hook.id} concurrency limit reached.`;
        appendHistory({
          type: "blocked",
          hookId: registration.hook.id,
          outcome: "concurrency-limited",
          message: reason,
        });
        if (registration.hook.failurePolicy === "closed") {
          block ??= { reason };
        }
        continue;
      }
      if (activeActions >= 8) {
        const reason = "Global hook action concurrency limit reached.";
        appendHistory({
          type: "blocked",
          hookId: registration.hook.id,
          outcome: "global-concurrency-limited",
          message: reason,
        });
        if (registration.hook.failurePolicy === "closed") {
          block ??= { reason };
        }
        continue;
      }
      activeHooks.set(registration.hook.id, active + 1);
      activeActions++;
      const executionGeneration = generation;
      const controller = new AbortController();
      const actionSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const execution = {
        generation: executionGeneration,
        controller,
        settled,
        resolveSettled,
      };
      activeExecutions.add(execution);
      const executionGenerationIsCurrent = () =>
        !closed &&
        !transitioning &&
        generation === handleGeneration &&
        generation === executionGeneration;
      const executionIsCurrent = () =>
        executionGenerationIsCurrent() && !actionSignal.aborted;
      const deadlineAt = Date.now() + registration.hook.timeoutMs;
      let deferredRelease: Promise<void> | undefined;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeExecutions.delete(execution);
        execution.resolveSettled();
        activeActions = Math.max(0, activeActions - 1);
        const count = activeHooks.get(registration.hook.id) ?? 1;
        if (count <= 1) activeHooks.delete(registration.hook.id);
        else activeHooks.set(registration.hook.id, count - 1);
      };
      const failAction = (
        action: DeclarativeHookAction,
        outcome: string,
        reason: string,
      ) => {
        if (!executionGenerationIsCurrent()) return false;
        appendHistory({
          type: "failed",
          hookId: registration.hook.id,
          action: action.type,
          outcome,
          message: reason,
        });
        if (registration.hook.failurePolicy === "closed") {
          block ??= { reason };
          return true;
        }
        return false;
      };
      const source = appliedSources.find(
        (candidate) =>
          resolve(candidate.source.path) ===
          resolve(registration.provenance.source),
      );
      try {
        for (const action of actions(registration.hook)) {
          if (!executionIsCurrent()) break;
          if (deadlineAt <= Date.now()) {
            failAction(action, "timed-out", "Hook deadline exceeded.");
            controller.abort(new Error("Hook deadline exceeded."));
            break;
          }
          const currentSource = source
            ? await sourceIsCurrent(source, executionGeneration)
            : true;
          if (!executionIsCurrent()) {
            if (
              !currentSource &&
              registration.hook.failurePolicy === "closed"
            ) {
              transitionBlock = {
                reason: source?.reason ?? "Hook source is no longer trusted.",
              };
            }
            break;
          }
          if (!currentSource) {
            const reason =
              source?.reason ?? "Hook source is no longer trusted.";
            appendHistory({
              type: "blocked",
              hookId: registration.hook.id,
              action: action.type,
              outcome: "untrusted",
              message: reason,
            });
            if (registration.hook.failurePolicy === "closed") {
              block ??= { reason };
            }
            break;
          }
          const remainingMs = deadlineAt - Date.now();
          if (remainingMs <= 0) {
            failAction(action, "timed-out", "Hook deadline exceeded.");
            controller.abort(new Error("Hook deadline exceeded."));
            break;
          }
          const operation = operationFor(action, options.adapters?.http);
          if (options.mode() === "plan" && deniedInPlanMode(operation)) {
            const reason = "Plan Mode denies side-effecting hook actions.";
            appendHistory({
              type: "blocked",
              hookId: registration.hook.id,
              action: action.type,
              outcome: "plan-denied",
              message: reason,
            });
            if (registration.hook.failurePolicy === "closed") {
              block ??= { reason };
            }
            continue;
          }
          let decision = sanitizeDecision(
            options.policy.decide(operation, options.actor(), {
              kind: options.mode(),
            }),
          );
          if (decision.kind === "deny") {
            appendHistory({
              type: "blocked",
              hookId: registration.hook.id,
              action: action.type,
              outcome: decision.kind,
              message: decision.reason,
            });
            if (registration.hook.failurePolicy === "closed") {
              block ??= { reason: decision.reason };
            }
            continue;
          }
          if (decision.kind === "require-user-confirmation") {
            let confirmed = false;
            if (!invocation.unattended && options.adapters?.ui !== undefined) {
              const confirmation = await beforeDeadline(
                options.adapters.ui.confirm(
                  `Hook ${registration.hook.id} requests confirmation`,
                  decision.reason,
                  remainingMs,
                ),
                remainingMs,
                controller,
                actionSignal,
              );
              if (confirmation.kind === "aborted") {
                deferredRelease = confirmation.settled;
                break;
              }
              if (confirmation.kind === "timed-out") {
                deferredRelease = confirmation.settled;
                failAction(
                  action,
                  "timed-out",
                  "Hook deadline exceeded during confirmation.",
                );
                break;
              }
              if (!executionIsCurrent()) break;
              if (confirmation.kind === "completed") {
                confirmed = confirmation.value;
              } else {
                failAction(
                  action,
                  "confirmation-failed",
                  "Hook confirmation failed.",
                );
                break;
              }
            }
            if (!confirmed) {
              appendHistory({
                type: "blocked",
                hookId: registration.hook.id,
                action: action.type,
                outcome: invocation.unattended
                  ? "unattended-confirmation"
                  : "confirmation-declined",
                message: decision.reason,
              });
              if (registration.hook.failurePolicy === "closed") {
                block ??= { reason: decision.reason };
              }
              continue;
            }
            const confirmedSource = source
              ? await sourceIsCurrent(source, executionGeneration)
              : true;
            if (!executionIsCurrent()) break;
            if (!confirmedSource) {
              const reason =
                source?.reason ?? "Hook source is no longer trusted.";
              appendHistory({
                type: "blocked",
                hookId: registration.hook.id,
                action: action.type,
                outcome: "untrusted",
                message: reason,
              });
              if (registration.hook.failurePolicy === "closed") {
                block ??= { reason };
              }
              break;
            }
            decision = sanitizeDecision(
              options.policy.decide(operation, options.actor(), {
                kind: options.mode(),
              }),
            );
            if (decision.kind === "deny") {
              appendHistory({
                type: "blocked",
                hookId: registration.hook.id,
                action: action.type,
                outcome: "denied-after-confirmation",
                message: decision.reason,
              });
              if (registration.hook.failurePolicy === "closed") {
                block ??= { reason: decision.reason };
              }
              continue;
            }
          }
          if (!executionIsCurrent()) break;
          let completionOutcome = "completed";
          let completionMessage = `Completed ${action.type} action.`;
          if (action.type === "notify") {
            if (!options.adapters?.ui) {
              if (
                failAction(
                  action,
                  "adapter-unavailable",
                  "Hook UI adapter is unavailable.",
                )
              ) {
                break;
              }
              continue;
            }
            options.adapters.ui.notify(redact(action.message), action.level);
          } else if (action.type === "status") {
            if (!options.adapters?.ui) {
              if (
                failAction(
                  action,
                  "adapter-unavailable",
                  "Hook UI adapter is unavailable.",
                )
              ) {
                break;
              }
              continue;
            }
            options.adapters.ui.setStatus(
              action.key,
              action.text === null ? undefined : redact(action.text),
            );
            if (action.text === null) ownedStatuses.delete(action.key);
            else ownedStatuses.add(action.key);
          } else if (action.type === "context") {
            const safeContent = redact(action.content);
            const bytes = Buffer.byteLength(safeContent);
            if (contextBytes + bytes > maxContextBytes) {
              if (
                failAction(
                  action,
                  "output-truncated",
                  "Hook response context limit reached.",
                )
              ) {
                break;
              }
              continue;
            }
            context.push(safeContent);
            contextBytes += bytes;
          } else if (action.type === "policy") {
            if (action.decision === "deny") {
              block ??= { reason: redact(action.reason) };
              break;
            } else if (action.decision === "require-user-confirmation") {
              if (invocation.unattended || !options.adapters?.ui) {
                block ??= { reason: redact(action.reason) };
                appendHistory({
                  type: "blocked",
                  hookId: registration.hook.id,
                  action: action.type,
                  outcome: "unattended-confirmation",
                  message: action.reason,
                });
                continue;
              }
              const confirmation = await beforeDeadline(
                options.adapters.ui.confirm(
                  `Hook ${registration.hook.id} requests confirmation`,
                  redact(action.reason),
                  Math.max(1, deadlineAt - Date.now()),
                ),
                Math.max(1, deadlineAt - Date.now()),
                controller,
                actionSignal,
              );
              if (confirmation.kind === "aborted") {
                deferredRelease = confirmation.settled;
                break;
              }
              if (confirmation.kind === "timed-out") {
                deferredRelease = confirmation.settled;
                failAction(
                  action,
                  "timed-out",
                  "Hook deadline exceeded during confirmation.",
                );
                break;
              }
              if (!executionIsCurrent()) break;
              if (confirmation.kind === "failed" || !confirmation.value) {
                block ??= { reason: redact(action.reason) };
                appendHistory({
                  type: "blocked",
                  hookId: registration.hook.id,
                  action: action.type,
                  outcome:
                    confirmation.kind === "failed"
                      ? "confirmation-failed"
                      : "confirmation-declined",
                  message: action.reason,
                });
                continue;
              }
              const confirmedSource = source
                ? await sourceIsCurrent(source, executionGeneration)
                : true;
              if (!executionIsCurrent()) break;
              if (!confirmedSource) {
                const reason =
                  source?.reason ?? "Hook source is no longer trusted.";
                block ??= { reason };
                appendHistory({
                  type: "blocked",
                  hookId: registration.hook.id,
                  action: action.type,
                  outcome: "untrusted",
                  message: reason,
                });
                break;
              }
              const commitDecision = sanitizeDecision(
                options.policy.decide(operation, options.actor(), {
                  kind: options.mode(),
                }),
              );
              if (commitDecision.kind !== "allow") {
                appendHistory({
                  type: "blocked",
                  hookId: registration.hook.id,
                  action: action.type,
                  outcome: "denied-after-confirmation",
                  message: commitDecision.reason,
                });
                block ??= { reason: commitDecision.reason };
                continue;
              }
            }
          } else if (action.type === "command") {
            const runner = options.adapters?.command;
            if (!runner) {
              if (
                failAction(
                  action,
                  "adapter-unavailable",
                  "Hook command adapter is unavailable.",
                )
              ) {
                break;
              }
              continue;
            }
            const execution = await beforeDeadline(
              runner.run({
                executable: action.executable,
                args: action.args,
                cwd: invocation.cwd,
                env: safeEnvironment(),
                timeoutMs: Math.max(1, deadlineAt - Date.now()),
                outputCapBytes: registration.hook.outputCapBytes,
                signal: actionSignal,
              }),
              Math.max(1, deadlineAt - Date.now()),
              controller,
              actionSignal,
            );
            if (execution.kind === "aborted") {
              deferredRelease = execution.settled;
              break;
            }
            if (execution.kind === "timed-out") {
              deferredRelease = execution.settled;
              failAction(action, "timed-out", "Hook deadline exceeded.");
              break;
            }
            if (!executionIsCurrent()) break;
            if (execution.kind === "failed") {
              if (
                failAction(
                  action,
                  "adapter-failed",
                  "Hook command adapter failed.",
                )
              ) {
                break;
              }
              continue;
            }
            if (
              execution.value.code !== 0 ||
              execution.value.killed ||
              execution.value.spillLimitExceeded
            ) {
              if (
                failAction(action, "command-failed", "Hook command failed.")
              ) {
                break;
              }
              continue;
            }
            if (execution.value.truncated) {
              completionOutcome = "output-truncated";
              completionMessage = "Command output exceeded its configured cap.";
            }
          } else if (action.type === "http") {
            const adapter = options.adapters?.http;
            if (!adapter) {
              if (
                failAction(
                  action,
                  "adapter-unavailable",
                  "Hook HTTP adapter is unavailable.",
                )
              ) {
                break;
              }
              continue;
            }
            const execution = await beforeDeadline(
              adapter.invoke({
                name: action.name,
                ...(action.input === undefined ? {} : { input: action.input }),
                cwd: invocation.cwd,
                signal: actionSignal,
                deadlineMs: deadlineAt,
                outputCapBytes: registration.hook.outputCapBytes,
              }),
              Math.max(1, deadlineAt - Date.now()),
              controller,
              actionSignal,
            );
            if (execution.kind === "aborted") {
              deferredRelease = execution.settled;
              break;
            }
            if (execution.kind === "timed-out") {
              deferredRelease = execution.settled;
              failAction(action, "timed-out", "Hook deadline exceeded.");
              break;
            }
            if (!executionIsCurrent()) break;
            if (execution.kind === "failed") {
              if (
                failAction(
                  action,
                  "adapter-failed",
                  "Hook HTTP adapter failed.",
                )
              ) {
                break;
              }
              continue;
            }
            if (
              execution.value.output !== undefined &&
              Buffer.byteLength(execution.value.output) >
                registration.hook.outputCapBytes
            ) {
              completionOutcome = "output-truncated";
              completionMessage = "HTTP output exceeded its configured cap.";
            }
          } else if (action.type === "mcp") {
            const adapter = options.adapters?.mcp;
            if (!adapter) {
              if (
                failAction(
                  action,
                  "adapter-unavailable",
                  "Hook MCP adapter is unavailable.",
                )
              ) {
                break;
              }
              continue;
            }
            const execution = await beforeDeadline(
              adapter.invoke({
                name: action.name,
                ...(action.input === undefined ? {} : { input: action.input }),
                cwd: invocation.cwd,
                signal: actionSignal,
                deadlineMs: deadlineAt,
                outputCapBytes: registration.hook.outputCapBytes,
              }),
              Math.max(1, deadlineAt - Date.now()),
              controller,
              actionSignal,
            );
            if (execution.kind === "aborted") {
              deferredRelease = execution.settled;
              break;
            }
            if (execution.kind === "timed-out") {
              deferredRelease = execution.settled;
              failAction(action, "timed-out", "Hook deadline exceeded.");
              break;
            }
            if (!executionIsCurrent()) break;
            if (execution.kind === "failed") {
              if (
                failAction(action, "adapter-failed", "Hook MCP adapter failed.")
              ) {
                break;
              }
              continue;
            }
            if (
              execution.value.output !== undefined &&
              Buffer.byteLength(execution.value.output) >
                registration.hook.outputCapBytes
            ) {
              completionOutcome = "output-truncated";
              completionMessage = "MCP output exceeded its configured cap.";
            }
          } else if (action.type === "agent") {
            const adapter = options.adapters?.agent;
            if (!adapter) {
              if (
                failAction(
                  action,
                  "adapter-unavailable",
                  "Hook agent adapter is unavailable.",
                )
              ) {
                break;
              }
              continue;
            }
            const execution = await beforeDeadline(
              adapter.run({
                name: action.profile,
                prompt: action.prompt,
                cwd: invocation.cwd,
                signal: actionSignal,
                deadlineMs: deadlineAt,
                outputCapBytes: registration.hook.outputCapBytes,
              }),
              Math.max(1, deadlineAt - Date.now()),
              controller,
              actionSignal,
            );
            if (execution.kind === "aborted") {
              deferredRelease = execution.settled;
              break;
            }
            if (execution.kind === "timed-out") {
              deferredRelease = execution.settled;
              failAction(action, "timed-out", "Hook deadline exceeded.");
              break;
            }
            if (!executionIsCurrent()) break;
            if (execution.kind === "failed") {
              if (
                failAction(
                  action,
                  "adapter-failed",
                  "Hook agent adapter failed.",
                )
              ) {
                break;
              }
              continue;
            }
            if (
              execution.value.output !== undefined &&
              Buffer.byteLength(execution.value.output) >
                registration.hook.outputCapBytes
            ) {
              completionOutcome = "output-truncated";
              completionMessage = "Agent output exceeded its configured cap.";
            }
          }
          if (!executionIsCurrent()) break;
          appendHistory({
            type: "action",
            hookId: registration.hook.id,
            action: action.type,
            outcome: completionOutcome,
            message: completionMessage,
          });
        }
      } finally {
        if (deferredRelease) void deferredRelease.finally(release);
        else release();
      }
    }
    const currentResponse =
      !closed && !transitioning && generation === handleGeneration;
    const responseBlock = currentResponse ? block : transitionBlock;
    return {
      ok: true,
      value: {
        context: currentResponse ? context : [],
        ...(responseBlock ? { block: responseBlock } : {}),
      },
    } as const;
  };

  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    transitioning = true;
    closePromise = (async () => {
      await fenceGeneration("Hooks runtime closed.");
      let shutdown: Promise<void> | undefined;
      try {
        shutdown = options.adapters?.command?.shutdown(250);
      } catch {
        shutdown = undefined;
      }
      if (shutdown) await waitAtMost(shutdown, 250);
      const ui = options.adapters?.ui;
      if (ui) {
        for (const key of ownedStatuses) {
          try {
            ui.setStatus(key, undefined);
          } catch {
            // Closing must continue across a failing host UI adapter.
          }
        }
      }
      ownedStatuses.clear();
      configured = [];
      transitioning = false;
    })();
    return closePromise;
  };

  const inspect = (query: HookQuery = {}) => {
    const historyLimit =
      Number.isSafeInteger(query.historyLimit) &&
      Number(query.historyLimit) >= 0
        ? Math.min(Number(query.historyLimit), maxHistoryEntries)
        : maxHistoryEntries;
    return {
      revision,
      hooks: configured.map(({ hook, provenance }) => ({
        id: containsSensitiveKey(hook.id) ? "[REDACTED]" : hook.id,
        event: hook.event,
        actions: actions(hook).map(({ type }) => type),
        source: redact(provenance.source),
      })),
      history: history.slice(-historyLimit).map((entry) => ({ ...entry })),
      diagnostics: diagnostics.map((entry) => ({ ...entry })),
      sources: appliedSources.map((source) => ({
        scope: source.source.scope,
        path: redact(source.source.path),
        status: source.status,
        ...(source.identity ? { digest: source.identity.digest } : {}),
        ...(source.reason ? { reason: source.reason } : {}),
      })),
    };
  };

  return { configure, handle, close, inspect };
}
