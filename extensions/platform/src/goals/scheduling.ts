import {
  GOAL_LIMITS,
  type GoalAttemptPhase,
  type GoalNodeState,
} from "./model.ts";

/**
 * Pure scheduling decisions.
 *
 * Everything here is a function of persisted state and the injected clock, so
 * the same inputs always produce the same plan. Nothing in this module talks to
 * an executor, which is what lets recovery replay the identical decision after
 * a crash.
 */

export interface GoalSchedulableNode {
  readonly id: string;
  readonly state: GoalNodeState;
  readonly dependsOn: readonly string[];
  readonly nextAttemptAt: number | null;
}

export interface GoalSchedulePlan {
  /** Nodes whose dependencies or retry delay are now satisfied. */
  readonly promote: readonly string[];
  /** Nodes whose dependency can never complete. Requires a user decision. */
  readonly block: readonly { readonly id: string; readonly reason: string }[];
  /** Nodes to claim now, already bounded by concurrency. */
  readonly dispatch: readonly string[];
  /** Earliest future instant worth waking for, if any. */
  readonly wakeAt: number | null;
}

export interface GoalScheduleOptions {
  readonly now: number;
  readonly maxConcurrency: number;
  readonly order: readonly string[];
}

const UNSATISFIABLE: readonly GoalNodeState[] = Object.freeze([
  "failed",
  "cancelled",
  "blocked",
]);

export function planSchedule(
  nodes: readonly GoalSchedulableNode[],
  options: GoalScheduleOptions,
): GoalSchedulePlan {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const promote: string[] = [];
  const block: { id: string; reason: string }[] = [];
  let wakeAt: number | null = null;

  for (const node of nodes) {
    if (node.state === "waiting") {
      const unsatisfiable = node.dependsOn
        .map((id) => byId.get(id))
        .find(
          (dependency) =>
            dependency && UNSATISFIABLE.includes(dependency.state),
        );
      if (unsatisfiable) {
        block.push({
          id: node.id,
          reason: `dependency-${unsatisfiable.state}`,
        });
        continue;
      }
      const satisfied = node.dependsOn.every(
        (id) => byId.get(id)?.state === "done",
      );
      if (satisfied) promote.push(node.id);
      continue;
    }
    if (node.state === "retry-wait") {
      const due = node.nextAttemptAt ?? options.now;
      if (due <= options.now) promote.push(node.id);
      else wakeAt = wakeAt === null ? due : Math.min(wakeAt, due);
    }
  }

  const promoted = new Set(promote);
  const blocked = new Set(block.map((entry) => entry.id));
  const running = nodes.filter((node) => node.state === "running").length;
  const capacity = Math.max(
    0,
    Math.min(options.maxConcurrency, GOAL_LIMITS.maxConcurrentNodes) - running,
  );
  const dispatchable = options.order.filter((id) => {
    if (blocked.has(id)) return false;
    const node = byId.get(id);
    return !!node && (node.state === "ready" || promoted.has(id));
  });
  return {
    promote,
    block,
    dispatch: dispatchable.slice(0, capacity),
    wakeAt,
  };
}

/** Deterministic exponential backoff, capped by the platform bound. */
export function retryDelayFor(retryDelayMs: number, attemptNumber: number) {
  const exponent = Math.max(0, attemptNumber - 1);
  const scaled = retryDelayMs * 2 ** Math.min(exponent, 30);
  return Math.min(
    GOAL_LIMITS.maxRetryDelayMs,
    Number.isFinite(scaled) ? Math.floor(scaled) : GOAL_LIMITS.maxRetryDelayMs,
  );
}

export type GoalExecutionCertainty = "not-started" | "started" | "unknown";

export interface GoalRetryInputs {
  readonly retryable: boolean;
  readonly certainty: GoalExecutionCertainty;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

/**
 * Decide what a durably settled failure earns.
 *
 * `block` is returned whenever the executor could not prove what happened.
 * Lease expiry, timeouts, and missing processes reach this function as
 * `unknown`, so none of them can produce a second child.
 */
export function retryDecision(
  inputs: GoalRetryInputs,
): "retry" | "fail" | "block" {
  if (inputs.certainty === "unknown") return "block";
  if (!inputs.retryable) return "fail";
  if (inputs.attemptCount >= inputs.maxAttempts) return "fail";
  return "retry";
}

export type GoalRecoveryInspection =
  | { readonly state: "not-started" }
  | { readonly state: "running" }
  | { readonly state: "settled" }
  | { readonly state: "unknown" };

/**
 * Decide how to recover an Attempt found in flight after a restart.
 *
 * A reservation or preparation provably never dispatched, so the same Attempt
 * is reclaimed. After dispatch, only the executor can certify what happened;
 * silence is ambiguity and becomes an Unknown Attempt.
 */
export function recoveryDecision(
  phase: GoalAttemptPhase,
  inspection: GoalRecoveryInspection | null,
): "reclaim" | "settle" | "adopt" | "block" {
  if (phase === "reserved" || phase === "prepared") return "reclaim";
  if (!inspection) return "block";
  if (inspection.state === "not-started") return "reclaim";
  if (inspection.state === "settled") return "settle";
  if (inspection.state === "running") return "adopt";
  return "block";
}
