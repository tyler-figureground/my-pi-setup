import type { ResolvedProfileIdentity } from "./agent-profile.ts";

export interface GoalWorkerRequest {
  /** Durable idempotency key owned by the Goal Attempt. */
  readonly attemptKey: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly projectId: string;
  /** Immutable host pin. Executor resolves current profile material itself. */
  readonly profile: ResolvedProfileIdentity;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Requires authoritative Supervisor metering. Omit when no token cap exists. */
  readonly maxTokens?: number;
}

export type GoalWorkerExecutionCertainty =
  "not-started" | "started" | "unknown";

export interface GoalWorkerArtifactCandidate {
  readonly body: string;
  readonly filename: "goal-worker-output.txt";
  readonly mediaType: "text/plain; charset=utf-8";
  readonly size: number;
  readonly sha256: string;
  readonly metadata: {
    readonly kind: "goal-worker-output";
    readonly attemptKey: string;
    readonly trust: "worker-reported";
  };
}

export interface GoalWorkerUsage {
  readonly tokens: number;
  readonly authoritative: true;
  readonly source: "agent-supervisor";
}

export interface GoalWorkerCompletion {
  readonly status: "completed";
  readonly artifact: GoalWorkerArtifactCandidate;
  readonly execution: {
    readonly attemptKey: string;
    readonly childId: string;
    readonly certainty: "started";
  };
  readonly usage?: GoalWorkerUsage;
  readonly sessionId?: string;
  readonly workspaceId?: string;
}

export interface GoalWorkerFailure {
  readonly code:
    | "invalid_request"
    | "attempt_conflict"
    | "profile_denied"
    | "backend_unavailable"
    | "metering_unavailable"
    | "timed_out"
    | "cancelled"
    | "run_failed"
    | "output_bounded"
    | "token_bounded"
    | "execution_unknown"
    | "shutting_down";
  readonly message: string;
  readonly retryable: boolean;
  readonly certainty: GoalWorkerExecutionCertainty;
  readonly childId?: string;
  readonly workspaceId?: string;
  readonly usage?: GoalWorkerUsage;
}

export type GoalWorkerOutcome =
  | { readonly ok: true; readonly value: GoalWorkerCompletion }
  | { readonly ok: false; readonly error: GoalWorkerFailure };

export type GoalWorkerInspection =
  | {
      readonly attemptKey: string;
      readonly state: "not-started";
      readonly certainty: "not-started";
    }
  | {
      readonly attemptKey: string;
      readonly state: "running";
      readonly certainty: "started";
      readonly childId: string;
      readonly workspaceId?: string;
    }
  | {
      readonly attemptKey: string;
      readonly state: "settled";
      readonly certainty: GoalWorkerExecutionCertainty;
      readonly outcome: GoalWorkerOutcome;
    }
  | {
      readonly attemptKey: string;
      readonly state: "unknown";
      readonly certainty: "unknown";
    };

/**
 * Host-only execution seam for one fully bound Goal Attempt.
 *
 * Request carries an immutable profile pin, never policy material or runtime
 * authority. Callers must inspect rather than redispatch after an ambiguous
 * outcome. An absent attempt is `unknown` unless executor can certify it never
 * started.
 */
export interface GoalWorkerExecutor {
  run(
    request: GoalWorkerRequest,
    signal?: AbortSignal,
  ): Promise<GoalWorkerOutcome>;
  inspect(attemptKey: string): Promise<GoalWorkerInspection>;
}

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface AvailabilityQuery {
  readonly kind: "query";
  readonly version: 1;
  claimed: boolean;
}

interface RunInvocation {
  readonly kind: "run";
  readonly version: 1;
  readonly request: GoalWorkerRequest;
  readonly signal?: AbortSignal;
  claimed: boolean;
  resolve(value: GoalWorkerOutcome): void;
  reject(error: unknown): void;
}

interface InspectInvocation {
  readonly kind: "inspect";
  readonly version: 1;
  readonly attemptKey: string;
  claimed: boolean;
  resolve(value: GoalWorkerInspection): void;
  reject(error: unknown): void;
}

type Invocation = AvailabilityQuery | RunInvocation | InspectInvocation;

const CHANNEL = "platform:goal-worker-executor:private";
const bindings = new WeakMap<
  object,
  { readonly executor: GoalWorkerExecutor; readonly unlisten: () => void }
>();

function isEventBusLike(value: object): value is object & EventBusLike {
  return (
    "emit" in value &&
    typeof value.emit === "function" &&
    "on" in value &&
    typeof value.on === "function"
  );
}

function hasExecutor(eventBus: EventBusLike) {
  const query: AvailabilityQuery = {
    kind: "query",
    version: 1,
    claimed: false,
  };
  eventBus.emit(CHANNEL, query);
  return query.claimed;
}

function protocolMessage(value: unknown): Invocation | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value) ||
    !("claimed" in value) ||
    typeof value.claimed !== "boolean"
  ) {
    return undefined;
  }
  if (value.kind === "query") return value as AvailabilityQuery;
  if (
    (value.kind === "run" || value.kind === "inspect") &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "reject" in value &&
    typeof value.reject === "function"
  ) {
    return value as unknown as RunInvocation | InspectInvocation;
  }
  return undefined;
}

function remoteExecutor(eventBus: EventBusLike): GoalWorkerExecutor {
  const invoke = <T>(
    invocation: Invocation & {
      claimed: boolean;
      resolve(value: T): void;
      reject(error: unknown): void;
    },
  ) =>
    new Promise<T>((resolve, reject) => {
      invocation.resolve = resolve;
      invocation.reject = reject;
      eventBus.emit(CHANNEL, invocation);
      if (!invocation.claimed) {
        reject(new Error("Goal Worker executor is unavailable."));
      }
    });
  return {
    run(request, signal) {
      return invoke<GoalWorkerOutcome>({
        kind: "run",
        version: 1,
        request: Object.freeze({ ...request }),
        signal,
        claimed: false,
        resolve() {},
        reject() {},
      });
    },
    inspect(attemptKey) {
      return invoke<GoalWorkerInspection>({
        kind: "inspect",
        version: 1,
        attemptKey,
        claimed: false,
        resolve() {},
        reject() {},
      });
    },
  };
}

export function bindGoalWorkerExecutor(
  eventBus: object,
  executor: GoalWorkerExecutor,
) {
  if (
    bindings.has(eventBus) ||
    (isEventBusLike(eventBus) && hasExecutor(eventBus))
  ) {
    throw new Error("A Goal Worker executor is already bound to this loader.");
  }
  const unlisten = isEventBusLike(eventBus)
    ? eventBus.on(CHANNEL, (value) => {
        const message = protocolMessage(value);
        if (!message || message.claimed) return;
        message.claimed = true;
        if (message.kind === "query") return;
        if (message.kind === "run") {
          void Promise.resolve(
            executor.run(message.request, message.signal),
          ).then(message.resolve, message.reject);
          return;
        }
        void Promise.resolve(executor.inspect(message.attemptKey)).then(
          message.resolve,
          message.reject,
        );
      })
    : () => {};
  bindings.set(eventBus, { executor, unlisten });
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    const binding = bindings.get(eventBus);
    if (binding?.executor !== executor) return;
    bindings.delete(eventBus);
    binding.unlisten();
  };
}

export function goalWorkerExecutorFor(eventBus: object) {
  const local = bindings.get(eventBus)?.executor;
  if (local || !isEventBusLike(eventBus)) return local;
  return hasExecutor(eventBus) ? remoteExecutor(eventBus) : undefined;
}
