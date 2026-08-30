import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  GoalWorkerExecutionCertainty,
  GoalWorkerExecutor,
  GoalWorkerFailure,
  GoalWorkerOutcome,
  GoalWorkerRequest,
} from "../../shared/goal-worker.ts";
import type { ResolvedAgentProfile } from "../../shared/agent-profile.ts";
import { sanitizeSessionText } from "../../platform/src/messaging/index.ts";
import type {
  WorkspaceLease,
  WorkspaceManager,
} from "../../platform/src/workspaces/index.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentSnapshot,
} from "./domain.ts";
import {
  compileClaudeExecutionPolicy,
  compileCodexExecutionPolicy,
  compilePiExecutionPolicy,
} from "./profile-policy.ts";
import { SupervisorPreDispatchError } from "./manager.ts";

const PROMPT_MAX_BYTES = 256 * 1024;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MAX_MS = 60 * 60 * 1_000;
const PATH_MAX_BYTES = 32 * 1024;
const PROJECT_ID_MAX_BYTES = 1_024;
const TOKEN_MAX = 2_000_000_000;
const ATTEMPT_KEY = /^[a-f0-9]{64}$/;
const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const PROFILE_DIGEST = /^[a-f0-9]{64}$/;
const ERROR_MAX_BYTES = 1_000;

function boundUtf8(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text)
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function safeMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return boundUtf8(sanitizeSessionText(message), ERROR_MAX_BYTES);
}

function failure(
  code: GoalWorkerFailure["code"],
  message: string,
  certainty: GoalWorkerExecutionCertainty,
  retryable = false,
  details: Pick<GoalWorkerFailure, "childId" | "workspaceId" | "usage"> = {},
): GoalWorkerOutcome {
  return {
    ok: false,
    error: { code, message, retryable, certainty, ...details },
  };
}

function exactDataFields(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return (
    keys.length === fields.length &&
    keys.every(
      (key) =>
        fields.includes(key) &&
        "value" in descriptors[key]! &&
        descriptors[key]!.enumerable,
    )
  );
}

function requestIsValid(request: GoalWorkerRequest) {
  const fields = [
    "attemptKey",
    "prompt",
    "cwd",
    "projectId",
    "profile",
    "timeoutMs",
    "maxOutputBytes",
    ...(Object.hasOwn(request, "maxTokens") ? ["maxTokens"] : []),
  ];
  return (
    exactDataFields(request, fields) &&
    ATTEMPT_KEY.test(request.attemptKey) &&
    typeof request.prompt === "string" &&
    !request.prompt.includes("\0") &&
    Buffer.byteLength(request.prompt) > 0 &&
    Buffer.byteLength(request.prompt) <= PROMPT_MAX_BYTES &&
    typeof request.cwd === "string" &&
    path.isAbsolute(request.cwd) &&
    !request.cwd.includes("\0") &&
    Buffer.byteLength(request.cwd) <= PATH_MAX_BYTES &&
    typeof request.projectId === "string" &&
    !request.projectId.includes("\0") &&
    Buffer.byteLength(request.projectId) > 0 &&
    Buffer.byteLength(request.projectId) <= PROJECT_ID_MAX_BYTES &&
    Number.isSafeInteger(request.timeoutMs) &&
    request.timeoutMs >= 1_000 &&
    request.timeoutMs <= TIMEOUT_MAX_MS &&
    Number.isSafeInteger(request.maxOutputBytes) &&
    request.maxOutputBytes >= 1 &&
    request.maxOutputBytes <= OUTPUT_MAX_BYTES &&
    (request.maxTokens === undefined ||
      (Number.isSafeInteger(request.maxTokens) &&
        request.maxTokens >= 1 &&
        request.maxTokens <= TOKEN_MAX)) &&
    exactDataFields(request.profile, [
      "name",
      "contentDigest",
      "catalogGeneration",
      "source",
    ]) &&
    PROFILE_NAME.test(request.profile.name) &&
    PROFILE_DIGEST.test(request.profile.contentDigest) &&
    Number.isSafeInteger(request.profile.catalogGeneration) &&
    request.profile.catalogGeneration >= 1 &&
    exactDataFields(request.profile.source, ["scope", "path"]) &&
    ["managed", "user", "project"].includes(request.profile.source.scope) &&
    typeof request.profile.source.path === "string" &&
    request.profile.source.path.length > 0 &&
    request.profile.source.path.length <= PATH_MAX_BYTES &&
    !request.profile.source.path.includes("\0")
  );
}

function sameIdentity(
  profile: ResolvedAgentProfile,
  identity: GoalWorkerRequest["profile"],
) {
  return isDeepStrictEqual(profile.identity, identity);
}

function profileCanRun(profile: ResolvedAgentProfile) {
  if (profile.policy.role !== "goal-worker") return false;
  switch (profile.defaults.backend) {
    case "pi":
      compilePiExecutionPolicy(profile.policy);
      return true;
    case "claude":
      compileClaudeExecutionPolicy(profile.policy);
      return true;
    case "codex":
      return compileCodexExecutionPolicy(profile.policy).ok;
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requestDigest(request: GoalWorkerRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        attemptKey: request.attemptKey,
        prompt: request.prompt,
        cwd: request.cwd,
        projectId: request.projectId,
        profile: request.profile,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        maxTokens: request.maxTokens ?? null,
      }),
    )
    .digest("hex");
}

function abortWait<const T extends string>(signal: AbortSignal, result: T) {
  let listener: (() => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    if (signal.aborted) return resolve(result);
    listener = () => resolve(result);
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
    },
  };
}

function timeoutWait(timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), timeoutMs);
    }),
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

function provenPreDispatchRejection(
  error: unknown,
): GoalWorkerFailure["code"] | undefined {
  if (!(error instanceof SupervisorPreDispatchError)) return undefined;
  if (error.reason === "shutting-down") return "shutting_down";
  if (error.reason === "backend-unavailable") return "backend_unavailable";
  return "run_failed";
}

export interface GoalWorkerProfileResolver {
  generation(): number;
  resolve(name: string): ResolvedAgentProfile | undefined;
}

/**
 * The production Goal Worker view of the Agent Supervisor.
 *
 * Metering is a separate method rather than a field of the snapshot the other
 * methods return, because a cap must be readable while the child runs, long
 * before any settlement exists to inspect.
 */
export interface GoalWorkerSubagentManager {
  spawn(
    backend: BackendName,
    task: SpawnTask,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot>;
  waitFor(ids: readonly string[]): Promise<void>;
  get(id: string): Promise<SubagentSnapshot | undefined>;
  cancel(ids: readonly string[]): Promise<unknown>;
  /** Whole-attempt metering, distinct from snapshot context occupancy. */
  authoritativeTokens?(id: string): Promise<number | undefined>;
}

/**
 * Declare authoritative whole-attempt token metering over a Supervisor manager.
 *
 * The figure is the child's cumulative metered spend, folded by the Supervisor
 * from its backend's own billed totals — never the context occupancy the
 * utilization gauge reads. A snapshot that carries no metered total yields
 * `undefined`, which the executor treats as "unproven" and refuses to enforce
 * or report a cap from, rather than as zero.
 */
export function withSupervisorMetering(
  base: GoalWorkerSubagentManager,
  read: (id: string) => SubagentSnapshot | undefined,
): GoalWorkerSubagentManager {
  return {
    spawn: (backend, task, signal) => base.spawn(backend, task, signal),
    waitFor: (ids) => base.waitFor(ids),
    get: (id) => base.get(id),
    cancel: (ids) => base.cancel(ids),
    async authoritativeTokens(id) {
      const tokens = read(id)?.metered.tokens;
      return typeof tokens === "number" &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0
        ? tokens
        : undefined;
    },
  };
}

/**
 * Deterministic ceilings for process-lifetime attempt retention.
 *
 * The executor is the only in-process record of what it dispatched, so an
 * attempt key cannot simply be forgotten the moment it settles. Retention is
 * therefore layered: recent keys keep a small inspection record, far fewer keep
 * a replayable outcome, and no key keeps an artifact body once its caller has
 * been handed the outcome.
 */
export const goalWorkerRetentionLimits = {
  /** Settled attempt keys remembered at all; oldest settlement evicted first. */
  settledEntries: 256,
  /** Age ceiling for a settled attempt key, measured at access time. */
  settledAgeMs: 30 * 60_000,
  /** Settled attempts allowed to keep a replayable outcome. */
  retainedOutcomes: 32,
  /** Total retained outcome payload across every settled attempt. */
  retainedBytes: 64 * 1024,
  /** Retained outcome payload allowed for one settled attempt. */
  entryBytes: 8 * 1024,
} as const;

interface LiveAttempt {
  readonly kind: "live";
  readonly digest: string;
  state: "preparing" | "dispatching" | "running";
  childId?: string;
  workspaceId?: string;
  readonly promise: Promise<GoalWorkerOutcome>;
}

/**
 * Post-execution inspection state. `settled` proved an outcome; `sealed` lost
 * the executor while the attempt was still ambiguous. Neither may ever be
 * downgraded into a certified `not-started`.
 */
interface RetainedAttempt {
  readonly kind: "retained";
  readonly digest: string;
  readonly status: "settled" | "sealed";
  certainty: GoalWorkerExecutionCertainty;
  childId?: string;
  workspaceId?: string;
  retainedAt: number;
  outcome?: GoalWorkerOutcome;
  bytes: number;
}

type AttemptRecord = LiveAttempt | RetainedAttempt;

export interface GoalWorkerRetentionSummary {
  readonly live: number;
  readonly settled: number;
  readonly retainedOutcomes: number;
  readonly retainedBytes: number;
}

/**
 * Host-side executor. Beyond the shared port it owns its own process lifetime:
 * bounded retention of attempt state and a shutdown that releases it.
 */
export interface GoalWorkerHostExecutor extends GoalWorkerExecutor {
  retention(): GoalWorkerRetentionSummary;
  shutdown(): void;
}

export interface GoalWorkerExecutorOptions {
  readonly profiles: () => GoalWorkerProfileResolver | undefined;
  readonly manager: () => Promise<GoalWorkerSubagentManager>;
  readonly parent: (request: GoalWorkerRequest) => ParentContext;
  readonly workspaces?: () =>
    | Pick<WorkspaceManager, "create" | "lease" | "renew" | "disposition">
    | undefined;
  readonly sessionId?: () => string;
  readonly generation: () => number;
  readonly lifecycleSignal: () => AbortSignal;
  /** Injected retention clock. Defaults to wall clock. */
  readonly now?: () => number;
  /** How often a token-capped Attempt re-reads authoritative Supervisor usage. */
  readonly usagePollMs?: number;
}

export function createGoalWorkerExecutor(options: GoalWorkerExecutorOptions) {
  const attempts = new Map<string, AttemptRecord>();
  let sealed = false;

  const clock = () => {
    const now = options.now?.() ?? Date.now();
    return Number.isFinite(now) ? now : Date.now();
  };

  const liveCertainty = (record: LiveAttempt): GoalWorkerExecutionCertainty =>
    record.state === "preparing"
      ? "not-started"
      : record.state === "dispatching"
        ? "unknown"
        : "started";

  const knownCertainty = (record: AttemptRecord) =>
    record.kind === "live" ? liveCertainty(record) : record.certainty;

  /** Knowledge only ever moves away from `not-started`, never back to it. */
  const strongest = (
    previous: GoalWorkerExecutionCertainty,
    next: GoalWorkerExecutionCertainty,
  ) => (next === "not-started" && previous !== "not-started" ? previous : next);

  const identifiers = (record: AttemptRecord) => ({
    ...(record.childId ? { childId: record.childId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
  });

  const outcomeBytes = (outcome: GoalWorkerOutcome) =>
    outcome.ok
      ? outcome.value.artifact.size
      : Buffer.byteLength(outcome.error.message);

  const dropOutcome = (entry: RetainedAttempt) => {
    entry.outcome = undefined;
    entry.bytes = 0;
  };

  /**
   * Access-driven retention sweep. Timers would keep the host process alive for
   * state that only matters when someone asks about it, so every bound is
   * enforced on the next run, inspect, or settlement instead.
   */
  const sweep = () => {
    const now = clock();
    let retainedEntries = 0;
    for (const [key, entry] of attempts) {
      if (entry.kind !== "retained") continue;
      if (now - entry.retainedAt > goalWorkerRetentionLimits.settledAgeMs) {
        attempts.delete(key);
        continue;
      }
      retainedEntries++;
    }
    let excess = retainedEntries - goalWorkerRetentionLimits.settledEntries;
    if (excess > 0) {
      for (const [key, entry] of attempts) {
        if (excess <= 0) break;
        if (entry.kind !== "retained") continue;
        attempts.delete(key);
        excess--;
      }
    }
    let outcomes = 0;
    let bytes = 0;
    for (const entry of attempts.values()) {
      if (entry.kind !== "retained" || !entry.outcome) continue;
      outcomes++;
      bytes += entry.bytes;
    }
    for (const entry of attempts.values()) {
      if (
        outcomes <= goalWorkerRetentionLimits.retainedOutcomes &&
        bytes <= goalWorkerRetentionLimits.retainedBytes
      ) {
        break;
      }
      if (entry.kind !== "retained" || !entry.outcome) continue;
      outcomes--;
      bytes -= entry.bytes;
      dropOutcome(entry);
    }
  };

  /**
   * Shutdown drops every payload the process was holding while keeping just
   * enough to refuse redispatch of work this executor may already have started.
   */
  const seal = () => {
    if (sealed) return;
    sealed = true;
    const now = clock();
    for (const [key, entry] of attempts) {
      if (entry.kind === "retained") {
        dropOutcome(entry);
        continue;
      }
      if (entry.state === "preparing") {
        attempts.delete(key);
        continue;
      }
      attempts.set(key, {
        kind: "retained",
        digest: entry.digest,
        status: "sealed",
        certainty: liveCertainty(entry),
        ...identifiers(entry),
        retainedAt: now,
        bytes: 0,
      });
    }
  };

  const ensureSealed = () => {
    if (!sealed && options.lifecycleSignal().aborted) seal();
  };

  const settleAttempt = (
    attemptKey: string,
    record: LiveAttempt,
    outcome: GoalWorkerOutcome,
  ) => {
    ensureSealed();
    const certainty = strongest(
      liveCertainty(record),
      outcome.ok ? "started" : outcome.error.certainty,
    );
    const childId =
      record.childId ??
      (outcome.ok ? outcome.value.execution.childId : outcome.error.childId);
    const workspaceId =
      record.workspaceId ??
      (outcome.ok ? outcome.value.workspaceId : outcome.error.workspaceId);
    const existing = attempts.get(attemptKey);
    if (sealed) {
      // A sealed executor accepts no new retention, only sharper knowledge
      // about attempts it already owned.
      if (existing?.kind === "retained") {
        existing.certainty = strongest(existing.certainty, certainty);
        if (childId) existing.childId = childId;
        if (workspaceId) existing.workspaceId = workspaceId;
        dropOutcome(existing);
      } else if (existing === record) {
        attempts.delete(attemptKey);
      }
      return;
    }
    if (existing !== record) return;
    const bytes = outcomeBytes(outcome);
    const retain = bytes <= goalWorkerRetentionLimits.entryBytes;
    attempts.delete(attemptKey);
    attempts.set(attemptKey, {
      kind: "retained",
      digest: record.digest,
      status: "settled",
      certainty,
      ...(childId ? { childId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      retainedAt: clock(),
      ...(retain ? { outcome } : {}),
      bytes: retain ? bytes : 0,
    });
    sweep();
  };

  /**
   * Enforce a token cap while the child is still running.
   *
   * Settlement-time enforcement only refuses to report a completion that
   * already burned the tokens. Polling stops the run at the cap instead.
   * Only authoritative whole-attempt metering can drive this guard. Snapshot
   * context occupancy is not a usage meter and never substitutes for one.
   *
   * The cap is therefore a stop signal, not a hard ceiling: a meter only moves
   * when a request completes, so a breach is observed after the request that
   * caused it was already billed. An Attempt can exceed `cap` by at most the
   * tokens of one in-flight request, bounded by the child's context window,
   * and shrinking the poll period cannot remove that overshoot. The Goal
   * budget absorbs it by reserving the node's full worst case up front rather
   * than by trusting the cap to be exact.
   */
  const watchTokenCap = (
    manager: GoalWorkerSubagentManager,
    childId: string,
    cap: number,
    onBreach: (tokens: number) => void,
  ) => {
    const meter = manager.authoritativeTokens;
    if (!meter) return () => {};
    const read = () => meter.call(manager, childId);
    const period = Math.min(Math.max(options.usagePollMs ?? 5_000, 1), 60_000);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        void tick();
      }, period);
      timer.unref?.();
    };
    const tick = async () => {
      if (stopped) return;
      let tokens: number | undefined;
      try {
        tokens = await read();
      } catch {
        tokens = undefined;
      }
      if (stopped) return;
      if (
        typeof tokens === "number" &&
        Number.isSafeInteger(tokens) &&
        tokens >= cap
      ) {
        stopped = true;
        onBreach(tokens);
        await manager.cancel([childId]).catch(() => undefined);
        return;
      }
      arm();
    };
    arm();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
  };

  const resolveProfile = (request: GoalWorkerRequest) => {
    const profiles = options.profiles();
    if (
      !profiles ||
      profiles.generation() !== request.profile.catalogGeneration
    ) {
      return undefined;
    }
    const resolved = profiles.resolve(request.profile.name);
    if (!resolved || !sameIdentity(resolved, request.profile)) return undefined;
    const immutable = deepFreeze(structuredClone(resolved));
    return profileCanRun(immutable) ? immutable : undefined;
  };

  const execute = async (
    request: GoalWorkerRequest,
    profile: ResolvedAgentProfile,
    record: LiveAttempt,
    signal: AbortSignal | undefined,
  ) => {
    const generation = options.generation();
    const lifecycleSignal = options.lifecycleSignal();
    const stale = () =>
      lifecycleSignal.aborted || options.generation() !== generation;
    const operation = new AbortController();
    const caller = abortWait(
      signal ?? new AbortController().signal,
      "cancelled",
    );
    const lifecycle = abortWait(lifecycleSignal, "shutting_down");
    const timeout = timeoutWait(request.timeoutMs);
    let interruptionReason:
      "cancelled" | "shutting_down" | "timed_out" | "token_bounded" | undefined;
    // A token cap is enforced while the child runs, not only at settlement:
    // reaching it interrupts this Attempt exactly like a timeout would.
    let capBreach: { readonly tokens: number } | undefined;
    let stopUsageWatch: (() => void) | undefined;
    let tripCap: (() => void) | undefined;
    const capacity = {
      promise: new Promise<"token_bounded">((resolve) => {
        tripCap = () => resolve("token_bounded");
      }),
    };
    const interruption = Promise.race([
      caller.promise,
      lifecycle.promise,
      timeout.promise,
      capacity.promise,
    ]).then((reason) => {
      interruptionReason = reason;
      operation.abort();
      return reason;
    });
    let activeLease: WorkspaceLease | undefined;
    let workspaceManager:
      | Pick<WorkspaceManager, "create" | "lease" | "renew" | "disposition">
      | undefined;
    let workspaceLifecycle = Promise.resolve();
    const workspaceId = () => activeLease?.workspaceId ?? record.workspaceId;
    const certainty = () => liveCertainty(record);
    const interrupted = (reason: typeof interruptionReason) => {
      // A cap breach is not ambiguity: the child provably started, the host
      // stopped it on purpose, and the Attempt is a definite failure.
      if (reason === "token_bounded" && capBreach) {
        return failure(
          "token_bounded",
          `Goal Worker reached its ${request.maxTokens} token cap at ${capBreach.tokens} metered tokens and was cancelled.`,
          "started",
          false,
          {
            ...(record.childId ? { childId: record.childId } : {}),
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
            usage: {
              tokens: capBreach.tokens,
              authoritative: true as const,
              source: "agent-supervisor" as const,
            },
          },
        );
      }
      const currentCertainty = certainty();
      const code =
        currentCertainty === "unknown"
          ? "execution_unknown"
          : reason === "timed_out"
            ? "timed_out"
            : reason === "shutting_down"
              ? "shutting_down"
              : "cancelled";
      const label =
        reason === "timed_out"
          ? `timed out after ${request.timeoutMs} ms`
          : reason === "shutting_down"
            ? "is shutting down"
            : "was cancelled";
      return failure(
        code,
        currentCertainty === "unknown"
          ? "Goal Worker dispatch outcome is unknown; automatic redispatch is unsafe."
          : `Goal Worker execution ${label}.`,
        currentCertainty,
        currentCertainty === "not-started",
        {
          ...(record.childId ? { childId: record.childId } : {}),
          ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
        },
      );
    };
    const binding = () =>
      activeLease
        ? {
            workspaceId: activeLease.workspaceId,
            owner: activeLease.owner,
            fence: activeLease.fence,
            expiresAt: activeLease.expiresAt,
            projectId: activeLease.snapshot.projectId,
            projectRoot: activeLease.snapshot.projectRoot,
            path: activeLease.snapshot.path,
            state: "leased" as const,
            role: "goal-worker" as const,
            profile: profile.identity,
            projectTrusted: true as const,
          }
        : undefined;
    const preserve = async () => {
      workspaceLifecycle = workspaceLifecycle.then(async () => {
        if (!activeLease || !workspaceManager) return;
        const result = await workspaceManager.disposition(activeLease, {
          kind: "preserve",
        });
        if (!result.ok) throw new Error(result.error.message);
        record.workspaceId = activeLease.workspaceId;
        activeLease = undefined;
      });
      await workspaceLifecycle;
    };

    const runCore = async (): Promise<GoalWorkerOutcome> => {
      if (stale()) {
        return failure(
          "shutting_down",
          "Goal Worker executor is shutting down.",
          "not-started",
          true,
        );
      }
      if (signal?.aborted) {
        return failure(
          "cancelled",
          "Goal Worker execution was cancelled.",
          "not-started",
          true,
        );
      }
      const managerResult = await Promise.race([
        options
          .manager()
          .then((manager) => ({ kind: "ready" as const, manager })),
        interruption.then((reason) => ({
          kind: "interrupted" as const,
          reason,
        })),
      ]);
      if (managerResult.kind === "interrupted") {
        return interrupted(managerResult.reason);
      }
      const manager = managerResult.manager;
      if (request.maxTokens !== undefined && !manager.authoritativeTokens) {
        return failure(
          "metering_unavailable",
          "A finite Goal Worker token cap requires authoritative whole-attempt metering.",
          "not-started",
          false,
        );
      }
      if (profile.policy.workspace === "isolated") {
        workspaceManager = options.workspaces?.();
        const sessionId = options.sessionId?.();
        if (!workspaceManager || !sessionId) {
          return failure(
            "profile_denied",
            "Isolated Goal Worker profile requires Guarded Workspace authority.",
            "not-started",
          );
        }
        const creating = workspaceManager.create({
          base: { kind: "current-head" },
        });
        const createdResult = await Promise.race([
          creating.then((result) => ({ kind: "created" as const, result })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (createdResult.kind === "interrupted") {
          return interrupted(createdResult.reason);
        }
        const created = createdResult.result;
        if (!created.ok) {
          return failure(
            "run_failed",
            safeMessage(created.error.message),
            "not-started",
            created.error.retryable,
          );
        }
        record.workspaceId = created.value.workspaceId;
        const leasing = workspaceManager.lease({
          workspaceId: created.value.workspaceId,
          owner: {
            sessionId,
            agentId: `goal-${request.attemptKey}`,
          },
          ttlMs: Math.min(
            Math.max(request.timeoutMs + 120_000, 600_000),
            86_400_000,
          ),
          role: "goal-worker",
          profile: profile.identity.name,
          profileDigest: profile.identity.contentDigest,
          profileGeneration: profile.identity.catalogGeneration,
          profileScope: profile.identity.source.scope,
          profilePath: profile.identity.source.path,
        });
        const leasedResult = await Promise.race([
          leasing.then((result) => ({ kind: "leased" as const, result })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (leasedResult.kind === "interrupted") {
          void leasing
            .then(async (lateLease) => {
              if (!lateLease.ok || !workspaceManager) return;
              await workspaceManager.disposition(lateLease.value, {
                kind: "preserve",
              });
            })
            .catch(() => undefined);
          return interrupted(leasedResult.reason);
        }
        const leased = leasedResult.result;
        if (!leased.ok) {
          return failure(
            "run_failed",
            safeMessage(leased.error.message),
            "not-started",
            leased.error.retryable,
            { workspaceId: record.workspaceId },
          );
        }
        activeLease = leased.value;
        if (
          activeLease.snapshot.projectId !== request.projectId ||
          activeLease.snapshot.path === request.cwd ||
          !path.isAbsolute(activeLease.snapshot.path)
        ) {
          return failure(
            "profile_denied",
            "Guarded Workspace identity does not match Goal project authority.",
            "not-started",
            false,
            { workspaceId: record.workspaceId },
          );
        }
      }
      let dispatchProfile: ResolvedAgentProfile | undefined;
      try {
        dispatchProfile = resolveProfile(request);
      } catch {
        dispatchProfile = undefined;
      }
      if (!dispatchProfile) {
        return failure(
          "profile_denied",
          "Goal Worker profile pin changed before dispatch.",
          "not-started",
          false,
          {
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      const guardedWorkspace = binding();
      const task = {
        origin: "model",
        prompt: request.prompt,
        title: `Goal attempt ${request.attemptKey}`,
        cwd: guardedWorkspace?.path ?? request.cwd,
        model: profile.defaults.model,
        reasoningEffort: profile.defaults.effort,
        profile: profile.identity,
        execution: profile.policy,
        ...(guardedWorkspace && workspaceManager
          ? {
              workspace: guardedWorkspace,
              workspaceControl: {
                async renew() {
                  let renewedBinding = guardedWorkspace;
                  workspaceLifecycle = workspaceLifecycle.then(async () => {
                    if (!activeLease || !workspaceManager) {
                      throw new Error("Workspace was already preserved.");
                    }
                    const renewed = await workspaceManager.renew(
                      activeLease,
                      Math.min(
                        Math.max(request.timeoutMs + 120_000, 600_000),
                        86_400_000,
                      ),
                    );
                    if (!renewed.ok) throw new Error(renewed.error.message);
                    activeLease = renewed.value;
                    renewedBinding = binding()!;
                  });
                  await workspaceLifecycle;
                  return renewedBinding;
                },
                preserve,
              },
            }
          : {}),
        parent: {
          ...options.parent(request),
          ...(guardedWorkspace ? { projectTrusted: true } : {}),
        },
      } satisfies SpawnTask;
      record.state = "dispatching";
      const spawn = manager.spawn(
        profile.defaults.backend,
        task,
        operation.signal,
      );
      const spawnResult = await Promise.race([
        spawn.then(
          (started) => ({ kind: "started" as const, started }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        interruption.then((reason) => ({
          kind: "interrupted" as const,
          reason,
        })),
      ]);
      if (spawnResult.kind === "interrupted") {
        void spawn
          .then(async (started) => {
            record.childId = started.id;
            await manager.cancel([started.id]).catch(() => undefined);
          })
          .catch(() => undefined);
        return interrupted(spawnResult.reason);
      }
      if (spawnResult.kind === "rejected") {
        const proven = provenPreDispatchRejection(spawnResult.error);
        if (!proven) {
          return failure(
            "execution_unknown",
            "Goal Worker dispatch outcome is unknown; automatic redispatch is unsafe.",
            "unknown",
            false,
            {
              ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
            },
          );
        }
        // The Supervisor refused before it could create anything, so this
        // Attempt provably never started and a backoff retry is safe. The live
        // record steps back to `preparing` so inspection says the same thing.
        record.state = "preparing";
        return failure(
          proven,
          safeMessage(spawnResult.error),
          "not-started",
          true,
          {
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      const started = spawnResult.started;
      record.childId = started.id;
      record.state = "running";
      if (request.maxTokens !== undefined) {
        stopUsageWatch = watchTokenCap(
          manager,
          started.id,
          request.maxTokens,
          (tokens) => {
            capBreach = { tokens };
            tripCap?.();
          },
        );
      }
      if (stale()) {
        await manager.cancel([started.id]).catch(() => undefined);
        return failure(
          "execution_unknown",
          "Goal Worker shut down after dispatch; automatic redispatch is unsafe.",
          "unknown",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      const wait = manager.waitFor([started.id]);
      const waitResult = await Promise.race([
        wait.then(() => ({ kind: "settled" as const })),
        interruption.then((reason) => ({
          kind: "interrupted" as const,
          reason,
        })),
      ]);
      if (waitResult.kind === "interrupted" || stale()) {
        await manager.cancel([started.id]).catch(() => undefined);
        if (capBreach) return interrupted("token_bounded");
        return failure(
          "execution_unknown",
          "Goal Worker was interrupted after dispatch; automatic redispatch is unsafe.",
          "unknown",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      const settlementResult = await Promise.race([
        manager
          .get(started.id)
          .then((settled) => ({ kind: "settled" as const, settled })),
        interruption.then((reason) => ({
          kind: "interrupted" as const,
          reason,
        })),
      ]);
      if (settlementResult.kind === "interrupted" || stale()) {
        if (capBreach) return interrupted("token_bounded");
        return failure(
          "execution_unknown",
          "Goal Worker settlement was fenced after dispatch; automatic redispatch is unsafe.",
          "unknown",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      const settled = settlementResult.settled;
      if (!settled) {
        return failure(
          "execution_unknown",
          "Goal Worker settlement cannot be proven; automatic redispatch is unsafe.",
          "unknown",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      if (settled.status !== "done") {
        return failure(
          "run_failed",
          safeMessage(settled.errorText ?? "Goal Worker child failed."),
          "started",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      let usage: GoalWorkerFailure["usage"];
      if (manager.authoritativeTokens) {
        try {
          const usageResult = await Promise.race([
            manager
              .authoritativeTokens(started.id)
              .then((tokens) => ({ kind: "usage" as const, tokens })),
            interruption.then((reason) => ({
              kind: "interrupted" as const,
              reason,
            })),
          ]);
          if (usageResult.kind === "interrupted" || stale()) {
            if (capBreach) return interrupted("token_bounded");
            return failure(
              "execution_unknown",
              "Goal Worker usage settlement was fenced after dispatch; automatic redispatch is unsafe.",
              "unknown",
              false,
              {
                childId: started.id,
                ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
              },
            );
          }
          const tokens = usageResult.tokens;
          if (
            Number.isSafeInteger(tokens) &&
            tokens !== undefined &&
            tokens >= 0
          ) {
            usage = {
              tokens,
              authoritative: true,
              source: "agent-supervisor",
            };
          }
        } catch {
          usage = undefined;
        }
      }
      // An executor that declares authoritative metering must deliver it. An
      // uncapped executor that never claimed metering reports no usage at all.
      if (
        request.maxTokens !== undefined &&
        manager.authoritativeTokens &&
        !usage
      ) {
        return failure(
          "metering_unavailable",
          "Authoritative Goal Worker token usage was unavailable at settlement.",
          "started",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          },
        );
      }
      if (
        usage &&
        request.maxTokens !== undefined &&
        usage.tokens > request.maxTokens
      ) {
        return failure(
          "token_bounded",
          `Goal Worker used ${usage.tokens} tokens, exceeding cap ${request.maxTokens}.`,
          "started",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
            usage,
          },
        );
      }
      const output = sanitizeSessionText(settled.finalText);
      const outputBytes = Buffer.byteLength(output);
      if (outputBytes > request.maxOutputBytes) {
        return failure(
          "output_bounded",
          `Goal Worker output exceeded ${request.maxOutputBytes} bytes.`,
          "started",
          false,
          {
            childId: started.id,
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
            ...(usage ? { usage } : {}),
          },
        );
      }
      return {
        ok: true,
        value: {
          status: "completed",
          artifact: {
            body: output,
            filename: "goal-worker-output.txt",
            mediaType: "text/plain; charset=utf-8",
            size: outputBytes,
            sha256: createHash("sha256").update(output).digest("hex"),
            metadata: {
              kind: "goal-worker-output",
              attemptKey: request.attemptKey,
              trust: "worker-reported",
            },
          },
          execution: {
            attemptKey: request.attemptKey,
            childId: started.id,
            certainty: "started",
          },
          ...(usage ? { usage } : {}),
          ...(settled.meta.nativeSessionId
            ? {
                sessionId: boundUtf8(
                  sanitizeSessionText(settled.meta.nativeSessionId),
                  256,
                ),
              }
            : {}),
          ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
        },
      };
    };

    let outcome: GoalWorkerOutcome;
    try {
      outcome = await runCore();
    } catch (error) {
      const proven = provenPreDispatchRejection(error);
      if (proven) record.state = "preparing";
      outcome = proven
        ? failure(proven, safeMessage(error), "not-started", true, {
            ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          })
        : failure(
            "execution_unknown",
            "Goal Worker dispatch outcome is unknown; automatic redispatch is unsafe.",
            "unknown",
            false,
            {
              ...(record.childId ? { childId: record.childId } : {}),
              ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
            },
          );
    }
    try {
      await preserve();
    } catch (error) {
      outcome = failure(
        "run_failed",
        `Goal Worker workspace preservation failed: ${safeMessage(error)}`,
        outcome.ok ? "started" : outcome.error.certainty,
        false,
        {
          ...(record.childId ? { childId: record.childId } : {}),
          ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
          ...(!outcome.ok && outcome.error.usage
            ? { usage: outcome.error.usage }
            : {}),
        },
      );
    } finally {
      caller.dispose();
      lifecycle.dispose();
      timeout.dispose();
      stopUsageWatch?.();
    }
    return outcome;
  };

  const executor = {
    run(request: GoalWorkerRequest, signal?: AbortSignal) {
      ensureSealed();
      sweep();
      if (options.lifecycleSignal().aborted) {
        const attemptKey =
          typeof request === "object" &&
          request !== null &&
          typeof request.attemptKey === "string"
            ? request.attemptKey
            : undefined;
        const existing = attemptKey ? attempts.get(attemptKey) : undefined;
        const certainty = existing ? knownCertainty(existing) : undefined;
        // Shutdown must never certify an attempt this executor already took on
        // as never-started; that would license a duplicate dispatch elsewhere.
        return Promise.resolve(
          existing && certainty && certainty !== "not-started"
            ? failure(
                "execution_unknown",
                "Goal Worker shut down with an unproven attempt; automatic redispatch is unsafe.",
                certainty,
                false,
                identifiers(existing),
              )
            : failure(
                "shutting_down",
                "Goal Worker executor is shutting down.",
                "not-started",
                true,
              ),
        );
      }
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        return Promise.resolve(
          failure(
            "invalid_request",
            "Goal Worker request is outside host safety bounds.",
            "not-started",
          ),
        );
      }
      if (!requestIsValid(request)) {
        return Promise.resolve(
          failure(
            "invalid_request",
            "Goal Worker request is outside host safety bounds.",
            "not-started",
          ),
        );
      }
      request = structuredClone(request);
      let profile: ResolvedAgentProfile | undefined;
      try {
        profile = resolveProfile(request);
      } catch {
        profile = undefined;
      }
      if (!profile) {
        return Promise.resolve(
          failure(
            "profile_denied",
            "Goal Worker profile pin or policy cannot be enforced.",
            "not-started",
          ),
        );
      }
      const digest = requestDigest(request);
      const attemptKey = request.attemptKey;
      const existing = attempts.get(attemptKey);
      if (existing) {
        if (existing.digest !== digest) {
          return Promise.resolve(
            failure(
              "attempt_conflict",
              "Goal Worker attempt key was reused with different immutable input.",
              knownCertainty(existing),
              false,
              identifiers(existing),
            ),
          );
        }
        // Same key, same input: adopt the live attempt or replay its settlement
        // rather than ever running the same bound Attempt twice.
        if (existing.kind === "live") return existing.promise;
        if (existing.outcome) return Promise.resolve(existing.outcome);
        return Promise.resolve(
          existing.certainty === "not-started"
            ? failure(
                "run_failed",
                "Goal Worker attempt settled without dispatch and its outcome is no longer retained.",
                "not-started",
                true,
                identifiers(existing),
              )
            : failure(
                "execution_unknown",
                "Goal Worker outcome is no longer retained; automatic redispatch is unsafe.",
                existing.certainty,
                false,
                identifiers(existing),
              ),
        );
      }
      let settle!: (outcome: GoalWorkerOutcome) => void;
      const settlement = new Promise<GoalWorkerOutcome>((resolve) => {
        settle = resolve;
      });
      const delivered = settlement.then((outcome) => {
        // The caller now owns the outcome, so the executor drops the artifact
        // body it was holding and keeps only inspection state.
        const entry = attempts.get(attemptKey);
        if (entry?.kind === "retained" && entry.outcome?.ok) dropOutcome(entry);
        return outcome;
      });
      const record: LiveAttempt = {
        kind: "live",
        digest,
        state: "preparing",
        promise: delivered,
      };
      attempts.set(attemptKey, record);
      void execute(request, profile, record, signal).then((outcome) => {
        settleAttempt(attemptKey, record, outcome);
        settle(outcome);
      });
      return delivered;
    },

    async inspect(attemptKey: string) {
      ensureSealed();
      sweep();
      if (typeof attemptKey !== "string" || !ATTEMPT_KEY.test(attemptKey)) {
        return {
          attemptKey:
            typeof attemptKey === "string"
              ? boundUtf8(attemptKey, 256)
              : "invalid-attempt-key",
          state: "unknown",
          certainty: "unknown",
        } as const;
      }
      const record = attempts.get(attemptKey);
      if (!record) {
        // Supervisor has no durable attempt-key lookup, and retention is
        // bounded. Absence cannot prove that no external work was dispatched.
        return { attemptKey, state: "unknown", certainty: "unknown" } as const;
      }
      if (record.kind === "live") {
        if (record.state === "preparing") {
          return {
            attemptKey,
            state: "not-started",
            certainty: "not-started",
          } as const;
        }
        if (record.state === "running" && record.childId) {
          return {
            attemptKey,
            state: "running",
            certainty: "started",
            childId: record.childId,
            ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
          } as const;
        }
        return { attemptKey, state: "unknown", certainty: "unknown" } as const;
      }
      if (record.status === "sealed") {
        // The executor was torn down before this attempt could be proven, so
        // no settlement may be reported for it.
        return { attemptKey, state: "unknown", certainty: "unknown" } as const;
      }
      return {
        attemptKey,
        state: "settled",
        certainty: record.certainty,
        outcome:
          record.outcome ??
          failure(
            "execution_unknown",
            "Goal Worker settlement is no longer retained; automatic redispatch is unsafe.",
            record.certainty,
            false,
            identifiers(record),
          ),
      } as const;
    },

    /** Retention diagnostics for lifecycle tests and host observability. */
    retention() {
      sweep();
      let live = 0;
      let settled = 0;
      let retainedOutcomes = 0;
      let retainedBytes = 0;
      for (const entry of attempts.values()) {
        if (entry.kind === "live") {
          live++;
          continue;
        }
        settled++;
        if (!entry.outcome) continue;
        retainedOutcomes++;
        retainedBytes += entry.bytes;
      }
      return { live, settled, retainedOutcomes, retainedBytes };
    },

    /**
     * Release process-lifetime state at session shutdown. Idempotent, and it
     * never converts a dispatched attempt into a redispatchable one.
     */
    shutdown() {
      seal();
    },
  } satisfies GoalWorkerHostExecutor;
  return executor;
}
