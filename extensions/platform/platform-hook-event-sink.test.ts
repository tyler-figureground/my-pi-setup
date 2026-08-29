import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPlatformHookEventSink,
  platformHookEventProducerFor,
  type PlatformHookEventEnvelope,
} from "./src/automation/platform-hook-event-sink.ts";

test("platform hook event sinks are loader-local, exclusive, and fenced by unbind", () => {
  const firstLoader = {};
  const secondLoader = {};
  const first: PlatformHookEventEnvelope[] = [];
  const second: PlatformHookEventEnvelope[] = [];
  const firstSink = {
    publish: (event: PlatformHookEventEnvelope) => first.push(event),
  };
  const unbind = bindPlatformHookEventSink(firstLoader, firstSink);
  bindPlatformHookEventSink(secondLoader, {
    publish: (event) => second.push(event),
  });

  assert.throws(
    () => bindPlatformHookEventSink(firstLoader, firstSink),
    /already bound/i,
  );
  platformHookEventProducerFor(firstLoader, "workspaces").publish(
    "worktree.created",
    { workspaceId: "one" },
  );
  platformHookEventProducerFor(secondLoader, "workflows").publish(
    "task.started",
    { runId: "two" },
  );
  assert.deepEqual(
    first.map(({ event }) => event),
    ["worktree.created"],
  );
  assert.deepEqual(
    second.map(({ event }) => event),
    ["task.started"],
  );

  const producer = platformHookEventProducerFor(firstLoader, "workspaces");
  unbind();
  producer.publish("worktree.released", { workspaceId: "one" });
  assert.equal(first.length, 1);
});

test("producer accepts only exact platform events and bounds plain payload without payload authority", () => {
  const loader = {};
  const published: PlatformHookEventEnvelope[] = [];
  bindPlatformHookEventSink(loader, {
    publish: (event) => published.push(event),
  });
  const producer = platformHookEventProducerFor(loader, "subagents");
  let getterRuns = 0;
  const hostile: Record<string, unknown> = {
    id: "sa-1",
    title: "child-selected-title",
    event: "task.failed",
    source: "child",
    authority: "system",
    trusted: true,
    token: "secret-value",
    huge: "x".repeat(100_000),
    nested: Array.from({ length: 200 }, (_, index) => ({ index })),
  };
  Object.defineProperty(hostile, "getter", {
    enumerable: true,
    get() {
      getterRuns++;
      return "must-not-run";
    },
  });
  hostile.cycle = hostile;

  producer.publish("subagent.completed", hostile);
  producer.publish("goal.completed" as never, { id: "forged" });

  assert.equal(getterRuns, 0);
  assert.equal(published.length, 1);
  const [envelope] = published;
  assert.ok(envelope);
  assert.equal(envelope.event, "subagent.completed");
  assert.equal(envelope.source, "subagents");
  assert.equal(Object.hasOwn(envelope, "authority"), false);
  assert.equal(Object.hasOwn(envelope.payload, "event"), false);
  assert.equal(Object.hasOwn(envelope.payload, "source"), false);
  assert.equal(Object.hasOwn(envelope.payload, "authority"), false);
  assert.equal(Object.hasOwn(envelope.payload, "trusted"), false);
  assert.equal(envelope.payload.token, "[REDACTED]");
  assert.equal(envelope.payload.getter, "[ACCESSOR]");
  assert.equal(envelope.payload.cycle, "[CYCLE]");
  assert.ok(Buffer.byteLength(JSON.stringify(envelope.payload)) <= 32 * 1024);
  assert.ok(Object.isFrozen(envelope));
  assert.ok(Object.isFrozen(envelope.payload));
});
