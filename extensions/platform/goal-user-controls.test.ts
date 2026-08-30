import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import {
  createGoalPersistence,
  createGoalRuntime,
  goalCommandDigest,
  type GoalAuthorityVerifier,
  type GoalCommand,
  type GoalCommandAuthority,
  type GoalCriterionInput,
  type GoalExecutorOutcome,
  type GoalExecutorPort,
  type GoalExecutorRequest,
  type GoalNodeInput,
  type GoalProfileResolution,
  type GoalResumeCommand,
  type GoalRuntimeOptions,
  type GoalSubmitCommand,
} from "./src/goals/index.ts";

/**
 * Direct-user Goal controls.
 *
 * These tests speak only through `GoalEngine`, because the point of the
 * controls is what a person is allowed to change and what the runtime is then
 * forced to redo. Everything asserted here is observable: node state, node
 * evidence, the definition revision, the audit trail, and which prompts the
 * executor actually ran.
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
) {
  const requests: GoalExecutorRequest[] = [];
  const waiters: (() => void)[] = [];
  return {
    requests,
    metering: { tokens: true, cost: true },
    async run(request: GoalExecutorRequest) {
      requests.push(request);
      const pending = behaviour(request);
      for (const notify of waiters.splice(0)) notify();
      return pending;
    },
    async inspect(attemptKey: string) {
      return { attemptKey, state: "unknown" as const, certainty: "unknown" };
    },
    async started(count: number) {
      while (requests.length < count) {
        const gate = deferred<void>();
        waiters.push(gate.resolve);
        await gate.promise;
      }
    },
    prompts: () => requests.map((request) => request.prompt),
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
  let generation = 3;
  const make = (overrides: Partial<GoalRuntimeOptions> = {}) =>
    createGoalRuntime({
      state,
      artifacts,
      clock,
      executor: createExecutor() as unknown as GoalExecutorPort,
      profiles: {
        async resolve(name) {
          return {
            ok: true,
            value: profile({ name, catalogGeneration: generation }),
          };
        },
      },
      review: {
        // Host review declines throughout, so every criterion in these tests is
        // met by worker output or by an explicit human decision, never by a
        // verifier quietly certifying the tree.
        async verify() {
          return {
            ok: true,
            value: {
              satisfied: false,
              kind: "review-report",
              summary: "host review declined",
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
  return {
    clock,
    state,
    artifacts,
    make,
    events,
    /** Move the Agent Profile catalog under a Goal that is already pinned. */
    repin: (next: number) => {
      generation = next;
    },
  };
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

function attestation(id: string): GoalCriterionInput {
  return {
    id,
    description: `Criterion ${id}`,
    acceptedEvidenceKinds: ["user-attestation"],
    minimumEvidenceCount: 1,
    minimumTrust: "user-accepted",
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
    budget: { maxConcurrency: 1, maxAgentCalls: 16, maxRuntimeMs: 3_600_000 },
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

type Runtime = ReturnType<ReturnType<typeof createStack>["make"]>;

async function submitTo(runtime: Runtime, command: GoalSubmitCommand) {
  const result = await runtime.engine.submit(command, authority(command));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function resumeWith(runtime: Runtime, command: GoalResumeCommand) {
  return runtime.engine.resume(command, authority(command));
}

async function detailOf(runtime: Runtime, goalId = "ship-feature") {
  const observed = await runtime.engine.observe({
    goalId,
    includeHistory: true,
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) throw new Error("Goal observation failed.");
  const detail = observed.value.detail;
  if (!detail) throw new Error(`Goal ${goalId} has no detail.`);
  return detail;
}

function stateMap(nodes: readonly { id: string; state: string }[]) {
  return Object.fromEntries(nodes.map((entry) => [entry.id, entry.state]));
}

/**
 * Run a three node chain to completion but pause before the Goal settles, so
 * the fixture ends with real Attempt results in a Goal a person may still edit.
 */
async function runChainThenPause(t: {
  after(fn: () => unknown): void;
}): Promise<{
  readonly stack: ReturnType<typeof createStack>;
  readonly runtime: Runtime;
  readonly executor: ReturnType<typeof createExecutor>;
}> {
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
  const paused = await runtime.engine.pause(pause, authority(pause));
  assert.equal(paused.ok, true, JSON.stringify(paused));
  gated = false;
  gate.resolve(completion(executor.requests[2]!));
  await runtime.drain();
  const detail = await detailOf(runtime);
  assert.equal(detail.state, "paused");
  assert.deepEqual(stateMap(detail.nodes), {
    plan: "done",
    build: "done",
    ship: "done",
  });
  return { stack, runtime, executor };
}

test("a paused Goal accepts node task edits and reruns exactly the affected nodes", async (t) => {
  const { runtime, executor } = await runChainThenPause(t);
  const before = await detailOf(runtime);
  const buildBefore = before.nodes.find((entry) => entry.id === "build")!;
  assert.ok(buildBefore.evidence.length > 0);
  const digestBefore = buildBefore.definitionDigest;

  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-task-1",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "the build step was described wrong",
    edits: [
      {
        kind: "node-task",
        nodeId: "build",
        title: "Build it properly",
        prompt: "Do build with the corrected steps",
      },
    ],
  };
  const edited = await resumeWith(runtime, command);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  if (!edited.ok) return;

  assert.equal(edited.value.goal.definitionRevision, 2);
  const states = stateMap(edited.value.goal.nodes);
  assert.equal(states.plan, "done", "an unaffected ancestor keeps its result");
  assert.equal(states.build, "waiting");
  assert.equal(states.ship, "waiting", "a dependent is invalidated too");
  const build = edited.value.goal.nodes.find((entry) => entry.id === "build")!;
  assert.equal(build.title, "Build it properly");
  assert.notEqual(build.definitionDigest, digestBefore);
  assert.equal(build.evidence.length, 0, "stale evidence never survives");
  assert.equal(build.attemptCount, 0);
  const ship = edited.value.goal.nodes.find((entry) => entry.id === "ship")!;
  assert.equal(ship.evidence.length, 0);
  assert.equal(ship.attemptCount, 0);

  const editAudit = edited.value.goal.history.find(
    (entry) => entry.type === "goal.edited",
  );
  assert.equal(editAudit?.actor, "direct-user");
  assert.equal(editAudit?.actorId, "tyler");
  assert.equal(editAudit?.details.revision, 2);
  const invalidation = edited.value.goal.history.find(
    (entry) => entry.type === "goal.invalidated",
  );
  assert.equal(invalidation?.details.nodes, "build,ship");
  assert.equal(invalidation?.reason, "the build step was described wrong");

  await runtime.drain();
  assert.deepEqual(executor.prompts(), [
    "Do plan",
    "Do build",
    "Do ship",
    "Do build with the corrected steps",
    "Do ship",
  ]);
  const after = await detailOf(runtime);
  assert.equal(after.state, "done");
  const rebuilt = after.nodes.find((entry) => entry.id === "build")!;
  assert.ok(rebuilt.evidence.length > 0);
  assert.equal(
    rebuilt.evidence.every((entry) => entry.definitionRevision === 2),
    true,
    "completion evidence is bound to the revision that produced it",
  );
});

test("a title-only edit still bumps the revision and invalidates the node", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-title",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [{ kind: "node-task", nodeId: "plan", title: "Plan it properly" }],
  };
  const edited = await resumeWith(runtime, command);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  if (!edited.ok) return;
  assert.equal(edited.value.goal.definitionRevision, 2);
  assert.equal(edited.value.goal.nodes[0]?.title, "Plan it properly");
  assert.equal(
    edited.value.goal.history.find((entry) => entry.type === "goal.invalidated")
      ?.details.nodes,
    "plan",
  );
  await runtime.drain();
  assert.deepEqual(executor.prompts(), ["Do plan"]);
});

test("node task edits reject text outside the declared bounds", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const empty: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-empty",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [{ kind: "node-task", nodeId: "plan" }],
  };
  const rejectedEmpty = await resumeWith(runtime, empty);
  assert.equal(rejectedEmpty.ok, false);
  if (!rejectedEmpty.ok)
    assert.equal(rejectedEmpty.error.details?.reason, "empty_node_task");

  const oversized: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-oversized",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [{ kind: "node-task", nodeId: "plan", prompt: "x".repeat(20_000) }],
  };
  const rejectedOversized = await resumeWith(runtime, oversized);
  assert.equal(rejectedOversized.ok, false);
  if (!rejectedOversized.ok)
    assert.equal(rejectedOversized.error.details?.reason, "invalid_prompt");

  const unknown: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-unknown",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [{ kind: "node-task", nodeId: "nowhere", title: "Nope" }],
  };
  const rejectedUnknown = await resumeWith(runtime, unknown);
  assert.equal(rejectedUnknown.ok, false);
  if (!rejectedUnknown.ok)
    assert.equal(rejectedUnknown.error.details?.reason, "unknown_node");

  const detail = await detailOf(runtime);
  assert.equal(detail.definitionRevision, 1);
  assert.equal(detail.state, "draft");
});

test("node criteria edits bump the revision and invalidate the node they judge", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-node-criteria",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "planning needs a written record",
    edits: [
      {
        kind: "node-criteria",
        nodeId: "plan",
        criteria: [
          {
            id: "written",
            description: "A written plan exists",
            acceptedEvidenceKinds: ["worker-output"],
            minimumEvidenceCount: 1,
            minimumTrust: "worker-reported",
          },
        ],
      },
    ],
  };
  const edited = await resumeWith(runtime, command);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  if (!edited.ok) return;
  assert.equal(edited.value.goal.definitionRevision, 2);
  const invalidation = edited.value.goal.history.find(
    (entry) => entry.type === "goal.invalidated",
  );
  assert.equal(invalidation?.details.nodes, "plan,build");

  await runtime.drain();
  const detail = await detailOf(runtime);
  assert.equal(detail.state, "done");
  const plan = detail.nodes.find((entry) => entry.id === "plan")!;
  assert.equal(
    plan.evidence.some(
      (entry) =>
        entry.criterionId === "written" && entry.definitionRevision === 2,
    ),
    true,
  );
});

test("a criteria edit a node cannot satisfy leaves the Goal blocked rather than done", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-impossible-criteria",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "node-criteria",
        nodeId: "plan",
        criteria: [attestation("hand")],
      },
    ],
  };
  assert.equal((await resumeWith(runtime, command)).ok, true);
  await runtime.drain();
  const detail = await detailOf(runtime);
  assert.notEqual(detail.state, "done");
  assert.equal(detail.nodes[0]?.state !== "done", true);
});

test("dependency edits revalidate the graph and invalidate the node they reorder", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      activate: false,
      nodes: [node("plan"), node("build"), node("ship")],
    }),
  );

  const cycle: GoalResumeCommand = {
    type: "resume",
    requestId: "deps-cycle",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      { kind: "node-dependencies", nodeId: "plan", dependsOn: ["build"] },
      { kind: "node-dependencies", nodeId: "build", dependsOn: ["plan"] },
    ],
  };
  const rejected = await resumeWith(runtime, cycle);
  assert.equal(rejected.ok, false);
  if (!rejected.ok)
    assert.equal(rejected.error.details?.reason, "dependency_cycle");

  const ordered: GoalResumeCommand = {
    type: "resume",
    requestId: "deps-ordered",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "ship must wait for build",
    edits: [
      { kind: "node-dependencies", nodeId: "ship", dependsOn: ["build"] },
    ],
  };
  const accepted = await resumeWith(runtime, ordered);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (!accepted.ok) return;
  assert.equal(accepted.value.goal.definitionRevision, 2);
  const ship = accepted.value.goal.nodes.find((entry) => entry.id === "ship")!;
  assert.deepEqual(ship.dependsOn, ["build"]);
  assert.equal(
    accepted.value.goal.history.find(
      (entry) => entry.type === "goal.invalidated",
    )?.details.nodes,
    "ship",
  );

  await runtime.drain();
  assert.equal(executor.prompts().indexOf("Do ship") > 0, true);
  assert.equal(
    executor.prompts().indexOf("Do build") <
      executor.prompts().indexOf("Do ship"),
    true,
    "the new dependency order is what actually runs",
  );
});

test("an objective edit bumps the revision without discarding node results", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-objective",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "sharpen the objective",
    edits: [{ kind: "objective", objective: "Ship the feature safely" }],
  };
  const edited = await resumeWith(runtime, command);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  if (!edited.ok) return;
  assert.equal(edited.value.goal.objective, "Ship the feature safely");
  assert.equal(edited.value.goal.definitionRevision, 2);
  assert.equal(
    edited.value.goal.history.some(
      (entry) => entry.type === "goal.invalidated",
    ),
    false,
    "an objective edit does not reset node work by itself",
  );
});

test("skip is an explicit audited done disposition that waives the node criteria", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      activate: false,
      nodes: [
        node("plan", { criteria: [attestation("reviewed")] }),
        node("build", { dependsOn: ["plan"] }),
      ],
    }),
  );

  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "skip-plan",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "skip",
        reason: "planning already happened offline",
      },
    ],
  };
  const skipped = await resumeWith(runtime, command);
  assert.equal(skipped.ok, true, JSON.stringify(skipped));
  if (!skipped.ok) return;
  const plan = skipped.value.goal.nodes.find((entry) => entry.id === "plan")!;
  assert.equal(plan.state, "done");
  assert.equal(plan.attemptCount, 0);
  const waiver = plan.evidence.find(
    (entry) => entry.criterionId === "reviewed",
  );
  assert.equal(waiver?.trust, "user-accepted");
  assert.equal(waiver?.kind, "user-attestation");
  assert.equal(waiver?.definitionRevision, 1);
  assert.match(String(waiver?.summary), /Skipped by tyler/);
  const audit = skipped.value.goal.history.find(
    (entry) => entry.type === "goal.disposition",
  );
  assert.equal(audit?.details.disposition, "skip");
  assert.equal(audit?.details.nodeId, "plan");
  assert.equal(audit?.reason, "planning already happened offline");
  assert.equal(audit?.actor, "direct-user");

  const events = await stack.events("ship-feature");
  const disposed = events.find(
    (event) => event.eventType === "goal.disposition",
  );
  assert.equal(disposed?.metadata?.disposition, "skip");

  await runtime.drain();
  assert.deepEqual(executor.prompts(), ["Do build"]);
  assert.equal((await detailOf(runtime)).state, "done");
});

test("a skip disposition still demands a reason", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));
  const command = JSON.parse(
    JSON.stringify({
      type: "resume",
      requestId: "skip-no-reason",
      goalId: "ship-feature",
      expectedRevision: 1,
      edits: [
        {
          kind: "disposition",
          nodeId: "plan",
          disposition: "skip",
          reason: "",
        },
      ],
    }),
  ) as GoalResumeCommand;
  const rejected = await runtime.engine.resume(command, authority(command));
  assert.equal(rejected.ok, false);
  if (!rejected.ok)
    assert.equal(rejected.error.details?.reason, "missing_reason");
});

test("a block disposition blocks the node and the Goal with the stated reason", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "block-plan",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "block",
        reason: "waiting on a decision from the customer",
      },
    ],
  };
  const blocked = await resumeWith(runtime, command);
  assert.equal(blocked.ok, true, JSON.stringify(blocked));
  if (!blocked.ok) return;
  const plan = blocked.value.goal.nodes.find((entry) => entry.id === "plan")!;
  assert.equal(plan.state, "blocked");
  assert.equal(plan.blockedReason, "waiting on a decision from the customer");
  const audit = blocked.value.goal.history.find(
    (entry) => entry.type === "goal.disposition",
  );
  assert.equal(audit?.details.disposition, "block");

  await runtime.drain();
  const detail = await detailOf(runtime);
  assert.equal(detail.state, "blocked");
  assert.equal(detail.blockedReason, "waiting on a decision from the customer");
  assert.equal(executor.requests.length, 0, "a blocked node never dispatches");
});

test("a done disposition requires explicit user attestation", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      activate: false,
      nodes: [node("plan", { criteria: [attestation("reviewed")] })],
    }),
  );

  const bare: GoalResumeCommand = {
    type: "resume",
    requestId: "done-bare",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "done",
        reason: "it is fine",
      },
    ],
  };
  const rejected = await resumeWith(runtime, bare);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, "invalid_request");
    assert.equal(rejected.error.details?.reason, "criteria_unattested");
  }

  const wrongCriterion: GoalResumeCommand = {
    ...bare,
    requestId: "done-wrong-criterion",
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "done",
        reason: "it is fine",
        evidence: {
          kind: "user-attestation",
          criterionId: "invented",
          summary: "Checked something else",
        },
      },
    ],
  };
  const wrong = await resumeWith(runtime, wrongCriterion);
  assert.equal(wrong.ok, false);
  if (!wrong.ok)
    assert.equal(wrong.error.details?.reason, "criteria_unattested");

  const attested: GoalResumeCommand = {
    ...bare,
    requestId: "done-attested",
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "done",
        reason: "reviewed together on a call",
        evidence: {
          kind: "user-attestation",
          criterionId: "reviewed",
          summary: "Reviewed together on a call",
        },
      },
    ],
  };
  const accepted = await resumeWith(runtime, attested);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (!accepted.ok) return;
  const plan = accepted.value.goal.nodes[0]!;
  assert.equal(plan.state, "done");
  assert.equal(plan.evidence[0]?.trust, "user-accepted");
});

test("a done disposition on a node without criteria still needs an attestation", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const bare: GoalResumeCommand = {
    type: "resume",
    requestId: "done-no-criteria",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "done",
        reason: "done offline",
      },
    ],
  };
  const rejected = await resumeWith(runtime, bare);
  assert.equal(rejected.ok, false);
  if (!rejected.ok)
    assert.equal(rejected.error.details?.reason, "criteria_unattested");
});

test("an edit and a done disposition in one command attest against the new revision", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      activate: false,
      nodes: [node("plan", { criteria: [attestation("reviewed")] })],
    }),
  );
  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-and-dispose",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "objective sharpened and plan accepted",
    edits: [
      { kind: "objective", objective: "Ship the feature safely" },
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "done",
        reason: "reviewed together on a call",
        evidence: {
          kind: "user-attestation",
          criterionId: "reviewed",
          summary: "Reviewed together on a call",
        },
      },
    ],
  };
  const applied = await resumeWith(runtime, command);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  if (!applied.ok) return;
  assert.equal(applied.value.goal.definitionRevision, 2);
  const plan = applied.value.goal.nodes[0]!;
  assert.equal(plan.state, "done");
  assert.equal(
    plan.evidence[0]?.definitionRevision,
    2,
    "attestation belongs to the revision the user approved",
  );
});

test("an Agent actor cannot edit task text, dependencies, criteria, or dispositions", async (t) => {
  const stack = createStack();
  const runtime = stack.make();
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const attempts: readonly GoalResumeCommand[] = [
    {
      type: "resume",
      requestId: "agent-task",
      goalId: "ship-feature",
      expectedRevision: 1,
      edits: [{ kind: "node-task", nodeId: "plan", prompt: "Do as I say" }],
    },
    {
      type: "resume",
      requestId: "agent-criteria",
      goalId: "ship-feature",
      expectedRevision: 1,
      edits: [{ kind: "node-criteria", nodeId: "plan", criteria: [] }],
    },
    {
      type: "resume",
      requestId: "agent-deps",
      goalId: "ship-feature",
      expectedRevision: 1,
      edits: [{ kind: "node-dependencies", nodeId: "build", dependsOn: [] }],
    },
    {
      type: "resume",
      requestId: "agent-skip",
      goalId: "ship-feature",
      expectedRevision: 1,
      edits: [
        {
          kind: "disposition",
          nodeId: "plan",
          disposition: "skip",
          reason: "not needed",
        },
      ],
    },
    {
      type: "resume",
      requestId: "agent-restart",
      goalId: "ship-feature",
      expectedRevision: 1,
      invalidateNode: "plan",
    },
  ];
  for (const command of attempts) {
    const denied = await runtime.engine.resume(
      command,
      agentAuthority(command),
    );
    assert.equal(denied.ok, false, command.requestId);
    if (!denied.ok) assert.equal(denied.error.code, "authority_denied");
  }
  const detail = await detailOf(runtime);
  assert.equal(detail.definitionRevision, 1);
  assert.equal(detail.state, "draft");
});

test("an Agent actor cannot resume a blocked Goal or dispatch its work", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(runtime, submitCommand({ activate: false }));

  const block: GoalResumeCommand = {
    type: "resume",
    requestId: "block-before-agent-resume",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [
      {
        kind: "disposition",
        nodeId: "plan",
        disposition: "block",
        reason: "waiting for user input",
      },
    ],
  };
  assert.equal((await resumeWith(runtime, block)).ok, true);
  await runtime.drain();
  const before = await detailOf(runtime);
  assert.equal(before.state, "blocked");
  assert.equal(executor.requests.length, 0);

  const resume: GoalResumeCommand = {
    type: "resume",
    requestId: "agent-resume-blocked",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const denied = await runtime.engine.resume(resume, agentAuthority(resume));
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "authority_denied");
    assert.equal(denied.error.details?.reason, "direct_user_required");
  }
  await runtime.drain();
  const after = await detailOf(runtime);
  assert.deepEqual(after, before);
  assert.equal(executor.requests.length, 0);
});

test("an Agent actor cannot resume a failed Goal or dispatch another Attempt", async (t) => {
  const stack = createStack();
  const executor = createExecutor(async () => ({
    ok: false,
    error: {
      code: "worker_failed",
      message: "worker failed",
      retryable: false,
      certainty: "started",
      usage: {
        tokens: 4,
        costMicros: 2,
        authoritative: true,
        source: "agent-supervisor",
      },
    },
  }));
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({
      nodes: [node("plan", { policy: { maxAttempts: 1 } })],
    }),
  );
  await runtime.drain();
  const before = await detailOf(runtime);
  assert.equal(before.state, "failed");
  assert.equal(executor.requests.length, 1);

  const resume: GoalResumeCommand = {
    type: "resume",
    requestId: "agent-resume-failed",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const denied = await runtime.engine.resume(resume, agentAuthority(resume));
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "authority_denied");
    assert.equal(denied.error.details?.reason, "direct_user_required");
  }
  await runtime.drain();
  const after = await detailOf(runtime);
  assert.deepEqual(after, before);
  assert.equal(executor.requests.length, 1);
});

test("edits refuse a running Goal and only apply while it is draft, paused, or blocked", async (t) => {
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
  await submitTo(runtime, submitCommand({ nodes: [node("plan")] }));
  await executor.started(1);

  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-running",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [{ kind: "node-task", nodeId: "plan", prompt: "Do it differently" }],
  };
  const refused = await resumeWith(runtime, command);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "state_conflict");
    assert.equal(refused.error.details?.reason, "edits_require_pause");
  }
});

test("an edited node is re-pinned against the catalog before it runs again", async (t) => {
  const stack = createStack();
  const executor = createExecutor();
  const runtime = stack.make({
    executor: executor as unknown as GoalExecutorPort,
  });
  t.after(() => runtime.close());
  await submitTo(
    runtime,
    submitCommand({ activate: false, nodes: [node("plan")] }),
  );
  const command: GoalResumeCommand = {
    type: "resume",
    requestId: "edit-then-repin",
    goalId: "ship-feature",
    expectedRevision: 1,
    edits: [{ kind: "node-task", nodeId: "plan", prompt: "Do it differently" }],
  };
  const edited = await resumeWith(runtime, command);
  assert.equal(edited.ok, true, JSON.stringify(edited));
  // The Agent Profile catalog moves between the edit and the rerun, so the
  // Attempt must not proceed on a pin nobody re-checked.
  stack.repin(9);
  await runtime.drain();
  const detail = await detailOf(runtime);
  const plan = detail.nodes[0]!;
  assert.equal(plan.state, "blocked");
  assert.equal(plan.blockedReason, "profile_changed");
  assert.equal(executor.requests.length, 0);
});
