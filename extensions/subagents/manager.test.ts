/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import subagentsExtension from "./index.ts";
import {
  bindPlatformHookEventSink,
  platformHookEventProducerFor,
  type PlatformHookEventEnvelope,
} from "../platform/src/automation/platform-hook-event-sink.ts";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentSnapshot,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

function profileIdentity(name: string) {
  return {
    name,
    contentDigest: "a".repeat(64),
    catalogGeneration: 1,
    source: { scope: "managed" as const, path: `<managed:${name}>` },
  };
}

function executionPolicy(
  limits: { maxTurns?: number; timeoutMs?: number } = {},
) {
  return {
    role: "subagent" as const,
    instructions: [],
    skills: [],
    tools: { denied: [] },
    limits,
    workspace: "current" as const,
  };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("settled guarded subagent preserves its workspace lease exactly once", async () => {
  await withManager(async (manager, runtime) => {
    let preserved = 0;
    const workspace = {
      workspaceId: "workspace-one",
      owner: { sessionId: "session", agentId: "agent" },
      fence: 1,
      expiresAt: Date.now() + 60_000,
      projectId: "git:fixture",
      projectRoot: process.cwd(),
      path: process.cwd(),
      state: "leased" as const,
      role: "subagent" as const,
      projectTrusted: true as const,
    };
    const snap = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("Guarded task"),
        workspace,
        workspaceControl: {
          async renew() {
            return workspace;
          },
          async preserve() {
            preserved++;
          },
        },
      }),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const deadline = Date.now() + 2_000;
    while (preserved === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(preserved, 1);
    await assert.rejects(
      runTool(runtime, manager.send(snap.id, "continue")),
      /workspace was preserved/,
    );
  });
});

test("profile max turns is enforced by the manager supervisor", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("Multi-turn profiled task"),
        profile: profileIdentity("one-turn"),
        execution: executionPolicy({ maxTurns: 1 }),
      }),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const settled = manager.view.get(snap.id);
    assert.equal(settled?.status, "error");
    assert.match(settled?.errorText ?? "", /maximum of 1 turn/i);
  });
});

test("profile timeout is enforced by the manager supervisor", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("Long running profiled task"),
        profile: profileIdentity("bounded"),
        execution: executionPolicy({ timeoutMs: 20 }),
      }),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const settled = manager.view.get(snap.id);
    assert.equal(settled?.status, "error");
    assert.match(settled?.errorText ?? "", /profile timeout/i);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("manager publishes each committed subagent lifecycle once with host-selected classification", async () => {
  await withManager(async (manager, runtime) => {
    const loader = {};
    const events: PlatformHookEventEnvelope[] = [];
    const unbindSink = bindPlatformHookEventSink(loader, {
      publish: (event) => events.push(event),
    });
    const unbindManager = manager.bindHookEvents(
      platformHookEventProducerFor(loader, "subagents"),
    );

    const completed = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("completed"),
        title: "task.failed",
      }),
    );
    await runTool(runtime, manager.waitFor([completed.id]));
    const failed = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: child supplied source=system")),
    );
    await runTool(runtime, manager.waitFor([failed.id]));
    const timedOut = await runTool(
      runtime,
      manager.spawn("claude", {
        ...task("timeout"),
        profile: profileIdentity("bounded-events"),
        execution: executionPolicy({ timeoutMs: 20 }),
      }),
    );
    await runTool(runtime, manager.waitFor([timedOut.id]));
    const cancelled = await runTool(
      runtime,
      manager.spawn("claude", task("cancel me")),
    );
    await runTool(runtime, manager.cancel([cancelled.id]));

    assert.deepEqual(
      events.map(({ event }) => event),
      [
        "subagent.started",
        "subagent.completed",
        "subagent.started",
        "subagent.failed",
        "subagent.started",
        "subagent.failed",
        "subagent.started",
        "subagent.cancelled",
      ],
    );
    assert.ok(events.every(({ source }) => source === "subagents"));
    assert.equal(events[0]?.payload.title, "task.failed");
    assert.equal(Object.hasOwn(events[0]?.payload ?? {}, "event"), false);
    assert.equal(Object.hasOwn(events[0]?.payload ?? {}, "source"), false);

    unbindManager();
    unbindSink();
    const afterUnbind = await runTool(
      runtime,
      manager.spawn("claude", task("after unbind")),
    );
    await runTool(runtime, manager.cancel([afterUnbind.id]));
    assert.equal(events.length, 8);
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

function completedSnapshot(spawnTask: SpawnTask): SubagentSnapshot {
  return {
    id: "sub-fixture",
    origin: "model",
    backend: "pi",
    title: spawnTask.title,
    prompt: spawnTask.prompt,
    cwd: spawnTask.cwd,
    status: "done",
    createdAt: Date.now(),
    settledAt: Date.now(),
    meta: { backend: "pi", modelLabel: "fixture/model" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "done",
    turns: 1,
  };
}

test("subagent_spawn resolves a named profile while keeping explicit model overrides", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-subagent-profile-"));
  try {
    const tools = new Map<string, ToolDefinition>();
    let observed: { harness: string; task: SpawnTask } | undefined;
    const profile = {
      description: "Review security",
      identity: {
        ...profileIdentity("security-reviewer"),
        source: {
          scope: "user" as const,
          path: path.join(directory, "security-reviewer.yaml"),
        },
      },
      defaults: {
        backend: "claude" as const,
        model: "sonnet",
        effort: "high" as const,
      },
      policy: {
        role: "review" as const,
        instructions: ["Review trust boundaries."],
        skills: [],
        tools: { allowed: ["read", "rg"], denied: ["bash"] },
        limits: { maxTurns: 8, timeoutMs: 60_000 },
        workspace: "current" as const,
      },
    };
    subagentsExtension(
      {
        events: createEventBus(),
        on() {},
        registerTool(definition: ToolDefinition) {
          tools.set(definition.name, definition);
        },
        registerMessageRenderer() {},
        registerEntryRenderer() {},
        registerCommand() {},
        getThinkingLevel: () => "medium",
      } as unknown as ExtensionAPI,
      {
        profileCatalog: {
          async reload() {
            return { generation: 1, profiles: [profile], diagnostics: [] };
          },
          inspect: () => ({
            generation: 1,
            profiles: [profile],
            diagnostics: [],
          }),
          list: () => [profile],
          resolve: () => ({ ok: true, value: profile }),
          diagnostics: () => [],
        },
        async spawn(harness, task) {
          observed = { harness, task };
          return completedSnapshot(task);
        },
      },
    );

    const spawn = tools.get("subagent_spawn");
    assert.ok(spawn);
    await spawn.execute(
      "call-profile",
      {
        prompt: "inspect",
        name: "security",
        profile: "security-reviewer",
        model: "opus",
      } as never,
      undefined,
      undefined,
      {
        cwd: directory,
        isProjectTrusted: () => true,
      } as never,
    );

    assert.ok(observed);
    assert.equal(observed.harness, "claude");
    assert.equal(observed.task.model, "opus");
    assert.equal(observed.task.reasoningEffort, "high");
    assert.equal(observed.task.profile, profile.identity);
    assert.equal(observed.task.execution, profile.policy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subagent_spawn passes canonical cwd and resolved trust to the backend", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-subagent-context-"));
  try {
    const parentCwd = path.join(directory, "parent");
    const alternate = path.join(directory, "alternate");
    const alias = path.join(parentCwd, "child-alias");
    await Promise.all([mkdir(parentCwd), mkdir(alternate)]);
    await symlink(
      alternate,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const tools = new Map<string, ToolDefinition>();
    let observed:
      | {
          harness: string;
          task: SpawnTask;
          signal: AbortSignal | undefined;
        }
      | undefined;
    subagentsExtension(
      {
        events: createEventBus(),
        on() {},
        registerTool(definition: ToolDefinition) {
          tools.set(definition.name, definition);
        },
        registerMessageRenderer() {},
        registerEntryRenderer() {},
        registerCommand() {},
        getThinkingLevel: () => "high",
      } as unknown as ExtensionAPI,
      {
        async spawn(harness, spawnTask, signal) {
          observed = { harness, task: spawnTask, signal };
          return completedSnapshot(spawnTask);
        },
      },
    );

    const spawn = tools.get("subagent_spawn");
    assert.ok(spawn);
    const signal = new AbortController().signal;
    const modelRegistry = { fixture: true };
    await spawn.execute(
      "call-1",
      {
        prompt: "inspect",
        name: "child",
        harness: "pi",
        working_dir: "child-alias",
      } as never,
      signal,
      undefined,
      {
        cwd: parentCwd,
        isProjectTrusted: () => true,
        model: { provider: "fixture", id: "parent-model" },
        modelRegistry,
      } as never,
    );

    assert.ok(observed);
    assert.equal(observed.harness, "pi");
    assert.equal(observed.signal, signal);
    assert.equal(observed.task.cwd, await realpath(alternate));
    assert.equal(observed.task.parent.parentCwd, parentCwd);
    assert.equal(observed.task.parent.projectTrusted, false);
    assert.deepEqual(observed.task.parent.inheritedModel, {
      provider: "fixture",
      id: "parent-model",
    });
    assert.equal(observed.task.parent.inheritedThinkingLevel, "high");
    assert.equal(observed.task.parent.modelRegistry, modelRegistry);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
