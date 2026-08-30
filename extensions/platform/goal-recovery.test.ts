import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import type { StateStore } from "./src/core/persistence/state-store.ts";
import {
  createGoalPersistence,
  createGoalRuntime,
  goalCommandDigest,
  type GoalAuthorityVerifier,
  type GoalCommand,
  type GoalCommandAuthority,
  type GoalExecutorInspection,
  type GoalExecutorOutcome,
  type GoalExecutorPort,
  type GoalExecutorRequest,
  type GoalNodeInput,
  type GoalProfileResolution,
  type GoalRuntimeOptions,
  type GoalResumeCommand,
  type GoalSubmitCommand,
} from "./src/goals/index.ts";

/**
 * Stand-in host approval issuer: only the exact token the fixture minted, bound
 * to the digest the engine recomputed, verifies.
 */
const issuedAuthority: GoalAuthorityVerifier = {
  verify: (request) =>
    request.authority.token === "opaque-approval" &&
    request.authority.commandDigest === request.commandDigest &&
    request.authority.projectId === request.projectId &&
    request.authority.sessionId === request.sessionId,
};

function createFakeClock(start = 1_000) {
  let current = start;
  const timers = new Set<{ at: number; wake: () => void }>();
  return {
    now: () => current,
    arm(at: number, wake: () => void) {
      const timer = { at, wake };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advance(ms: number) {
      current += ms;
      for (const timer of [...timers]) {
        if (timer.at <= current) {
          timers.delete(timer);
          timer.wake();
        }
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function completion(
  request: GoalExecutorRequest,
  body = "done",
): GoalExecutorOutcome {
  return {
    ok: true,
    value: {
      status: "completed",
      artifact: {
        body,
        filename: "goal-worker-output.txt",
        mediaType: "text/plain; charset=utf-8",
        size: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
        metadata: {
          kind: "goal-worker-output",
          attemptKey: request.attemptKey,
          trust: "worker-reported",
        },
      },
      execution: {
        attemptKey: request.attemptKey,
        childId: "child-1",
        certainty: "started",
      },
      usage: {
        tokens: 4,
        costMicros: 2,
        authoritative: true,
        source: "agent-supervisor",
      },
    },
  };
}

function createExecutor(
  behaviour: (
    request: GoalExecutorRequest,
  ) => Promise<GoalExecutorOutcome> = async (request) => completion(request),
  inspection: (
    attemptKey: string,
  ) => GoalExecutorInspection | Promise<GoalExecutorInspection> = (
    attemptKey,
  ) => ({
    attemptKey,
    state: "unknown",
    certainty: "unknown",
  }),
) {
  const requests: GoalExecutorRequest[] = [];
  const inspected: string[] = [];
  const waiters: (() => void)[] = [];
  return {
    requests,
    inspected,
    metering: { tokens: true, cost: true },
    async run(request: GoalExecutorRequest) {
      requests.push(request);
      const pending = behaviour(request);
      for (const notify of waiters.splice(0)) notify();
      return pending;
    },
    async inspect(attemptKey: string) {
      inspected.push(attemptKey);
      return inspection(attemptKey);
    },
    async started(count: number) {
      while (requests.length < count) {
        const gate = deferred<void>();
        waiters.push(gate.resolve);
        await gate.promise;
      }
    },
  };
}

function profile(
  overrides: Partial<GoalProfileResolution> = {},
): GoalProfileResolution {
  return {
    name: "goal-worker",
    contentDigest: "a".repeat(64),
    catalogGeneration: 3,
    source: { scope: "user", path: "/profiles/goal-worker.md" },
    role: "goal-worker",
    workspacePolicy: "inherit",
    ...overrides,
  };
}

function createStack() {
  const clock = createFakeClock();
  const state = createMemoryStateStore({ now: () => clock.now() });
  const artifacts = createInMemoryArtifactStore({ clock: () => clock.now() });
  const persistence = createGoalPersistence(state, "project-1");
  const make = (
    overrides: Partial<GoalRuntimeOptions> & { readonly ownerId?: string } = {},
  ) =>
    createGoalRuntime({
      state,
      artifacts,
      clock,
      executor: createExecutor(),
      profiles: {
        async resolve(name) {
          return { ok: true, value: profile({ name }) };
        },
      },
      workspaces: {
        async prepare() {
          return {
            ok: true,
            value: { workspaceId: "workspace-1", cwd: "/repo/.worktrees/goal" },
          };
        },
        async dispose() {
          return { ok: true, value: { disposition: "released" } };
        },
      },
      review: {
        async verify(request) {
          return {
            ok: true,
            value: {
              satisfied: true,
              kind: "review-report",
              summary: `verified ${request.criterionId}`,
              artifact: null,
            },
          };
        },
      },
      delivery: {
        async deliver() {
          return { ok: true, value: { state: "delivered" } };
        },
      },
      binding: { projectId: "project-1", cwd: "/repo", sessionId: "session-1" },
      ownerId: "owner-1",
      leaseTtlMs: 60_000,
      authority: issuedAuthority,
      ...overrides,
    });
  const events = async (goalId: string) => {
    const result = await state.query({
      type: "events",
      stream: persistence.eventStream(goalId),
      limit: 200,
    });
    return result.ok && result.value.type === "events"
      ? result.value.events
      : [];
  };
  return { clock, state, artifacts, persistence, make, events };
}

function node(
  id: string,
  overrides: Partial<GoalNodeInput> = {},
): GoalNodeInput {
  return {
    id,
    title: `Node ${id}`,
    prompt: `Do ${id}`,
    dependsOn: [],
    profileName: "goal-worker",
    ...overrides,
  };
}

function submitCommand(
  overrides: Partial<GoalSubmitCommand> = {},
): GoalSubmitCommand {
  return {
    type: "submit",
    requestId: "request-1",
    goalId: "ship-feature",
    objective: "Ship the feature",
    nodes: [node("plan"), node("build", { dependsOn: ["plan"] })],
    budget: { maxConcurrency: 1, maxAgentCalls: 8, maxRuntimeMs: 3_600_000 },
    ...overrides,
  };
}

function authority(
  command: GoalCommand,
  overrides: Partial<GoalCommandAuthority> = {},
): GoalCommandAuthority {
  return {
    actor: "direct-user",
    actorId: "tyler",
    projectId: "project-1",
    sessionId: "session-1",
    commandDigest: goalCommandDigest(command),
    token: "opaque-approval",
    expiresAt: 3_600_000,
    ...overrides,
  };
}

function agentAuthority(command: GoalCommand): GoalCommandAuthority {
  return {
    actor: "agent",
    actorId: "session-1",
    projectId: "project-1",
    sessionId: "session-1",
    commandDigest: goalCommandDigest(command),
  };
}

async function submitTo(
  runtime: ReturnType<ReturnType<typeof createStack>["make"]>,
  command: GoalSubmitCommand,
) {
  const result = await runtime.engine.submit(command, authority(command));
  assert.equal(result.ok, true);
  return result;
}

test("a lost node lease aborts exactly that Attempt and fences its settlement", async (t) => {
  const stack = createStack();
  const aborts: string[] = [];
  const gates = new Map<
    string,
    {
      promise: Promise<GoalExecutorOutcome>;
      resolve: (value: GoalExecutorOutcome) => void;
    }
  >();
  const dispatched: GoalExecutorRequest[] = [];
  const stalling: GoalExecutorPort = {
    metering: { tokens: true, cost: true },
    async run(request, signal) {
      dispatched.push(request);
      const gate = deferred<GoalExecutorOutcome>();
      gates.set(request.prompt, gate);
      signal?.addEventListener("abort", () => {
        aborts.push(request.prompt);
      });
      return gate.promise;
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "unknown", certainty: "unknown" };
    },
  };
  // The node lease for `plan` is stolen: its renewals stop committing while
  // every other node keeps its own lease.
  const withStolenPlanLease: StateStore = {
    ...stack.state,
    async transact(transaction) {
      const stolen = transaction.operations.some(
        (operation) =>
          operation.type === "renew-lease" &&
          operation.metadata?.nodeId === "plan" &&
          operation.metadata?.renewal !== undefined,
      );
      if (stolen)
        return {
          ok: false,
          error: {
            code: "LEASE_LOST",
            message: "simulated lease theft",
            retryable: false,
          },
        };
      return stack.state.transact(transaction);
    },
  };
  const primary = stack.make({
    state: withStolenPlanLease,
    executor: stalling,
  });
  t.after(async () => {
    for (const gate of gates.values())
      gate.resolve({
        ok: false,
        error: {
          code: "cancelled",
          message: "teardown",
          retryable: false,
          certainty: "not-started",
        },
      });
    await primary.close();
  });
  await submitTo(
    primary,
    submitCommand({
      nodes: [node("plan"), node("other")],
      budget: {
        maxConcurrency: 2,
        maxAgentCalls: 8,
        maxRuntimeMs: 3_600_000,
      },
    }),
  );
  while (dispatched.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // One renewal period later the stolen lease fails to renew.
  stack.clock.advance(20_000);
  while (aborts.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(aborts, ["Do plan"]);

  // Time keeps moving. Every other node keeps renewing its own lease, while the
  // stolen one lapses and a replacement incarnation takes that node over.
  for (let step = 0; step < 4; step += 1) {
    stack.clock.advance(20_000);
    for (let flush = 0; flush < 6; flush += 1)
      await new Promise((resolve) => setImmediate(resolve));
  }
  const replacement = stack.make({ ownerId: "owner-2" });
  t.after(() => replacement.close());
  await replacement.drain();

  const takenOver = await replacement.engine.observe({
    goalId: "ship-feature",
  });
  assert.equal(takenOver.ok, true);
  if (!takenOver.ok) return;
  const planAfterTakeover = takenOver.value.detail?.nodes.find(
    (entry) => entry.id === "plan",
  );
  assert.equal(planAfterTakeover?.state, "blocked");
  assert.equal(planAfterTakeover?.blockedReason, "unknown-attempt");
  assert.equal(planAfterTakeover?.attempts[0]?.certainty, "unknown");

  // The abandoned worker answers afterwards. Its settlement is fenced.
  gates.get("Do plan")!.resolve({
    ok: true,
    value: {
      status: "completed",
      artifact: {
        body: "late",
        filename: "goal-worker-output.txt",
        mediaType: "text/plain; charset=utf-8",
        size: 4,
        sha256: createHash("sha256").update("late").digest("hex"),
        metadata: {
          kind: "goal-worker-output",
          attemptKey: dispatched[0]!.attemptKey,
          trust: "worker-reported",
        },
      },
      execution: {
        attemptKey: dispatched[0]!.attemptKey,
        childId: "child-late",
        certainty: "started",
      },
    },
  });
  gates.get("Do other")!.resolve(completion(dispatched[1]!));
  await primary.drain();

  const settled = await replacement.engine.observe({ goalId: "ship-feature" });
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  const plan = settled.value.detail?.nodes.find((entry) => entry.id === "plan");
  const other = settled.value.detail?.nodes.find(
    (entry) => entry.id === "other",
  );
  assert.equal(plan?.state, "blocked");
  assert.equal(plan?.blockedReason, "unknown-attempt");
  assert.equal(plan?.attempts.length, 1);
  assert.equal(other?.state, "done");
  assert.deepEqual(aborts, ["Do plan"]);
  assert.equal(dispatched.length, 2);
  // Charged exactly once per Attempt: the unknown Attempt at its full worst
  // case and the completed one at its measured usage.
  assert.equal(settled.value.detail?.budget.consumed.calls, 2);
  assert.equal(settled.value.detail?.budget.reserved.calls, 0);
  const audit = await stack.events("ship-feature");
  assert.equal(
    audit.some((entry) => entry.eventType === "goal.late-settlement"),
    true,
  );
});

test("a Goal killed after cancel stays cancelled and exposes the unresolved Attempt until it reconciles", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const dispatched: GoalExecutorRequest[] = [];
  const stalling: GoalExecutorPort = {
    metering: { tokens: true, cost: true },
    async run(request) {
      dispatched.push(request);
      return gate.promise;
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "unknown", certainty: "unknown" };
    },
  };
  const disposals: {
    workspaceId: string;
    preserve: boolean;
    outcome: string;
  }[] = [];
  const workspaces = {
    async prepare() {
      return {
        ok: true as const,
        value: {
          workspaceId: "workspace-cancel",
          cwd: "/repo/.worktrees/x",
        },
      };
    },
    async dispose(request: {
      workspaceId: string;
      preserve: boolean;
      outcome: string;
    }) {
      disposals.push({
        workspaceId: request.workspaceId,
        preserve: request.preserve,
        outcome: request.outcome,
      });
      return { ok: true as const, value: { disposition: "preserved" } };
    },
  };
  let dead = false;
  // Everything this incarnation tries to write after the kill is lost.
  const killable: StateStore = {
    ...stack.state,
    async transact(transaction) {
      if (dead)
        return {
          ok: false,
          error: {
            code: "STORAGE_FAILED",
            message: "process was killed",
            retryable: false,
          },
        };
      return stack.state.transact(transaction);
    },
  };
  const victim = stack.make({
    state: killable,
    executor: stalling,
    profiles: {
      async resolve(name) {
        return {
          ok: true,
          value: profile({ name, workspacePolicy: "isolated" }),
        };
      },
    },
    workspaces,
  });
  t.after(async () => {
    gate.resolve({
      ok: false,
      error: {
        code: "cancelled",
        message: "teardown",
        retryable: false,
        certainty: "unknown",
      },
    });
    await victim.close();
  });
  await submitTo(victim, submitCommand({ nodes: [node("plan")] }));
  while (dispatched.length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "operator stopped the run",
  };
  const cancelled = await victim.engine.cancel(cancel, authority(cancel));
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(cancelled.value.goal.state, "cancelled");
  assert.deepEqual(cancelled.value.goal.cancellation?.unresolved, ["plan"]);
  assert.equal(cancelled.value.goal.cancellation?.reconciledAt, null);
  assert.equal(cancelled.value.goal.cancellation?.certainty, "pending");
  // The parent dies before anything else can be written.
  dead = true;

  stack.clock.advance(120_000);
  const replacement = stack.make({
    ownerId: "owner-2",
    executor: stalling,
    workspaces,
  });
  t.after(() => replacement.close());
  await replacement.drain();

  const observed = await replacement.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  const detail = observed.value.detail;
  assert.equal(detail?.state, "cancelled");
  assert.equal(detail?.nodes[0]?.state, "cancelled");
  const attempt = detail?.nodes[0]?.attempts[0];
  assert.equal(attempt?.phase, "unknown");
  assert.equal(attempt?.certainty, "unknown");
  assert.equal(attempt?.settledAt !== null, true);
  // Reconciled exactly once: the reservation is released and the worst case is
  // charged, and the Goal records that it cannot prove what the child did.
  assert.equal(detail?.budget.reserved.calls, 0);
  assert.equal(detail?.budget.consumed.calls, 1);
  assert.equal(detail?.cancellation?.certainty, "unknown");
  assert.equal(typeof detail?.cancellation?.reconciledAt, "number");
  assert.deepEqual(detail?.cancellation?.unresolved, ["plan"]);
  // The Guarded Workspace is preserved for inspection, never deleted.
  assert.equal(disposals.length > 0, true);
  assert.equal(
    disposals.every((entry) => entry.preserve),
    true,
  );
  assert.equal(dispatched.length, 1);

  // A later sweep must not release anything twice.
  await replacement.drain();
  const again = await replacement.engine.observe({ goalId: "ship-feature" });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.detail?.budget.consumed.calls, 1);
  assert.equal(again.value.detail?.budget.reserved.calls, 0);
});

test("a crash before dispatch reclaims the same attempt without a new child", async (t) => {
  const stack = createStack();
  const stalled = createExecutor();
  const crashed = stack.make({
    executor: stalled as unknown as GoalExecutorPort,
    profiles: {
      async resolve(name) {
        return {
          ok: true,
          value: profile({ name, workspacePolicy: "isolated" }),
        };
      },
    },
    workspaces: {
      // The previous incarnation died while preparing a Guarded Workspace.
      prepare: () => new Promise(() => {}) as never,
      async dispose() {
        return { ok: true, value: { disposition: "preserved" } };
      },
    },
  });
  await submitTo(crashed, submitCommand({ nodes: [node("plan")] }));
  for (let index = 0; index < 50; index += 1) {
    const observed = await crashed.engine.observe({ goalId: "ship-feature" });
    if (observed.ok && observed.value.detail?.nodes[0]?.state === "running")
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  stack.clock.advance(120_000);
  const restarted = stack.make({ ownerId: "owner-2" });
  t.after(() => restarted.close());
  await restarted.drain();

  const observed = await restarted.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "done");
  assert.equal(stalled.requests.length, 0);
  assert.equal(stalled.inspected.length, 0);
  // The reservation from the lost incarnation was released, not leaked.
  assert.equal(observed.value.detail?.budget.consumed.calls, 1);
  assert.equal(observed.value.detail?.budget.reserved.calls, 0);
});

test("a crash after dispatch settles from a certified executor result", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const stalled = createExecutor(() => gate.promise);
  const crashed = stack.make({
    executor: stalled as unknown as GoalExecutorPort,
  });
  await submitTo(crashed, submitCommand({ nodes: [node("plan")] }));
  await stalled.started(1);
  const dispatched = stalled.requests[0]!;

  stack.clock.advance(120_000);
  const restarted = stack.make({
    ownerId: "owner-2",
    executor: createExecutor(
      async () => {
        throw new Error("must not dispatch again");
      },
      (attemptKey) => ({
        attemptKey,
        state: "settled",
        certainty: "started",
        outcome: completion(dispatched),
      }),
    ) as unknown as GoalExecutorPort,
  });
  t.after(() => restarted.close());
  await restarted.drain();

  const observed = await restarted.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(observed.value.detail?.state, "done");
});

test("a crash after dispatch that cannot be certified blocks as an unknown attempt", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const stalled = createExecutor(() => gate.promise);
  const crashed = stack.make({
    executor: stalled as unknown as GoalExecutorPort,
  });
  await submitTo(crashed, submitCommand({ nodes: [node("plan")] }));
  await stalled.started(1);

  const restartedExecutor = createExecutor(async () => {
    throw new Error("must not dispatch again");
  });
  stack.clock.advance(120_000);
  const restarted = stack.make({
    ownerId: "owner-2",
    executor: restartedExecutor as unknown as GoalExecutorPort,
  });
  t.after(() => restarted.close());
  await restarted.drain();

  const observed = await restarted.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "blocked");
  assert.equal(observed.value.detail?.blockedReason, "unknown-attempt");
  assert.equal(observed.value.detail?.nodes[0]?.state, "blocked");
  assert.equal(observed.value.detail?.nodes[0]?.attempts[0]?.phase, "unknown");
  assert.equal(restartedExecutor.requests.length, 0);
  // An unknown Attempt consumes its whole reservation.
  assert.equal(observed.value.detail?.budget.consumed.calls, 1);

  // The killed incarnation now answers late. Its fence is stale, so it can only
  // add audit, never resurrect the node or claim success.
  gate.resolve(completion(stalled.requests[0]!));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await restarted.engine.observe({ goalId: "ship-feature" });
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.value.detail?.nodes[0]?.state, "blocked");
  assert.equal(after.value.detail?.nodes[0]?.attempts[0]?.phase, "unknown");
  const events = await stack.events("ship-feature");
  assert.equal(
    events.some((event) => event.eventType === "goal.late-settlement"),
    true,
  );
});

test("a stale fenced settlement accounts its reservation without transitioning the node", async (t) => {
  const stack = createStack();
  const oldOutcome = deferred<GoalExecutorOutcome>();
  const oldExecutor = createExecutor(() => oldOutcome.promise);
  const oldRuntime = stack.make({
    ownerId: "owner-1",
    executor: oldExecutor as unknown as GoalExecutorPort,
  });
  await submitTo(oldRuntime, submitCommand({ nodes: [node("plan")] }));
  await oldExecutor.started(1);
  stack.clock.advance(120_000);

  const inspectionStarted = deferred<void>();
  const inspection = deferred<GoalExecutorInspection>();
  const replacementExecutor = createExecutor(
    async () => {
      throw new Error("must not dispatch again");
    },
    async () => {
      inspectionStarted.resolve();
      return inspection.promise;
    },
  );
  const replacement = stack.make({
    ownerId: "owner-2",
    executor: replacementExecutor as unknown as GoalExecutorPort,
  });
  t.after(() => replacement.close());
  const recovering = replacement.drain();
  await inspectionStarted.promise;

  oldOutcome.resolve(completion(oldExecutor.requests[0]!));
  await oldRuntime.drain();
  const duringRecovery = await stack.persistence.loadHead("ship-feature");
  assert.equal(duringRecovery.ok, true);
  if (!duringRecovery.ok || !duringRecovery.value) return;
  assert.equal(duringRecovery.value.value.budget.reserved.calls, 0);
  assert.equal(duringRecovery.value.value.budget.consumed.calls, 1);

  const attemptKey = oldExecutor.requests[0]!.attemptKey;
  inspection.resolve({
    attemptKey,
    state: "unknown",
    certainty: "unknown",
  });
  await recovering;
  const observed = await replacement.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "blocked");
  assert.equal(observed.value.detail?.budget.consumed.calls, 1);
  assert.equal(observed.value.detail?.budget.reserved.calls, 0);
});

test("an executor that certifies the attempt never started allows a fresh dispatch", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const stalled = createExecutor(() => gate.promise);
  const crashed = stack.make({
    executor: stalled as unknown as GoalExecutorPort,
  });
  await submitTo(crashed, submitCommand({ nodes: [node("plan")] }));
  await stalled.started(1);

  const restartedExecutor = createExecutor(
    async (request) => completion(request),
    (attemptKey) => ({
      attemptKey,
      state: "not-started",
      certainty: "not-started",
    }),
  );
  stack.clock.advance(120_000);
  const restarted = stack.make({
    ownerId: "owner-2",
    executor: restartedExecutor as unknown as GoalExecutorPort,
  });
  t.after(() => restarted.close());
  await restarted.drain();

  const observed = await restarted.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "done");
  assert.equal(restartedExecutor.requests.length, 1);
});

test("an attempt still running elsewhere is never redispatched", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const stalled = createExecutor(() => gate.promise);
  const crashed = stack.make({
    executor: stalled as unknown as GoalExecutorPort,
  });
  await submitTo(crashed, submitCommand({ nodes: [node("plan")] }));
  await stalled.started(1);

  const restartedExecutor = createExecutor(
    async () => {
      throw new Error("must not dispatch again");
    },
    (attemptKey) => ({ attemptKey, state: "running", certainty: "started" }),
  );
  stack.clock.advance(120_000);
  const restarted = stack.make({
    ownerId: "owner-2",
    executor: restartedExecutor as unknown as GoalExecutorPort,
  });
  t.after(() => restarted.close());
  await restarted.drain();

  const observed = await restarted.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(restartedExecutor.requests.length, 0);
  assert.equal(observed.value.detail?.state, "blocked");
});

test("recovery keeps sweeping after startup and reclaims a peer lease once it expires", async (t) => {
  const stack = createStack();
  const preparationStarted = deferred<void>();
  const crashed = stack.make({
    ownerId: "owner-1",
    profiles: {
      async resolve(name) {
        return {
          ok: true,
          value: profile({ name, workspacePolicy: "isolated" }),
        };
      },
    },
    workspaces: {
      async prepare() {
        preparationStarted.resolve();
        return new Promise(() => {}) as never;
      },
      async dispose() {
        return { ok: true, value: { disposition: "preserved" } };
      },
    },
  });
  await submitTo(crashed, submitCommand({ nodes: [node("plan")] }));
  await preparationStarted.promise;

  const replacementExecutor = createExecutor();
  const replacement = stack.make({
    ownerId: "owner-2",
    executor: replacementExecutor as unknown as GoalExecutorPort,
  });
  t.after(() => replacement.close());
  await replacement.drain();
  assert.equal(replacementExecutor.requests.length, 0);

  stack.clock.advance(120_000);
  await replacement.drain();
  const observed = await replacement.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "done");
  assert.equal(replacementExecutor.requests.length, 1);
});

test("startup recovery paginates beyond 128 goals", async (t) => {
  const stack = createStack();
  // This drill is about paging, so the Goal cap is raised out of its way.
  const seeder = stack.make({ ownerId: "seeder", maxGoals: 200 });
  t.after(() => seeder.close());
  for (let index = 0; index < 128; index += 1) {
    await submitTo(
      seeder,
      submitCommand({
        activate: false,
        requestId: `seed-request-${index}`,
        goalId: `goal-${String(index).padStart(3, "0")}`,
        nodes: [node("plan")],
      }),
    );
  }

  let crash = true;
  const crashAfterCommit: StateStore = {
    ...stack.state,
    async transact(transaction) {
      const result = await stack.state.transact(transaction);
      if (
        crash &&
        result.ok &&
        transaction.operations.some(
          (operation) =>
            operation.type === "put-record" &&
            operation.collection.includes("goals.request."),
        )
      ) {
        crash = false;
        throw new Error("simulated loss before scheduling");
      }
      return result;
    },
  };
  const crashed = stack.make({
    state: crashAfterCommit,
    ownerId: "crashed",
    maxGoals: 200,
  });
  t.after(() => crashed.close());
  const target = submitCommand({
    requestId: "target-request",
    goalId: "zz-target",
    nodes: [node("plan")],
  });
  await assert.rejects(
    crashed.engine.submit(target, authority(target)),
    /simulated loss/,
  );

  const executor = createExecutor();
  const replacement = stack.make({
    maxGoals: 200,
    ownerId: "replacement",
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => replacement.close());
  await replacement.drain();
  const observed = await replacement.engine.observe({ goalId: "zz-target" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "done");
  assert.equal(executor.requests.length, 1);
});

test("an unknown attempt must be resolved by the user before resuming", async (t) => {
  const stack = createStack();
  const ambiguous = stack.make({
    executor: createExecutor(async () => ({
      ok: false,
      error: {
        code: "execution_unknown",
        message: "cannot prove the outcome",
        retryable: true,
        certainty: "unknown",
      },
    })) as unknown as GoalExecutorPort,
  });
  t.after(() => ambiguous.close());
  await submitTo(ambiguous, submitCommand({ nodes: [node("plan")] }));
  await ambiguous.drain();

  const bare = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const refused = await ambiguous.engine.resume(bare, agentAuthority(bare));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "authority_denied");
    assert.equal(refused.error.details?.reason, "direct_user_required");
  }

  const resolve = {
    type: "resume" as const,
    requestId: "resume-2",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "Checked the host: nothing ran",
    edits: [
      {
        kind: "resolve-unknown" as const,
        nodeId: "plan",
        attemptNumber: 1,
        resolution: "failed" as const,
        reason: "No child process ever appeared",
      },
    ],
  };
  const agentAttempt = await ambiguous.engine.resume(
    resolve,
    agentAuthority(resolve),
  );
  assert.equal(agentAttempt.ok, false);
  if (!agentAttempt.ok)
    assert.equal(agentAttempt.error.details?.reason, "direct_user_required");

  const resolved = await ambiguous.engine.resume(resolve, authority(resolve));
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const plan = resolved.value.goal.nodes[0]!;
  assert.equal(plan.attempts[0]?.phase, "failed");
  assert.equal(plan.blockedReason, null);
  assert.equal(
    resolved.value.goal.history.some(
      (entry) => entry.type === "goal.attempt-resolved",
    ),
    true,
  );
  const events = await stack.events("ship-feature");
  assert.equal(
    events.some((event) => event.eventType === "goal.attempt-resolved"),
    true,
  );
});

test("succeeding an unknown Attempt satisfies a host-verified test criterion", async (t) => {
  const stack = createStack();
  const runtime = stack.make({
    executor: createExecutor(async () => ({
      ok: false,
      error: {
        code: "execution_unknown",
        message: "cannot prove the outcome",
        retryable: true,
        certainty: "unknown",
      },
    })) as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "tests",
              description: "Tests pass",
              acceptedEvidenceKinds: ["test-report"],
              minimumEvidenceCount: 1,
              minimumTrust: "host-verified",
            },
          ],
        }),
      ],
    }),
  );
  await runtime.drain();

  const bare: GoalResumeCommand = {
    type: "resume",
    requestId: "resolve-succeeded-without-test-report",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "resolve-unknown",
        nodeId: "plan",
        attemptNumber: 1,
        resolution: "succeeded",
        reason: "Assume the run completed",
      },
    ],
  };
  const rejected = await runtime.engine.resume(bare, authority(bare));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "invalid_request");
    assert.equal(rejected.error.details?.reason, "criteria_unattested");
  }

  const resume: GoalResumeCommand = {
    type: "resume",
    requestId: "resolve-succeeded-with-test-report",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "resolve-unknown",
        nodeId: "plan",
        attemptNumber: 1,
        resolution: "succeeded",
        reason: "Verified the completed run",
        evidence: {
          kind: "test-report",
          criterionId: "tests",
          summary: "Host test report passed",
        },
      },
    ],
  };
  const resolved = await runtime.engine.resume(resume, authority(resume));
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  if (!resolved.ok) return;
  assert.equal(resolved.value.goal.nodes[0]?.state, "done");
  assert.equal(resolved.value.goal.nodes[0]?.attempts[0]?.phase, "succeeded");
  assert.equal(
    resolved.value.goal.nodes[0]?.evidence[0]?.definitionRevision,
    1,
  );
});

test("succeeding an unknown Attempt without criteria still needs attestation", async (t) => {
  const stack = createStack();
  const runtime = stack.make({
    executor: createExecutor(async () => ({
      ok: false,
      error: {
        code: "execution_unknown",
        message: "cannot prove the outcome",
        retryable: true,
        certainty: "unknown",
      },
    })) as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ nodes: [node("plan")] }));
  await runtime.drain();

  const resume: GoalResumeCommand = {
    type: "resume",
    requestId: "resolve-succeeded-without-attestation",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "resolve-unknown",
        nodeId: "plan",
        attemptNumber: 1,
        resolution: "succeeded",
        reason: "Assume the run completed",
      },
    ],
  };
  const rejected = await runtime.engine.resume(resume, authority(resume));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "invalid_request");
    assert.equal(rejected.error.details?.reason, "criteria_unattested");
  }
  const observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "blocked");
  assert.equal(observed.value.detail?.nodes[0]?.state, "blocked");
  assert.equal(observed.value.detail?.nodes[0]?.attempts[0]?.phase, "unknown");
});

test("edits require direct user authority and a paused or draft goal", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const executor = createExecutor(() => gate.promise);
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(async () => {
    gate.resolve(completion(executor.requests[0]!));
    await runtime.close();
  });
  await submitTo(runtime, submitCommand());
  await executor.started(1);

  const edit = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "sharpen the objective",
    edits: [
      { kind: "objective" as const, objective: "Ship the feature safely" },
    ],
  };
  const whileRunning = await runtime.engine.resume(edit, authority(edit));
  assert.equal(whileRunning.ok, false);
  if (!whileRunning.ok) {
    assert.equal(whileRunning.error.code, "state_conflict");
    assert.equal(whileRunning.error.details?.reason, "edits_require_pause");
  }
});

test("audited edits bump the definition revision and record provenance", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const command = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "sharpen the objective",
    edits: [
      { kind: "objective" as const, objective: "Ship the feature safely" },
      {
        kind: "criteria" as const,
        criteria: [
          {
            id: "signed-off",
            description: "User signed off",
            acceptedEvidenceKinds: ["user-attestation" as const],
            minimumEvidenceCount: 1,
            minimumTrust: "user-accepted" as const,
          },
        ],
      },
    ],
  };
  const agentEdit = await runtime.engine.resume(
    command,
    agentAuthority(command),
  );
  assert.equal(agentEdit.ok, false);

  const edited = await runtime.engine.resume(command, authority(command));
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.value.goal.definitionRevision, 2);
  assert.equal(edited.value.goal.objective, "Ship the feature safely");
  assert.equal(edited.value.goal.criteria.length, 1);
  const audit = edited.value.goal.history.find(
    (entry) => entry.type === "goal.edited",
  );
  assert.ok(audit);
  assert.equal(audit?.actor, "direct-user");
  assert.equal(audit?.actorId, "tyler");
  assert.equal(audit?.reason, "sharpen the objective");
  assert.match(String(audit?.details.previousDigest), /^[a-f0-9]{64}$/);
  assert.match(String(audit?.details.digest), /^[a-f0-9]{64}$/);
  assert.notEqual(audit?.details.previousDigest, audit?.details.digest);
  const events = await stack.events("ship-feature");
  assert.equal(
    events.some((event) => event.eventType === "goal.edited"),
    true,
  );
});

test("dependency edits are revalidated against the whole graph", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const cycle = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "node-dependencies" as const,
        nodeId: "plan",
        dependsOn: ["build"],
      },
    ],
  };
  const refused = await runtime.engine.resume(cycle, authority(cycle));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "invalid_request");
    assert.equal(refused.error.details?.reason, "dependency_cycle");
  }

  const missing = {
    ...cycle,
    requestId: "resume-2",
    edits: [
      {
        kind: "node-dependencies" as const,
        nodeId: "plan",
        dependsOn: ["nowhere"],
      },
    ],
  };
  const refusedMissing = await runtime.engine.resume(
    missing,
    authority(missing),
  );
  assert.equal(refusedMissing.ok, false);
  if (!refusedMissing.ok)
    assert.equal(refusedMissing.error.details?.reason, "missing_dependency");

  const observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.definitionRevision, 1);
  assert.equal(observed.ok && observed.value.detail?.state, "draft");
});

test("budget edits expand freely but never fall below what is already used", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  const executor = createExecutor(() => gate.promise);
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ nodes: [node("plan")] }));
  await executor.started(1);
  stack.clock.advance(5_000);

  const pause = {
    type: "pause" as const,
    requestId: "pause-1",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const paused = await runtime.engine.pause(pause, authority(pause));
  assert.equal(paused.ok, true);
  gate.resolve(completion(executor.requests[0]!));
  await runtime.drain();

  const observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "paused");
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(observed.value.detail?.budget.consumed.runtimeMs, 5_000);

  const shrink = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "budget" as const,
        limits: { maxConcurrency: 1, maxAgentCalls: 8, maxRuntimeMs: 1_000 },
      },
    ],
  };
  const refused = await runtime.engine.resume(shrink, authority(shrink));
  assert.equal(refused.ok, false);
  if (!refused.ok)
    assert.equal(refused.error.details?.reason, "budget_below_consumed");

  const expand = {
    ...shrink,
    requestId: "resume-2",
    edits: [
      {
        kind: "budget" as const,
        limits: {
          maxConcurrency: 2,
          maxAgentCalls: 16,
          maxRuntimeMs: 7_200_000,
        },
      },
    ],
  };
  const expanded = await runtime.engine.resume(expand, authority(expand));
  assert.equal(expanded.ok, true);
  if (!expanded.ok) return;
  assert.equal(expanded.value.goal.budget.limits.maxAgentCalls, 16);
  assert.equal(expanded.value.goal.definitionRevision, 2);
});

test("a manual disposition completes a node with an audited reason and evidence", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const command = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "planning already happened offline",
    edits: [
      {
        kind: "disposition" as const,
        nodeId: "plan",
        disposition: "done" as const,
        reason: "planning already happened offline",
        evidence: {
          kind: "user-attestation" as const,
          criterionId: "output",
          summary: "Plan agreed in person",
        },
      },
    ],
  };
  const disposed = await runtime.engine.resume(command, authority(command));
  assert.equal(disposed.ok, true);
  if (!disposed.ok) return;
  const plan = disposed.value.goal.nodes.find((entry) => entry.id === "plan")!;
  assert.equal(plan.state, "done");
  assert.equal(plan.evidence.length, 1);
  assert.equal(plan.evidence[0]?.trust, "user-accepted");
  assert.equal(plan.attemptCount, 0);
  const audit = disposed.value.goal.history.find(
    (entry) => entry.type === "goal.disposition",
  );
  assert.equal(audit?.reason, "planning already happened offline");
  assert.equal(audit?.details.nodeId, "plan");

  await runtime.drain();
  assert.deepEqual(
    executor.requests.map((request) => request.prompt),
    ["Do build"],
  );
  const observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.state, "done");
});

test("manual artifact evidence uses host-verified metadata and rejects missing artifacts", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const stored = await stack.artifacts.put({
    body: "verified report",
    filename: "report.txt",
    mediaType: "text/plain",
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const edit = {
    type: "resume" as const,
    requestId: "manual-artifact",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "disposition" as const,
        nodeId: "plan",
        disposition: "done" as const,
        reason: "Reviewed report",
        evidence: {
          kind: "test-report" as const,
          criterionId: "manual",
          summary: "Verified report",
          artifactId: stored.value.id,
        },
      },
    ],
  };
  const accepted = await runtime.engine.resume(edit, authority(edit));
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  const artifact = accepted.value.goal.nodes[0]?.evidence[0]?.artifact;
  assert.equal(artifact?.sha256, stored.value.sha256);
  assert.equal(artifact?.size, stored.value.size);

  const missing = {
    ...edit,
    requestId: "manual-artifact-missing",
    edits: [
      {
        ...edit.edits[0],
        evidence: {
          ...edit.edits[0]!.evidence,
          artifactId: "f".repeat(64),
        },
      },
    ],
  };
  const rejected = await runtime.engine.resume(missing, authority(missing));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "invalid_request");
});

test("manual evidence rejects kinds outside the runtime allowlist", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const command = JSON.parse(
    JSON.stringify({
      type: "resume",
      requestId: "invalid-manual-kind",
      goalId: "ship-feature",
      expectedRevision: 1,
      edits: [
        {
          kind: "disposition",
          nodeId: "plan",
          disposition: "done",
          reason: "Manual review",
          evidence: {
            kind: "invented-proof",
            criterionId: "manual",
            summary: "Not a real evidence kind",
          },
        },
      ],
    }),
  ) as GoalResumeCommand;
  const rejected = await runtime.engine.resume(command, authority(command));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "invalid_request");
    assert.equal(rejected.error.details?.reason, "invalid_evidence_kind");
  }
});

test("a current-revision node waiver combines with Attempt evidence for completion", async (t) => {
  const stack = createStack();
  const runtime = stack.make({
    review: {
      async verify() {
        return {
          ok: true,
          value: {
            satisfied: false,
            kind: "test-report",
            summary: "not verified",
          },
        };
      },
    },
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      activate: false,
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "tests",
              description: "Tests pass",
              acceptedEvidenceKinds: ["test-report", "user-attestation"],
              minimumEvidenceCount: 1,
              minimumTrust: "host-verified",
            },
          ],
        }),
      ],
    }),
  );
  const resume = {
    type: "resume" as const,
    requestId: "resume-with-node-waiver",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "waive-criterion" as const,
        scope: "node" as const,
        nodeId: "plan",
        criterionId: "tests",
        reason: "Direct user accepted external verification",
      },
    ],
  };
  const resumed = await runtime.engine.resume(resume, authority(resume));
  assert.equal(resumed.ok, true);
  await runtime.drain();
  const observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(observed.value.detail?.state, "done");
});

test("a user waiver satisfies a goal criterion and is recorded as evidence", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      nodes: [node("plan")],
      criteria: [
        {
          id: "signed-off",
          description: "User signed off",
          acceptedEvidenceKinds: ["user-attestation"],
          minimumEvidenceCount: 1,
          minimumTrust: "user-accepted",
        },
      ],
    }),
  );
  await runtime.drain();
  let observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.state, "blocked");

  const waive = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "signed off in review",
    edits: [
      {
        kind: "waive-criterion" as const,
        scope: "goal" as const,
        criterionId: "signed-off",
        reason: "signed off in review",
      },
    ],
  };
  const waived = await runtime.engine.resume(waive, authority(waive));
  assert.equal(waived.ok, true);
  if (!waived.ok) return;
  assert.equal(waived.value.goal.evidence.length, 1);
  assert.equal(waived.value.goal.evidence[0]?.trust, "user-accepted");
  assert.equal(waived.value.goal.evidence[0]?.criterionId, "signed-off");
  await runtime.drain();
  observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.state, "done");
});

test("a completed goal is terminal for both pause and resume", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      nodes: [
        node("plan"),
        node("build", { dependsOn: ["plan"] }),
        node("ship", { dependsOn: ["build"] }),
        node("unrelated"),
      ],
    }),
  );
  await runtime.drain();
  let observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.state, "done");
  assert.equal(executor.requests.length, 4);

  const pause = {
    type: "pause" as const,
    requestId: "pause-1",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const paused = await runtime.engine.pause(pause, authority(pause));
  assert.equal(paused.ok, false, "a completed Goal is terminal");

  const invalidate = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "the plan output was wrong",
    invalidateNode: "build",
  };
  const resumed = await runtime.engine.resume(
    invalidate,
    authority(invalidate),
  );
  assert.equal(resumed.ok, false, "done Goals do not resume");
  if (!resumed.ok) assert.equal(resumed.error.code, "state_conflict");
});

test("invalidation reruns the selected node and its dependents", async (t) => {
  const stack = createStack();
  const gate = deferred<GoalExecutorOutcome>();
  let gated = true;
  const executor = createExecutor(async (request) => {
    if (gated && request.prompt === "Do ship") return gate.promise;
    return completion(request);
  });
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      nodes: [
        node("plan"),
        node("build", { dependsOn: ["plan"] }),
        node("ship", { dependsOn: ["build"] }),
      ],
    }),
  );
  await executor.started(3);

  const pause = {
    type: "pause" as const,
    requestId: "pause-1",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  assert.equal((await runtime.engine.pause(pause, authority(pause))).ok, true);
  gated = false;
  gate.resolve(completion(executor.requests[2]!));
  await runtime.drain();

  let observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "paused");
  assert.deepEqual(
    observed.value.detail?.nodes.map((entry) => entry.state),
    ["done", "done", "done"],
  );

  const invalidate = {
    type: "resume" as const,
    requestId: "resume-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "the build output was wrong",
    invalidateNode: "build",
  };
  const resumed = await runtime.engine.resume(
    invalidate,
    authority(invalidate),
  );
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  const states = Object.fromEntries(
    resumed.value.goal.nodes.map((entry) => [entry.id, entry.state]),
  );
  assert.equal(states.plan, "done");
  assert.equal(states.build, "waiting");
  assert.equal(states.ship, "waiting");
  const build = resumed.value.goal.nodes.find((entry) => entry.id === "build")!;
  assert.equal(build.evidence.length, 0);
  assert.equal(build.attemptCount, 0);
  assert.equal(resumed.value.goal.runGeneration, 2);
  const audit = resumed.value.goal.history.find(
    (entry) => entry.type === "goal.invalidated",
  );
  assert.equal(audit?.details.nodes, "build,ship");
  assert.equal(audit?.reason, "the build output was wrong");

  await runtime.drain();
  observed = await runtime.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.state, "done");
  assert.deepEqual(
    executor.requests.map((request) => request.prompt),
    ["Do plan", "Do build", "Do ship", "Do build", "Do ship"],
  );
});
