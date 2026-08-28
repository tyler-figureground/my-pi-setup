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

const executors = new WeakMap<object, ScheduledAgentExecutor>();

export function bindScheduledAgentExecutor(
  eventBus: object,
  executor: ScheduledAgentExecutor,
) {
  if (executors.has(eventBus)) {
    throw new Error(
      "A Scheduled Agent executor is already bound to this loader.",
    );
  }
  executors.set(eventBus, executor);
  return () => {
    if (executors.get(eventBus) === executor) executors.delete(eventBus);
  };
}

export function scheduledAgentExecutorFor(eventBus: object) {
  return executors.get(eventBus);
}
