/**
 * Whole-attempt token metering, one layer at a time.
 *
 * Every backend reports two different quantities that happen to be measured in
 * tokens: how full the context window is right now, and how many tokens the
 * session has burned in total. These tests pin the arithmetic of the second
 * one and, at every step, that it was not quietly read off the first.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  billedTokens,
  contextOccupancyTokens,
  createClaudeTokenMeter,
} from "./src/backends/claude.ts";
import { parseThreadTokenUsage } from "./src/backends/codex.ts";
import { sessionMeteredTokens } from "./src/backends/pi.ts";
import { withSupervisorMetering } from "./src/goal-worker.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";

// --- Claude: accumulate every request, then trust the run aggregate ----------

test("Claude billing counts every input class plus output", () => {
  assert.equal(
    billedTokens({
      input_tokens: 12,
      cache_read_input_tokens: 45_000,
      cache_creation_input_tokens: 3_000,
      output_tokens: 700,
    }),
    48_712,
  );
});

test("Claude billing treats unusable counts as zero rather than poisoning a total", () => {
  assert.equal(billedTokens(undefined), 0);
  assert.equal(billedTokens(null), 0);
  assert.equal(
    billedTokens({
      input_tokens: null,
      cache_read_input_tokens: Number.NaN,
      cache_creation_input_tokens: -5,
      output_tokens: 250,
    }),
    250,
  );
});

test("Claude metering accumulates every request, sidechains included", () => {
  const meter = createClaudeTokenMeter();
  // A top-level request, then a subagent (sidechain) request that never enters
  // this conversation's context window but is billed to the same run.
  assert.equal(
    meter.request({ input_tokens: 1_000, output_tokens: 200 }),
    1_200,
  );
  assert.equal(meter.request({ input_tokens: 400, output_tokens: 100 }), 1_700);
  assert.equal(meter.request({ input_tokens: 300, output_tokens: 50 }), 2_050);
});

test("Claude metering ignores a request that billed nothing", () => {
  const meter = createClaudeTokenMeter();
  assert.equal(meter.request({ input_tokens: 500, output_tokens: 100 }), 600);
  assert.equal(meter.request({ input_tokens: null }), undefined);
  assert.equal(meter.request(undefined), undefined);
  assert.equal(meter.settle({ input_tokens: 600 }), 600);
});

test("Claude metering overwrites the run's accumulation with the SDK aggregate", () => {
  const meter = createClaudeTokenMeter();
  meter.request({ input_tokens: 1_000, output_tokens: 200 });
  meter.request({ input_tokens: 1_000, output_tokens: 200 });
  // The SDK's own whole-run total is authoritative even when it is lower than
  // what the message stream implied, so the correction must go downward too.
  assert.equal(
    meter.settle({ input_tokens: 1_500, output_tokens: 100 }),
    1_600,
  );
});

test("Claude metering keeps its accumulation when the aggregate is unusable", () => {
  const meter = createClaudeTokenMeter();
  meter.request({ input_tokens: 900, output_tokens: 100 });
  assert.equal(meter.settle(undefined), 1_000);
});

test("Claude metering stays cumulative across the session's runs", () => {
  const meter = createClaudeTokenMeter();
  meter.request({ input_tokens: 1_000, output_tokens: 200 });
  assert.equal(
    meter.settle({ input_tokens: 1_000, output_tokens: 200 }),
    1_200,
  );
  // A steered second turn continues the same counter; the first run's total is
  // never revisited.
  assert.equal(meter.request({ input_tokens: 800, output_tokens: 100 }), 2_100);
  assert.equal(meter.settle({ input_tokens: 800, output_tokens: 100 }), 2_100);
});

test("Claude metering and occupancy diverge over a cached tool loop", () => {
  const perRequest = {
    input_tokens: 500,
    cache_read_input_tokens: 150_000,
    cache_creation_input_tokens: 0,
    output_tokens: 400,
  };
  const meter = createClaudeTokenMeter();
  for (let request = 0; request < 10; request++) meter.request(perRequest);
  const metered = meter.settle({
    input_tokens: 5_000,
    cache_read_input_tokens: 1_500_000,
    cache_creation_input_tokens: 0,
    output_tokens: 4_000,
  });
  // The window never filled; the bill is still more than seven windows deep.
  const occupancy = contextOccupancyTokens(perRequest);
  assert.ok(occupancy !== undefined && occupancy < 200_000);
  assert.equal(metered, 1_509_000);
  assert.ok(metered > occupancy * 7);
});

// --- Codex: two fields, parsed independently --------------------------------

const codexParams = (tokenUsage: unknown) => ({
  threadId: "t",
  turnId: "u",
  tokenUsage,
});

test("Codex parses cumulative total for metering and last request for occupancy", () => {
  const parsed = parseThreadTokenUsage(
    codexParams({
      total: { totalTokens: 1_450_000, inputTokens: 1_400_000 },
      last: { totalTokens: 61_000, inputTokens: 60_000 },
      modelContextWindow: 272_000,
    }),
  );
  assert.deepEqual(parsed, {
    tokens: 61_000,
    contextWindow: 272_000,
    meteredTokens: 1_450_000,
  });
});

test("Codex metering and occupancy are each unknown on their own", () => {
  assert.deepEqual(
    parseThreadTokenUsage(
      codexParams({
        last: { totalTokens: 61_000 },
        modelContextWindow: 272_000,
      }),
    ),
    { tokens: 61_000, contextWindow: 272_000, meteredTokens: undefined },
  );
  assert.deepEqual(
    parseThreadTokenUsage(codexParams({ total: { totalTokens: 900 } })),
    { tokens: undefined, contextWindow: undefined, meteredTokens: 900 },
  );
  assert.deepEqual(parseThreadTokenUsage({ threadId: "t" }), {
    tokens: undefined,
    contextWindow: undefined,
    meteredTokens: undefined,
  });
});

// --- pi: session stats, not context usage -----------------------------------

test("pi metering reads the session's billed total", () => {
  assert.equal(
    sessionMeteredTokens({
      tokens: { input: 90_000, output: 4_000, total: 94_000 },
    }),
    94_000,
  );
  assert.equal(sessionMeteredTokens({ tokens: { total: 0 } }), 0);
});

test("pi metering refuses anything that is not a countable total", () => {
  assert.equal(sessionMeteredTokens(undefined), undefined);
  assert.equal(sessionMeteredTokens({}), undefined);
  assert.equal(sessionMeteredTokens({ tokens: {} }), undefined);
  assert.equal(sessionMeteredTokens({ tokens: { total: -1 } }), undefined);
  assert.equal(sessionMeteredTokens({ tokens: { total: 1.5 } }), undefined);
  assert.equal(sessionMeteredTokens({ tokens: { total: "94000" } }), undefined);
});

// --- The Goal Worker seam ---------------------------------------------------

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "claude",
    title: "fixture",
    prompt: "work",
    cwd: "C:\\repo",
    status: "done",
    createdAt: 1,
    settledAt: 2,
    meta: { backend: "claude" },
    usage: {},
    metered: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "done",
    turns: 1,
    ...overrides,
  };
}

const baseManager = {
  async spawn(_backend: unknown, task: SpawnTask) {
    return snapshot({ title: task.title });
  },
  async waitFor() {},
  async get() {
    return snapshot();
  },
  async cancel() {},
};

test("Supervisor metering reports the folded cumulative total", async () => {
  const manager = withSupervisorMetering(baseManager, () =>
    snapshot({ metered: { tokens: 48_712 } }),
  );
  assert.equal(await manager.authoritativeTokens?.("sa-1"), 48_712);
});

test("Supervisor metering never substitutes context occupancy for spend", async () => {
  const manager = withSupervisorMetering(baseManager, () =>
    snapshot({
      usage: { tokens: 150_000, contextWindow: 200_000 },
      metered: {},
    }),
  );
  // Occupancy is present and large. Metering is still unproven, and unproven
  // must read as unknown rather than as zero or as the occupancy figure.
  assert.equal(await manager.authoritativeTokens?.("sa-1"), undefined);
});

test("Supervisor metering rejects an uncountable total and an unknown child", async () => {
  const bad = withSupervisorMetering(baseManager, (id) =>
    id === "sa-1" ? snapshot({ metered: { tokens: -3 } }) : undefined,
  );
  assert.equal(await bad.authoritativeTokens?.("sa-1"), undefined);
  assert.equal(await bad.authoritativeTokens?.("sa-missing"), undefined);
});

test("Supervisor metering leaves every other manager method alone", async () => {
  const calls: string[] = [];
  const manager = withSupervisorMetering(
    {
      async spawn(_backend, task) {
        calls.push(`spawn:${task.title}`);
        return snapshot({ title: task.title });
      },
      async waitFor(ids) {
        calls.push(`waitFor:${ids.join(",")}`);
      },
      async get(id) {
        calls.push(`get:${id}`);
        return snapshot();
      },
      async cancel(ids) {
        calls.push(`cancel:${ids.join(",")}`);
      },
    },
    () => snapshot({ metered: { tokens: 5 } }),
  );
  const started = await manager.spawn("claude", {
    prompt: "work",
    title: "fixture",
    cwd: "C:\\repo",
    parent: { parentCwd: "C:\\repo", projectTrusted: false },
  });
  await manager.waitFor([started.id]);
  await manager.get(started.id);
  await manager.cancel([started.id]);
  await manager.authoritativeTokens?.(started.id);
  // Reading the meter is not a manager call: polling a cap must not disturb
  // the dispatch bookkeeping that `get` settles.
  assert.deepEqual(calls, [
    "spawn:fixture",
    "waitFor:sa-1",
    "get:sa-1",
    "cancel:sa-1",
  ]);
});
