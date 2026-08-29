import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime } from "effect";
import { namedProfileExecutionPortFor } from "../platform/src/agents/named-profile-execution-service.ts";
import type {
  ProfileCatalog,
  ResolvedAgentProfile,
} from "../platform/src/profiles/index.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";
import { BackendRegistry } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";
import { createNamedProfileExecutionPort } from "./src/named-profile-execution.ts";
import { runTool } from "./src/runtime.ts";
import subagentsExtension from "./index.ts";

function profile(
  overrides: Partial<ResolvedAgentProfile> = {},
): ResolvedAgentProfile {
  return {
    description: "Hook reviewer",
    identity: {
      name: "hook-reviewer",
      contentDigest: "a".repeat(64),
      catalogGeneration: 4,
      source: { scope: "project", path: "C:\\repo\\.pi\\agents\\hook.yaml" },
    },
    defaults: { backend: "pi", model: "profile-model", effort: "high" },
    policy: {
      role: "review",
      instructions: ["Review exactly."],
      skills: [],
      tools: { allowed: ["read", "rg"], denied: ["write"] },
      limits: { maxTurns: 3, timeoutMs: 10_000 },
      resources: { project: true, contextFiles: false },
      workspace: "current",
    },
    ...overrides,
  };
}

function catalog(current: () => ResolvedAgentProfile): ProfileCatalog {
  return {
    async reload() {
      return { generation: 4, profiles: [current()], diagnostics: [] };
    },
    inspect: () => ({
      generation: current().identity.catalogGeneration,
      profiles: [current()],
      diagnostics: [],
    }),
    list: () => [current()],
    resolve(name) {
      const resolved = current();
      return name === resolved.identity.name
        ? { ok: true, value: resolved }
        : {
            ok: false,
            error: {
              code: "PROFILE_NOT_FOUND",
              message: "not found",
              retryable: false,
            },
          };
    },
    diagnostics: () => [],
  };
}

function snapshot(
  task: SpawnTask,
  status: "running" | "done" = "running",
): SubagentSnapshot {
  return {
    id: "sa-hook",
    origin: task.origin ?? "model",
    backend: "pi",
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    profile: task.profile,
    status,
    createdAt: 1,
    ...(status === "done" ? { settledAt: 2 } : {}),
    meta: { backend: "pi", nativeSessionId: "hook-child" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText:
      status === "done" ? `access_token=hook-secret ${"x".repeat(512)}` : "",
    turns: status === "done" ? 1 : 0,
  };
}

test("named profile execution spawns exact immutable policy and consumes bounded settlement", async () => {
  const resolved = profile();
  let capturedTask: SpawnTask | undefined;
  let settled: SubagentSnapshot | undefined;
  const waited: string[][] = [];
  const manager = {
    async spawn(backend: "pi" | "claude" | "codex", task: SpawnTask) {
      assert.equal(backend, "pi");
      capturedTask = task;
      settled = snapshot(task);
      return settled;
    },
    async waitFor(ids: readonly string[]) {
      waited.push([...ids]);
      settled = snapshot(capturedTask!, "done");
    },
    async get() {
      return settled;
    },
    async cancel() {},
  };
  const lifecycle = new AbortController();
  const port = createNamedProfileExecutionPort({
    profiles: () => catalog(() => resolved),
    manager: async () => manager,
    context: async (cwd) => ({
      cwd,
      catalogProjectMatches: true,
      projectTrusted: true,
      parent: { parentCwd: "C:\\repo", projectTrusted: true },
    }),
    generation: () => 2,
    lifecycleSignal: () => lifecycle.signal,
  });
  const signal = new AbortController().signal;

  assert.deepEqual(
    await port.revalidateProfile({
      ...resolved.identity,
      cwd: "C:\\repo",
      signal,
    }),
    { trusted: true, contentDigest: "a".repeat(64) },
  );
  const result = await port.run({
    profile: resolved,
    prompt: "Review change.",
    cwd: "C:\\repo",
    signal,
    deadlineMs: Date.now() + 5_000,
    outputCapBytes: 128,
  });

  assert.ok(capturedTask);
  assert.equal(capturedTask.model, "profile-model");
  assert.equal(capturedTask.reasoningEffort, "high");
  assert.deepEqual(capturedTask.profile, resolved.identity);
  assert.deepEqual(capturedTask.execution, resolved.policy);
  assert.equal(Object.isFrozen(capturedTask.execution), true);
  assert.equal(Object.isFrozen(capturedTask.execution?.tools), true);
  assert.equal(capturedTask.parent.projectTrusted, true);
  assert.deepEqual(waited, [["sa-hook"]]);
  assert.ok(Buffer.byteLength(result.output ?? "") <= 128);
  assert.doesNotMatch(result.output ?? "", /hook-secret/);
});

test("named profile execution rejects catalog, trust, role, policy, and caller authority drift", async () => {
  let current = profile();
  let projectTrusted = true;
  let managerStarts = 0;
  const lifecycle = new AbortController();
  const port = createNamedProfileExecutionPort({
    profiles: () => catalog(() => current),
    manager: async () => {
      managerStarts++;
      throw new Error("manager must remain lazy");
    },
    context: async (cwd) => ({
      cwd,
      catalogProjectMatches: true,
      projectTrusted,
      parent: { parentCwd: "C:\\repo", projectTrusted },
    }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });
  const controller = new AbortController();
  const original = current;
  const validation = {
    ...original.identity,
    cwd: "C:\\repo",
    signal: controller.signal,
  };
  const run = {
    profile: original,
    prompt: "Review.",
    cwd: "C:\\repo",
    signal: controller.signal,
    deadlineMs: Date.now() + 5_000,
    outputCapBytes: 1_024,
  };

  current = profile({
    identity: {
      ...original.identity,
      contentDigest: "b".repeat(64),
      catalogGeneration: 5,
      source: { scope: "project", path: "C:\\repo\\.pi\\agents\\other.yaml" },
    },
  });
  await assert.rejects(port.revalidateProfile(validation), /stale|changed/i);
  await assert.rejects(port.run(run), /stale|changed/i);

  current = original;
  projectTrusted = false;
  assert.deepEqual(await port.revalidateProfile(validation), {
    trusted: false,
    contentDigest: original.identity.contentDigest,
  });
  await assert.rejects(port.run(run), /trust/i);

  projectTrusted = true;
  const changedPolicy = {
    ...original,
    defaults: { ...original.defaults, model: "caller-model" },
    policy: {
      ...original.policy,
      role: "subagent" as const,
      tools: { allowed: ["write"], denied: [] },
    },
  };
  await assert.rejects(
    port.run({ ...run, profile: changedPolicy }),
    /policy changed/i,
  );
  await assert.rejects(
    port.run(
      Object.assign({}, run, {
        role: "parent",
        tools: ["write"],
        model: "caller-model",
        trust: true,
      }),
    ),
    /invalid/i,
  );

  current = profile({
    policy: { ...original.policy, role: "scheduled" },
  });
  await assert.rejects(
    port.revalidateProfile({
      ...current.identity,
      cwd: "C:\\repo",
      signal: controller.signal,
    }),
    /policy/i,
  );
  assert.equal(managerStarts, 0);
});

test("named profile execution cancels only its child and fences late generations", async () => {
  const resolved = profile({
    identity: {
      ...profile().identity,
      source: { scope: "user", path: "C:\\agent\\agents\\hook.yaml" },
    },
  });
  let generation = 1;
  const lifecycle = new AbortController();
  let notifySpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    notifySpawned = resolve;
  });
  let releaseWait!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const cancellations: string[][] = [];
  let spawns = 0;
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      spawns++;
      notifySpawned();
      return { ...snapshot(task), id: "sa-exact-child" };
    },
    waitFor: async () => waiting,
    async get() {
      return undefined;
    },
    async cancel(ids: readonly string[]) {
      cancellations.push([...ids]);
      releaseWait();
    },
  };
  const port = createNamedProfileExecutionPort({
    profiles: () => catalog(() => resolved),
    manager: async () => manager,
    context: async (cwd) => ({
      cwd,
      catalogProjectMatches: true,
      projectTrusted: false,
      parent: { parentCwd: cwd, projectTrusted: false },
    }),
    generation: () => generation,
    lifecycleSignal: () => lifecycle.signal,
  });
  const controller = new AbortController();
  const pending = port.run({
    profile: resolved,
    prompt: "Review.",
    cwd: "C:\\repo",
    signal: controller.signal,
    deadlineMs: Date.now() + 5_000,
    outputCapBytes: 1_024,
  });
  await spawned;
  controller.abort(new Error("cancel requested"));
  await assert.rejects(
    Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("watchdog expired")), 500),
      ),
    ]),
    /cancel/i,
  );
  assert.deepEqual(cancellations, [["sa-exact-child"]]);

  let releaseManager!: (value: typeof manager) => void;
  const lateManager = new Promise<typeof manager>((resolve) => {
    releaseManager = resolve;
  });
  const fencedPort = createNamedProfileExecutionPort({
    profiles: () => catalog(() => resolved),
    manager: () => lateManager,
    context: async (cwd) => ({
      cwd,
      catalogProjectMatches: true,
      projectTrusted: false,
      parent: { parentCwd: cwd, projectTrusted: false },
    }),
    generation: () => generation,
    lifecycleSignal: () => lifecycle.signal,
  });
  const fenced = fencedPort.run({
    profile: resolved,
    prompt: "Review.",
    cwd: "C:\\repo",
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
    outputCapBytes: 1_024,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  generation++;
  lifecycle.abort();
  releaseManager(manager);
  await assert.rejects(fenced, /shutting down|changed/i);
  assert.equal(spawns, 1);
});

test("named profile execution deadline bounds final settlement retrieval", async () => {
  const resolved = profile({
    identity: {
      ...profile().identity,
      source: { scope: "user", path: "C:\\agent\\agents\\hook.yaml" },
    },
  });
  const lifecycle = new AbortController();
  const cancellations: string[][] = [];
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      return { ...snapshot(task), id: "sa-stuck-get" };
    },
    async waitFor() {},
    get: () => new Promise<SubagentSnapshot | undefined>(() => {}),
    async cancel(ids: readonly string[]) {
      cancellations.push([...ids]);
    },
  };
  const port = createNamedProfileExecutionPort({
    profiles: () => catalog(() => resolved),
    manager: async () => manager,
    context: async (cwd) => ({
      cwd,
      catalogProjectMatches: true,
      projectTrusted: false,
      parent: { parentCwd: cwd, projectTrusted: false },
    }),
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });

  await assert.rejects(
    Promise.race([
      port.run({
        profile: resolved,
        prompt: "Review.",
        cwd: "C:\\repo",
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 50,
        outputCapBytes: 1_024,
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("watchdog expired")), 500),
      ),
    ]),
    /deadline/i,
  );
  assert.deepEqual(cancellations, [["sa-stuck-get"]]);
});

test("named profile execution consumes real manager settlement before normal delivery", async () => {
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
    const resolved = profile({
      identity: {
        ...profile().identity,
        source: { scope: "user", path: "C:\\agent\\agents\\hook.yaml" },
      },
      policy: {
        ...profile().policy,
        role: "subagent",
        tools: { allowed: ["read"], denied: ["write"] },
      },
    });
    const lifecycle = new AbortController();
    const port = createNamedProfileExecutionPort({
      profiles: () => catalog(() => resolved),
      manager: async () => ({
        spawn: (backendName, task, signal) =>
          runTool(runtime, manager.spawn(backendName, task), { signal }),
        waitFor: (ids) => runTool(runtime, manager.waitFor([...ids])),
        get: (id) => runTool(runtime, manager.get(id)),
        cancel: (ids) => runTool(runtime, manager.cancel([...ids])),
      }),
      context: async (cwd) => ({
        cwd,
        catalogProjectMatches: true,
        projectTrusted: false,
        parent: { parentCwd: cwd, projectTrusted: false },
      }),
      generation: () => 1,
      lifecycleSignal: () => lifecycle.signal,
    });

    const result = await port.run({
      profile: resolved,
      prompt: "Inspect repository.",
      cwd: process.cwd(),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
      outputCapBytes: 1_024,
    });

    assert.match(result.output ?? "", /Inspect repository/);
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]?.consumed, true);
  } finally {
    await runtime.dispose();
  }
});

test("subagents binds named profile execution lazily and unbinds before fenced shutdown", async () => {
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
  const resolved = profile();
  subagentsExtension(api, {
    profileCatalog: catalog(() => resolved),
    namedProfileManager: async () => {
      managerStarts++;
      throw new Error("manager must remain lazy");
    },
  });

  const port = namedProfileExecutionPortFor(eventBus);
  assert.ok(port);
  assert.equal(managerStarts, 0);

  await handlers.get("session_shutdown")?.({
    type: "session_shutdown",
    reason: "reload",
  });
  assert.equal(namedProfileExecutionPortFor(eventBus), undefined);
  await assert.rejects(
    port.revalidateProfile({
      ...resolved.identity,
      cwd: "C:\\repo",
      signal: new AbortController().signal,
    }),
    /shutting down/i,
  );
  assert.equal(managerStarts, 0);
});
