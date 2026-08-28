import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime } from "effect";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import { scheduledAgentExecutorFor } from "../shared/scheduled-agent.ts";
import subagentsExtension from "./index.ts";
import { BackendRegistry } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import { createScheduledAgentExecutor } from "./src/scheduled-agent.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";

const occurrenceId = "a".repeat(64);

const profile = {
  description: "Scheduled fixture",
  identity: {
    name: "scheduled-fixture",
    contentDigest: "b".repeat(64),
    catalogGeneration: 7,
    source: { scope: "managed", path: "<scheduled-fixture>" },
  },
  defaults: { backend: "pi", model: "host-model", effort: "high" },
  policy: {
    role: "scheduled",
    instructions: ["Run scheduled maintenance."],
    skills: [],
    tools: { allowed: ["read", "rg"], denied: ["write", "edit", "bash"] },
    limits: { maxTurns: 2, timeoutMs: 10_000 },
    resources: { project: false, contextFiles: false },
    workspace: "current",
  },
} as const satisfies ResolvedAgentProfile;

function snapshot(task: SpawnTask, status: "running" | "done" = "running") {
  return {
    id: "sa-scheduled",
    origin: task.origin ?? "model",
    backend: profile.defaults.backend,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    profile: task.profile,
    status,
    createdAt: 1,
    ...(status === "done" ? { settledAt: 2 } : {}),
    meta: {
      backend: profile.defaults.backend,
      nativeSessionId: "scheduled-child",
    },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: status === "done" ? "scheduled result" : "",
    turns: status === "done" ? 1 : 0,
  } satisfies SubagentSnapshot;
}

test("scheduled execution uses the exact resolved profile policy and consumes settlement", async () => {
  let capturedBackend: string | undefined;
  let capturedTask: SpawnTask | undefined;
  let current: SubagentSnapshot | undefined;
  const waited: string[][] = [];
  const manager = {
    async spawn(backend: "pi" | "claude" | "codex", task: SpawnTask) {
      capturedBackend = backend;
      capturedTask = task;
      current = snapshot(task);
      return current;
    },
    async waitFor(ids: readonly string[]) {
      waited.push([...ids]);
      current = snapshot(capturedTask!, "done");
    },
    async get() {
      return current;
    },
    async cancel() {},
  };
  const lifecycle = new AbortController();
  const executor = createScheduledAgentExecutor({
    manager: async () => manager,
    parent: () => ({
      parentCwd: "C:\\host-parent",
      projectTrusted: false,
    }),
    generation: () => 3,
    lifecycleSignal: () => lifecycle.signal,
  });

  const outcome = await executor.run({
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  });

  assert.deepEqual(outcome, {
    ok: true,
    value: {
      status: "completed",
      output: "scheduled result",
      outputBytes: 16,
      sessionId: "scheduled-child",
    },
  });
  assert.equal(capturedBackend, "pi");
  assert.ok(capturedTask);
  assert.equal(capturedTask.origin, "model");
  assert.equal(capturedTask.title, `Scheduled occurrence ${occurrenceId}`);
  assert.equal(capturedTask.cwd, "C:\\scheduled-project");
  assert.equal(capturedTask.model, "host-model");
  assert.equal(capturedTask.reasoningEffort, "high");
  assert.deepEqual(capturedTask.profile, profile.identity);
  assert.deepEqual(capturedTask.execution, profile.policy);
  assert.deepEqual(capturedTask.execution?.tools, {
    allowed: ["read", "rg"],
    denied: ["write", "edit", "bash"],
  });
  assert.equal(capturedTask.execution?.role, "scheduled");
  assert.equal(capturedTask.parent.projectTrusted, false);
  assert.deepEqual(waited, [["sa-scheduled"]]);
});

test("scheduled execution rejects invalid bounds and authority overrides before manager creation", async () => {
  let managerStarts = 0;
  const lifecycle = new AbortController();
  const executor = createScheduledAgentExecutor({
    manager: async () => {
      managerStarts++;
      throw new Error("manager must stay lazy");
    },
    parent: () => ({ parentCwd: "C:\\host", projectTrusted: false }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });
  const validRequest = {
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  };
  const invalidRequests: unknown[] = [
    { ...validRequest, occurrenceId: "not-an-occurrence" },
    { ...validRequest, prompt: "" },
    { ...validRequest, prompt: "x".repeat(256 * 1_024 + 1) },
    { ...validRequest, cwd: "relative/path" },
    { ...validRequest, projectId: "" },
    { ...validRequest, timeoutMs: 999 },
    { ...validRequest, timeoutMs: 60 * 60 * 1_000 + 1 },
    { ...validRequest, maxOutputBytes: 0 },
    { ...validRequest, maxOutputBytes: 16 * 1_024 * 1_024 + 1 },
    { ...validRequest, role: "parent" },
    { ...validRequest, tools: ["bash"] },
    { ...validRequest, model: "caller-model" },
    { ...validRequest, trust: true },
    { ...validRequest, extra: "not-allowed" },
  ];
  let accessorReads = 0;
  const accessorRequest = { ...validRequest };
  Object.defineProperty(accessorRequest, "prompt", {
    enumerable: true,
    get() {
      accessorReads++;
      return "must-not-run";
    },
  });
  invalidRequests.push(accessorRequest);

  for (const request of invalidRequests) {
    const outcome = await executor.run(
      request as Parameters<typeof executor.run>[0],
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, "invalid_request");
  }
  assert.equal(accessorReads, 0);
  assert.equal(managerStarts, 0);
});

test("scheduled execution denies non-scheduled and unenforceable profiles", async () => {
  let managerStarts = 0;
  const lifecycle = new AbortController();
  const executor = createScheduledAgentExecutor({
    manager: async () => {
      managerStarts++;
      throw new Error("manager must stay lazy");
    },
    parent: () => ({ parentCwd: "C:\\host", projectTrusted: false }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });
  const request = {
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  };

  const wrongRole = await executor.run({
    ...request,
    profile: {
      ...profile,
      policy: { ...profile.policy, role: "subagent" },
    },
  });
  assert.equal(wrongRole.ok, false);
  if (!wrongRole.ok) assert.equal(wrongRole.error.code, "profile_denied");

  const unenforceable = await executor.run({
    ...request,
    profile: {
      ...profile,
      defaults: { ...profile.defaults, backend: "claude" },
      policy: {
        ...profile.policy,
        tools: { allowed: ["unknown-host-tool"], denied: [] },
      },
    },
  });
  assert.equal(unenforceable.ok, false);
  if (!unenforceable.ok)
    assert.equal(unenforceable.error.code, "profile_denied");
  assert.equal(managerStarts, 0);
});

test("scheduled execution maps child failure and oversized output to bounded redacted outcomes", async () => {
  const lifecycle = new AbortController();
  const request = {
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 32,
  };
  const makeManager = (settled: SubagentSnapshot) => ({
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      return snapshot(task);
    },
    async waitFor() {},
    async get() {
      return settled;
    },
    async cancel() {},
  });
  const failed = {
    ...snapshot(
      {
        prompt: request.prompt,
        title: "scheduled",
        cwd: request.cwd,
        parent: { parentCwd: request.cwd, projectTrusted: false },
      },
      "done",
    ),
    status: "error",
    errorText: `token=super-secret ${"x".repeat(2_000)}`,
  } satisfies SubagentSnapshot;
  const failedExecutor = createScheduledAgentExecutor({
    manager: async () => makeManager(failed),
    parent: () => ({ parentCwd: request.cwd, projectTrusted: false }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });

  const failureOutcome = await failedExecutor.run(request);
  assert.equal(failureOutcome.ok, false);
  if (!failureOutcome.ok) {
    assert.equal(failureOutcome.error.code, "run_failed");
    assert.equal(failureOutcome.error.retryable, true);
    assert.doesNotMatch(failureOutcome.error.message, /super-secret/);
    assert.ok(Buffer.byteLength(failureOutcome.error.message) <= 1_000);
  }

  const oversized = {
    ...failed,
    status: "done",
    errorText: undefined,
    finalText: `password=hunter2 ${"result ".repeat(20)}`,
  } satisfies SubagentSnapshot;
  const oversizedExecutor = createScheduledAgentExecutor({
    manager: async () => makeManager(oversized),
    parent: () => ({ parentCwd: request.cwd, projectTrusted: false }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });
  const outputOutcome = await oversizedExecutor.run(request);
  assert.deepEqual(outputOutcome, {
    ok: false,
    error: {
      code: "output_bounded",
      message: "Scheduled Agent output exceeded 32 bytes.",
      retryable: false,
    },
  });
});

test("scheduled execution abort cancels the exact child and drains before returning", async () => {
  const lifecycle = new AbortController();
  const caller = new AbortController();
  let releaseWait: (() => void) | undefined;
  let announceSpawn: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    announceSpawn = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const cancelled: string[][] = [];
  let cancelDrained = false;
  let current: SubagentSnapshot | undefined;
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      current = snapshot(task);
      announceSpawn?.();
      return current;
    },
    async waitFor() {
      await wait;
    },
    async get() {
      return current;
    },
    async cancel(ids: readonly string[]) {
      cancelled.push([...ids]);
      current = {
        ...current!,
        status: "error",
        settledAt: 2,
        errorText: "Run was aborted",
      };
      releaseWait?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      cancelDrained = true;
    },
  };
  const executor = createScheduledAgentExecutor({
    manager: async () => manager,
    parent: () => ({
      parentCwd: "C:\\scheduled-project",
      projectTrusted: false,
    }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });
  const running = executor.run(
    {
      occurrenceId,
      prompt: "Inspect repository",
      cwd: "C:\\scheduled-project",
      projectId: "git:scheduled-project",
      profile,
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    },
    caller.signal,
  );
  await spawned;
  caller.abort();

  const outcome = await running;
  assert.deepEqual(cancelled, [["sa-scheduled"]]);
  assert.equal(cancelDrained, true);
  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: "cancelled",
      message: "Scheduled Agent execution was cancelled.",
      retryable: false,
    },
  });
});

test(
  "scheduled execution abort also bounds backend startup",
  { timeout: 1_000 },
  async () => {
    const lifecycle = new AbortController();
    const caller = new AbortController();
    let spawnSignal: AbortSignal | undefined;
    let announceSpawn: (() => void) | undefined;
    const spawning = new Promise<void>((resolve) => {
      announceSpawn = resolve;
    });
    const manager = {
      async spawn(
        _backend: "pi" | "claude" | "codex",
        _task: SpawnTask,
        signal?: AbortSignal,
      ) {
        spawnSignal = signal;
        announceSpawn?.();
        return new Promise<SubagentSnapshot>(() => undefined);
      },
      async waitFor() {},
      async get() {
        return undefined;
      },
      async cancel() {},
    };
    const executor = createScheduledAgentExecutor({
      manager: async () => manager,
      parent: () => ({
        parentCwd: "C:\\scheduled-project",
        projectTrusted: false,
      }),
      generation: () => 1,
      lifecycleSignal: () => lifecycle.signal,
    });
    const running = executor.run(
      {
        occurrenceId,
        prompt: "Inspect repository",
        cwd: "C:\\scheduled-project",
        projectId: "git:scheduled-project",
        profile,
        timeoutMs: 10_000,
        maxOutputBytes: 1_024,
      },
      caller.signal,
    );
    await spawning;
    caller.abort();

    assert.deepEqual(await running, {
      ok: false,
      error: {
        code: "cancelled",
        message: "Scheduled Agent execution was cancelled.",
        retryable: false,
      },
    });
    assert.equal(spawnSignal?.aborted, true);
  },
);

test("scheduled execution timeout cancels the exact child and cannot become late success", async () => {
  const lifecycle = new AbortController();
  let releaseWait: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const cancelled: string[][] = [];
  let current: SubagentSnapshot | undefined;
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      current = snapshot(task);
      return current;
    },
    async waitFor() {
      await wait;
    },
    async get() {
      return current;
    },
    async cancel(ids: readonly string[]) {
      cancelled.push([...ids]);
      current = {
        ...current!,
        status: "done",
        settledAt: 2,
        finalText: "late success",
        turns: 1,
      };
      releaseWait?.();
    },
  };
  const executor = createScheduledAgentExecutor({
    manager: async () => manager,
    parent: () => ({
      parentCwd: "C:\\scheduled-project",
      projectTrusted: false,
    }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });

  const outcome = await executor.run({
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  });

  assert.deepEqual(cancelled, [["sa-scheduled"]]);
  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: "timed_out",
      message: "Scheduled Agent execution timed out after 1000 ms.",
      retryable: true,
    },
  });
});

test("scheduled execution fences shutdown generation and rejects late success", async () => {
  let generation = 4;
  const lifecycle = new AbortController();
  let announceSpawn: (() => void) | undefined;
  let releaseWait: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    announceSpawn = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const cancelled: string[][] = [];
  let current: SubagentSnapshot | undefined;
  let managerStarts = 0;
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      current = snapshot(task);
      announceSpawn?.();
      return current;
    },
    async waitFor() {
      await wait;
    },
    async get() {
      return current;
    },
    async cancel(ids: readonly string[]) {
      cancelled.push([...ids]);
      current = {
        ...current!,
        status: "done",
        settledAt: 2,
        finalText: "late success after shutdown",
        turns: 1,
      };
      releaseWait?.();
    },
  };
  const executor = createScheduledAgentExecutor({
    manager: async () => {
      managerStarts++;
      return manager;
    },
    parent: () => ({
      parentCwd: "C:\\scheduled-project",
      projectTrusted: false,
    }),
    generation: () => generation,
    lifecycleSignal: () => lifecycle.signal,
  });
  const request = {
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  };
  const running = executor.run(request);
  await spawned;
  generation++;
  lifecycle.abort();

  const outcome = await running;
  assert.deepEqual(cancelled, [["sa-scheduled"]]);
  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: "shutting_down",
      message: "Scheduled Agent executor is shutting down.",
      retryable: true,
    },
  });
  assert.deepEqual(await executor.run(request), outcome);
  assert.equal(managerStarts, 1);
});

test("scheduled execution maps backend startup failure without leaking secrets", async () => {
  const lifecycle = new AbortController();
  const executor = createScheduledAgentExecutor({
    manager: async () => ({
      async spawn() {
        throw new Error('Backend "pi" is not available; token=backend-secret');
      },
      async waitFor() {},
      async get() {
        return undefined;
      },
      async cancel() {},
    }),
    parent: () => ({
      parentCwd: "C:\\scheduled-project",
      projectTrusted: false,
    }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });

  const outcome = await executor.run({
    occurrenceId,
    prompt: "Inspect repository",
    cwd: "C:\\scheduled-project",
    projectId: "git:scheduled-project",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "backend_unavailable");
    assert.equal(outcome.error.retryable, true);
    assert.doesNotMatch(outcome.error.message, /backend-secret/);
  }
});

test("subagents binds loader-local executor lazily and unbinds before shutdown", async () => {
  const eventBus = createEventBus();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let managerStarts = 0;
  const api = {
    events: eventBus,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry() {},
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  subagentsExtension(api, {
    scheduledAgentManager: async () => {
      managerStarts++;
      throw new Error("manager must remain lazy");
    },
  });

  const executor = scheduledAgentExecutorFor(eventBus);
  assert.ok(executor);
  assert.equal(managerStarts, 0);

  await handlers.get("session_shutdown")?.({
    type: "session_shutdown",
    reason: "reload",
  });
  assert.equal(scheduledAgentExecutorFor(eventBus), undefined);
  assert.deepEqual(
    await executor.run({
      occurrenceId,
      prompt: "Inspect repository",
      cwd: "C:\\scheduled-project",
      projectId: "git:scheduled-project",
      profile,
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    }),
    {
      ok: false,
      error: {
        code: "shutting_down",
        message: "Scheduled Agent executor is shutting down.",
        retryable: true,
      },
    },
  );
  assert.equal(managerStarts, 0);
});

test("scheduled execution consumes real manager settlement before normal result delivery", async () => {
  const backend = makeStubBackend({
    backend: "pi",
    defaultModelLabel: "stub/pi",
    contextWindow: 16_000,
    toolName: "read",
    cadenceMs: 1,
  });
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(Layer.succeed(BackendRegistry, new Map([["pi", backend]]))),
    ),
  );
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const settlements: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((settled, consumed) => {
      settlements.push({ id: settled.id, consumed });
    });
    const lifecycle = new AbortController();
    const executor = createScheduledAgentExecutor({
      manager: async () => ({
        spawn: (backendName, task) =>
          runtime.runPromise(manager.spawn(backendName, task)),
        waitFor: (ids) => runtime.runPromise(manager.waitFor(ids)),
        get: (id) => runtime.runPromise(manager.get(id)),
        cancel: (ids) => runtime.runPromise(manager.cancel(ids)),
      }),
      parent: () => ({
        parentCwd: "C:\\scheduled-project",
        projectTrusted: false,
      }),
      generation: () => 1,
      lifecycleSignal: () => lifecycle.signal,
    });

    const outcome = await executor.run({
      occurrenceId,
      prompt: "Inspect repository",
      cwd: "C:\\scheduled-project",
      projectId: "git:scheduled-project",
      profile,
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });

    assert.equal(outcome.ok, true);
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]?.consumed, true);
  } finally {
    await runtime.dispose();
  }
});
