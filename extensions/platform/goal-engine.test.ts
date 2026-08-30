import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  createMemoryStateStore,
  createSqliteStateStore,
} from "./src/core/persistence/index.ts";
import type { StateStore } from "./src/core/persistence/state-store.ts";
import {
  createGoalPersistence,
  createGoalRuntime,
  goalCommandDigest,
  type GoalAuthorityVerifier,
  type GoalCommand,
  type GoalCommandAuthority,
  type GoalDeliveryPort,
  type GoalExecutorInspection,
  type GoalExecutorOutcome,
  type GoalExecutorPort,
  type GoalExecutorRequest,
  GOAL_LIMITS,
  type GoalNodeInput,
  type GoalProfilePort,
  type GoalProfileResolution,
  type GoalReviewPort,
  type GoalSubmitCommand,
  type GoalWorkspacePort,
} from "./src/goals/index.ts";

export function createFakeClock(start = 1_000) {
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

function sha256(body: string) {
  return createHash("sha256").update(body).digest("hex");
}

export function completion(
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
        sha256: sha256(body),
        metadata: {
          kind: "goal-worker-output",
          attemptKey: request.attemptKey,
          trust: "worker-reported",
        },
      },
      execution: {
        attemptKey: request.attemptKey,
        childId: `child-${request.attemptKey.slice(0, 8)}`,
        certainty: "started",
      },
      usage: {
        tokens: 10,
        costMicros: 5,
        authoritative: true,
        source: "agent-supervisor",
      },
    },
  };
}

export function createExecutor(
  behaviour: (
    request: GoalExecutorRequest,
    signal?: AbortSignal,
  ) => Promise<GoalExecutorOutcome> = async (request) => completion(request),
) {
  const requests: GoalExecutorRequest[] = [];
  const inspections = new Map<string, GoalExecutorInspection>();
  const waiters: (() => void)[] = [];
  let live = 0;
  let peak = 0;
  return {
    requests,
    inspections,
    get peakConcurrency() {
      return peak;
    },
    metering: { tokens: true, cost: true },
    async run(request: GoalExecutorRequest, signal?: AbortSignal) {
      requests.push(request);
      live += 1;
      peak = Math.max(peak, live);
      try {
        // Start the behaviour first so any gate it registers exists before a
        // waiter observes the start.
        const pending = behaviour(request, signal);
        for (const notify of waiters.splice(0)) notify();
        return await pending;
      } finally {
        live -= 1;
      }
    },
    async inspect(attemptKey: string): Promise<GoalExecutorInspection> {
      return (
        inspections.get(attemptKey) ?? {
          attemptKey,
          state: "unknown",
          certainty: "unknown",
        }
      );
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

export function profile(
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

/**
 * Stand-in for the host approval issuer.
 *
 * Only a token this issuer handed out verifies, so a test that invents a
 * plausible looking token is exercising forgery, not a shortcut.
 */
export function createAuthorityIssuer(seed = "opaque-approval") {
  const issued = new Set<string>([seed]);
  const verifier: GoalAuthorityVerifier = {
    verify(request) {
      const token = request.authority.token;
      return (
        typeof token === "string" &&
        issued.has(token) &&
        request.authority.commandDigest === request.commandDigest &&
        request.authority.projectId === request.projectId &&
        request.authority.sessionId === request.sessionId
      );
    },
  };
  return {
    verifier,
    issue(token: string) {
      issued.add(token);
      return token;
    },
    revoke(token: string) {
      issued.delete(token);
    },
  };
}

export interface HarnessOptions<E extends GoalExecutorPort = GoalExecutorPort> {
  readonly executor?: E;
  readonly profiles?: GoalProfilePort;
  readonly workspaces?: GoalWorkspacePort;
  readonly review?: GoalReviewPort;
  readonly delivery?: GoalDeliveryPort;
  readonly ownerId?: string;
  readonly state?: StateStore;
  readonly clock?: ReturnType<typeof createFakeClock>;
  readonly authority?: GoalAuthorityVerifier | null;
  readonly maxGoals?: number;
  readonly terminalRetentionMs?: number;
}

export function createHarness<
  E extends GoalExecutorPort = ReturnType<typeof createExecutor>,
>(options: HarnessOptions<E> = {}) {
  const clock = options.clock ?? createFakeClock();
  const state =
    options.state ?? createMemoryStateStore({ now: () => clock.now() });
  const artifacts = createInMemoryArtifactStore({ clock: () => clock.now() });
  const executor = (options.executor ?? createExecutor()) as E;
  const workspaceCalls: { type: string; request: unknown }[] = [];
  const reviewCalls: unknown[] = [];
  const deliveries: unknown[] = [];
  const runtime = createGoalRuntime({
    state,
    artifacts,
    clock,
    executor,
    profiles: options.profiles ?? {
      async resolve(name) {
        return { ok: true, value: profile({ name }) };
      },
    },
    workspaces: options.workspaces ?? {
      async prepare(request) {
        workspaceCalls.push({ type: "prepare", request });
        return {
          ok: true,
          value: { workspaceId: "workspace-1", cwd: "/repo/.worktrees/goal" },
        };
      },
      async dispose(request) {
        workspaceCalls.push({ type: "dispose", request });
        return { ok: true, value: { disposition: "released" } };
      },
    },
    review: options.review ?? {
      async verify(request) {
        reviewCalls.push(request);
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
    delivery: options.delivery ?? {
      async deliver(request) {
        deliveries.push(request);
        return { ok: true, value: { state: "delivered" } };
      },
    },
    binding: { projectId: "project-1", cwd: "/repo", sessionId: "session-1" },
    ownerId: options.ownerId ?? "owner-1",
    ...(options.authority === null
      ? {}
      : { authority: options.authority ?? createAuthorityIssuer().verifier }),
    ...(options.maxGoals === undefined ? {} : { maxGoals: options.maxGoals }),
    ...(options.terminalRetentionMs === undefined
      ? {}
      : { terminalRetentionMs: options.terminalRetentionMs }),
  });
  return {
    clock,
    state,
    artifacts,
    executor,
    runtime,
    workspaceCalls,
    reviewCalls,
    deliveries,
    engine: runtime.engine,
  };
}

export function node(
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

export function submitCommand(
  overrides: Partial<GoalSubmitCommand> = {},
): GoalSubmitCommand {
  return {
    type: "submit",
    requestId: "request-1",
    goalId: "ship-feature",
    objective: "Ship the feature",
    nodes: [node("plan"), node("build", { dependsOn: ["plan"] })],
    budget: { maxConcurrency: 2, maxAgentCalls: 8, maxRuntimeMs: 3_600_000 },
    ...overrides,
  };
}

export function authority(
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

export function agentAuthority(command: GoalCommand): GoalCommandAuthority {
  return {
    actor: "agent",
    actorId: "session-1",
    projectId: "project-1",
    sessionId: "session-1",
    commandDigest: goalCommandDigest(command),
  };
}

test("submit persists a bounded graph and reports it through observe", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });
  const receipt = await harness.engine.submit(command, authority(command));
  assert.equal(receipt.ok, true);
  if (!receipt.ok) return;
  assert.equal(receipt.value.replayed, false);
  assert.equal(receipt.value.goal.state, "draft");
  assert.equal(receipt.value.goal.definitionRevision, 1);
  assert.equal(receipt.value.goal.runGeneration, 1);
  assert.deepEqual(
    receipt.value.goal.nodes.map((entry) => entry.state),
    ["waiting", "waiting"],
  );
  assert.equal(harness.executor.requests.length, 0);

  const observed = await harness.engine.observe();
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.goals.length, 1);
  assert.equal(observed.value.goals[0]?.goalId, "ship-feature");
  assert.equal(observed.value.goals[0]?.counts.waiting, 2);
  assert.equal(observed.value.detail, null);
});

test("submit is idempotent per request and refuses a reused request identifier", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });
  const first = await harness.engine.submit(command, authority(command));
  const second = await harness.engine.submit(command, authority(command));
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.replayed, true);
  assert.equal(second.value.goal.definitionRevision, 1);

  const different = submitCommand({
    activate: false,
    goalId: "other-goal",
    objective: "Different objective",
  });
  const conflict = await harness.engine.submit(different, authority(different));
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, "invalid_request");
  assert.equal(conflict.error.details?.reason, "request_conflict");
});

test("a request replays after a crash immediately following its atomic commit", async (t) => {
  const clock = createFakeClock();
  const persisted = createMemoryStateStore({ now: () => clock.now() });
  let crash = true;
  const crashAfterCommit: StateStore = {
    ...persisted,
    async transact(transaction) {
      const result = await persisted.transact(transaction);
      const hasHead = transaction.operations.some(
        (operation) =>
          operation.type === "put-record" &&
          operation.collection.includes("goals.head."),
      );
      const hasReceipt = transaction.operations.some(
        (operation) =>
          operation.type === "put-record" &&
          operation.collection.includes("goals.request."),
      );
      if (crash && result.ok && hasHead && hasReceipt) {
        crash = false;
        throw new Error("simulated process loss after commit");
      }
      return result;
    },
  };
  const beforeCrash = createHarness({ state: crashAfterCommit, clock });
  t.after(() => beforeCrash.runtime.close());
  const command = submitCommand({ activate: false });

  await assert.rejects(
    beforeCrash.engine.submit(command, authority(command)),
    /simulated process loss/,
  );

  const restarted = createHarness({ state: persisted, clock });
  t.after(() => restarted.runtime.close());
  const replayed = await restarted.engine.submit(command, authority(command));
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  assert.equal(replayed.value.replayed, true);
  assert.equal(replayed.value.goal.goalId, command.goalId);
  const observed = await restarted.engine.observe();
  assert.equal(observed.ok, true);
  if (observed.ok) assert.equal(observed.value.goals.length, 1);
});

test("pause, cancel, and resume receipts survive response-loss crashes", async (t) => {
  for (const type of ["pause", "cancel", "resume"] as const) {
    const clock = createFakeClock();
    const persisted = createMemoryStateStore({ now: () => clock.now() });
    const seeded = createHarness({ state: persisted, clock });
    const submit = submitCommand({
      activate: false,
      requestId: `seed-${type}`,
    });
    await seeded.engine.submit(submit, authority(submit));
    await seeded.runtime.close();

    let crash = true;
    const crashAfterCommit: StateStore = {
      ...persisted,
      async transact(transaction) {
        const result = await persisted.transact(transaction);
        if (
          crash &&
          result.ok &&
          transaction.operations.some(
            (operation) =>
              operation.type === "put-record" &&
              operation.collection.includes("goals.head."),
          ) &&
          transaction.operations.some(
            (operation) =>
              operation.type === "put-record" &&
              operation.collection.includes("goals.request."),
          )
        ) {
          crash = false;
          throw new Error(`lost ${type} response`);
        }
        return result;
      },
    };
    const command: Exclude<GoalCommand, GoalSubmitCommand> = {
      type,
      requestId: `${type}-atomic`,
      goalId: submit.goalId,
      expectedRevision: 1,
    };
    const beforeCrash = createHarness({ state: crashAfterCommit, clock });
    const invoke = () => {
      if (command.type === "pause")
        return beforeCrash.engine.pause(command, authority(command));
      if (command.type === "cancel")
        return beforeCrash.engine.cancel(command, authority(command));
      return beforeCrash.engine.resume(command, authority(command));
    };
    await assert.rejects(invoke(), new RegExp(`lost ${type} response`));
    await beforeCrash.runtime.close();

    const restarted = createHarness({ state: persisted, clock });
    t.after(() => restarted.runtime.close());
    const replayed =
      command.type === "pause"
        ? await restarted.engine.pause(command, authority(command))
        : command.type === "cancel"
          ? await restarted.engine.cancel(command, authority(command))
          : await restarted.engine.resume(command, authority(command));
    assert.equal(replayed.ok, true, type);
    if (replayed.ok) assert.equal(replayed.value.replayed, true, type);
    await restarted.runtime.close();
  }
});

test("submit refuses to reuse a goal identifier", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const first = submitCommand({ activate: false });
  await harness.engine.submit(first, authority(first));
  const second = submitCommand({ activate: false, requestId: "request-2" });
  const result = await harness.engine.submit(second, authority(second));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "already_exists");
});

test("submission requires unexpired, digest bound, direct user authority", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });

  const agent = await harness.engine.submit(command, agentAuthority(command));
  assert.equal(agent.ok, false);
  if (!agent.ok) {
    assert.equal(agent.error.code, "authority_denied");
    assert.equal(agent.error.details?.reason, "direct_user_required");
  }

  const forged = await harness.engine.submit(
    command,
    authority(command, {
      commandDigest: goalCommandDigest(
        submitCommand({ activate: false, objective: "Something else" }),
      ),
    }),
  );
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error.details?.reason, "digest_mismatch");

  const expired = await harness.engine.submit(
    command,
    authority(command, { expiresAt: 500 }),
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.details?.reason, "expired");

  const foreign = await harness.engine.submit(
    command,
    authority(command, { projectId: "other-project" }),
  );
  assert.equal(foreign.ok, false);
  if (!foreign.ok)
    assert.equal(foreign.error.details?.reason, "binding_mismatch");

  const untokened = await harness.engine.submit(
    command,
    authority(command, { token: "" }),
  );
  assert.equal(untokened.ok, false);
  if (!untokened.ok)
    assert.equal(untokened.error.details?.reason, "missing_token");

  assert.equal(harness.executor.requests.length, 0);
});

test("a forged direct user token is refused by the host issuer", async (t) => {
  const issuer = createAuthorityIssuer();
  const harness = createHarness({ authority: issuer.verifier });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });

  const forged = await harness.engine.submit(
    command,
    authority(command, { token: "definitely-not-issued" }),
  );
  assert.equal(forged.ok, false);
  if (!forged.ok) {
    assert.equal(forged.error.code, "authority_denied");
    assert.equal(forged.error.details?.reason, "token_rejected");
  }

  const oversized = await harness.engine.submit(
    command,
    authority(command, { token: "x".repeat(513) }),
  );
  assert.equal(oversized.ok, false);
  if (!oversized.ok)
    assert.equal(oversized.error.details?.reason, "invalid_token");

  // A token issued for one command never authorizes another: the issuer sees
  // the digest the engine recomputed, not the caller's copy of it.
  const other = submitCommand({
    activate: false,
    goalId: "other-goal",
    requestId: "request-other",
  });
  const wrongCommand = await harness.engine.submit(other, {
    ...authority(other),
    commandDigest: goalCommandDigest(other),
    token: issuer.issue("issued-for-ship-feature"),
  });
  assert.equal(wrongCommand.ok, true);

  issuer.revoke("issued-for-ship-feature");
  const stale = await harness.engine.submit(
    submitCommand({
      activate: false,
      goalId: "third-goal",
      requestId: "request-third",
    }),
    {
      ...authority(
        submitCommand({
          activate: false,
          goalId: "third-goal",
          requestId: "request-third",
        }),
      ),
      token: "issued-for-ship-feature",
    },
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.details?.reason, "token_rejected");

  const accepted = await harness.engine.submit(command, authority(command));
  assert.equal(accepted.ok, true);
  assert.equal(harness.executor.requests.length, 0);
});

async function settleMicrotasks(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a long Attempt renews its node lease across several lease lifetimes", async (t) => {
  const clock = createFakeClock();
  const gate = deferred<GoalExecutorOutcome>();
  let dispatched: GoalExecutorRequest | undefined;
  const executor = createExecutor(async (request) => {
    dispatched = request;
    return gate.promise;
  });
  const harness = createHarness({ clock, executor });
  t.after(() => {
    // Never let a stalled worker keep the runtime alive past a failed assert.
    gate.resolve({
      ok: false,
      error: {
        code: "cancelled",
        message: "test teardown",
        retryable: false,
        certainty: "not-started",
      },
    });
    return harness.runtime.close();
  });
  // A worker allowed to run for fifteen minutes outlives the five minute node
  // lease three times over.
  const command = submitCommand({
    nodes: [node("plan", { policy: { timeoutMs: 900_000 } })],
  });
  await harness.engine.submit(command, authority(command));
  await harness.executor.started(1);

  const persistence = createGoalPersistence(harness.state, "project-1");
  const resource = persistence.leaseResource("ship-feature", "plan");
  const leaseNow = async () => {
    const result = await harness.state.query({ type: "lease", resource });
    return result.ok && result.value.type === "lease"
      ? result.value.lease
      : null;
  };
  const claimed = await leaseNow();
  assert.ok(claimed);
  assert.equal(claimed.owner, "owner-1");
  const claimedExpiry = claimed.expiresAt;

  for (let step = 0; step < 9; step += 1) {
    clock.advance(100_000);
    await settleMicrotasks();
    const lease = await leaseNow();
    assert.ok(lease, `lease missing at step ${step}`);
    assert.equal(lease.owner, "owner-1");
    assert.ok(
      lease.expiresAt > clock.now(),
      `lease expired at step ${step}: ${lease.expiresAt} <= ${clock.now()}`,
    );
  }
  // Without renewal the original claim would have lapsed twice over by now.
  assert.ok(claimedExpiry < clock.now());
  const renewed = await leaseNow();
  assert.ok(renewed);
  assert.equal(renewed.fence, claimed.fence);
  assert.ok(
    Number(renewed.metadata.renewal) >= 3,
    `renewals: ${JSON.stringify(renewed.metadata)}`,
  );

  assert.ok(dispatched);
  gate.resolve(completion(dispatched));
  await harness.runtime.drain();

  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "done");
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(
    observed.value.detail?.nodes[0]?.attempts[0]?.phase,
    "succeeded",
  );
  assert.equal(observed.value.detail?.budget.consumed.calls, 1);
  assert.equal(observed.value.detail?.budget.reserved.calls, 0);
  const released = await leaseNow();
  assert.equal(released?.owner, null);
  assert.equal(harness.executor.requests.length, 1);
});

test("a runtime without a host issuer accepts no direct user command", async (t) => {
  const harness = createHarness({ authority: null });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });

  const refused = await harness.engine.submit(command, authority(command));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "authority_denied");
    assert.equal(refused.error.details?.reason, "unverifiable_token");
  }

  const observed = await harness.engine.observe();
  assert.equal(observed.ok, true);
  if (observed.ok) assert.equal(observed.value.goals.length, 0);
});

test("an activated graph runs in dependency order and completes with evidence", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand();
  const receipt = await harness.engine.submit(command, authority(command));
  assert.equal(receipt.ok, true);
  await harness.runtime.drain();

  assert.deepEqual(
    harness.executor.requests.map((request) => request.prompt),
    ["Do plan", "Do build"],
  );
  const pinned = harness.executor.requests[0]!;
  assert.equal(pinned.profile.name, "goal-worker");
  assert.equal(pinned.profile.contentDigest, "a".repeat(64));
  assert.equal(pinned.projectId, "project-1");
  assert.equal(pinned.cwd, "/repo");
  assert.match(pinned.attemptKey, /^[a-f0-9]{64}$/);

  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  const goal = observed.value.detail!;
  assert.equal(goal.state, "done");
  assert.deepEqual(
    goal.nodes.map((entry) => entry.state),
    ["done", "done"],
  );
  const evidence = goal.nodes[0]!.evidence;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "worker-output");
  assert.equal(evidence[0]?.trust, "worker-reported");
  assert.equal(evidence[0]?.definitionRevision, 1);
  assert.match(evidence[0]?.artifact?.sha256 ?? "", /^[a-f0-9]{64}$/);
  const stored = await harness.artifacts.get(evidence[0]!.artifact!.id);
  assert.equal(stored.ok, true);
  assert.equal(goal.budget.consumed.calls, 2);
  assert.equal(goal.budget.reserved.calls, 0);
  assert.equal(harness.deliveries.length, 1);
});

test("worker output that misreports its digest fails the attempt", async (t) => {
  const harness = createHarness({
    executor: createExecutor(async (request) => {
      const outcome = completion(request);
      if (!outcome.ok) return outcome;
      return {
        ok: true,
        value: {
          ...outcome.value,
          artifact: { ...outcome.value.artifact, sha256: "b".repeat(64) },
        },
      };
    }),
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ nodes: [node("plan")] });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "failed");
  assert.equal(
    observed.value.detail?.nodes[0]?.lastError?.code,
    "artifact_failed",
  );
});

test("concurrency stays within the goal budget", async (t) => {
  const gates = new Map<
    string,
    ReturnType<typeof deferred<GoalExecutorOutcome>>
  >();
  const executor = createExecutor(async (request) => {
    const gate = deferred<GoalExecutorOutcome>();
    gates.set(request.attemptKey, gate);
    return gate.promise;
  });
  const harness = createHarness({ executor });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("a"), node("b"), node("c"), node("d")],
    budget: { maxConcurrency: 2, maxAgentCalls: 8, maxRuntimeMs: 3_600_000 },
  });
  await harness.engine.submit(command, authority(command));
  await executor.started(2);
  assert.equal(executor.requests.length, 2);
  assert.equal(executor.peakConcurrency, 2);

  for (const [key, gate] of [...gates]) {
    gates.delete(key);
    gate.resolve(
      completion(
        executor.requests.find((request) => request.attemptKey === key)!,
      ),
    );
  }
  await executor.started(4);
  assert.equal(executor.peakConcurrency, 2);
  for (const [key, gate] of [...gates]) {
    gates.delete(key);
    gate.resolve(
      completion(
        executor.requests.find((request) => request.attemptKey === key)!,
      ),
    );
  }
  await harness.runtime.drain();
  assert.equal(executor.requests.length, 4);
  assert.equal(executor.peakConcurrency, 2);
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok && observed.value.detail?.state, "done");
});

test("multi-runtime claims enforce maxConcurrency atomically on memory and native SQLite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "goal-claim-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = createFakeClock();
  const sqlitePath = join(directory, "state.sqlite");
  const firstSqlite = createSqliteStateStore({
    path: sqlitePath,
    now: () => clock.now(),
  });
  assert.equal(firstSqlite.ok, true);
  if (!firstSqlite.ok) return;
  const secondSqlite = createSqliteStateStore({
    path: sqlitePath,
    now: () => clock.now(),
  });
  assert.equal(secondSqlite.ok, true);
  if (!secondSqlite.ok) return;
  const memory = createMemoryStateStore({ now: () => clock.now() });
  const cases = [
    { name: "memory", first: memory, second: memory },
    { name: "sqlite", first: firstSqlite.value, second: secondSqlite.value },
  ];

  for (const entry of cases) {
    const firstGate = deferred<GoalExecutorOutcome>();
    const firstExecutor = createExecutor(async () => firstGate.promise);
    const first = createHarness({
      state: entry.first,
      clock,
      executor: firstExecutor,
      ownerId: `${entry.name}-owner-1`,
    });
    const command = submitCommand({
      requestId: `${entry.name}-submit`,
      goalId: `${entry.name}-goal`,
      nodes: [node("alpha"), node("beta")],
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 1_200_000,
      },
    });
    await first.engine.submit(command, authority(command));
    await firstExecutor.started(1);

    const staleSnapshot: StateStore = {
      ...entry.second,
      async query(query) {
        const result = await entry.second.query(query);
        if (
          !result.ok ||
          result.value.type !== "records" ||
          query.type !== "records" ||
          !query.collection.includes("goals.node.")
        )
          return result;
        return {
          ok: true,
          value: {
            type: "records",
            records: result.value.records.map((record) =>
              record.key.endsWith(":alpha")
                ? {
                    ...record,
                    metadata: {
                      ...record.metadata,
                      state: "done",
                    },
                  }
                : record,
            ),
          },
        };
      },
    };
    const secondExecutor = createExecutor();
    const second = createHarness({
      state: staleSnapshot,
      clock,
      executor: secondExecutor,
      ownerId: `${entry.name}-owner-2`,
    });
    await second.runtime.drain();
    assert.equal(secondExecutor.requests.length, 0, entry.name);

    const cancel = {
      type: "cancel" as const,
      requestId: `${entry.name}-cancel`,
      goalId: command.goalId,
      expectedRevision: 1,
    };
    await first.engine.cancel(cancel, authority(cancel));
    firstGate.resolve(completion(firstExecutor.requests[0]!));
    await first.runtime.drain();
    await first.runtime.close();
    await second.runtime.close();
  }
});

test("retryable failures back off and eventually succeed", async (t) => {
  let failures = 0;
  const harness = createHarness({
    executor: createExecutor(async (request) => {
      if (failures < 2) {
        failures += 1;
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "backend is unavailable",
            retryable: true,
            certainty: "not-started",
          },
        };
      }
      return completion(request);
    }),
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan", { policy: { maxAttempts: 3, retryDelayMs: 1_000 } })],
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();

  let observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(
    observed.ok && observed.value.detail?.nodes[0]?.state,
    "retry-wait",
  );

  harness.clock.advance(1_000);
  await harness.runtime.drain();
  observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(
    observed.ok && observed.value.detail?.nodes[0]?.state,
    "retry-wait",
  );

  harness.clock.advance(2_000);
  await harness.runtime.drain();
  observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "done");
  assert.equal(observed.value.detail?.nodes[0]?.attemptCount, 3);
});

test("attempts stop at the declared maximum", async (t) => {
  const harness = createHarness({
    executor: createExecutor(async () => ({
      ok: false,
      error: {
        code: "run_failed",
        message: "worker failed",
        retryable: true,
        certainty: "started",
      },
    })),
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan", { policy: { maxAttempts: 2, retryDelayMs: 0 } })],
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.attemptCount, 2);
  assert.equal(observed.value.detail?.nodes[0]?.state, "failed");
  assert.equal(observed.value.detail?.state, "failed");
});

test("a dependent of a failed node never runs", async (t) => {
  const harness = createHarness({
    executor: createExecutor(async (request) =>
      request.prompt === "Do plan"
        ? {
            ok: false,
            error: {
              code: "run_failed",
              message: "worker failed",
              retryable: false,
              certainty: "started",
            },
          }
        : completion(request),
    ),
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand();
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  const states = Object.fromEntries(
    observed.value.detail!.nodes.map((entry) => [entry.id, entry.state]),
  );
  assert.equal(states.plan, "failed");
  assert.equal(states.build, "blocked");
  assert.equal(harness.executor.requests.length, 1);
});

test("ambiguous execution blocks the goal instead of dispatching again", async (t) => {
  const harness = createHarness({
    executor: createExecutor(async () => ({
      ok: false,
      error: {
        code: "execution_unknown",
        message: "child outcome cannot be proven",
        retryable: true,
        certainty: "unknown",
        workspaceId: "workspace-1",
      },
    })),
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan", { policy: { maxAttempts: 3, retryDelayMs: 0 } })],
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  harness.clock.advance(600_000);
  await harness.runtime.drain();

  assert.equal(harness.executor.requests.length, 1);
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.state, "blocked");
  assert.equal(observed.value.detail?.nodes[0]?.state, "blocked");
  assert.equal(
    observed.value.detail?.nodes[0]?.attempts.at(-1)?.phase,
    "unknown",
  );
  assert.equal(observed.value.detail?.blockedReason, "unknown-attempt");
});

test("an unmetered executor rejects a finite token budget before persistence or dispatch", async (t) => {
  const executor = createExecutor(async (request) => {
    const done = completion(request);
    if (!done.ok) return done;
    // No metering was declared, so this reported figure is not evidence.
    return {
      ok: true,
      value: {
        ...done.value,
        usage: {
          tokens: 3,
          costMicros: 0,
          authoritative: true,
          source: "worker-claim",
        },
      },
    };
  });
  const harness = createHarness({
    executor: { ...executor, metering: { tokens: false, cost: false } },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan", { reservation: { tokens: 500 } })],
    budget: {
      maxConcurrency: 1,
      maxAgentCalls: 4,
      maxRuntimeMs: 3_600_000,
      maxTokens: 1_200,
    },
  });
  const submitted = await harness.engine.submit(command, authority(command));
  assert.equal(submitted.ok, false);
  if (!submitted.ok) {
    assert.equal(submitted.error.code, "metering_unavailable");
    assert.equal(submitted.error.details?.limit, "tokens");
  }
  assert.equal(harness.executor.requests.length, 0);
  const persistence = createGoalPersistence(harness.state, "project-1");
  const storedHead = await persistence.loadHead(command.goalId);
  const storedRequest = await persistence.loadRequest(
    command.goalId,
    command.requestId,
  );
  assert.equal(storedHead.ok, true);
  assert.equal(storedRequest.ok, true);
  if (storedHead.ok) assert.equal(storedHead.value, null);
  if (storedRequest.ok) assert.equal(storedRequest.value, null);
});

test("a token budget with nothing reserved per Attempt is refused", async (t) => {
  const harness = createHarness({
    executor: {
      ...createExecutor(async () => {
        throw new Error("must not dispatch");
      }),
      metering: { tokens: false, cost: false },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan")],
    budget: {
      maxConcurrency: 1,
      maxAgentCalls: 4,
      maxRuntimeMs: 3_600_000,
      maxTokens: 10_000,
    },
  });
  const refused = await harness.engine.submit(command, authority(command));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "invalid_request");
    assert.equal(refused.error.details?.reason, "missing_token_reservation");
  }
});

test("an unpriced executor rejects a finite cost budget before persistence or dispatch", async (t) => {
  const executor = createExecutor(async (request) => {
    const done = completion(request);
    if (!done.ok) return done;
    return {
      ok: true,
      value: {
        ...done.value,
        usage: {
          tokens: 10,
          // The worker claims a trivial cost. This executor does not price
          // runs, so that number is not evidence and must not be charged.
          costMicros: 1,
          authoritative: true,
          source: "agent-supervisor",
        },
      },
    };
  });
  const harness = createHarness({
    executor: { ...executor, metering: { tokens: true, cost: false } },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [
      node("plan", {
        reservation: { tokens: 500, costMicros: 2_000 },
      }),
    ],
    budget: {
      maxConcurrency: 1,
      maxAgentCalls: 8,
      maxRuntimeMs: 3_600_000,
      maxTokens: 10_000,
      maxCostMicros: 6_000,
    },
  });
  const submitted = await harness.engine.submit(command, authority(command));
  assert.equal(submitted.ok, false);
  if (!submitted.ok) {
    assert.equal(submitted.error.code, "metering_unavailable");
    assert.equal(submitted.error.details?.limit, "cost");
  }
  assert.equal(harness.executor.requests.length, 0);
  const persistence = createGoalPersistence(harness.state, "project-1");
  const storedHead = await persistence.loadHead(command.goalId);
  const storedRequest = await persistence.loadRequest(
    command.goalId,
    command.requestId,
  );
  assert.equal(storedHead.ok, true);
  assert.equal(storedRequest.ok, true);
  if (storedHead.ok) assert.equal(storedHead.value, null);
  if (storedRequest.ok) assert.equal(storedRequest.value, null);
});

test("an authoritative executor receives and enforces finite token and cost dimensions", async (t) => {
  for (const dimension of ["tokens", "costMicros"] as const) {
    const executor = createExecutor(async (request) => {
      const ceiling =
        dimension === "tokens" ? request.maxTokens : request.maxCostMicros;
      assert.equal(ceiling, 40);
      return {
        ok: false,
        error: {
          code: dimension === "tokens" ? "token_bounded" : "cost_bounded",
          message: `${dimension} ceiling reached`,
          retryable: false,
          certainty: "started",
          usage: {
            tokens: dimension === "tokens" ? 40 : 0,
            costMicros: dimension === "costMicros" ? 40 : 0,
            authoritative: true,
            source: "authoritative-fake",
          },
        },
      };
    });
    const harness = createHarness({ executor });
    t.after(() => harness.runtime.close());
    const command = submitCommand({
      goalId: `bounded-${dimension.toLowerCase()}`,
      requestId: `request-${dimension.toLowerCase()}`,
      nodes: [
        node("bounded", {
          reservation: {
            tokens: dimension === "tokens" ? 40 : 0,
            costMicros: dimension === "costMicros" ? 40 : 0,
          },
        }),
      ],
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 1,
        maxRuntimeMs: 3_600_000,
        ...(dimension === "tokens"
          ? { maxTokens: 100 }
          : { maxCostMicros: 100 }),
      },
    });
    const submitted = await harness.engine.submit(command, authority(command));
    assert.equal(submitted.ok, true);
    await harness.runtime.drain();

    const observed = await harness.engine.observe({ goalId: command.goalId });
    assert.equal(observed.ok, true);
    if (!observed.ok) continue;
    assert.equal(observed.value.detail?.nodes[0]?.state, "failed");
    assert.equal(observed.value.detail?.budget.consumed[dimension], 40);
    assert.equal(
      observed.value.detail?.nodes[0]?.attempts[0]?.usage?.authoritative,
      true,
    );
  }
});

test("a declared cost meter that omits settlement cost fails closed", async (t) => {
  const baseExecutor = createExecutor(async (request) => {
    assert.equal(request.maxCostMicros, 40);
    const done = completion(request);
    if (!done.ok) return done;
    const { costMicros: _missing, ...usage } = done.value.usage!;
    return {
      ok: true as const,
      value: { ...done.value, usage },
    };
  });
  const executor = {
    ...baseExecutor,
    metering: { tokens: false, cost: true },
  };
  const harness = createHarness({ executor });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan", { reservation: { costMicros: 40 } })],
    budget: {
      maxConcurrency: 1,
      maxAgentCalls: 2,
      maxRuntimeMs: 3_600_000,
      maxCostMicros: 40,
    },
  });
  assert.equal(
    (await harness.engine.submit(command, authority(command))).ok,
    true,
  );
  await harness.runtime.drain();

  const observed = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(observed.ok, true);
  if (!observed.ok || !observed.value.detail) return;
  assert.equal(observed.value.detail.nodes[0]?.state, "failed");
  assert.equal(
    observed.value.detail.nodes[0]?.lastError?.code,
    "metering_unavailable",
  );
  assert.equal(observed.value.detail.budget.consumed.costMicros, 0);
  assert.equal(observed.value.detail.nodes[0]?.attempts[0]?.usage, null);
});

test("an unmetered fast completion cannot masquerade as token or cost usage", async (t) => {
  const executor = createExecutor(async (request) => {
    const done = completion(request);
    if (!done.ok) return done;
    return {
      ok: true,
      value: {
        ...done.value,
        usage: {
          tokens: 1,
          costMicros: 1,
          authoritative: true,
          source: "unmetered-worker-claim",
        },
      },
    };
  });
  const harness = createHarness({
    executor: { ...executor, metering: { tokens: false, cost: false } },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [
      node("fast", {
        reservation: { runtimeMs: 60_000, tokens: 500, costMicros: 400 },
      }),
    ],
  });
  const submitted = await harness.engine.submit(command, authority(command));
  assert.equal(submitted.ok, true);
  await harness.runtime.drain();

  const observed = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(observed.value.detail?.budget.consumed.tokens, 0);
  assert.equal(observed.value.detail?.budget.consumed.costMicros, 0);
  assert.equal(observed.value.detail?.nodes[0]?.attempts[0]?.usage, null);
});

test("an exhausted call budget blocks instead of dispatching", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("a"), node("b")],
    budget: { maxConcurrency: 1, maxAgentCalls: 1, maxRuntimeMs: 3_600_000 },
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(harness.executor.requests.length, 1);
  assert.equal(observed.value.detail?.state, "blocked");
  assert.equal(observed.value.detail?.budget.consumed.calls, 1);
});

test("a profile that is not a goal worker is refused at submission", async (t) => {
  const harness = createHarness({
    profiles: {
      async resolve(name) {
        return { ok: true, value: profile({ name, role: "subagent" }) };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand();
  const result = await harness.engine.submit(command, authority(command));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "profile_denied");
    assert.equal(result.error.details?.reason, "role_denied");
  }
});

test("a profile that changed after submission blocks the node before dispatch", async (t) => {
  let generation = 3;
  const harness = createHarness({
    profiles: {
      async resolve(name) {
        return {
          ok: true,
          value: profile({
            name,
            catalogGeneration: generation,
            contentDigest: generation === 3 ? "a".repeat(64) : "c".repeat(64),
          }),
        };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false, nodes: [node("plan")] });
  await harness.engine.submit(command, authority(command));
  generation = 4;
  const resume = {
    type: "resume" as const,
    requestId: "request-resume",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const resumed = await harness.engine.resume(resume, authority(resume));
  assert.equal(resumed.ok, true);
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(harness.executor.requests.length, 0);
  assert.equal(
    observed.value.detail?.nodes[0]?.blockedReason,
    "profile_changed",
  );
  assert.equal(observed.value.detail?.state, "blocked");
  assert.equal(observed.value.detail?.budget.reserved.calls, 0);
});

test("isolated profiles receive a prepared workspace and a disposition", async (t) => {
  const harness = createHarness({
    profiles: {
      async resolve(name) {
        return {
          ok: true,
          value: profile({ name, workspacePolicy: "isolated" }),
        };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ nodes: [node("plan")] });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  assert.equal(harness.executor.requests[0]?.cwd, "/repo/.worktrees/goal");
  assert.deepEqual(
    harness.workspaceCalls.map((entry) => entry.type),
    ["prepare", "dispose"],
  );
});

test("host verified criteria gate node completion", async (t) => {
  const harness = createHarness({
    review: {
      async verify(request) {
        return {
          ok: true,
          value: {
            satisfied: false,
            kind: "review-report",
            summary: `not verified ${request.criterionId}`,
            artifact: null,
          },
        };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [
      node("plan", {
        policy: { maxAttempts: 1 },
        criteria: [
          {
            id: "reviewed",
            description: "Reviewed by the host",
            acceptedEvidenceKinds: ["review-report"],
            minimumEvidenceCount: 1,
            minimumTrust: "host-verified",
          },
        ],
      }),
    ],
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "failed");
  assert.equal(
    observed.value.detail?.nodes[0]?.lastError?.code,
    "evidence_missing",
  );
});

test("satisfied host verified criteria complete the node", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [
      node("plan", {
        criteria: [
          {
            id: "reviewed",
            description: "Reviewed by the host",
            acceptedEvidenceKinds: ["review-report"],
            minimumEvidenceCount: 1,
            minimumTrust: "host-verified",
          },
        ],
      }),
    ],
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(harness.reviewCalls.length, 1);
  assert.equal(
    observed.value.detail?.nodes[0]?.evidence.some(
      (entry) => entry.trust === "host-verified",
    ),
    true,
  );
});

test("unmet goal criteria block completion even when every node is done", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({
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
  });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: "ship-feature" });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "done");
  assert.equal(observed.value.detail?.state, "blocked");
  assert.equal(observed.value.detail?.blockedReason, "goal-criteria-unmet");
});

test("outcome delivery sees a durable pending outbox intent before side effects", async (t) => {
  const clock = createFakeClock();
  const state = createMemoryStateStore({ now: () => clock.now() });
  let pendingAtDelivery = false;
  const harness = createHarness({
    clock,
    state,
    delivery: {
      async deliver() {
        const exported = await state.export({ format: "snapshot" });
        pendingAtDelivery =
          exported.ok &&
          exported.value.format === "snapshot" &&
          exported.value.snapshot.records.some(
            (record) =>
              record.collection.includes("goals.outbox.") &&
              record.metadata.result === "pending",
          );
        return { ok: true, value: { state: "delivered" } };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ nodes: [node("plan")] });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.drain();
  assert.equal(pendingAtDelivery, true);
});

test("a failed outbox receipt commit is recovered with the same delivery identity", async (t) => {
  const clock = createFakeClock();
  const persisted = createMemoryStateStore({ now: () => clock.now() });
  let rejectReceipt = true;
  const failReceiptOnce: StateStore = {
    ...persisted,
    async transact(transaction) {
      if (
        rejectReceipt &&
        transaction.operations.some(
          (operation) =>
            operation.type === "put-record" &&
            operation.collection.includes("goals.outbox.") &&
            typeof operation.expectedVersion === "number" &&
            operation.metadata.result === "delivered",
        )
      ) {
        rejectReceipt = false;
        return {
          ok: false,
          error: {
            code: "STORAGE_FAILED",
            message: "simulated receipt failure",
            retryable: true,
          },
        };
      }
      return persisted.transact(transaction);
    },
  };
  const deliveryIds: string[] = [];
  const delivery: GoalDeliveryPort = {
    async deliver(request) {
      deliveryIds.push(request.deliveryId);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const first = createHarness({ state: failReceiptOnce, clock, delivery });
  const command = submitCommand({ nodes: [node("plan")] });
  await first.engine.submit(command, authority(command));
  await first.runtime.drain();
  await first.runtime.close();

  const restarted = createHarness({ state: persisted, clock, delivery });
  t.after(() => restarted.runtime.close());
  await restarted.runtime.drain();
  assert.equal(deliveryIds.length, 2);
  assert.equal(deliveryIds[0], deliveryIds[1]);
  const exported = await persisted.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (!exported.ok || exported.value.format !== "snapshot") return;
  const outbox = exported.value.snapshot.records.find((record) =>
    record.collection.includes("goals.outbox."),
  );
  assert.equal(outbox?.metadata.result, "delivered");
});

test("pause stops scheduling and cancel closes the goal", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });
  await harness.engine.submit(command, authority(command));

  const pause = {
    type: "pause" as const,
    requestId: "request-pause",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "user paused",
  };
  const paused = await harness.engine.pause(pause, agentAuthority(pause));
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(paused.value.goal.state, "paused");
  await harness.runtime.drain();
  assert.equal(harness.executor.requests.length, 0);

  const cancel = {
    type: "cancel" as const,
    requestId: "request-cancel",
    goalId: "ship-feature",
    expectedRevision: 1,
    reason: "no longer needed",
  };
  const cancelled = await harness.engine.cancel(cancel, authority(cancel));
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(cancelled.value.goal.state, "cancelled");
  assert.deepEqual(
    cancelled.value.goal.nodes.map((entry) => entry.state),
    ["cancelled", "cancelled"],
  );
  await harness.runtime.drain();
  assert.equal(harness.executor.requests.length, 0);

  const again = { ...pause, requestId: "request-pause-2" };
  const afterCancel = await harness.engine.pause(again, authority(again));
  assert.equal(afterCancel.ok, false);
  if (!afterCancel.ok) assert.equal(afterCancel.error.code, "state_conflict");
});

test("a late completion after cancel charges and releases its reservation without reviving the node", async (t) => {
  const gate = deferred<GoalExecutorOutcome>();
  const executor = createExecutor(async () => gate.promise);
  const harness = createHarness({ executor });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    nodes: [node("plan", { reservation: { runtimeMs: 60_000 } })],
    budget: { maxConcurrency: 1, maxAgentCalls: 2, maxRuntimeMs: 120_000 },
  });
  await harness.engine.submit(command, authority(command));
  await executor.started(1);
  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-running",
    goalId: command.goalId,
    expectedRevision: 1,
  };
  const cancelled = await harness.engine.cancel(cancel, authority(cancel));
  assert.equal(cancelled.ok, true);

  gate.resolve(completion(executor.requests[0]!));
  await harness.runtime.drain();
  const observed = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(observed.ok, true);
  if (!observed.ok || !observed.value.detail) return;
  assert.equal(observed.value.detail.state, "cancelled");
  assert.equal(observed.value.detail.nodes[0]?.state, "cancelled");
  assert.equal(observed.value.detail.budget.reserved.calls, 0);
  assert.equal(observed.value.detail.budget.consumed.calls, 1);
});

test("cancel during preparation durably fences dispatch so no child starts", async (t) => {
  const preparing = deferred<void>();
  const release = deferred<{
    ok: true;
    value: { workspaceId: string; cwd: string };
  }>();
  const executor = createExecutor();
  const harness = createHarness({
    executor,
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
        preparing.resolve();
        return release.promise;
      },
      async dispose() {
        return { ok: true, value: { disposition: "released" } };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({ nodes: [node("plan")] });
  await harness.engine.submit(command, authority(command));
  await preparing.promise;

  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-before-dispatch",
    goalId: command.goalId,
    expectedRevision: 1,
  };
  const cancelled = await harness.engine.cancel(cancel, authority(cancel));
  assert.equal(cancelled.ok, true);
  release.resolve({
    ok: true,
    value: { workspaceId: "prepared-too-late", cwd: "/repo/late" },
  });
  await harness.runtime.drain();

  assert.equal(executor.requests.length, 0);
  const observed = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(observed.ok, true);
  if (!observed.ok || !observed.value.detail) return;
  assert.equal(observed.value.detail.state, "cancelled");
  assert.equal(observed.value.detail.nodes[0]?.state, "cancelled");
  assert.equal(observed.value.detail.budget.reserved.calls, 0);
});

test("commands check the expected revision", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  const command = submitCommand({ activate: false });
  await harness.engine.submit(command, authority(command));
  const pause = {
    type: "pause" as const,
    requestId: "request-pause",
    goalId: "ship-feature",
    expectedRevision: 7,
  };
  const result = await harness.engine.pause(pause, authority(pause));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "revision_conflict");
});

test("full-bound head audit remains below State Record metadata limit", async (t) => {
  const gate = deferred<GoalExecutorOutcome>();
  const executor = createExecutor(async () => gate.promise);
  const harness = createHarness({ executor });
  t.after(async () => {
    if (executor.requests[0]) gate.resolve(completion(executor.requests[0]));
    await harness.runtime.close();
  });
  const command = submitCommand({
    activate: false,
    objective: "o".repeat(GOAL_LIMITS.maxObjectiveLength),
    nodes: [node("plan")],
    criteria: Array.from({ length: GOAL_LIMITS.maxCriteria }, (_, index) => ({
      id: `criterion-${index}`,
      description: "d".repeat(GOAL_LIMITS.maxDescriptionLength),
      acceptedEvidenceKinds: ["user-attestation" as const],
      minimumEvidenceCount: 1,
      minimumTrust: "user-accepted" as const,
    })),
    budget: { maxConcurrency: 1, maxAgentCalls: 2, maxRuntimeMs: 600_000 },
  });
  const submitted = await harness.engine.submit(command, authority(command));
  assert.equal(submitted.ok, true);

  for (let index = 0; index < GOAL_LIMITS.maxHistoryEntries / 2; index += 1) {
    const pause = {
      type: "pause" as const,
      requestId: `head-bound-pause-${index}`,
      goalId: command.goalId,
      expectedRevision: 1,
      reason: `pause-${index}-${"p".repeat(GOAL_LIMITS.maxReasonLength - 10)}`,
    };
    const paused = await harness.engine.pause(pause, authority(pause));
    assert.equal(paused.ok, true, `pause ${index}`);
    const resume = {
      type: "resume" as const,
      requestId: `head-bound-resume-${index}`,
      goalId: command.goalId,
      expectedRevision: 1,
      reason: `resume-${index}-${"r".repeat(GOAL_LIMITS.maxReasonLength - 11)}`,
    };
    const resumed = await harness.engine.resume(resume, authority(resume));
    assert.equal(resumed.ok, true, `resume ${index}`);
  }

  const exported = await harness.state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (!exported.ok || exported.value.format !== "snapshot") return;
  const head = exported.value.snapshot.records.find((record) =>
    record.collection.includes("goals.head."),
  );
  assert.ok(head);
  assert.ok(Buffer.byteLength(JSON.stringify(head.metadata)) <= 64 * 1024);
  const observed = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(observed.ok, true);
  if (observed.ok)
    assert.match(
      observed.value.detail?.history.at(-1)?.reason ?? "",
      /resume-31/,
    );

  const cancel = {
    type: "cancel" as const,
    requestId: "head-bound-cancel",
    goalId: command.goalId,
    expectedRevision: 1,
  };
  await harness.engine.cancel(cancel, authority(cancel));
  if (executor.requests[0]) gate.resolve(completion(executor.requests[0]));
  await harness.runtime.drain();
});

test("observe is bounded, paginated, and refuses unknown goals politely", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  for (let index = 0; index < 5; index += 1) {
    const command = submitCommand({
      activate: false,
      requestId: `request-${index}`,
      goalId: `goal-${index}`,
      nodes: [node("plan")],
    });
    await harness.engine.submit(command, authority(command));
  }
  const page = await harness.engine.observe({ limit: 2 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.value.goals.length, 2);
  assert.equal(page.value.truncated, true);
  assert.equal(page.value.nextCursor, "goal-1");

  const next = await harness.engine.observe({
    limit: 2,
    afterGoalId: "goal-1",
  });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.deepEqual(
    next.value.goals.map((goal) => goal.goalId),
    ["goal-2", "goal-3"],
  );

  const clamped = await harness.engine.observe({ limit: 5_000 });
  assert.equal(clamped.ok, true);
  if (!clamped.ok) return;
  assert.equal(clamped.value.goals.length, 5);
  assert.equal(clamped.value.truncated, false);

  const missing = await harness.engine.observe({ goalId: "nope" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "not_found");

  const filtered = await harness.engine.observe({ state: "running" });
  assert.equal(filtered.ok, true);
  if (filtered.ok) assert.equal(filtered.value.goals.length, 0);
});

test("state filtered observation pages past non matching goals", async (t) => {
  const harness = createHarness();
  t.after(() => harness.runtime.close());
  // Twenty drafts sort ahead of the four goals the caller is filtering for, so
  // a single unfiltered page of heads never reaches a match.
  for (let index = 0; index < 20; index += 1) {
    const command = submitCommand({
      activate: false,
      requestId: `draft-${index}`,
      goalId: `aaa-draft-${String(index).padStart(2, "0")}`,
      nodes: [node("plan")],
    });
    const submitted = await harness.engine.submit(command, authority(command));
    assert.equal(submitted.ok, true);
  }
  const matching: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const goalId = `zzz-ready-${index}`;
    const command = submitCommand({
      activate: false,
      requestId: `ready-${index}`,
      goalId,
      nodes: [node("plan")],
    });
    const submitted = await harness.engine.submit(command, authority(command));
    assert.equal(submitted.ok, true);
    const resume = {
      type: "resume" as const,
      requestId: `activate-${index}`,
      goalId,
      expectedRevision: 1,
    };
    const activated = await harness.engine.resume(resume, authority(resume));
    assert.equal(activated.ok, true);
    matching.push(goalId);
  }
  await harness.runtime.drain();

  const first = await harness.engine.observe({ state: "done", limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(
    first.value.goals.map((goal) => goal.goalId),
    matching.slice(0, 2),
  );
  assert.equal(first.value.truncated, true);
  assert.ok(first.value.nextCursor);

  const second = await harness.engine.observe({
    state: "done",
    limit: 2,
    afterGoalId: first.value.nextCursor!,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    second.value.goals.map((goal) => goal.goalId),
    matching.slice(2),
  );
  assert.equal(second.value.truncated, false);
  assert.equal(second.value.nextCursor, null);

  const all = await harness.engine.observe({ state: "done", limit: 25 });
  assert.equal(all.ok, true);
  if (!all.ok) return;
  assert.deepEqual(
    all.value.goals.map((goal) => goal.goalId),
    matching,
  );
  assert.equal(all.value.truncated, false);

  const drafts = await harness.engine.observe({ state: "draft", limit: 25 });
  assert.equal(drafts.ok, true);
  if (drafts.ok) assert.equal(drafts.value.goals.length, 20);
});

test("the configured Goal cap is enforced and never counts a replay twice", async (t) => {
  const harness = createHarness({ maxGoals: 2 });
  t.after(() => harness.runtime.close());
  const first = submitCommand({
    activate: false,
    goalId: "goal-a",
    requestId: "request-a",
    nodes: [node("plan")],
  });
  assert.equal((await harness.engine.submit(first, authority(first))).ok, true);
  // An idempotent replay returns the stored receipt without consuming a slot.
  const replay = await harness.engine.submit(first, authority(first));
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.value.replayed, true);

  const second = submitCommand({
    activate: false,
    goalId: "goal-b",
    requestId: "request-b",
    nodes: [node("plan")],
  });
  assert.equal(
    (await harness.engine.submit(second, authority(second))).ok,
    true,
  );

  const third = submitCommand({
    activate: false,
    goalId: "goal-c",
    requestId: "request-c",
    nodes: [node("plan")],
  });
  const refused = await harness.engine.submit(third, authority(third));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "capacity_exceeded");
    assert.equal(refused.error.details?.reason, "goal_capacity");
  }
  const observed = await harness.engine.observe({ limit: 25 });
  assert.equal(observed.ok, true);
  if (observed.ok)
    assert.deepEqual(
      observed.value.goals.map((goal) => goal.goalId),
      ["goal-a", "goal-b"],
    );
});

test("two runtimes racing for the last Goal slot admit exactly one", async (t) => {
  const clock = createFakeClock();
  const shared = createMemoryStateStore({ now: () => clock.now() });
  const first = createHarness({ state: shared, clock, maxGoals: 2 });
  const second = createHarness({
    state: shared,
    clock,
    maxGoals: 2,
    ownerId: "owner-2",
  });
  t.after(() => Promise.all([first.runtime.close(), second.runtime.close()]));
  const seed = submitCommand({
    activate: false,
    goalId: "goal-seed",
    requestId: "request-seed",
    nodes: [node("plan")],
  });
  assert.equal((await first.engine.submit(seed, authority(seed))).ok, true);

  const left = submitCommand({
    activate: false,
    goalId: "goal-left",
    requestId: "request-left",
    nodes: [node("plan")],
  });
  const right = submitCommand({
    activate: false,
    goalId: "goal-right",
    requestId: "request-right",
    nodes: [node("plan")],
  });
  const [leftResult, rightResult] = await Promise.all([
    first.engine.submit(left, authority(left)),
    second.engine.submit(right, authority(right)),
  ]);
  const accepted = [leftResult, rightResult].filter((entry) => entry.ok);
  const rejected = [leftResult, rightResult].filter((entry) => !entry.ok);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  const failure = rejected[0];
  assert.ok(failure && !failure.ok);
  if (failure && !failure.ok)
    assert.equal(failure.error.code, "capacity_exceeded");

  const observed = await first.engine.observe({ limit: 25 });
  assert.equal(observed.ok, true);
  if (observed.ok) assert.equal(observed.value.goals.length, 2);
});

test("concurrent lifecycle owners release one terminal capacity slot exactly once", async (t) => {
  const clock = createFakeClock();
  const shared = createMemoryStateStore({ now: () => clock.now() });
  const first = createHarness({
    state: shared,
    clock,
    maxGoals: 2,
    terminalRetentionMs: 0,
  });
  const second = createHarness({
    state: shared,
    clock,
    maxGoals: 2,
    terminalRetentionMs: 0,
    ownerId: "owner-2",
  });
  t.after(() => Promise.all([first.runtime.close(), second.runtime.close()]));
  await Promise.all([first.runtime.drain(), second.runtime.drain()]);

  const survivor = submitCommand({
    activate: false,
    goalId: "capacity-survivor",
    requestId: "request-capacity-survivor",
    nodes: [node("main")],
  });
  const retiring = submitCommand({
    activate: false,
    goalId: "capacity-retiring",
    requestId: "request-capacity-retiring",
    nodes: [node("main")],
  });
  assert.equal(
    (await first.engine.submit(survivor, authority(survivor))).ok,
    true,
  );
  assert.equal(
    (await first.engine.submit(retiring, authority(retiring))).ok,
    true,
  );
  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-capacity-retiring",
    goalId: retiring.goalId,
    expectedRevision: 1,
  };
  assert.equal((await first.engine.cancel(cancel, authority(cancel))).ok, true);

  clock.advance(60_001);
  await Promise.all([first.runtime.drain(), second.runtime.drain()]);
  const persistence = createGoalPersistence(shared, "project-1");
  const capacity = await persistence.loadCapacity();
  assert.equal(capacity.ok, true);
  if (capacity.ok) assert.equal(capacity.value?.value.count, 1);

  const left = submitCommand({
    activate: false,
    goalId: "capacity-left",
    requestId: "request-capacity-left",
    nodes: [node("main")],
  });
  const right = submitCommand({
    activate: false,
    goalId: "capacity-right",
    requestId: "request-capacity-right",
    nodes: [node("main")],
  });
  const admitted = await Promise.all([
    first.engine.submit(left, authority(left)),
    second.engine.submit(right, authority(right)),
  ]);
  assert.equal(admitted.filter((result) => result.ok).length, 1);
  assert.equal(admitted.filter((result) => !result.ok).length, 1);
  const finalCapacity = await persistence.loadCapacity();
  assert.equal(finalCapacity.ok, true);
  if (finalCapacity.ok) assert.equal(finalCapacity.value?.value.count, 2);
  const observed = await first.engine.observe({ limit: 25 });
  assert.equal(observed.ok, true);
  if (observed.ok) assert.equal(observed.value.goals.length, 2);
});

test("terminal Goals are compacted only after retention and never touch workspaces", async (t) => {
  const clock = createFakeClock();
  const harness = createHarness({
    clock,
    maxGoals: 1,
    terminalRetentionMs: 600_000,
  });
  t.after(() => harness.runtime.close());
  const first = submitCommand({
    activate: false,
    goalId: "goal-a",
    requestId: "request-a",
    nodes: [node("plan")],
  });
  assert.equal((await harness.engine.submit(first, authority(first))).ok, true);
  const second = submitCommand({
    activate: false,
    goalId: "goal-b",
    requestId: "request-b",
    nodes: [node("plan")],
  });

  // A live Goal is never compacted to make room.
  const blocked = await harness.engine.submit(second, authority(second));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, "capacity_exceeded");

  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-a",
    goalId: "goal-a",
    expectedRevision: 1,
  };
  assert.equal(
    (await harness.engine.cancel(cancel, authority(cancel))).ok,
    true,
  );

  // Terminal but still inside its retention window.
  const tooEarly = await harness.engine.submit(second, authority(second));
  assert.equal(tooEarly.ok, false);
  if (!tooEarly.ok) assert.equal(tooEarly.error.code, "capacity_exceeded");

  clock.advance(600_001);
  const admitted = await harness.engine.submit(second, authority(second));
  assert.equal(admitted.ok, true);

  const observed = await harness.engine.observe({ limit: 25 });
  assert.equal(observed.ok, true);
  if (observed.ok)
    assert.deepEqual(
      observed.value.goals.map((goal) => goal.goalId),
      ["goal-b"],
    );
  const compacted = await harness.engine.observe({ goalId: "goal-a" });
  assert.equal(compacted.ok, false);
  if (!compacted.ok) assert.equal(compacted.error.code, "not_found");
  // Compaction is record retention only: it never disposes a Guarded Workspace.
  assert.deepEqual(harness.workspaceCalls, []);
});

test("lifecycle sweep retires expired terminal Goals below capacity pressure", async (t) => {
  const clock = createFakeClock();
  const harness = createHarness({
    clock,
    maxGoals: 10,
    terminalRetentionMs: 1_000,
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand({
    activate: false,
    goalId: "below-capacity",
    requestId: "request-below-capacity",
    nodes: [node("plan")],
  });
  assert.equal(
    (await harness.engine.submit(command, authority(command))).ok,
    true,
  );
  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-below-capacity",
    goalId: command.goalId,
    expectedRevision: 1,
  };
  assert.equal(
    (await harness.engine.cancel(cancel, authority(cancel))).ok,
    true,
  );
  await harness.runtime.drain();

  clock.advance(60_001);
  await harness.runtime.drain();

  const retired = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(retired.ok, false);
  if (!retired.ok) assert.equal(retired.error.code, "not_found");
  const persistence = createGoalPersistence(harness.state, "project-1");
  const exported = await harness.state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (!exported.ok || exported.value.format !== "snapshot") return;
  const retainedGoalRecords = exported.value.snapshot.records.filter((record) =>
    Object.values(persistence.collections).includes(record.collection),
  );
  assert.deepEqual(
    retainedGoalRecords.map((record) => [record.collection, record.key]),
    [[persistence.collections.CAPACITY, "goals"]],
  );
  assert.equal(
    exported.value.snapshot.events.filter(
      (event) => event.stream === persistence.eventStream(command.goalId),
    ).length,
    0,
  );
});

test("lifecycle sweep preserves an unreconciled cancellation and its workspace", async (t) => {
  const clock = createFakeClock();
  const gate = deferred<GoalExecutorOutcome>();
  const baseExecutor = createExecutor(async () => gate.promise);
  const executor = {
    ...baseExecutor,
    async inspect(attemptKey: string) {
      return {
        attemptKey,
        state: "running" as const,
        certainty: "started" as const,
        childId: "child-still-running",
        workspaceId: "workspace-1",
      };
    },
  };
  const harness = createHarness({
    clock,
    executor,
    terminalRetentionMs: 0,
    profiles: {
      async resolve(name) {
        return {
          ok: true,
          value: profile({ name, workspacePolicy: "isolated" }),
        };
      },
    },
  });
  t.after(async () => {
    if (baseExecutor.requests[0])
      gate.resolve(completion(baseExecutor.requests[0]));
    await harness.runtime.close();
  });
  const command = submitCommand({
    goalId: "unreconciled-retention",
    requestId: "request-unreconciled-retention",
    nodes: [node("main")],
  });
  assert.equal(
    (await harness.engine.submit(command, authority(command))).ok,
    true,
  );
  await baseExecutor.started(1);
  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-unreconciled-retention",
    goalId: command.goalId,
    expectedRevision: 1,
  };
  assert.equal(
    (await harness.engine.cancel(cancel, authority(cancel))).ok,
    true,
  );

  clock.advance(60_001);
  for (let turn = 0; turn < 4; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));

  const retained = await harness.engine.observe({ goalId: command.goalId });
  assert.equal(retained.ok, true);
  if (retained.ok) {
    assert.equal(retained.value.detail?.state, "cancelled");
    assert.equal(retained.value.detail?.cancellation?.reconciledAt, null);
  }
  assert.deepEqual(
    harness.workspaceCalls.map((entry) => entry.type),
    ["prepare"],
  );
});

test("reusing a retired Goal ID creates a distinct immutable execution generation", async (t) => {
  const clock = createFakeClock();
  const harness = createHarness({ clock, terminalRetentionMs: 0 });
  t.after(() => harness.runtime.close());
  const first = submitCommand({
    goalId: "reusable-goal",
    requestId: "request-reusable-first",
    nodes: [node("main")],
  });
  assert.equal((await harness.engine.submit(first, authority(first))).ok, true);
  await harness.runtime.drain();
  assert.equal(harness.executor.requests.length, 1);
  const firstAttemptKey = harness.executor.requests[0]!.attemptKey;

  clock.advance(60_001);
  await harness.runtime.drain();
  assert.equal(
    (await harness.engine.observe({ goalId: first.goalId })).ok,
    false,
  );

  const second = submitCommand({
    goalId: first.goalId,
    requestId: "request-reusable-second",
    nodes: [node("main")],
  });
  assert.equal(
    (await harness.engine.submit(second, authority(second))).ok,
    true,
  );
  await harness.runtime.drain();
  assert.equal(harness.executor.requests.length, 2);
  assert.notEqual(harness.executor.requests[1]!.attemptKey, firstAttemptKey);
  const observed = await harness.engine.observe({ goalId: second.goalId });
  assert.equal(observed.ok, true);
  if (observed.ok) assert.equal(observed.value.detail?.state, "done");
});

test("terminal churn keeps durable Goal records and events bounded", async (t) => {
  const clock = createFakeClock();
  const harness = createHarness({
    clock,
    maxGoals: 10,
    terminalRetentionMs: 0,
  });
  t.after(() => harness.runtime.close());

  for (let index = 0; index < 24; index += 1) {
    const suffix = index.toString().padStart(2, "0");
    const command = submitCommand({
      goalId: `churn-${suffix}`,
      requestId: `request-churn-${suffix}`,
      nodes: [node("main")],
    });
    assert.equal(
      (await harness.engine.submit(command, authority(command))).ok,
      true,
    );
    await harness.runtime.drain();
    clock.advance(60_001);
    await harness.runtime.drain();
    assert.equal(
      (await harness.engine.observe({ goalId: command.goalId })).ok,
      false,
    );
  }

  const persistence = createGoalPersistence(harness.state, "project-1");
  const exported = await harness.state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (!exported.ok || exported.value.format !== "snapshot") return;
  const goalRecords = exported.value.snapshot.records.filter((record) =>
    Object.values(persistence.collections).includes(record.collection),
  );
  assert.deepEqual(
    goalRecords.map((record) => [record.collection, record.key]),
    [[persistence.collections.CAPACITY, "goals"]],
  );
  assert.equal(
    exported.value.snapshot.events.filter((event) =>
      event.stream.startsWith(`goals.${persistence.namespace}.`),
    ).length,
    0,
  );
  const diagnostics = await harness.state.diagnose();
  assert.equal(diagnostics.ok, true);
  if (diagnostics.ok) {
    assert.equal(diagnostics.value.counts.records, 1);
    assert.equal(diagnostics.value.counts.events, 0);
  }
});

test("native SQLite cleanup bounds churn while one Goal ID is reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-retention-sqlite-"));
  const clock = createFakeClock();
  const created = createSqliteStateStore({
    path: join(directory, "state.sqlite"),
    now: () => clock.now(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  const harness = createHarness({
    state: created.value,
    clock,
    terminalRetentionMs: 0,
  });
  try {
    for (let generation = 0; generation < 8; generation += 1) {
      const command = submitCommand({
        goalId: "sqlite-reused-goal",
        requestId: `sqlite-generation-${generation}`,
        nodes: [node("main")],
      });
      assert.equal(
        (await harness.engine.submit(command, authority(command))).ok,
        true,
      );
      await harness.runtime.drain();
      clock.advance(60_001);
      await harness.runtime.drain();
      assert.equal(
        (await harness.engine.observe({ goalId: command.goalId })).ok,
        false,
      );
    }

    assert.equal(
      new Set(harness.executor.requests.map((request) => request.attemptKey))
        .size,
      8,
    );
    const persistence = createGoalPersistence(harness.state, "project-1");
    const exported = await harness.state.export({ format: "snapshot" });
    assert.equal(exported.ok, true);
    if (!exported.ok || exported.value.format !== "snapshot") return;
    const goalRecords = exported.value.snapshot.records.filter((record) =>
      Object.values(persistence.collections).includes(record.collection),
    );
    assert.deepEqual(
      goalRecords.map((record) => [record.collection, record.key]),
      [[persistence.collections.CAPACITY, "goals"]],
    );
    assert.equal(
      exported.value.snapshot.events.filter((event) =>
        event.stream.startsWith(`goals.${persistence.namespace}.`),
      ).length,
      0,
    );
  } finally {
    await harness.runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a closed runtime refuses further commands", async () => {
  const harness = createHarness();
  const command = submitCommand({ activate: false });
  await harness.engine.submit(command, authority(command));
  await harness.runtime.close();
  const pause = {
    type: "pause" as const,
    requestId: "request-pause",
    goalId: "ship-feature",
    expectedRevision: 1,
  };
  const result = await harness.engine.pause(pause, authority(pause));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "closed");
});
