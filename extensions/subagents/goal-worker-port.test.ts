import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import {
  bindGoalWorkerExecutor,
  goalWorkerExecutorFor,
  type GoalWorkerExecutor,
  type GoalWorkerRequest,
} from "../shared/goal-worker.ts";

const request = {
  attemptKey: "a".repeat(64),
  prompt: "Implement the bounded goal node.",
  cwd: "C:/fixture",
  projectId: "git:fixture",
  profile: {
    name: "goal-fixture",
    contentDigest: "b".repeat(64),
    catalogGeneration: 4,
    source: { scope: "managed", path: "<goal-fixture>" },
  },
  timeoutMs: 10_000,
  maxOutputBytes: 4_096,
} as const satisfies GoalWorkerRequest;

function wrapper(shared: EventBus): EventBus {
  return {
    emit: (channel, data) => shared.emit(channel, data),
    on: (channel, handler) => shared.on(channel, handler),
  };
}

test("goal worker port is loader-local, exclusive, and crosses event wrappers", async () => {
  const shared = createEventBus();
  const provider = wrapper(shared);
  const consumer = wrapper(shared);
  const seen: GoalWorkerRequest[] = [];
  const executor: GoalWorkerExecutor = {
    async run(received) {
      seen.push(received);
      assert.ok(Object.isFrozen(received));
      return {
        ok: false,
        error: {
          code: "execution_unknown",
          message: "No durable Supervisor handle is available.",
          retryable: false,
          certainty: "unknown",
        },
      };
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "unknown", certainty: "unknown" };
    },
  };

  assert.equal(goalWorkerExecutorFor(consumer), undefined);
  const unbind = bindGoalWorkerExecutor(provider, executor);
  const client = goalWorkerExecutorFor(consumer);
  assert.ok(client);
  assert.notEqual(client, executor);
  assert.deepEqual(await client.run(request), {
    ok: false,
    error: {
      code: "execution_unknown",
      message: "No durable Supervisor handle is available.",
      retryable: false,
      certainty: "unknown",
    },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(await client.inspect(request.attemptKey), {
    attemptKey: request.attemptKey,
    state: "unknown",
    certainty: "unknown",
  });
  assert.throws(
    () => bindGoalWorkerExecutor(consumer, executor),
    /already bound/i,
  );

  unbind();
  assert.equal(goalWorkerExecutorFor(consumer), undefined);
  await assert.rejects(() => client.run(request), /unavailable/i);
});
