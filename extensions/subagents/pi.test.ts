import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./src/manager.ts";
import type { SpawnTask } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Live Pi profile test exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test(
  "Pi backend completes a live profiled manager run",
  { timeout: 90_000 },
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
      prompt: "Reply with exactly: hello pi profile",
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
        limits: { maxTurns: 2, timeoutMs: 60_000 },
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
    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(runtime, manager.spawn("pi", task));
      await deadline(runTool(runtime, manager.waitFor([started.id])), 60_000);
      const done = manager.view.get(started.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello pi profile/i);
      assert.equal(done?.profile?.name, "live-pi");
      assert.equal(done?.meta.profile?.contentDigest, "a".repeat(64));
    } finally {
      await runtime.dispose();
    }
  },
);
