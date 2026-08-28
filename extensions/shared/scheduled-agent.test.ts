import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedAgentProfile } from "./agent-profile.ts";
import {
  bindScheduledAgentExecutor,
  scheduledAgentExecutorFor,
  type ScheduledAgentExecutor,
} from "./scheduled-agent.ts";

const profile = {
  description: "fixture",
  identity: {
    name: "scheduled-fixture",
    contentDigest: "a".repeat(64),
    catalogGeneration: 7,
    source: { scope: "managed", path: "<fixture>" },
  },
  defaults: { backend: "pi" },
  policy: {
    role: "scheduled",
    instructions: [],
    skills: [],
    tools: { allowed: ["read"], denied: ["write", "edit", "bash"] },
    limits: { maxTurns: 2, timeoutMs: 10_000 },
    workspace: "current",
  },
} as const satisfies ResolvedAgentProfile;

test("scheduled executor binding is host-local, exclusive, and releasable", async () => {
  const eventBus = {};
  const seen: string[] = [];
  let captured: Record<string, unknown> | undefined;
  const executor: ScheduledAgentExecutor = {
    async run(request) {
      captured = request as unknown as Record<string, unknown>;
      seen.push(`${request.occurrenceId}:${request.profile.identity.name}`);
      return {
        ok: true,
        value: {
          status: "completed",
          output: "done",
          outputBytes: 4,
          sessionId: "child-session",
        },
      };
    },
  };

  const release = bindScheduledAgentExecutor(eventBus, executor);
  assert.equal(scheduledAgentExecutorFor(eventBus), executor);
  assert.throws(
    () => bindScheduledAgentExecutor(eventBus, executor),
    /already bound/i,
  );

  const result = await scheduledAgentExecutorFor(eventBus)!.run({
    occurrenceId: "occurrence-1",
    prompt: "Inspect CI",
    cwd: "C:/fixture",
    projectId: "git:fixture",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["occurrence-1:scheduled-fixture"]);
  assert.equal(Object.hasOwn(captured!, "role"), false);
  assert.equal(Object.hasOwn(captured!, "tools"), false);
  assert.equal(profile.policy.role, "scheduled");

  release();
  assert.equal(scheduledAgentExecutorFor(eventBus), undefined);
});
