import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_ATTEMPT_PHASES,
  GOAL_ATTEMPT_TRANSITIONS,
  GOAL_NODE_STATES,
  GOAL_NODE_TRANSITIONS,
  GOAL_STATES,
  GOAL_TRANSITIONS,
  attemptResolutionAllowed,
  attemptTransitionAllowed,
  deriveGoalState,
  goalTransitionAllowed,
  nodeTransitionAllowed,
  type GoalNodeState,
} from "./src/goals/index.ts";

function nodes(entries: readonly (readonly [GoalNodeState, boolean])[]) {
  return entries.map(([state, required]) => ({ state, required }));
}

test("transition tables are total over every declared state", () => {
  assert.deepEqual(
    Object.keys(GOAL_TRANSITIONS).sort(),
    [...GOAL_STATES].sort(),
  );
  assert.deepEqual(
    Object.keys(GOAL_NODE_TRANSITIONS).sort(),
    [...GOAL_NODE_STATES].sort(),
  );
  assert.deepEqual(
    Object.keys(GOAL_ATTEMPT_TRANSITIONS).sort(),
    [...GOAL_ATTEMPT_PHASES].sort(),
  );
  for (const [from, targets] of Object.entries(GOAL_TRANSITIONS)) {
    for (const target of targets) {
      assert.ok(GOAL_STATES.includes(target), `${from} -> ${target}`);
      assert.notEqual(target, from);
    }
  }
});

test("goal transitions are explicit and terminal states are closed", () => {
  assert.equal(goalTransitionAllowed("draft", "ready"), true);
  assert.equal(goalTransitionAllowed("ready", "running"), true);
  assert.equal(goalTransitionAllowed("running", "paused"), true);
  assert.equal(goalTransitionAllowed("paused", "ready"), true);
  assert.equal(goalTransitionAllowed("blocked", "ready"), true);
  assert.equal(goalTransitionAllowed("failed", "ready"), true);

  assert.equal(goalTransitionAllowed("draft", "running"), false);
  assert.equal(goalTransitionAllowed("paused", "running"), false);
  assert.equal(goalTransitionAllowed("done", "running"), false);
  assert.equal(goalTransitionAllowed("cancelled", "ready"), false);
  assert.equal(goalTransitionAllowed("done", "cancelled"), false);
  assert.deepEqual(GOAL_TRANSITIONS.done, []);
  assert.deepEqual(GOAL_TRANSITIONS.cancelled, []);
});

test("node transitions allow reclaim but never skip execution", () => {
  assert.equal(nodeTransitionAllowed("waiting", "ready"), true);
  assert.equal(nodeTransitionAllowed("ready", "running"), true);
  assert.equal(nodeTransitionAllowed("running", "retry-wait"), true);
  assert.equal(nodeTransitionAllowed("retry-wait", "ready"), true);
  // A crash before dispatch may reclaim the same node without a new child.
  assert.equal(nodeTransitionAllowed("running", "ready"), true);
  assert.equal(nodeTransitionAllowed("running", "blocked"), true);

  assert.equal(nodeTransitionAllowed("waiting", "running"), false);
  assert.equal(nodeTransitionAllowed("waiting", "retry-wait"), false);
  assert.equal(nodeTransitionAllowed("done", "running"), false);
  assert.equal(nodeTransitionAllowed("cancelled", "ready"), false);
  assert.equal(nodeTransitionAllowed("failed", "running"), false);
});

test("manual dispositions are explicit transitions, not silent completion", () => {
  assert.equal(nodeTransitionAllowed("waiting", "done"), true);
  assert.equal(nodeTransitionAllowed("blocked", "done"), true);
  assert.equal(nodeTransitionAllowed("retry-wait", "cancelled"), true);
  assert.equal(nodeTransitionAllowed("failed", "done"), false);
});

test("attempt phases advance in order and never leave unknown automatically", () => {
  assert.equal(attemptTransitionAllowed("reserved", "prepared"), true);
  assert.equal(attemptTransitionAllowed("prepared", "dispatching"), true);
  assert.equal(attemptTransitionAllowed("dispatching", "running"), true);
  assert.equal(attemptTransitionAllowed("running", "verifying"), true);
  assert.equal(attemptTransitionAllowed("verifying", "succeeded"), true);

  assert.equal(attemptTransitionAllowed("reserved", "running"), false);
  assert.equal(attemptTransitionAllowed("prepared", "succeeded"), false);
  assert.equal(attemptTransitionAllowed("succeeded", "failed"), false);
  assert.deepEqual(GOAL_ATTEMPT_TRANSITIONS.unknown, []);
  assert.equal(attemptTransitionAllowed("unknown", "failed"), false);
  assert.equal(attemptTransitionAllowed("unknown", "succeeded"), false);
});

test("every phase that may have dispatched can become unknown", () => {
  for (const phase of [
    "prepared",
    "dispatching",
    "running",
    "verifying",
  ] as const) {
    assert.equal(attemptTransitionAllowed(phase, "unknown"), true);
  }
  // Nothing was dispatched from a bare reservation, so it settles as cancelled.
  assert.equal(attemptTransitionAllowed("reserved", "cancelled"), true);
});

test("only direct user resolution leaves an unknown attempt", () => {
  assert.equal(attemptResolutionAllowed("unknown", "failed"), true);
  assert.equal(attemptResolutionAllowed("unknown", "succeeded"), true);
  assert.equal(attemptResolutionAllowed("unknown", "cancelled"), true);
  assert.equal(attemptResolutionAllowed("running", "failed"), false);
  assert.equal(attemptResolutionAllowed("succeeded", "failed"), false);
});

test("derived goal state blocks on unknown attempts before anything else", () => {
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["done", true],
        ["running", true],
      ]),
      hasUnknownAttempt: true,
      criteriaSatisfied: true,
    }),
    "blocked",
  );
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["blocked", true],
        ["waiting", true],
      ]),
      hasUnknownAttempt: false,
      criteriaSatisfied: true,
    }),
    "blocked",
  );
});

test("derived goal state honours required nodes and the evidence gate", () => {
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["done", true],
        ["done", true],
      ]),
      hasUnknownAttempt: false,
      criteriaSatisfied: true,
    }),
    "done",
  );
  // Every required node is done but Goal criteria are unmet: never silently done.
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([["done", true]]),
      hasUnknownAttempt: false,
      criteriaSatisfied: false,
    }),
    "blocked",
  );
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["done", true],
        ["failed", false],
      ]),
      hasUnknownAttempt: false,
      criteriaSatisfied: true,
    }),
    "done",
  );
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["failed", true],
        ["done", true],
      ]),
      hasUnknownAttempt: false,
      criteriaSatisfied: true,
    }),
    "failed",
  );
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["running", true],
        ["waiting", true],
      ]),
      hasUnknownAttempt: false,
      criteriaSatisfied: false,
    }),
    "running",
  );
  assert.equal(
    deriveGoalState("running", {
      nodes: nodes([
        ["retry-wait", true],
        ["waiting", true],
      ]),
      hasUnknownAttempt: false,
      criteriaSatisfied: false,
    }),
    "ready",
  );
});

test("derived state never resurrects a settled or paused goal", () => {
  for (const state of [
    "paused",
    "draft",
    "done",
    "cancelled",
    "failed",
  ] as const) {
    assert.equal(
      deriveGoalState(state, {
        nodes: nodes([["ready", true]]),
        hasUnknownAttempt: false,
        criteriaSatisfied: false,
      }),
      state,
    );
  }
});

test("derived transitions stay inside the declared table", () => {
  for (const current of ["ready", "running"] as const) {
    for (const state of GOAL_NODE_STATES) {
      const derived = deriveGoalState(current, {
        nodes: nodes([[state, true]]),
        hasUnknownAttempt: false,
        criteriaSatisfied: true,
      });
      assert.ok(
        derived === current || goalTransitionAllowed(current, derived),
        `${current} -> ${derived} for node state ${state}`,
      );
    }
  }
});
