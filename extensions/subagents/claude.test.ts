import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { SubagentManager } from "./src/manager.ts";
import { claudeBackend } from "./src/backends/claude.ts";
import type { ParentContext, SpawnTask, SubagentEvent } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";
import {
  assertLiveMetered,
  claudeAssistantBilling,
  createObservedSubagentRuntime,
  latestMeteredUsage,
  latestOccupancyUsage,
  waitForRunning,
} from "./live-test-helpers.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Claude test",
    cwd: process.cwd(),
    model: "haiku",
    reasoningEffort: "off",
    parent,
  };
}

async function claudeAvailable() {
  return Effect.runPromise(claudeBackend.available);
}

/** Rejecting deadline so a hung wait still reaches finally() and disposes. */
function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Claude test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test(
  "Claude backend reports cumulative aggregate metering across two live turns",
  { timeout: 150_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const events: SubagentEvent[] = [];
    const runtime = createObservedSubagentRuntime(claudeBackend, events);
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn(
          "claude",
          task(
            "Use the Read tool to read package.json, then reply with exactly: hello claude",
          ),
        ),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 60_000);

      const done = manager.view.get(started.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello claude/i);
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath?.endsWith(".jsonl"));
      assert.ok(
        done?.transcript.some(
          (item) => item.kind === "toolResult" && item.name === "Read",
        ),
      );
      const firstMetered = assertLiveMetered(done);
      const firstSessionFilePath = done?.meta.sessionFilePath;
      assert.ok(firstSessionFilePath);
      const firstAssistantBilling =
        await claudeAssistantBilling(firstSessionFilePath);
      assert.ok(firstAssistantBilling > 0);
      assert.ok(firstMetered >= firstAssistantBilling);
      assert.equal(latestMeteredUsage(events)?.meteredTokens, firstMetered);
      assert.equal(latestOccupancyUsage(events)?.tokens, done?.usage.tokens);

      const running = waitForRunning(
        manager.view,
        started.id,
        10_000,
        "Live Claude second turn start",
      );
      await runTool(
        runtime,
        manager.send(started.id, "Reply with exactly: hello claude again"),
      );
      await running;
      await deadline(runTool(runtime, manager.waitFor([started.id])), 60_000);

      const second = manager.view.get(started.id);
      assert.equal(second?.status, "done");
      assert.match(second?.finalText ?? "", /hello claude again/i);
      assert.ok((second?.turns ?? 0) >= 2);
      const secondMetered = assertLiveMetered(second);
      assert.ok(secondMetered > firstMetered);
      assert.ok(second.meta.sessionFilePath);
      const secondAssistantBilling = await claudeAssistantBilling(
        second.meta.sessionFilePath,
      );
      assert.ok(secondAssistantBilling > firstAssistantBilling);
      assert.ok(secondMetered >= secondAssistantBilling);
      assert.equal(latestMeteredUsage(events)?.meteredTokens, secondMetered);
      assert.equal(latestOccupancyUsage(events)?.tokens, second.usage.tokens);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude backend interrupt settles a live run as aborted",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn(
          "claude",
          task(
            "Write a detailed 10,000-word essay about the history of computing.",
          ),
        ),
      );

      // Wait for streamed output so cancellation definitely lands mid-run and
      // exercises the SDK's normal interrupt receipt/result path.
      const streamDeadline = Date.now() + 15_000;
      while (
        manager.view.get(started.id)?.status === "running" &&
        !manager.view.get(started.id)?.liveAssistant?.text &&
        Date.now() < streamDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(manager.view.get(started.id)?.status, "running");
      assert.ok(manager.view.get(started.id)?.liveAssistant?.text);

      const report = await deadline(
        runTool(runtime, manager.cancel([started.id])),
        20_000,
      );

      assert.equal(report[0]?.cancelled, true);
      assert.equal(manager.view.get(started.id)?.status, "error");
      assert.equal(manager.view.get(started.id)?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);
