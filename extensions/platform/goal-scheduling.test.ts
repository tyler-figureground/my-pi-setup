import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_LIMITS,
  planSchedule,
  recoveryDecision,
  retryDecision,
  retryDelayFor,
  type GoalSchedulableNode,
} from "./src/goals/index.ts";

function node(
  id: string,
  overrides: Partial<GoalSchedulableNode> = {},
): GoalSchedulableNode {
  return {
    id,
    state: "waiting",
    dependsOn: [],
    nextAttemptAt: null,
    ...overrides,
  };
}

test("nodes with satisfied dependencies are promoted and dispatched in order", () => {
  const plan = planSchedule(
    [
      node("plan", { state: "done" }),
      node("build", { dependsOn: ["plan"] }),
      node("ship", { dependsOn: ["build"] }),
    ],
    { now: 0, maxConcurrency: 4, order: ["plan", "build", "ship"] },
  );
  assert.deepEqual(plan.promote, ["build"]);
  assert.deepEqual(plan.dispatch, ["build"]);
  assert.deepEqual(plan.block, []);
  assert.equal(plan.wakeAt, null);
});

test("an unmet ordinary dependency stays waiting and is never blocked", () => {
  const plan = planSchedule(
    [
      node("plan", { state: "running" }),
      node("build", { dependsOn: ["plan"] }),
    ],
    { now: 0, maxConcurrency: 4, order: ["plan", "build"] },
  );
  assert.deepEqual(plan.promote, []);
  assert.deepEqual(plan.dispatch, []);
  assert.deepEqual(plan.block, []);
});

test("dependents of an unsatisfiable dependency are blocked with a reason", () => {
  for (const state of ["failed", "cancelled", "blocked"] as const) {
    const plan = planSchedule(
      [node("plan", { state }), node("build", { dependsOn: ["plan"] })],
      { now: 0, maxConcurrency: 4, order: ["plan", "build"] },
    );
    assert.deepEqual(plan.block, [
      { id: "build", reason: `dependency-${state}` },
    ]);
    assert.deepEqual(plan.dispatch, []);
  }
});

test("concurrency is bounded by policy and by nodes already running", () => {
  const nodes = [
    node("a", { state: "ready" }),
    node("b", { state: "ready" }),
    node("c", { state: "ready" }),
    node("d", { state: "ready" }),
  ];
  const bounded = planSchedule(nodes, {
    now: 0,
    maxConcurrency: 2,
    order: ["a", "b", "c", "d"],
  });
  assert.deepEqual(bounded.dispatch, ["a", "b"]);

  const partial = planSchedule(
    [node("running", { state: "running" }), ...nodes],
    { now: 0, maxConcurrency: 2, order: ["running", "a", "b", "c", "d"] },
  );
  assert.deepEqual(partial.dispatch, ["a"]);

  const saturated = planSchedule(
    [
      node("one", { state: "running" }),
      node("two", { state: "running" }),
      node("a", { state: "ready" }),
    ],
    { now: 0, maxConcurrency: 2, order: ["one", "two", "a"] },
  );
  assert.deepEqual(saturated.dispatch, []);
});

test("concurrency never exceeds the platform maximum", () => {
  const nodes = Array.from({ length: 8 }, (_, index) =>
    node(`n-${index}`, { state: "ready" }),
  );
  const plan = planSchedule(nodes, {
    now: 0,
    maxConcurrency: 99,
    order: nodes.map((entry) => entry.id),
  });
  assert.equal(plan.dispatch.length, GOAL_LIMITS.maxConcurrentNodes);
});

test("retry-wait nodes wake only when their delay has elapsed", () => {
  const waiting = planSchedule(
    [node("build", { state: "retry-wait", nextAttemptAt: 5_000 })],
    { now: 4_999, maxConcurrency: 2, order: ["build"] },
  );
  assert.deepEqual(waiting.dispatch, []);
  assert.equal(waiting.wakeAt, 5_000);

  const due = planSchedule(
    [node("build", { state: "retry-wait", nextAttemptAt: 5_000 })],
    { now: 5_000, maxConcurrency: 2, order: ["build"] },
  );
  assert.deepEqual(due.promote, ["build"]);
  assert.deepEqual(due.dispatch, ["build"]);
  assert.equal(due.wakeAt, null);
});

test("the earliest pending retry determines the wake time", () => {
  const plan = planSchedule(
    [
      node("a", { state: "retry-wait", nextAttemptAt: 9_000 }),
      node("b", { state: "retry-wait", nextAttemptAt: 6_000 }),
    ],
    { now: 1_000, maxConcurrency: 2, order: ["a", "b"] },
  );
  assert.equal(plan.wakeAt, 6_000);
});

test("dispatch order follows the declared topological order", () => {
  const plan = planSchedule(
    [node("zulu", { state: "ready" }), node("alpha", { state: "ready" })],
    { now: 0, maxConcurrency: 1, order: ["zulu", "alpha"] },
  );
  assert.deepEqual(plan.dispatch, ["zulu"]);
});

test("retry backoff is exponential, deterministic, and capped", () => {
  assert.equal(retryDelayFor(1_000, 1), 1_000);
  assert.equal(retryDelayFor(1_000, 2), 2_000);
  assert.equal(retryDelayFor(1_000, 3), 4_000);
  assert.equal(retryDelayFor(1_000, 6), 32_000);
  assert.equal(
    retryDelayFor(GOAL_LIMITS.maxRetryDelayMs, 6),
    GOAL_LIMITS.maxRetryDelayMs,
  );
  assert.equal(retryDelayFor(0, 4), 0);
});

test("ambiguous execution never earns a retry", () => {
  assert.equal(
    retryDecision({
      retryable: true,
      certainty: "unknown",
      attemptCount: 1,
      maxAttempts: 6,
    }),
    "block",
  );
  // Even a retryable failure of a child that provably started stays safe,
  // because the executor durably settled it before we decided.
  assert.equal(
    retryDecision({
      retryable: true,
      certainty: "started",
      attemptCount: 1,
      maxAttempts: 6,
    }),
    "retry",
  );
  assert.equal(
    retryDecision({
      retryable: true,
      certainty: "not-started",
      attemptCount: 1,
      maxAttempts: 6,
    }),
    "retry",
  );
});

test("non retryable failures and exhausted attempts fail the node", () => {
  assert.equal(
    retryDecision({
      retryable: false,
      certainty: "started",
      attemptCount: 1,
      maxAttempts: 6,
    }),
    "fail",
  );
  assert.equal(
    retryDecision({
      retryable: true,
      certainty: "started",
      attemptCount: 3,
      maxAttempts: 3,
    }),
    "fail",
  );
});

test("recovery reclaims only attempts that provably never dispatched", () => {
  assert.equal(recoveryDecision("reserved", null), "reclaim");
  assert.equal(recoveryDecision("prepared", null), "reclaim");
  assert.equal(
    recoveryDecision("dispatching", { state: "not-started" }),
    "reclaim",
  );
  assert.equal(recoveryDecision("dispatching", { state: "settled" }), "settle");
  assert.equal(recoveryDecision("running", { state: "running" }), "adopt");
  assert.equal(recoveryDecision("running", { state: "unknown" }), "block");
  // No inspection answer at all is ambiguity, not permission to redispatch.
  assert.equal(recoveryDecision("dispatching", null), "block");
  assert.equal(recoveryDecision("running", null), "block");
  assert.equal(recoveryDecision("verifying", null), "block");
});
