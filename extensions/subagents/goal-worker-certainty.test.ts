import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import {
  createGoalWorkerExecutor,
  type GoalWorkerSubagentManager,
} from "./src/goal-worker.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import { SupervisorPreDispatchError } from "./src/manager.ts";

const attemptKey = "c".repeat(64);
const profile = {
  description: "Goal certainty fixture",
  identity: {
    name: "goal-certainty",
    contentDigest: "d".repeat(64),
    catalogGeneration: 9,
    source: { scope: "managed", path: "<goal-certainty>" },
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

const request = {
  attemptKey,
  prompt: "Inspect once.",
  cwd: "C:\\goal-project",
  projectId: "git:goal-project",
  profile: profile.identity,
  timeoutMs: 10_000,
  maxOutputBytes: 1_024,
} as const;

function snapshot(task: SpawnTask, status: "running" | "done" = "running") {
  return {
    id: "sa-certainty",
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
    finalText: status === "done" ? "done" : "",
    turns: status === "done" ? 1 : 0,
  } satisfies SubagentSnapshot;
}

function executor(
  manager: GoalWorkerSubagentManager,
  overrides: { readonly usagePollMs?: number } = {},
) {
  const lifecycle = new AbortController();
  return createGoalWorkerExecutor({
    profiles: () => ({
      generation: () => profile.identity.catalogGeneration,
      resolve: () => profile,
    }),
    manager: async () => manager,
    parent: () => ({
      parentCwd: "C:\\host",
      projectTrusted: false,
    }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
    ...(overrides.usagePollMs === undefined
      ? {}
      : { usagePollMs: overrides.usagePollMs }),
  });
}

test("same attempt key adopts one live dispatch and conflicting input never redispatches", async () => {
  let releaseSpawn: ((value: SubagentSnapshot) => void) | undefined;
  let task: SpawnTask | undefined;
  let spawns = 0;
  const spawning = new Promise<SubagentSnapshot>((resolve) => {
    releaseSpawn = resolve;
  });
  const manager: GoalWorkerSubagentManager = {
    async spawn(_backend, next) {
      spawns++;
      task = next;
      return spawning;
    },
    async waitFor() {},
    async get() {
      return task ? snapshot(task, "done") : undefined;
    },
    async cancel() {},
  };
  const worker = executor(manager);
  const first = worker.run(request);
  const adopted = worker.run(request);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first, adopted);
  assert.equal(spawns, 1);
  assert.deepEqual(await worker.inspect(attemptKey), {
    attemptKey,
    state: "unknown",
    certainty: "unknown",
  });
  const conflict = await worker.run({ ...request, prompt: "Different work." });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "attempt_conflict");
    assert.equal(conflict.error.certainty, "unknown");
    assert.equal(conflict.error.retryable, false);
  }

  releaseSpawn?.(snapshot(task!));
  assert.equal((await first).ok, true);
  const inspection = await worker.inspect(attemptKey);
  assert.equal(inspection.state, "settled");
  assert.equal(inspection.certainty, "started");
  assert.equal(spawns, 1);
});

test("a finite token cap without authoritative metering is rejected before dispatch", async () => {
  let spawns = 0;
  const worker = executor({
    async spawn(_backend, next) {
      spawns += 1;
      return snapshot(next);
    },
    async waitFor() {},
    async get() {
      return undefined;
    },
    async cancel() {},
  });

  const outcome = await worker.run({ ...request, maxTokens: 100 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "metering_unavailable");
    assert.equal(outcome.error.certainty, "not-started");
    assert.equal(outcome.error.retryable, false);
    assert.equal(outcome.error.usage, undefined);
  }
  assert.equal(spawns, 0);
});

test("an unmetered default completion reports no usage rather than inventing it", async () => {
  let task: SpawnTask | undefined;
  const worker = executor({
    async spawn(_backend, next) {
      task = next;
      return snapshot(next);
    },
    async waitFor() {},
    async get() {
      return task ? snapshot(task, "done") : undefined;
    },
    async cancel() {},
  });

  const outcome = await worker.run(request);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.value.usage, undefined);
});

test("an executor that claims metering must still deliver it", async () => {
  let task: SpawnTask | undefined;
  const worker = executor({
    async spawn(_backend, next) {
      task = next;
      return snapshot(next);
    },
    async waitFor() {},
    async get() {
      return task ? snapshot(task, "done") : undefined;
    },
    async cancel() {},
    async authoritativeTokens() {
      return undefined;
    },
  });

  const outcome = await worker.run({ ...request, maxTokens: 100 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "metering_unavailable");
    assert.equal(outcome.error.certainty, "started");
  }
});

test("authoritative usage is reported and token overage cannot complete", async () => {
  let task: SpawnTask | undefined;
  const worker = executor({
    async spawn(_backend, next) {
      task = next;
      return snapshot(next);
    },
    async waitFor() {},
    async get() {
      return task ? snapshot(task, "done") : undefined;
    },
    async cancel() {},
    async authoritativeTokens() {
      return 101;
    },
  });

  const outcome = await worker.run({ ...request, maxTokens: 100 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "token_bounded");
    assert.equal(outcome.error.certainty, "started");
    assert.deepEqual(outcome.error.usage, {
      tokens: 101,
      authoritative: true,
      source: "agent-supervisor",
    });
  }
});

test("a proven pre-dispatch rejection never becomes an unknown Attempt", async () => {
  const globalCap = new SupervisorPreDispatchError({
    reason: "capacity",
    message:
      "Max 8 subagents can run concurrently. Wait for one to finish before spawning another.",
  });
  let spawns = 0;
  const worker = executor({
    async spawn() {
      spawns += 1;
      throw globalCap;
    },
    async waitFor() {
      throw new Error("must not wait on a child that was never created");
    },
    async get() {
      throw new Error("must not settle a child that was never created");
    },
    async cancel() {
      throw new Error("must not cancel a child that was never created");
    },
  });

  const outcome = await worker.run(request);
  assert.equal(spawns, 1);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.certainty, "not-started");
    assert.equal(outcome.error.retryable, true);
    assert.equal(outcome.error.childId, undefined);
    assert.match(outcome.error.message, /Max 8 subagents/);
  }
  // Inspection agrees, so recovery reclaims the Attempt instead of blocking it.
  const inspected = await worker.inspect(attemptKey);
  assert.equal(inspected.state, "settled");
  assert.equal(inspected.certainty, "not-started");
});

test("pre-dispatch guards keep their own failure codes and stay retryable", async () => {
  const cases = [
    {
      error: new SupervisorPreDispatchError({
        reason: "shutting-down",
        message: "Subagent manager is shutting down.",
      }),
      code: "shutting_down",
    },
    {
      error: new SupervisorPreDispatchError({
        reason: "backend-unavailable",
        message:
          'Backend "claude" is not available on this machine (binary/SDK/credentials missing).',
      }),
      code: "backend_unavailable",
    },
    {
      error: new SupervisorPreDispatchError({
        reason: "capacity",
        message: "host proved nothing started",
      }),
      code: "run_failed",
    },
  ] as const;
  for (const entry of cases) {
    const worker = executor({
      async spawn() {
        throw entry.error;
      },
      async waitFor() {},
      async get() {
        return undefined;
      },
      async cancel() {},
    });
    const outcome = await worker.run(request);
    assert.equal(outcome.ok, false, entry.code);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, entry.code);
      assert.equal(outcome.error.certainty, "not-started");
      assert.equal(outcome.error.retryable, true);
    }
  }
});

test("a rejection that cannot rule out a child stays unknown and unretryable", async () => {
  const ambiguous = [
    new Error("Subagent manager shut down while spawning."),
    new Error("socket hang up"),
    new Error(
      "Max 8 subagents can run concurrently. Wait for one to finish before spawning another.",
    ),
    new Error("Subagent manager is shutting down."),
    new Error('Unknown backend "claude".'),
    new Error(
      'Backend "claude" is not available on this machine (binary/SDK/credentials missing).',
    ),
    Object.assign(new Error("host claimed nothing started"), {
      goalWorkerSpawnCertainty: "not-started",
    }),
  ];
  for (const error of ambiguous) {
    const worker = executor({
      async spawn() {
        throw error;
      },
      async waitFor() {},
      async get() {
        return undefined;
      },
      async cancel() {},
    });
    const outcome = await worker.run(request);
    assert.equal(outcome.ok, false, error.message);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, "execution_unknown");
      assert.equal(outcome.error.certainty, "unknown");
      assert.equal(outcome.error.retryable, false);
    }
    const inspected = await worker.inspect(attemptKey);
    assert.equal(inspected.certainty, "unknown");
  }
});

test("a running child is cancelled as soon as metered usage reaches the token cap", async () => {
  let task: SpawnTask | undefined;
  const cancelled: string[] = [];
  let polls = 0;
  const worker = executor(
    {
      async spawn(_backend, next) {
        task = next;
        return snapshot(next);
      },
      async waitFor() {
        // The child never settles on its own; only the cap stops it.
        await new Promise<void>(() => {});
      },
      async get() {
        return task ? snapshot(task, "done") : undefined;
      },
      async cancel(ids) {
        cancelled.push(...ids);
      },
      async authoritativeTokens() {
        polls += 1;
        return polls * 60;
      },
    },
    { usagePollMs: 1 },
  );

  const outcome = await worker.run({ ...request, maxTokens: 100 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "token_bounded");
    assert.equal(outcome.error.certainty, "started");
    assert.equal(outcome.error.retryable, false);
    assert.equal(outcome.error.childId, "sa-certainty");
    assert.deepEqual(outcome.error.usage, {
      tokens: 120,
      authoritative: true,
      source: "agent-supervisor",
    });
  }
  // Cancelled preemptively: the child was still running and never settled on
  // its own, so only the cap could have ended this Attempt.
  assert.ok(cancelled.length >= 1);
  assert.ok(cancelled.every((id) => id === "sa-certainty"));
  assert.equal(polls, 2);
});

test("usage polling stops when a child settles under its cap", async () => {
  let task: SpawnTask | undefined;
  const cancelled: string[] = [];
  const worker = executor(
    {
      async spawn(_backend, next) {
        task = next;
        return snapshot(next);
      },
      async waitFor() {},
      async get() {
        return task ? snapshot(task, "done") : undefined;
      },
      async cancel(ids) {
        cancelled.push(...ids);
      },
      async authoritativeTokens() {
        return 10;
      },
    },
    { usagePollMs: 1 },
  );

  const outcome = await worker.run({ ...request, maxTokens: 100 });
  assert.equal(outcome.ok, true);
  if (outcome.ok)
    assert.deepEqual(outcome.value.usage, {
      tokens: 10,
      authoritative: true,
      source: "agent-supervisor",
    });
  assert.deepEqual(cancelled, []);
});

test("missing settlement is unknown and therefore never retryable", async () => {
  const worker = executor({
    async spawn(_backend, task) {
      return snapshot(task);
    },
    async waitFor() {},
    async get() {
      return undefined;
    },
    async cancel() {},
  });

  const outcome = await worker.run(request);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "execution_unknown");
    assert.equal(outcome.error.certainty, "unknown");
    assert.equal(outcome.error.retryable, false);
    assert.equal(outcome.error.childId, "sa-certainty");
  }
});

test("Supervisor wait failure cannot certify dispatched work as terminal", async () => {
  const worker = executor({
    async spawn(_backend, task) {
      return snapshot(task);
    },
    async waitFor() {
      throw new Error("Supervisor connection lost");
    },
    async get() {
      return undefined;
    },
    async cancel() {},
  });

  const outcome = await worker.run(request);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "execution_unknown");
    assert.equal(outcome.error.certainty, "unknown");
    assert.equal(outcome.error.retryable, false);
  }
});

test("output bound rejects certified completion without returning partial content", async () => {
  let task: SpawnTask | undefined;
  const worker = executor({
    async spawn(_backend, next) {
      task = next;
      return snapshot(next);
    },
    async waitFor() {},
    async get() {
      return task
        ? { ...snapshot(task, "done"), finalText: "oversized output" }
        : undefined;
    },
    async cancel() {},
  });

  const outcome = await worker.run({ ...request, maxOutputBytes: 4 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "output_bounded");
    assert.equal(outcome.error.certainty, "started");
    assert.equal(Object.hasOwn(outcome.error, "output"), false);
  }
});

test("caller cancellation after dispatch cancels exact child and fences late success as unknown", async () => {
  let announce: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const cancelled: string[][] = [];
  const manager: GoalWorkerSubagentManager = {
    async spawn(_backend, task) {
      announce?.();
      return snapshot(task);
    },
    async waitFor() {
      await new Promise(() => undefined);
    },
    async get() {
      return undefined;
    },
    async cancel(ids) {
      cancelled.push([...ids]);
    },
  };
  const worker = executor(manager);
  const caller = new AbortController();
  const running = worker.run(request, caller.signal);
  await spawned;
  caller.abort();

  const outcome = await running;
  assert.deepEqual(cancelled, [["sa-certainty"]]);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "execution_unknown");
    assert.equal(outcome.error.certainty, "unknown");
    assert.equal(outcome.error.retryable, false);
  }
});

test("lifecycle generation fence rejects post-shutdown and late child success", async () => {
  let generation = 3;
  const lifecycle = new AbortController();
  let announce: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const cancelled: string[][] = [];
  const manager: GoalWorkerSubagentManager = {
    async spawn(_backend, task) {
      announce?.();
      return snapshot(task);
    },
    async waitFor() {
      await new Promise(() => undefined);
    },
    async get() {
      return undefined;
    },
    async cancel(ids) {
      cancelled.push([...ids]);
    },
  };
  const worker = createGoalWorkerExecutor({
    profiles: () => ({ generation: () => 9, resolve: () => profile }),
    manager: async () => manager,
    parent: () => ({ parentCwd: "C:\\host", projectTrusted: false }),
    generation: () => generation,
    lifecycleSignal: () => lifecycle.signal,
  });
  const running = worker.run(request);
  await spawned;
  generation++;
  lifecycle.abort();

  const outcome = await running;
  assert.deepEqual(cancelled, [["sa-certainty"]]);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "execution_unknown");
    assert.equal(outcome.error.certainty, "unknown");
  }
  const afterShutdown = await worker.run({
    ...request,
    attemptKey: "e".repeat(64),
  });
  assert.equal(afterShutdown.ok, false);
  if (!afterShutdown.ok) {
    assert.equal(afterShutdown.error.code, "shutting_down");
    assert.equal(afterShutdown.error.certainty, "not-started");
  }
});

test("timeout cancels dispatched child and remains ambiguous", async () => {
  const cancelled: string[][] = [];
  const worker = executor({
    async spawn(_backend, task) {
      return snapshot(task);
    },
    async waitFor() {
      await new Promise(() => undefined);
    },
    async get() {
      return undefined;
    },
    async cancel(ids) {
      cancelled.push([...ids]);
    },
  });

  const outcome = await worker.run({ ...request, timeoutMs: 1_000 });
  assert.deepEqual(cancelled, [["sa-certainty"]]);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "execution_unknown");
    assert.equal(outcome.error.certainty, "unknown");
    assert.equal(outcome.error.retryable, false);
  }
});
