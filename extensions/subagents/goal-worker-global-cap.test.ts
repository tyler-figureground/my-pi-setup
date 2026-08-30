/**
 * The Goal Worker against the real Agent Supervisor at its global cap.
 *
 * The classification that matters here cannot be proven with a fake: it is the
 * typed marker the Supervisor emits from its reservation before any child can
 * exist. This drill saturates a real manager over stub backends and asserts
 * that the Attempt comes back provably not started - retryable, with no child
 * identifier - instead of blocking the Goal as an unknown Attempt.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Layer, ManagedRuntime } from "effect";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import { piBackend } from "./src/backends/pi.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import { createGoalWorkerExecutor } from "./src/goal-worker.ts";
import {
  MAX_RUNNING,
  SubagentManager,
  SubagentManagerLive,
} from "./src/manager.ts";
import { runSupervisorSpawn, runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 5_000,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

const profile = {
  description: "Goal cap fixture",
  identity: {
    name: "goal-cap",
    contentDigest: "e".repeat(64),
    catalogGeneration: 3,
    source: { scope: "managed", path: "<goal-cap>" },
  },
  defaults: { backend: "claude" },
  policy: {
    role: "goal-worker",
    instructions: [],
    skills: [],
    tools: { allowed: ["read"], denied: ["write", "edit", "bash"] },
    limits: { maxTurns: 1, timeoutMs: 60_000 },
    workspace: "current",
  },
} as const satisfies ResolvedAgentProfile;

const request = {
  attemptKey: "f".repeat(64),
  prompt: "Inspect once and report.",
  cwd: process.cwd(),
  projectId: "git:goal-cap",
  profile: profile.identity,
  timeoutMs: 30_000,
  maxOutputBytes: 4_096,
} as const;

function occupyingTask(index: number): SpawnTask {
  return {
    prompt: `Occupy slot ${index}`,
    title: `occupier-${index}`,
    cwd: process.cwd(),
    parent,
  };
}

test("the Supervisor pre-dispatch marker settles a saturated Goal Attempt as not started", async (t) => {
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );
  t.after(() => runtime.dispose());
  const manager = await runtime.runPromise(SubagentManager);

  const occupied: string[] = [];
  for (let index = 0; index < MAX_RUNNING; index += 1) {
    const snapshot = await runTool(
      runtime,
      manager.spawn("claude", occupyingTask(index)),
    );
    occupied.push(snapshot.id);
  }
  t.after(async () => {
    await runTool(runtime, manager.cancel(occupied)).catch(() => undefined);
  });
  assert.equal(occupied.length, MAX_RUNNING);

  const lifecycle = new AbortController();
  const worker = createGoalWorkerExecutor({
    profiles: () => ({
      generation: () => profile.identity.catalogGeneration,
      resolve: (name: string) =>
        name === profile.identity.name ? profile : undefined,
    }),
    // Wired exactly as the extension wires the Goal Worker manager seam.
    manager: async () => ({
      spawn: (backend, task, signal) =>
        runSupervisorSpawn(runtime, manager.spawn(backend, task), {
          ...(signal ? { signal } : {}),
          interruptMessage: "Goal Worker spawn cancelled.",
        }),
      waitFor: (ids) => runTool(runtime, manager.waitFor([...ids])),
      get: (id) => runTool(runtime, manager.get(id)),
      cancel: (ids) => runTool(runtime, manager.cancel([...ids])),
    }),
    parent: () => parent,
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });

  const outcome = await worker.run(request);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(
      outcome.error.message,
      new RegExp(`Max ${MAX_RUNNING} subagents can run concurrently`),
    );
    assert.equal(outcome.error.certainty, "not-started");
    assert.equal(outcome.error.retryable, true);
    assert.equal(outcome.error.childId, undefined);
  }
  // Recovery may reclaim this Attempt: no child of it exists to be unknown.
  const inspected = await worker.inspect(request.attemptKey);
  assert.equal(inspected.state, "settled");
  assert.equal(inspected.certainty, "not-started");
});
