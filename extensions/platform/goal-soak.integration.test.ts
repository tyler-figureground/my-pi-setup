import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import {
  createGoalRuntime,
  goalCommandDigest,
  type GoalAuthorityVerifier,
  type GoalCommand,
  type GoalCommandAuthority,
  type GoalExecutorOutcome,
  type GoalExecutorPort,
  type GoalExecutorRequest,
  type GoalNodeInput,
  type GoalRuntime,
  type GoalSnapshot,
  type GoalSubmitCommand,
} from "./src/goals/index.ts";

/**
 * Stand-in host approval issuer: only the exact token the fixture minted, bound
 * to the digest the engine recomputed, verifies.
 */
const issuedAuthority: GoalAuthorityVerifier = {
  verify: (request) =>
    typeof request.authority.token === "string" &&
    request.authority.token.startsWith("phase8-soak-") &&
    request.authority.commandDigest === request.commandDigest &&
    request.authority.projectId === request.projectId &&
    request.authority.sessionId === request.sessionId,
};

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SIMULATED_HOURS = 72;
const PROJECT_ID = "phase8-goal-soak";
const SESSION_ID = "phase8-goal-soak-session";

async function flush(turns = 8) {
  for (let turn = 0; turn < turns; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  turns = 2_000,
) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await predicate()) return;
    await flush(1);
  }
  assert.fail(message);
}

function valueOf<T>(
  outcome: { ok: true; value: T } | { ok: false; error: unknown },
) {
  if (!outcome.ok) assert.fail(JSON.stringify(outcome.error));
  return outcome.value;
}

class GoalSoakClock {
  nowMs = Date.parse("2028-01-01T00:00:00.000Z");
  maximumArmed = 0;
  armedDeadlineAdvances = 0;
  #nextId = 0;
  #timers = new Map<
    number,
    { readonly at: number; readonly wake: () => void }
  >();

  now = () => this.nowMs;

  arm = (at: number, wake: () => void) => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at, wake });
    this.maximumArmed = Math.max(this.maximumArmed, this.#timers.size);
    return () => void this.#timers.delete(id);
  };

  hasTimerAt(at: number) {
    return [...this.#timers.values()].some((timer) => timer.at === at);
  }

  get armedCount() {
    return this.#timers.size;
  }

  async advanceTo(at: number, requireArmedDeadline = false) {
    assert.ok(at >= this.nowMs, "fake clock cannot move backwards");
    if (requireArmedDeadline) {
      assert.equal(
        this.hasTimerAt(at),
        true,
        `expected an armed Goal deadline at ${at}`,
      );
      this.armedDeadlineAdvances += 1;
    }
    this.nowMs = at;
    for (let pass = 0; pass < 100; pass += 1) {
      const due = [...this.#timers]
        .filter(([, timer]) => timer.at <= this.nowMs)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.at - right.at || leftId - rightId,
        );
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        if (this.#timers.delete(id)) timer.wake();
      }
      await flush();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function parsePrompt(prompt: string) {
  const separator = prompt.indexOf("/");
  assert.ok(separator > 0, `invalid soak prompt ${prompt}`);
  return {
    goalId: prompt.slice(0, separator),
    nodeId: prompt.slice(separator + 1),
  };
}

function completion(request: GoalExecutorRequest): GoalExecutorOutcome {
  const body = `completed ${request.prompt}`;
  return {
    ok: true,
    value: {
      status: "completed",
      artifact: {
        body,
        filename: "phase8-goal-soak.txt",
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
        childId: `soak-${request.attemptKey.slice(0, 12)}`,
        certainty: "started",
      },
      usage: {
        tokens: 25,
        costMicros: 10,
        authoritative: true,
        source: "phase8-soak-executor",
      },
    },
  };
}

interface PendingExecution {
  readonly ownerId: string;
  readonly request: GoalExecutorRequest;
  readonly goalId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly resolve: (outcome: GoalExecutorOutcome) => void;
}

class GoalSoakExecutor {
  readonly requests: PendingExecution[] = [];
  readonly events: {
    readonly sequence: number;
    readonly type: "start" | "success";
    readonly goalId: string;
    readonly nodeId: string;
  }[] = [];
  readonly owners = new Set<string>();
  readonly seenAttemptKeys = new Set<string>();
  readonly attemptCounts = new Map<string, number>();
  readonly peakByGoal = new Map<string, number>();
  #pending = new Map<string, PendingExecution>();
  #activeByGoal = new Map<string, number>();
  #sequence = 0;
  active = 0;
  peak = 0;

  port(ownerId: string): GoalExecutorPort {
    return {
      metering: { tokens: true, cost: true },
      run: (request) => this.run(ownerId, request),
      inspect: async (attemptKey) => ({
        attemptKey,
        state: "unknown",
        certainty: "unknown",
      }),
    };
  }

  private async run(ownerId: string, request: GoalExecutorRequest) {
    assert.equal(
      this.seenAttemptKeys.has(request.attemptKey),
      false,
      `duplicate Attempt dispatch ${request.attemptKey}`,
    );
    this.seenAttemptKeys.add(request.attemptKey);
    this.owners.add(ownerId);
    const { goalId, nodeId } = parsePrompt(request.prompt);
    const promptAttempts = (this.attemptCounts.get(request.prompt) ?? 0) + 1;
    this.attemptCounts.set(request.prompt, promptAttempts);
    const gate = deferred<GoalExecutorOutcome>();
    const pending = {
      ownerId,
      request,
      goalId,
      nodeId,
      attemptNumber: promptAttempts,
      resolve: gate.resolve,
    };
    this.requests.push(pending);
    this.#pending.set(request.attemptKey, pending);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    const goalActive = (this.#activeByGoal.get(goalId) ?? 0) + 1;
    this.#activeByGoal.set(goalId, goalActive);
    this.peakByGoal.set(
      goalId,
      Math.max(this.peakByGoal.get(goalId) ?? 0, goalActive),
    );
    this.events.push({
      sequence: ++this.#sequence,
      type: "start",
      goalId,
      nodeId,
    });
    try {
      return await gate.promise;
    } finally {
      this.active -= 1;
      this.#activeByGoal.set(goalId, goalActive - 1);
    }
  }

  pendingCount(goalId?: string) {
    if (goalId === undefined) return this.#pending.size;
    return [...this.#pending.values()].filter(
      (pending) => pending.goalId === goalId,
    ).length;
  }

  attemptsFor(goalId: string, nodeId: string) {
    return this.attemptCounts.get(`${goalId}/${nodeId}`) ?? 0;
  }

  release(goalId: string) {
    const pending = [...this.#pending.values()].filter(
      (entry) => entry.goalId === goalId,
    );
    assert.ok(pending.length > 0, `no pending executions for ${goalId}`);
    for (const entry of pending) {
      this.#pending.delete(entry.request.attemptKey);
      let outcome: GoalExecutorOutcome;
      if (entry.nodeId === "ambiguous") {
        outcome = {
          ok: false,
          error: {
            code: "execution_unknown",
            message: "simulated host lost the child outcome",
            retryable: true,
            certainty: "unknown",
          },
        };
      } else if (entry.nodeId === "retry" && entry.attemptNumber <= 2) {
        outcome = {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "simulated transient backend outage",
            retryable: true,
            certainty: "not-started",
          },
        };
      } else {
        outcome = completion(entry.request);
        if (entry.nodeId !== "evidence" || entry.attemptNumber > 1) {
          this.events.push({
            sequence: ++this.#sequence,
            type: "success",
            goalId: entry.goalId,
            nodeId: entry.nodeId,
          });
        }
      }
      entry.resolve(outcome);
    }
  }
}

function node(
  goalId: string,
  id: string,
  overrides: Partial<GoalNodeInput> = {},
): GoalNodeInput {
  return {
    id,
    title: `Soak node ${id}`,
    prompt: `${goalId}/${id}`,
    dependsOn: [],
    profileName: "goal-worker",
    policy: {
      timeoutMs: MINUTE_MS,
      maxAttempts: 1,
      retryDelayMs: 5 * MINUTE_MS,
      maxOutputBytes: 64 * 1_024,
    },
    reservation: { runtimeMs: MINUTE_MS, tokens: 100, costMicros: 50 },
    ...overrides,
  };
}

function standardGoal(goalId: string, requestId: string): GoalSubmitCommand {
  const roots = ["root-a", "root-b", "root-c", "root-d"];
  return {
    type: "submit",
    requestId,
    goalId,
    objective: `Complete bounded DAG ${goalId}`,
    nodes: [
      ...roots.map((id) => node(goalId, id)),
      node(goalId, "fan-in", { dependsOn: roots }),
      node(goalId, "retry", {
        dependsOn: ["fan-in"],
        policy: { maxAttempts: 3, retryDelayMs: 5 * MINUTE_MS },
      }),
      node(goalId, "evidence", {
        dependsOn: ["retry"],
        policy: { maxAttempts: 2, retryDelayMs: 7 * MINUTE_MS },
        criteria: [
          {
            id: "host-tests",
            description: "Host test evidence is required",
            acceptedEvidenceKinds: ["test-report"],
            minimumEvidenceCount: 1,
            minimumTrust: "host-verified",
          },
        ],
      }),
      node(goalId, "leaf", { dependsOn: ["evidence"] }),
    ],
    budget: {
      maxConcurrency: 4,
      maxAgentCalls: 16,
      maxRuntimeMs: 2 * HOUR_MS,
      maxTokens: 5_000,
      maxCostMicros: 5_000,
    },
  };
}

function ambiguousGoal(): GoalSubmitCommand {
  const goalId = "soak-ambiguous";
  return {
    type: "submit",
    requestId: "submit-soak-ambiguous",
    goalId,
    objective: "Block safely when execution outcome is ambiguous",
    nodes: [
      node(goalId, "prepare"),
      node(goalId, "ambiguous", {
        dependsOn: ["prepare"],
        policy: { maxAttempts: 3, retryDelayMs: MINUTE_MS },
      }),
      node(goalId, "must-not-run", { dependsOn: ["ambiguous"] }),
    ],
    budget: {
      maxConcurrency: 4,
      maxAgentCalls: 8,
      maxRuntimeMs: HOUR_MS,
      maxTokens: 2_000,
      maxCostMicros: 2_000,
    },
  };
}

function authority(command: GoalCommand, now: number): GoalCommandAuthority {
  return {
    actor: "direct-user",
    actorId: "phase8-soak-user",
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    commandDigest: goalCommandDigest(command),
    token: `phase8-soak-${command.requestId}`,
    expiresAt: now + 30 * DAY_MS,
  };
}

async function observe(runtime: GoalRuntime, goalId: string) {
  const observed = valueOf(
    await runtime.engine.observe({ goalId, includeHistory: true }),
  );
  assert.ok(observed.detail);
  return observed.detail;
}

function assertBudgetBounded(goal: GoalSnapshot) {
  assert.equal(goal.budget.reserved.calls, 0);
  assert.equal(goal.budget.reserved.runtimeMs, 0);
  assert.equal(goal.budget.reserved.tokens, 0);
  assert.equal(goal.budget.reserved.costMicros, 0);
  assert.ok(goal.budget.consumed.calls <= goal.budget.limits.maxAgentCalls);
  assert.ok(goal.budget.consumed.runtimeMs <= goal.budget.limits.maxRuntimeMs);
  assert.ok(
    goal.budget.limits.maxTokens === null ||
      goal.budget.consumed.tokens <= goal.budget.limits.maxTokens,
  );
  assert.ok(
    goal.budget.limits.maxCostMicros === null ||
      goal.budget.consumed.costMicros <= goal.budget.limits.maxCostMicros,
  );
}

function assertDependencyOrdering(executor: GoalSoakExecutor, goalId: string) {
  const dependencies = new Map<string, readonly string[]>([
    ["fan-in", ["root-a", "root-b", "root-c", "root-d"]],
    ["retry", ["fan-in"]],
    ["evidence", ["retry"]],
    ["leaf", ["evidence"]],
  ]);
  const events = executor.events.filter((event) => event.goalId === goalId);
  for (const [nodeId, required] of dependencies) {
    const firstStart = events.find(
      (event) => event.type === "start" && event.nodeId === nodeId,
    );
    assert.ok(firstStart, `${goalId}/${nodeId} never started`);
    for (const dependency of required) {
      const success = [...events]
        .reverse()
        .find(
          (event) => event.type === "success" && event.nodeId === dependency,
        );
      assert.ok(success, `${goalId}/${dependency} never succeeded`);
      assert.ok(
        success.sequence < firstStart.sequence,
        `${goalId}/${nodeId} started before ${dependency} succeeded`,
      );
    }
  }
}

test("Phase 8 GoalEngine survives a deterministic 72-hour simulated run", async () => {
  const clock = new GoalSoakClock();
  const startedAt = clock.now();
  const state = createMemoryStateStore({ now: clock.now });
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  const executor = new GoalSoakExecutor();
  const reviewAttempts = new Map<string, number>();
  const activeWorkspaces = new Set<string>();
  const deliveries = new Set<string>();
  let reviewRejections = 0;
  let runtimeSequence = 0;
  let runtimeReplacements = 0;
  let pauseResumeCycles = 0;
  let sharedStoreObservations = 0;

  const openRuntime = () => {
    const ownerId = `phase8-soak-owner-${++runtimeSequence}`;
    return createGoalRuntime({
      state,
      artifacts,
      clock,
      executor: executor.port(ownerId),
      profiles: {
        async resolve(name) {
          return {
            ok: true,
            value: {
              name,
              contentDigest: "a".repeat(64),
              catalogGeneration: 8,
              source: {
                scope: "managed" as const,
                path: "/profiles/goal-worker.md",
              },
              role: "goal-worker",
              workspacePolicy: "isolated" as const,
            },
          };
        },
      },
      workspaces: {
        async prepare(request) {
          const workspaceId = `workspace-${request.attemptKey}`;
          assert.equal(activeWorkspaces.has(workspaceId), false);
          activeWorkspaces.add(workspaceId);
          return { ok: true, value: { workspaceId, cwd: "/phase8-soak" } };
        },
        async dispose(request) {
          activeWorkspaces.delete(request.workspaceId);
          return { ok: true, value: { disposition: "released" } };
        },
      },
      review: {
        async verify(request) {
          const key = `${request.goalId}/${request.nodeId}/${request.criterionId}`;
          const attempt = (reviewAttempts.get(key) ?? 0) + 1;
          reviewAttempts.set(key, attempt);
          const satisfied = attempt > 1;
          if (!satisfied) reviewRejections += 1;
          return {
            ok: true,
            value: {
              satisfied,
              kind: "test-report" as const,
              summary: satisfied
                ? "host tests passed"
                : "host tests intentionally withheld",
              artifact: null,
            },
          };
        },
      },
      delivery: {
        async deliver(request) {
          assert.equal(deliveries.has(request.deliveryId), false);
          deliveries.add(request.deliveryId);
          return { ok: true, value: { state: "delivered" as const } };
        },
      },
      binding: {
        projectId: PROJECT_ID,
        cwd: "/phase8-soak",
        sessionId: SESSION_ID,
      },
      ownerId,
      leaseTtlMs: 2 * MINUTE_MS,
      authority: issuedAuthority,
    });
  };

  let runtimes = [openRuntime(), openRuntime()];
  let commandRuntime = 0;

  const replaceRuntime = async (slot: number) => {
    await runtimes[slot]!.close();
    runtimes[slot] = openRuntime();
    runtimeReplacements += 1;
  };

  const driveGoal = async (goalId: string) => {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      await waitFor(async () => {
        if (executor.pendingCount(goalId) > 0) return true;
        const snapshot = await observe(runtimes[1 - commandRuntime]!, goalId);
        return (
          snapshot.state === "done" ||
          snapshot.state === "failed" ||
          snapshot.state === "blocked" ||
          snapshot.nodes.some((entry) => entry.state === "retry-wait")
        );
      }, `${goalId} made no progress`);

      if (executor.pendingCount(goalId) > 0) {
        executor.release(goalId);
        await flush();
        continue;
      }

      const snapshot = await observe(runtimes[1 - commandRuntime]!, goalId);
      if (
        snapshot.state === "done" ||
        snapshot.state === "failed" ||
        snapshot.state === "blocked"
      )
        return snapshot;
      const deadlines = snapshot.nodes
        .filter((entry) => entry.state === "retry-wait")
        .map((entry) => entry.nextAttemptAt)
        .filter((at): at is number => at !== null);
      assert.ok(deadlines.length > 0, `${goalId} has no retry deadline`);
      const deadline = Math.min(...deadlines);
      await waitFor(
        () => clock.hasTimerAt(deadline),
        `${goalId} retry deadline was not armed`,
      );
      await clock.advanceTo(deadline, true);
    }
    assert.fail(`${goalId} exceeded bounded drive cycles`);
  };

  const ambiguous = ambiguousGoal();
  valueOf(
    await runtimes[commandRuntime]!.engine.submit(
      ambiguous,
      authority(ambiguous, clock.now()),
    ),
  );
  valueOf(
    await runtimes[1 - commandRuntime]!.engine.observe({
      goalId: ambiguous.goalId,
    }),
  );
  sharedStoreObservations += 1;
  const ambiguousSnapshot = await driveGoal(ambiguous.goalId);
  assert.equal(ambiguousSnapshot.state, "blocked");
  assert.equal(ambiguousSnapshot.blockedReason, "unknown-attempt");
  assert.equal(executor.attemptsFor(ambiguous.goalId, "ambiguous"), 1);
  assert.equal(executor.attemptsFor(ambiguous.goalId, "must-not-run"), 0);
  assert.equal(
    ambiguousSnapshot.nodes.find((entry) => entry.id === "ambiguous")
      ?.attempts[0]?.phase,
    "unknown",
  );
  assertBudgetBounded(ambiguousSnapshot);

  const completedGoals: GoalSnapshot[] = [];
  for (let interval = 0; interval < 6; interval += 1) {
    if (interval > 0 && interval % 2 === 0)
      await replaceRuntime(1 - commandRuntime);

    const goalId = `soak-dag-${interval}`;
    const command = standardGoal(goalId, `submit-${goalId}`);
    valueOf(
      await runtimes[commandRuntime]!.engine.submit(
        command,
        authority(command, clock.now()),
      ),
    );
    valueOf(await runtimes[1 - commandRuntime]!.engine.observe({ goalId }));
    sharedStoreObservations += 1;

    if (interval % 2 === 0) {
      await waitFor(
        () => executor.pendingCount(goalId) === 4,
        `${goalId} did not reach concurrency four before pause`,
      );
      const pause = {
        type: "pause" as const,
        requestId: `pause-${goalId}`,
        goalId,
        expectedRevision: 1,
        reason: "periodic soak checkpoint",
      };
      const paused = valueOf(
        await runtimes[1 - commandRuntime]!.engine.pause(
          pause,
          authority(pause, clock.now()),
        ),
      );
      assert.equal(paused.goal.state, "paused");
      executor.release(goalId);
      await waitFor(async () => {
        const snapshot = await observe(runtimes[commandRuntime]!, goalId);
        return (
          executor.pendingCount(goalId) === 0 &&
          snapshot.nodes.filter((entry) => entry.state === "done").length === 4
        );
      }, `${goalId} did not settle paused work`);
      const resume = {
        type: "resume" as const,
        requestId: `resume-${goalId}`,
        goalId,
        expectedRevision: 1,
        reason: "periodic soak checkpoint complete",
      };
      valueOf(
        await runtimes[commandRuntime]!.engine.resume(
          resume,
          authority(resume, clock.now()),
        ),
      );
      pauseResumeCycles += 1;
    }

    const completed = await driveGoal(goalId);
    assert.equal(completed.state, "done");
    assert.equal(completed.nodes.length, 8);
    assert.ok((executor.peakByGoal.get(goalId) ?? 0) <= 4);
    assert.equal(executor.attemptsFor(goalId, "retry"), 3);
    assert.equal(executor.attemptsFor(goalId, "evidence"), 2);
    const retryAttempts = completed.nodes.find(
      (entry) => entry.id === "retry",
    )!.attempts;
    assert.equal(
      retryAttempts[1]!.startedAt - retryAttempts[0]!.settledAt!,
      5 * MINUTE_MS,
    );
    assert.equal(
      retryAttempts[2]!.startedAt - retryAttempts[1]!.settledAt!,
      10 * MINUTE_MS,
    );
    const evidenceAttempts = completed.nodes.find(
      (entry) => entry.id === "evidence",
    )!.attempts;
    assert.equal(
      evidenceAttempts[1]!.startedAt - evidenceAttempts[0]!.settledAt!,
      7 * MINUTE_MS,
    );
    assert.equal(
      completed.nodes
        .find((entry) => entry.id === "evidence")
        ?.evidence.some(
          (entry) =>
            entry.kind === "test-report" && entry.trust === "host-verified",
        ),
      true,
    );
    assertBudgetBounded(completed);
    assertDependencyOrdering(executor, goalId);
    completedGoals.push(completed);

    const intervalDeadline = startedAt + (interval + 1) * 12 * HOUR_MS;
    if (clock.now() < intervalDeadline) await clock.advanceTo(intervalDeadline);
    await flush();
    commandRuntime = 1 - commandRuntime;
  }

  assert.ok(clock.now() - startedAt >= SIMULATED_HOURS * HOUR_MS);
  assert.equal(executor.attemptsFor(ambiguous.goalId, "ambiguous"), 1);
  const unknownAfterSoak = await observe(runtimes[0]!, ambiguous.goalId);
  assert.equal(
    unknownAfterSoak.nodes.find((entry) => entry.id === "ambiguous")
      ?.attempts[0]?.phase,
    "unknown",
  );

  const cancelledGoal = standardGoal("soak-cancelled", "submit-soak-cancelled");
  const draft = { ...cancelledGoal, activate: false };
  valueOf(
    await runtimes[0]!.engine.submit(draft, authority(draft, clock.now())),
  );
  const cancel = {
    type: "cancel" as const,
    requestId: "cancel-soak-cancelled",
    goalId: draft.goalId,
    expectedRevision: 1,
    reason: "exercise final public GoalEngine command",
  };
  const cancelled = valueOf(
    await runtimes[1]!.engine.cancel(cancel, authority(cancel, clock.now())),
  );
  assert.equal(cancelled.goal.state, "cancelled");
  assert.equal(executor.attemptsFor(draft.goalId, "root-a"), 0);

  await Promise.all(runtimes.map((runtime) => runtime.close()));
  assert.equal(executor.active, 0);
  assert.equal(executor.pendingCount(), 0);
  assert.equal(activeWorkspaces.size, 0);
  assert.equal(clock.armedCount, 0);
  assert.equal(executor.seenAttemptKeys.size, executor.requests.length);
  assert.equal(executor.peak, 4);
  assert.ok(executor.peak <= 4);
  assert.ok(clock.armedDeadlineAdvances >= completedGoals.length * 3);
  assert.equal(reviewRejections, completedGoals.length);
  assert.ok(runtimeReplacements >= 2);
  assert.ok(executor.owners.size >= 2);

  const exported = valueOf(await state.export({ format: "snapshot" }));
  assert.equal(exported.format, "snapshot");
  assert.equal(
    exported.snapshot.leases.filter((lease) => lease.owner !== null).length,
    0,
  );
  const diagnostics = valueOf(await state.diagnose());
  assert.equal(diagnostics.integrity, "ok");

  const metrics = {
    schemaVersion: 1,
    classification: "integration",
    simulatedHours: (clock.now() - startedAt) / HOUR_MS,
    goalsSubmitted: completedGoals.length + 2,
    goalsCompleted: completedGoals.length,
    dagNodesCompleted: completedGoals.reduce(
      (total, goal) => total + goal.nodes.length,
      0,
    ),
    attemptsDispatched: executor.requests.length,
    uniqueAttemptKeys: executor.seenAttemptKeys.size,
    peakConcurrency: executor.peak,
    peakConcurrencyByGoal: Object.fromEntries(executor.peakByGoal),
    armedDeadlineAdvances: clock.armedDeadlineAdvances,
    maximumArmedTimers: clock.maximumArmed,
    timersAfterClose: clock.armedCount,
    pauseResumeCycles,
    runtimeInstances: runtimeSequence,
    runtimeReplacements,
    executionOwners: executor.owners.size,
    sharedStoreObservations,
    retryAttempts: completedGoals.reduce(
      (total, goal) => total + executor.attemptsFor(goal.goalId, "retry"),
      0,
    ),
    evidenceGateRejections: reviewRejections,
    unknownAttempts: 1,
    unknownRedispatches:
      executor.attemptsFor(ambiguous.goalId, "ambiguous") - 1,
    activeLeasesAfterClose: exported.snapshot.leases.filter(
      (lease) => lease.owner !== null,
    ).length,
    stateCounts: diagnostics.counts,
  };
  const json = JSON.stringify(metrics);
  assert.ok(Buffer.byteLength(json) <= 8 * 1_024);
  const metricsPath = join(tmpdir(), `pi-phase8-goal-soak-${process.pid}.json`);
  await writeFile(metricsPath, json, "utf8");
  console.log(`PHASE8_GOAL_SOAK_METRICS ${json}`);
  console.log(`PHASE8_GOAL_SOAK_METRICS_PATH ${metricsPath}`);
});
