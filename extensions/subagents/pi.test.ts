import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./src/manager.ts";
import { piBackend } from "./src/backends/pi.ts";
import type { SpawnTask, SubagentEvent } from "./src/domain.ts";
import { runTool } from "./src/runtime.ts";
import {
  assertLiveMetered,
  createObservedSubagentRuntime,
  deadline,
  latestMeteredUsage,
  waitForRunning,
} from "./live-test-helpers.ts";

test(
  "Pi backend reports cumulative getSessionStats metering across two live turns",
  { timeout: 135_000 },
  async (t) => {
    const modelRuntime = await ModelRuntime.create();
    const available = await modelRuntime.getAvailable();
    const model =
      available.find(
        (candidate) =>
          candidate.provider === "openai-codex" &&
          candidate.id === "gpt-5.4-mini",
      ) ?? available.find((candidate) => candidate.provider !== "anthropic");
    if (!model) {
      t.skip("No authenticated Pi model is available");
      return;
    }
    const registry = new ModelRegistry(modelRuntime);
    const task: SpawnTask = {
      prompt:
        "Use the read tool to read package.json, then reply with exactly: hello pi profile",
      title: "live Pi profile test",
      cwd: process.cwd(),
      model: `${model.provider}/${model.id}`,
      reasoningEffort: "off",
      profile: {
        name: "live-pi",
        contentDigest: "a".repeat(64),
        catalogGeneration: 1,
        source: { scope: "managed", path: "<live-pi>" },
      },
      execution: {
        role: "review",
        instructions: ["Return only the requested exact phrase."],
        skills: [],
        tools: { allowed: ["read"], denied: [] },
        limits: { maxTurns: 5, timeoutMs: 120_000 },
        workspace: "current",
      },
      parent: {
        parentCwd: process.cwd(),
        projectTrusted: false,
        modelRegistry: registry,
        inheritedModel: { provider: model.provider, id: model.id },
        inheritedThinkingLevel: "off",
      },
    };
    const events: SubagentEvent[] = [];
    const runtime = createObservedSubagentRuntime(piBackend, events);
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(runtime, manager.spawn("pi", task));
      await deadline(
        runTool(runtime, manager.waitFor([started.id])),
        60_000,
        "Live Pi first turn",
      );
      const first = manager.view.get(started.id);
      assert.equal(first?.status, "done");
      assert.match(first?.finalText ?? "", /hello pi profile/i);
      assert.equal(first?.profile?.name, "live-pi");
      assert.equal(first?.meta.profile?.contentDigest, "a".repeat(64));
      assert.ok(
        first?.transcript.some(
          (item) => item.kind === "toolResult" && item.name === "read",
        ),
      );
      const firstMetered = assertLiveMetered(first);
      const firstStatsUsage = latestMeteredUsage(events);
      assert.equal(firstStatsUsage?.meteredTokens, firstMetered);
      assert.equal(firstStatsUsage?.tokens, first?.usage.tokens);

      const running = waitForRunning(
        manager.view,
        started.id,
        10_000,
        "Live Pi second turn start",
      );
      await runTool(
        runtime,
        manager.send(started.id, "Reply with exactly: hello pi again"),
      );
      await running;
      await deadline(
        runTool(runtime, manager.waitFor([started.id])),
        60_000,
        "Live Pi second turn",
      );

      const second = manager.view.get(started.id);
      assert.equal(second?.status, "done");
      assert.match(second?.finalText ?? "", /hello pi again/i);
      assert.ok((second?.turns ?? 0) >= 3);
      const secondMetered = assertLiveMetered(second);
      assert.ok(secondMetered > firstMetered);
      const secondStatsUsage = latestMeteredUsage(events);
      assert.equal(secondStatsUsage?.meteredTokens, secondMetered);
      assert.equal(secondStatsUsage?.tokens, second?.usage.tokens);
    } finally {
      await runtime.dispose();
    }
  },
);
