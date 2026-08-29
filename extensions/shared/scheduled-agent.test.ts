import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
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

function eventBusWrapper(shared: EventBus): EventBus {
  return {
    emit: (channel, data) => shared.emit(channel, data),
    on: (channel, handler) => shared.on(channel, handler),
  };
}

test("scheduled executor crosses distinct event wrappers with structural private invocations", async () => {
  const shared = createEventBus();
  const providerEvents = eventBusWrapper(shared);
  const consumerEvents = eventBusWrapper(shared);
  const emitted: unknown[] = [];
  const observingConsumerEvents: EventBus = {
    emit(channel, data) {
      emitted.push(data);
      shared.emit(channel, data);
    },
    on: (channel, handler) => shared.on(channel, handler),
  };
  const prompts: string[] = [];
  const executor: ScheduledAgentExecutor = {
    async run(request) {
      prompts.push(request.prompt);
      assert.ok(Object.isFrozen(request));
      assert.equal(Object.hasOwn(request, "model"), false);
      assert.equal(Object.hasOwn(request, "authority"), false);
      return {
        ok: true,
        value: { status: "completed", output: "done", outputBytes: 4 },
      };
    },
  };

  assert.equal(scheduledAgentExecutorFor(consumerEvents), undefined);
  const unbind = bindScheduledAgentExecutor(providerEvents, executor);
  const client = scheduledAgentExecutorFor(observingConsumerEvents);
  assert.ok(client);
  assert.notEqual(client, executor);
  const request = {
    occurrenceId: "occurrence-cross-wrapper",
    prompt: "Inspect CI",
    cwd: "C:/fixture",
    projectId: "git:fixture",
    profile,
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  };
  const result = await client.run(request);
  assert.equal(result.ok, true);
  assert.deepEqual(prompts, ["Inspect CI"]);
  assert.deepEqual(
    emitted.map((value) => (value as { kind: string }).kind),
    ["query", "run"],
  );
  assert.ok(
    emitted.every(
      (value) =>
        (value as { version: number }).version === 1 &&
        (value as { claimed: boolean }).claimed,
    ),
  );
  assert.throws(
    () => bindScheduledAgentExecutor(consumerEvents, executor),
    /already bound/i,
  );

  unbind();
  assert.equal(scheduledAgentExecutorFor(consumerEvents), undefined);
  await assert.rejects(() => client.run(request), /unavailable/i);
});

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
