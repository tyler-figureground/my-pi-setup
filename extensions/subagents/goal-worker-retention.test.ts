import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { GoalWorkerRequest } from "../shared/goal-worker.ts";
import {
  createGoalWorkerExecutor,
  goalWorkerRetentionLimits,
  type GoalWorkerSubagentManager,
} from "./src/goal-worker.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";

const profile = {
  description: "Goal retention fixture",
  identity: {
    name: "goal-retention",
    contentDigest: "f".repeat(64),
    catalogGeneration: 5,
    source: { scope: "managed", path: "<goal-retention>" },
  },
  defaults: { backend: "pi" },
  policy: {
    role: "goal-worker",
    instructions: [],
    skills: [],
    tools: { allowed: ["read"], denied: ["write", "edit", "bash"] },
    limits: { maxTurns: 2, timeoutMs: 10_000 },
    workspace: "current",
  },
} as const satisfies ResolvedAgentProfile;

/** Distinct valid attempt keys without colliding on the shared prefix. */
function attemptKey(index: number) {
  return index.toString(16).padStart(64, "0");
}

function request(
  key: string,
  overrides: Partial<GoalWorkerRequest> = {},
): GoalWorkerRequest {
  return {
    attemptKey: key,
    prompt: "Inspect once.",
    cwd: "C:\\goal-project",
    projectId: "git:goal-project",
    profile: profile.identity,
    timeoutMs: 10_000,
    maxOutputBytes: 1_048_576,
    ...overrides,
  };
}

function snapshot(
  id: string,
  task: SpawnTask,
  status: "running" | "done",
  finalText: string,
) {
  return {
    id,
    origin: task.origin ?? "model",
    backend: "pi",
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    profile: task.profile,
    status,
    createdAt: 1,
    ...(status === "done" ? { settledAt: 2 } : {}),
    meta: { backend: "pi" },
    usage: {},
    metered: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: status === "done" ? finalText : "",
    turns: status === "done" ? 1 : 0,
  } satisfies SubagentSnapshot;
}

interface HarnessOptions {
  readonly output?: string;
  readonly now?: () => number;
  /** Attempt keys whose child never settles, so the attempt stays live. */
  readonly hang?: ReadonlySet<string>;
}

function harness(options: HarnessOptions = {}) {
  const output = options.output ?? "done";
  const tasks = new Map<string, SpawnTask>();
  const cancelled: string[] = [];
  let spawns = 0;
  const hangs = options.hang ?? new Set<string>();
  const hanging = (task: SpawnTask) =>
    [...hangs].some((key) => task.title?.includes(key));
  const manager: GoalWorkerSubagentManager = {
    async spawn(_backend, task) {
      spawns += 1;
      const id = `sa-${spawns}`;
      tasks.set(id, task);
      return snapshot(id, task, "running", output);
    },
    async waitFor(ids) {
      for (const id of ids) {
        const task = tasks.get(id);
        if (task && hanging(task)) await new Promise(() => undefined);
      }
    },
    async get(id) {
      const task = tasks.get(id);
      return task ? snapshot(id, task, "done", output) : undefined;
    },
    async cancel(ids) {
      cancelled.push(...ids);
    },
  };
  const lifecycle = new AbortController();
  const executor = createGoalWorkerExecutor({
    profiles: () => ({
      generation: () => profile.identity.catalogGeneration,
      resolve: () => profile,
    }),
    manager: async () => manager,
    parent: () => ({ parentCwd: "C:\\host", projectTrusted: false }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    executor,
    lifecycle,
    cancelled,
    get spawns() {
      return spawns;
    },
  };
}

test("a delivered completion stops retaining the artifact body", async () => {
  const body = "e".repeat(256_000);
  const worker = harness({ output: body });
  const key = attemptKey(1);

  const outcome = await worker.executor.run(request(key));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.artifact.body, body);
  assert.equal(outcome.value.artifact.size, body.length);

  const retention = worker.executor.retention();
  assert.equal(retention.live, 0);
  assert.equal(retention.settled, 1);
  assert.equal(retention.retainedOutcomes, 0);
  assert.equal(retention.retainedBytes, 0);

  const inspected = await worker.executor.inspect(key);
  assert.equal(inspected.state, "settled");
  assert.equal(inspected.certainty, "started");
  if (inspected.state !== "settled" || inspected.outcome.ok) return;
  assert.equal(inspected.outcome.error.code, "execution_unknown");
  assert.equal(inspected.outcome.error.retryable, false);
  assert.equal(inspected.outcome.error.certainty, "started");
  assert.equal(inspected.outcome.error.childId, "sa-1");
});

test("replaying a settled completion never redispatches and never certifies not-started", async () => {
  const worker = harness({ output: "evidence" });
  const key = attemptKey(2);

  assert.equal((await worker.executor.run(request(key))).ok, true);
  const replay = await worker.executor.run(request(key));

  assert.equal(worker.spawns, 1);
  assert.equal(replay.ok, false);
  if (replay.ok) return;
  assert.equal(replay.error.code, "execution_unknown");
  assert.equal(replay.error.certainty, "started");
  assert.equal(replay.error.retryable, false);
  assert.equal(replay.error.childId, "sa-1");
});

test("a retained bounded failure replays exactly and a reused key with new input conflicts", async () => {
  const worker = harness({ output: "oversized output" });
  const key = attemptKey(3);

  const first = await worker.executor.run(request(key, { maxOutputBytes: 4 }));
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.error.code, "output_bounded");

  assert.deepEqual(
    await worker.executor.run(request(key, { maxOutputBytes: 4 })),
    first,
  );
  const conflict = await worker.executor.run(
    request(key, { maxOutputBytes: 8 }),
  );
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.equal(conflict.error.code, "attempt_conflict");
  assert.equal(conflict.error.certainty, "started");
  assert.equal(conflict.error.retryable, false);
  assert.equal(worker.spawns, 1);
});

test("high-cardinality attempt keys stay bounded and evicted keys report unknown", async () => {
  const worker = harness({ output: "ok" });
  const total = goalWorkerRetentionLimits.settledEntries + 24;

  for (let index = 1; index <= total; index++) {
    assert.equal(
      (await worker.executor.run(request(attemptKey(index)))).ok,
      true,
    );
  }

  const retention = worker.executor.retention();
  assert.equal(worker.spawns, total);
  assert.equal(retention.live, 0);
  assert.ok(retention.settled <= goalWorkerRetentionLimits.settledEntries);
  assert.ok(
    retention.retainedOutcomes <= goalWorkerRetentionLimits.retainedOutcomes,
  );
  assert.ok(retention.retainedBytes <= goalWorkerRetentionLimits.retainedBytes);

  assert.deepEqual(await worker.executor.inspect(attemptKey(1)), {
    attemptKey: attemptKey(1),
    state: "unknown",
    certainty: "unknown",
  });
  const newest = await worker.executor.inspect(attemptKey(total));
  assert.equal(newest.state, "settled");
  assert.equal(newest.certainty, "started");
});

test("retained failure outcomes stay under the byte budget and degrade oldest first", async () => {
  const worker = harness({ output: "x".repeat(4_096) });
  const bounded = { maxOutputBytes: 8 } as const;
  const count = goalWorkerRetentionLimits.retainedOutcomes + 8;

  for (let index = 1; index <= count; index++) {
    const outcome = await worker.executor.run(
      request(attemptKey(1_000 + index), bounded),
    );
    assert.equal(outcome.ok, false);
  }

  const retention = worker.executor.retention();
  assert.ok(
    retention.retainedOutcomes <= goalWorkerRetentionLimits.retainedOutcomes,
  );
  assert.ok(retention.retainedBytes <= goalWorkerRetentionLimits.retainedBytes);

  const degraded = await worker.executor.inspect(attemptKey(1_001));
  assert.equal(degraded.state, "settled");
  assert.equal(degraded.certainty, "started");
  if (degraded.state !== "settled" || degraded.outcome.ok) return;
  assert.equal(degraded.outcome.error.code, "execution_unknown");
  assert.equal(degraded.outcome.error.retryable, false);

  const newest = await worker.executor.inspect(attemptKey(1_000 + count));
  assert.equal(newest.state, "settled");
  if (newest.state !== "settled" || newest.outcome.ok) return;
  assert.equal(newest.outcome.error.code, "output_bounded");
});

test("settled attempts expire by age against the injected clock", async () => {
  let now = 1_000;
  const worker = harness({ output: "ok", now: () => now });
  const stale = attemptKey(4);
  const fresh = attemptKey(5);

  assert.equal((await worker.executor.run(request(stale))).ok, true);
  now += goalWorkerRetentionLimits.settledAgeMs + 1;
  assert.equal((await worker.executor.run(request(fresh))).ok, true);

  assert.equal(worker.executor.retention().settled, 1);
  assert.deepEqual(await worker.executor.inspect(stale), {
    attemptKey: stale,
    state: "unknown",
    certainty: "unknown",
  });
  assert.equal((await worker.executor.inspect(fresh)).state, "settled");
});

test("a live attempt is never evicted and still adopts the same key", async () => {
  const live = attemptKey(6);
  const worker = harness({ output: "ok", hang: new Set([live]) });

  const running = worker.executor.run(request(live));
  const adopted = worker.executor.run(request(live));
  assert.equal(running, adopted);
  await new Promise((resolve) => setImmediate(resolve));

  for (let index = 1; index <= 32; index++) {
    assert.equal(
      (await worker.executor.run(request(attemptKey(2_000 + index)))).ok,
      true,
    );
  }

  const retention = worker.executor.retention();
  assert.equal(retention.live, 1);
  const inspected = await worker.executor.inspect(live);
  assert.equal(inspected.state, "running");
  assert.equal(inspected.certainty, "started");
  assert.equal(worker.spawns, 33);

  worker.lifecycle.abort();
  assert.equal((await running).ok, false);
});

test("shutdown drops retained outcomes without enabling redispatch", async () => {
  const worker = harness({ output: "z".repeat(64_000) });
  const key = attemptKey(7);
  assert.equal((await worker.executor.run(request(key))).ok, true);

  worker.lifecycle.abort();
  worker.executor.shutdown();
  worker.executor.shutdown();

  const retention = worker.executor.retention();
  assert.equal(retention.live, 0);
  assert.equal(retention.retainedOutcomes, 0);
  assert.equal(retention.retainedBytes, 0);

  const inspected = await worker.executor.inspect(key);
  assert.equal(inspected.state, "settled");
  assert.equal(inspected.certainty, "started");
  if (inspected.state !== "settled" || inspected.outcome.ok) return;
  assert.equal(inspected.outcome.error.code, "execution_unknown");
  assert.equal(inspected.outcome.error.retryable, false);

  const replay = await worker.executor.run(request(key));
  assert.equal(replay.ok, false);
  if (replay.ok) return;
  assert.equal(replay.error.code, "execution_unknown");
  assert.equal(replay.error.certainty, "started");
  assert.equal(replay.error.retryable, false);

  const fresh = await worker.executor.run(request(attemptKey(8)));
  assert.equal(fresh.ok, false);
  if (fresh.ok) return;
  assert.equal(fresh.error.code, "shutting_down");
  assert.equal(fresh.error.certainty, "not-started");
  assert.equal(fresh.error.retryable, true);
  assert.equal(worker.spawns, 1);
});

test("shutdown seals a dispatched attempt as unknown and frees its live record", async () => {
  const live = attemptKey(9);
  const worker = harness({ output: "ok", hang: new Set([live]) });
  const running = worker.executor.run(request(live));
  await new Promise((resolve) => setImmediate(resolve));

  worker.lifecycle.abort();
  worker.executor.shutdown();

  const outcome = await running;
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, "execution_unknown");
  assert.equal(outcome.error.retryable, false);
  assert.deepEqual(worker.cancelled, ["sa-1"]);

  const retention = worker.executor.retention();
  assert.equal(retention.live, 0);
  assert.equal(retention.retainedOutcomes, 0);
  assert.equal(retention.retainedBytes, 0);

  const inspected = await worker.executor.inspect(live);
  assert.equal(inspected.state, "unknown");
  assert.equal(inspected.certainty, "unknown");

  const replay = await worker.executor.run(request(live));
  assert.equal(replay.ok, false);
  if (replay.ok) return;
  assert.equal(replay.error.code, "execution_unknown");
  assert.equal(replay.error.retryable, false);
  assert.equal(worker.spawns, 1);
});
