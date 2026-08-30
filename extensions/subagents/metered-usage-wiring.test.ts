/**
 * Metering end to end: a backend's events, the Supervisor snapshot they fold
 * into, and the Goal Worker cap that is enforced from it.
 *
 * The backend here is scripted rather than stubbed so the two token quantities
 * can be moved independently — that is the only way to prove the fold keeps
 * them apart instead of coincidentally agreeing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Cause, Scope } from "effect";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import type { BackendName, SubagentEvent, SubagentMeta } from "./src/domain.ts";
import {
  createGoalWorkerExecutor,
  withSupervisorMetering,
  type GoalWorkerSubagentManager,
} from "./src/goal-worker.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

/** A backend that emits exactly the given events, in order, then stops. */
function scriptedBackend(
  name: BackendName,
  script: ReadonlyArray<SubagentEvent>,
): SubagentBackend {
  return {
    name,
    capabilities: {
      steering: false,
      modelSelection: false,
      reasoningEffort: false,
    },
    available: Effect.succeed(true),
    spawn: (): Effect.Effect<
      {
        meta: Effect.Effect<SubagentMeta>;
        events: Stream.Stream<SubagentEvent>;
        send: () => Effect.Effect<void>;
        interrupt: Effect.Effect<void>;
      },
      never,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const meta: SubagentMeta = { backend: name, contextWindow: 200_000 };
        const events = yield* Queue.make<SubagentEvent, Cause.Done>();
        // A script that stops mid-run leaves the run active, exactly like a
        // child still working. Interrupting must then terminate it, or the
        // Supervisor's cancel would wait for a settlement that never comes.
        let active = false;
        const offer = (event: SubagentEvent) =>
          Effect.gen(function* () {
            if (event._tag === "RunStarted") active = true;
            if (event._tag === "RunSettled") active = false;
            yield* Queue.offer(events, event);
          });
        yield* Effect.forkScoped(
          Effect.forEach(script, offer, { discard: true }).pipe(Effect.ignore),
        );
        yield* Effect.addFinalizer(() => Queue.end(events).pipe(Effect.ignore));
        return {
          meta: Effect.succeed(meta),
          events: Stream.fromQueue(events),
          send: () => Effect.void,
          interrupt: Effect.suspend(() =>
            active
              ? offer({
                  _tag: "RunSettled",
                  outcome: { _tag: "Interrupted" },
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
        };
      }),
  };
}

async function withScriptedManager(
  script: ReadonlyArray<SubagentEvent>,
  run: (
    manager: SubagentManagerShape,
    runtime: ManagedRuntime.ManagedRuntime<SubagentManager, never>,
  ) => Promise<void>,
) {
  const registry = Layer.sync(BackendRegistry, () => {
    const backend = scriptedBackend("claude", script);
    return new Map<BackendName, SubagentBackend>([[backend.name, backend]]);
  });
  const runtime = ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(registry)),
  );
  try {
    await run(await runtime.runPromise(SubagentManager), runtime);
  } finally {
    await runtime.dispose();
  }
}

const parent = { parentCwd: process.cwd(), projectTrusted: false };
const task = {
  prompt: "Do the bounded work.",
  title: "metered",
  cwd: process.cwd(),
  parent,
};

const settled: SubagentEvent = {
  _tag: "RunSettled",
  outcome: { _tag: "Completed", finalText: "done" },
};

// --- The Supervisor fold ----------------------------------------------------

test("the Supervisor folds cumulative metering separately from context occupancy", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      // A cached tool loop: occupancy barely moves while the bill climbs.
      { _tag: "UsageChanged", tokens: 150_900, meteredTokens: 150_900 },
      { _tag: "UsageChanged", tokens: 151_800, meteredTokens: 301_800 },
      { _tag: "UsageChanged", tokens: 152_700, meteredTokens: 452_700 },
      settled,
    ],
    async (manager, runtime) => {
      const started = await runTool(runtime, manager.spawn("claude", task));
      await runTool(runtime, manager.waitFor([started.id]));
      const snapshot = manager.view.get(started.id);
      assert.equal(snapshot?.usage.tokens, 152_700);
      assert.equal(snapshot?.usage.contextWindow, 200_000);
      // Occupancy stayed inside one window; the meter is more than two deep.
      assert.equal(snapshot?.metered.tokens, 452_700);
    },
  );
});

test("an occupancy-only usage event never clears a metered total", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 40_000, meteredTokens: 40_000 },
      // Claude's result message reports capacity with no occupancy, and Codex
      // reports occupancy with no total. Neither may erase the meter.
      { _tag: "UsageChanged", contextWindow: 200_000 },
      { _tag: "UsageChanged", tokens: 41_000 },
      settled,
    ],
    async (manager, runtime) => {
      const started = await runTool(runtime, manager.spawn("claude", task));
      await runTool(runtime, manager.waitFor([started.id]));
      assert.equal(manager.view.get(started.id)?.metered.tokens, 40_000);
      assert.equal(manager.view.get(started.id)?.usage.tokens, 41_000);
    },
  );
});

test("an authoritative aggregate may correct the meter downward", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", meteredTokens: 2_400 },
      // The run's own aggregate arrives last and wins, even when lower: the
      // fold is last-writer-wins, not a running maximum.
      { _tag: "UsageChanged", meteredTokens: 1_600 },
      settled,
    ],
    async (manager, runtime) => {
      const started = await runTool(runtime, manager.spawn("claude", task));
      await runTool(runtime, manager.waitFor([started.id]));
      assert.equal(manager.view.get(started.id)?.metered.tokens, 1_600);
    },
  );
});

test("a backend that proves no metering leaves the total unset", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 61_000, contextWindow: 272_000 },
      settled,
    ],
    async (manager, runtime) => {
      const started = await runTool(runtime, manager.spawn("claude", task));
      await runTool(runtime, manager.waitFor([started.id]));
      const snapshot = manager.view.get(started.id);
      assert.equal(snapshot?.usage.tokens, 61_000);
      assert.equal(snapshot?.metered.tokens, undefined);
    },
  );
});

// --- The production Goal Worker manager -------------------------------------

function productionManager(
  manager: SubagentManagerShape,
  runtime: ManagedRuntime.ManagedRuntime<SubagentManager, never>,
): GoalWorkerSubagentManager {
  return withSupervisorMetering(
    {
      spawn: (backend, next) => runTool(runtime, manager.spawn(backend, next)),
      waitFor: (ids) => runTool(runtime, manager.waitFor(ids)),
      get: (id) => runTool(runtime, manager.get(id)),
      cancel: (ids) => runTool(runtime, manager.cancel(ids)),
    },
    (id) => manager.view.get(id),
  );
}

test("the production Goal Worker manager meters a live child from the Supervisor", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 150_900, meteredTokens: 150_900 },
      { _tag: "UsageChanged", tokens: 151_800, meteredTokens: 301_800 },
      settled,
    ],
    async (manager, runtime) => {
      const goalWorker = productionManager(manager, runtime);
      const started = await goalWorker.spawn("claude", task);
      // Nothing has been metered yet, and occupancy must not stand in for it.
      assert.equal(
        await goalWorker.authoritativeTokens?.("sa-missing"),
        undefined,
      );
      await goalWorker.waitFor([started.id]);
      assert.equal(await goalWorker.authoritativeTokens?.(started.id), 301_800);
    },
  );
});

// --- The cap the Goal Worker enforces from it -------------------------------

const profile = {
  description: "Metered goal worker fixture",
  identity: {
    name: "goal-metered",
    contentDigest: "e".repeat(64),
    catalogGeneration: 3,
    source: { scope: "managed", path: "<goal-metered>" },
  },
  defaults: { backend: "claude" },
  policy: {
    role: "goal-worker",
    instructions: [],
    skills: [],
    tools: { allowed: ["read"], denied: ["write", "edit", "bash"] },
    limits: { maxTurns: 2, timeoutMs: 10_000 },
    workspace: "current",
  },
} as const satisfies ResolvedAgentProfile;

const goalRequest = {
  attemptKey: "f".repeat(64),
  prompt: "Do the bounded work.",
  cwd: process.cwd(),
  projectId: "git:metered",
  profile: profile.identity,
  timeoutMs: 10_000,
  maxOutputBytes: 4_096,
} as const;

function goalWorkerOver(manager: GoalWorkerSubagentManager) {
  const lifecycle = new AbortController();
  return createGoalWorkerExecutor({
    profiles: () => ({
      generation: () => profile.identity.catalogGeneration,
      resolve: () => profile,
    }),
    manager: async () => manager,
    parent: () => parent,
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
    usagePollMs: 1,
  });
}

test("a Goal Attempt under its cap settles with the Supervisor's metered total", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 40_000, meteredTokens: 40_000 },
      {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: "finished" }],
      },
      {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "finished" },
      },
    ],
    async (manager, runtime) => {
      const worker = goalWorkerOver(productionManager(manager, runtime));
      const outcome = await worker.run({ ...goalRequest, maxTokens: 100_000 });
      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        assert.deepEqual(outcome.value.usage, {
          tokens: 40_000,
          authoritative: true,
          source: "agent-supervisor",
        });
      }
    },
  );
});

test("a Goal Attempt that breaches its cap is stopped rather than completed", async () => {
  await withScriptedManager(
    [
      { _tag: "RunStarted" },
      { _tag: "UsageChanged", tokens: 40_000, meteredTokens: 40_000 },
      // Past the cap. The child is never scripted to settle, so only the
      // polled meter can end this Attempt.
      { _tag: "UsageChanged", tokens: 41_000, meteredTokens: 120_000 },
    ],
    async (manager, runtime) => {
      const worker = goalWorkerOver(productionManager(manager, runtime));
      const outcome = await worker.run({ ...goalRequest, maxTokens: 100_000 });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.error.code, "token_bounded");
        assert.equal(outcome.error.certainty, "started");
        assert.equal(outcome.error.retryable, false);
        // Overshoot is expected and reported honestly: the meter only moved
        // once the request that breached the cap had already been billed.
        assert.deepEqual(outcome.error.usage, {
          tokens: 120_000,
          authoritative: true,
          source: "agent-supervisor",
        });
      }
    },
  );
});

test("a cap is refused before dispatch when the Supervisor cannot meter", async () => {
  await withScriptedManager([settled], async (manager, runtime) => {
    // The bare manager, without the metering declaration.
    const worker = goalWorkerOver({
      spawn: (backend, next) => runTool(runtime, manager.spawn(backend, next)),
      waitFor: (ids) => runTool(runtime, manager.waitFor(ids)),
      get: (id) => runTool(runtime, manager.get(id)),
      cancel: (ids) => runTool(runtime, manager.cancel(ids)),
    });
    const outcome = await worker.run({ ...goalRequest, maxTokens: 100_000 });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, "metering_unavailable");
      assert.equal(outcome.error.certainty, "not-started");
    }
    assert.equal(manager.view.size(), 0);
  });
});
