import type {
  GoalAttemptPhase,
  GoalDisposition,
  GoalNodeState,
  GoalState,
} from "./model.ts";

/**
 * Explicit transition tables.
 *
 * Every state change in Goal Mode is checked against these tables before it is
 * persisted. Nothing derives a transition implicitly from a timer, a missing
 * process, or a model claim, which is what keeps `unknown` sticky and terminal
 * states closed.
 */

export const GOAL_STATES = Object.freeze([
  "draft",
  "ready",
  "running",
  "paused",
  "blocked",
  "failed",
  "done",
  "cancelled",
] as const satisfies readonly GoalState[]);

export const GOAL_NODE_STATES = Object.freeze([
  "waiting",
  "ready",
  "running",
  "retry-wait",
  "blocked",
  "failed",
  "done",
  "cancelled",
] as const satisfies readonly GoalNodeState[]);

export const GOAL_ATTEMPT_PHASES = Object.freeze([
  "reserved",
  "prepared",
  "dispatching",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const satisfies readonly GoalAttemptPhase[]);

export const GOAL_TRANSITIONS: Readonly<
  Record<GoalState, readonly GoalState[]>
> = Object.freeze({
  draft: ["ready", "paused", "cancelled"],
  ready: ["running", "paused", "blocked", "failed", "done", "cancelled"],
  running: ["ready", "paused", "blocked", "failed", "done", "cancelled"],
  paused: ["ready", "blocked", "cancelled"],
  blocked: ["ready", "paused", "failed", "cancelled"],
  failed: ["ready", "cancelled"],
  done: [],
  cancelled: [],
});

export const GOAL_NODE_TRANSITIONS: Readonly<
  Record<GoalNodeState, readonly GoalNodeState[]>
> = Object.freeze({
  waiting: ["ready", "blocked", "done", "failed", "cancelled"],
  ready: ["running", "waiting", "blocked", "done", "failed", "cancelled"],
  // `running` may return to `ready` only when the attempt provably never
  // dispatched; ambiguity goes to `blocked` instead.
  running: ["ready", "retry-wait", "blocked", "done", "failed", "cancelled"],
  "retry-wait": ["ready", "blocked", "done", "failed", "cancelled"],
  blocked: ["ready", "waiting", "done", "failed", "cancelled"],
  failed: [],
  done: [],
  cancelled: [],
});

export const GOAL_ATTEMPT_TRANSITIONS: Readonly<
  Record<GoalAttemptPhase, readonly GoalAttemptPhase[]>
> = Object.freeze({
  reserved: ["prepared", "failed", "cancelled"],
  prepared: ["dispatching", "failed", "cancelled", "unknown"],
  dispatching: ["running", "succeeded", "failed", "cancelled", "unknown"],
  running: ["verifying", "succeeded", "failed", "cancelled", "unknown"],
  verifying: ["succeeded", "failed", "unknown"],
  succeeded: [],
  failed: [],
  cancelled: [],
  // Only direct user resolution leaves `unknown`; see attemptResolutionAllowed.
  unknown: [],
});

const UNKNOWN_RESOLUTIONS: readonly GoalAttemptPhase[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
]);

export function goalTransitionAllowed(from: GoalState, to: GoalState) {
  return GOAL_TRANSITIONS[from].includes(to);
}

export function nodeTransitionAllowed(from: GoalNodeState, to: GoalNodeState) {
  return GOAL_NODE_TRANSITIONS[from].includes(to);
}

export function attemptTransitionAllowed(
  from: GoalAttemptPhase,
  to: GoalAttemptPhase,
) {
  return GOAL_ATTEMPT_TRANSITIONS[from].includes(to);
}

/** Direct user resolution of an Unknown Attempt. Never reached automatically. */
export function attemptResolutionAllowed(
  from: GoalAttemptPhase,
  to: GoalAttemptPhase,
) {
  return from === "unknown" && UNKNOWN_RESOLUTIONS.includes(to);
}

/** An invalidated node restarts from `waiting` regardless of prior state. */
export function resetNodeState(): GoalNodeState {
  return "waiting";
}

const DISPOSITION_STATES: Readonly<Record<GoalDisposition, GoalNodeState>> =
  Object.freeze({
    done: "done",
    // Skipping finishes a node without executing it. It is deliberately the
    // same terminal state as `done` so dependents may proceed, and it is
    // deliberately a separate decision so the audit trail never conflates
    // "we did this" with "we chose not to".
    skip: "done",
    block: "blocked",
    cancelled: "cancelled",
    failed: "failed",
  });

/** The node state one direct user disposition lands in. */
export function dispositionNodeState(
  disposition: GoalDisposition,
): GoalNodeState {
  return DISPOSITION_STATES[disposition];
}

const ACTIVE_NODE_STATES: readonly GoalNodeState[] = Object.freeze([
  "waiting",
  "ready",
  "running",
  "retry-wait",
]);

export interface GoalStateInputs {
  readonly nodes: readonly {
    readonly state: GoalNodeState;
    readonly required: boolean;
  }[];
  readonly hasUnknownAttempt: boolean;
  readonly criteriaSatisfied: boolean;
}

/**
 * Recompute the Goal state from node states and the evidence gate.
 *
 * Paused, draft, and settled Goals are returned unchanged: only an explicit
 * command moves them. An unmet evidence gate blocks rather than completes.
 */
export function deriveGoalState(
  current: GoalState,
  inputs: GoalStateInputs,
): GoalState {
  if (current !== "ready" && current !== "running") return current;
  if (inputs.hasUnknownAttempt) return "blocked";
  if (inputs.nodes.some((node) => node.state === "blocked")) return "blocked";
  const required = inputs.nodes.filter((node) => node.required);
  if (required.some((node) => node.state === "failed")) return "failed";
  if (inputs.nodes.some((node) => node.state === "running")) return "running";
  if (inputs.nodes.some((node) => ACTIVE_NODE_STATES.includes(node.state)))
    return "ready";
  if (required.every((node) => node.state === "done"))
    return inputs.criteriaSatisfied ? "done" : "blocked";
  return "blocked";
}
