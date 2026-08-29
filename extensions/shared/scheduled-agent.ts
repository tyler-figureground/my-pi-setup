import type { ResolvedAgentProfile } from "./agent-profile.ts";

export interface ScheduledAgentRequest {
  readonly occurrenceId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly projectId: string;
  readonly profile: ResolvedAgentProfile;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ScheduledAgentCompletion {
  readonly status: "completed";
  readonly output: string;
  readonly outputBytes: number;
  readonly sessionId?: string;
}

export interface ScheduledAgentFailure {
  readonly code:
    | "invalid_request"
    | "profile_denied"
    | "backend_unavailable"
    | "timed_out"
    | "cancelled"
    | "run_failed"
    | "output_bounded"
    | "shutting_down";
  readonly message: string;
  readonly retryable: boolean;
}

export type ScheduledAgentOutcome =
  | { readonly ok: true; readonly value: ScheduledAgentCompletion }
  | { readonly ok: false; readonly error: ScheduledAgentFailure };

/**
 * Host-only execution seam for one fully bound Scheduled Occurrence.
 *
 * The request intentionally has no role, tool, model, trust, credential, or
 * authority override. The immutable Agent Profile carries host-resolved child
 * policy and must have the `scheduled` Execution Role.
 */
export interface ScheduledAgentExecutor {
  run(
    request: ScheduledAgentRequest,
    signal?: AbortSignal,
  ): Promise<ScheduledAgentOutcome>;
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
  readonly request: ScheduledAgentRequest;
  readonly signal?: AbortSignal;
  claimed: boolean;
  resolve(value: ScheduledAgentOutcome): void;
  reject(error: unknown): void;
}

// Coordination among trusted extension code. Executor core remains authority.
const CHANNEL = "platform:scheduled-agent-executor:private";
const bindings = new WeakMap<
  object,
  { readonly executor: ScheduledAgentExecutor; readonly unlisten: () => void }
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

function protocolMessage(value: unknown) {
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
    value.kind === "run" &&
    "request" in value &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "reject" in value &&
    typeof value.reject === "function"
  ) {
    return value as unknown as RunInvocation;
  }
  return undefined;
}

function remoteExecutor(eventBus: EventBusLike): ScheduledAgentExecutor {
  return {
    run(request, signal) {
      return new Promise((resolve, reject) => {
        const invocation: RunInvocation = {
          kind: "run",
          version: 1,
          request: Object.freeze({ ...request }),
          signal,
          claimed: false,
          resolve,
          reject,
        };
        eventBus.emit(CHANNEL, invocation);
        if (!invocation.claimed) {
          reject(new Error("Scheduled Agent executor is unavailable."));
        }
      });
    },
  };
}

export function bindScheduledAgentExecutor(
  eventBus: object,
  executor: ScheduledAgentExecutor,
) {
  if (
    bindings.has(eventBus) ||
    (isEventBusLike(eventBus) && hasExecutor(eventBus))
  ) {
    throw new Error(
      "A Scheduled Agent executor is already bound to this loader.",
    );
  }
  const unlisten = isEventBusLike(eventBus)
    ? eventBus.on(CHANNEL, (value) => {
        const message = protocolMessage(value);
        if (!message || message.claimed) return;
        message.claimed = true;
        if (message.kind === "query") {
          return;
        }
        void Promise.resolve()
          .then(() => executor.run(message.request, message.signal))
          .then(message.resolve, message.reject);
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

export function scheduledAgentExecutorFor(eventBus: object) {
  const local = bindings.get(eventBus)?.executor;
  if (local || !isEventBusLike(eventBus)) return local;
  return hasExecutor(eventBus) ? remoteExecutor(eventBus) : undefined;
}
