import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createMemoryTriggerPersistence,
  createTriggerEngine,
  type TriggerDelivery,
} from "./src/automation/triggers/index.ts";
import { triggerPayloadDigest } from "./src/automation/triggers/persistence.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function bindFixture(runtime: ReturnType<typeof createTriggerEngine>) {
  const bound = runtime.bindSource({
    kind: "fixture",
    id: "source",
    projectId: "project-a",
    sessionId: "session-a",
    trust: "untrusted",
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("Fixture source binding failed.");
  return bound.value;
}

class FakeClock {
  #now = 0;
  #nextId = 0;
  #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  now = () => this.#now;

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return id;
  };

  clearTimeout = (id: unknown) => {
    if (typeof id === "number") this.#timers.delete(id);
  };

  async advance(ms: number) {
    const target = this.#now + ms;
    while (true) {
      const next = [...this.#timers]
        .filter(([, timer]) => timer.at <= target)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.at - right.at || leftId - rightId,
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#now = timer.at;
      timer.callback();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

test("returns bounded plain consumer output through the publish seam", async () => {
  const runtime = createTriggerEngine({ hostId: "host-output" });
  const source = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "hooks",
    generation: 1,
    bindings: [
      {
        id: "gate",
        eventTypes: ["pi.tool_call"],
        deliver: async () => ({
          context: ["trusted context"],
          block: { reason: "fixture" },
        }),
      },
    ],
  });

  const published = await source.publish({
    type: "pi.tool_call",
    payload: { toolName: "read" },
  });
  assert.equal(published.ok, true);
  if (published.ok) {
    assert.deepEqual(published.value.deliveries[0]?.output, {
      context: ["trusted context"],
      block: { reason: "fixture" },
    });
  }

  let getterCalls = 0;
  await runtime.engine.reconcile({
    ownerId: "hooks",
    generation: 2,
    bindings: [
      {
        id: "invalid-output",
        eventTypes: ["pi.tool_call"],
        deliver: async () =>
          Object.defineProperty({}, "value", {
            enumerable: true,
            get() {
              getterCalls++;
              return "never";
            },
          }),
      },
    ],
  });
  const invalid = await source.publish({
    type: "pi.tool_call",
    payload: {},
  });
  assert.equal(invalid.ok, true);
  if (invalid.ok) {
    assert.equal(invalid.value.deliveries[0]?.status, "failed");
    assert.equal(invalid.value.deliveries[0]?.output, undefined);
  }
  assert.equal(getterCalls, 0);
  await runtime.close();
});

test("admits events only through opaque host-bound source publishers", async () => {
  const delivered: TriggerDelivery[] = [];
  const runtime = createTriggerEngine({
    hostId: "host-a",
    clock: { now: () => 1_234 },
    createEventId: () => "event-1",
  });
  const bound = runtime.bindSource({
    kind: "terminal",
    id: "terminal-7",
    projectId: "project-a",
    sessionId: "session-a",
    trust: "trusted-project",
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;

  await runtime.engine.reconcile({
    ownerId: "monitor:build",
    generation: 1,
    bindings: [
      {
        id: "notify",
        eventTypes: ["process.line"],
        deliver: async (delivery) => void delivered.push(delivery),
      },
    ],
  });
  const published = await bound.value.publish({
    type: "process.line",
    payload: { line: "ready" },
  });
  assert.equal(published.ok, true);
  assert.deepEqual(delivered[0]?.events[0]?.provenance, {
    hostId: "host-a",
    projectId: "project-a",
    sessionId: "session-a",
    trust: "trusted-project",
    source: { kind: "terminal", id: "terminal-7", generation: 1 },
  });

  const forged = await runtime.engine.publish(
    Object.freeze({}) as Parameters<typeof runtime.engine.publish>[0],
    { type: "process.line", payload: {} },
  );
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error.code, "INVALID_ARGUMENT");

  await runtime.close();
});

test("source rebinding fences prior and cross-runtime publishers", async () => {
  const runtime = createTriggerEngine({ hostId: "host-a" });
  const first = bindFixture(runtime);
  const rebound = bindFixture(runtime);
  const stale = await first.publish({ type: "fixture.event", payload: {} });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "STALE_GENERATION");
  assert.equal(
    (await rebound.publish({ type: "fixture.event", payload: {} })).ok,
    true,
  );

  const other = createTriggerEngine({ hostId: "host-b" });
  const crossRuntime = await other.engine.publish(rebound, {
    type: "fixture.event",
    payload: {},
  });
  assert.equal(crossRuntime.ok, false);
  if (!crossRuntime.ok) {
    assert.equal(crossRuntime.error.code, "INVALID_ARGUMENT");
  }

  await Promise.all([runtime.close(), other.close()]);
});

test("source revocation bounds active authority maps under high-cardinality churn", async () => {
  const runtime = createTriggerEngine({ hostId: "host-a", maxSources: 2 });
  const bind = (id: string) =>
    runtime.bindSource({
      kind: "fixture",
      id,
      projectId: "project-a",
      trust: "untrusted",
    });
  const first = bind("source-1");
  const second = bind("source-2");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(bind("source-3").ok, false);
  if (!first.ok) return;

  assert.equal(runtime.revokeSource(first.value).ok, true);
  const stale = await first.value.publish({
    type: "fixture.event",
    payload: {},
  });
  assert.equal(stale.ok, false);
  assert.equal(bind("source-3").ok, true);

  for (let index = 0; index < 2_000; index += 1) {
    const churned = bind(`churn-${index}`);
    if (!churned.ok) {
      assert.equal(churned.error.code, "CAPACITY_EXCEEDED");
      const active = index % 2 === 0 ? second : bind("source-3");
      if (active.ok) runtime.revokeSource(active.value);
      continue;
    }
    assert.equal(runtime.revokeSource(churned.value).ok, true);
  }

  await runtime.close();
});

test("delivered event snapshots cannot mutate provenance for later bindings", async () => {
  const seen: string[] = [];
  const runtime = createTriggerEngine({ hostId: "host-a" });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "mutator",
        priority: 0,
        eventTypes: ["fixture.event"],
        deliver: async ({ binding, events }) => {
          assert.throws(() => {
            const source = events[0]?.provenance.source as { id: string };
            source.id = "forged";
          }, TypeError);
          assert.throws(() => {
            const identity = binding as { generation: number };
            identity.generation = 99;
          }, TypeError);
        },
      },
      {
        id: "observer",
        priority: 1,
        eventTypes: ["fixture.event"],
        deliver: async ({ events }) =>
          void seen.push(events[0]?.provenance.source.id ?? "missing"),
      },
    ],
  });
  const published = await publisher.publish({
    type: "fixture.event",
    payload: {},
  });
  assert.equal(published.ok, true);
  if (published.ok) {
    assert.deepEqual(
      published.value.deliveries.map(({ status }) => status),
      ["delivered", "delivered"],
    );
  }
  assert.deepEqual(seen, ["source"]);

  await runtime.close();
});

test("reconcile rejects accessors and proxies without executing caller code", async () => {
  const runtime = createTriggerEngine({ hostId: "host-a" });
  let getterCalls = 0;
  const accessorBindings: unknown[] = [];
  Object.defineProperty(accessorBindings, "0", {
    enumerable: true,
    get() {
      getterCalls++;
      return {
        id: "unsafe",
        eventTypes: ["fixture.event"],
        deliver: async () => undefined,
      };
    },
  });
  Object.defineProperty(accessorBindings, "length", { value: 1 });

  const accessor = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: accessorBindings,
  } as Parameters<typeof runtime.engine.reconcile>[0]);
  assert.equal(accessor.ok, false);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxy = new Proxy([], {
    ownKeys() {
      proxyTraps++;
      return ["length"];
    },
    getOwnPropertyDescriptor(target, key) {
      proxyTraps++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const proxied = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: proxy,
  });
  assert.equal(proxied.ok, false);
  assert.equal(proxyTraps, 0);

  await runtime.close();
});

test("restart persistence stores exact bounded secret-free payload and cause", async () => {
  const memory = createMemoryTriggerPersistence();
  const stored: Parameters<typeof memory.store>[0][] = [];
  const persistence = {
    ...memory,
    async store(request: Parameters<typeof memory.store>[0]) {
      stored.push(structuredClone(request));
      return memory.store(request);
    },
  };
  const runtime = createTriggerEngine({
    hostId: "host-a",
    persistence,
    maxPayloadBytes: 1_024,
    maxEnvelopeBytes: 2_048,
    createEventId: () => "durable-payload-1",
  });
  const bound = runtime.bindSource({
    kind: "terminal",
    id: "source-safe",
    projectId: "project-a",
    sessionId: "session-a",
    trust: "trusted-project",
    metadata: { authorization: "source-secret", label: "safe" },
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;

  const payload = { body: "x".repeat(128), nested: { result: "READY" } };
  const durable = await bound.value.publish({
    type: "fixture.event",
    payload,
    durability: "restart-only",
  });
  assert.equal(durable.ok, true);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.record.payload, payload);
  assert.deepEqual(stored[0]?.record.cause, {
    rootEventId: "durable-payload-1",
    ancestry: [],
  });
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes("source-secret"), false);
  assert.ok(Buffer.byteLength(serialized) <= 48 * 1_024);

  await runtime.close();
});

test("memory persistence rejects secret-bearing or extended durable records", async () => {
  const persistence = createMemoryTriggerPersistence();
  const secretPayload = { password: "raw-secret" };
  const stored = await persistence.store({
    record: {
      schemaVersion: 2,
      eventId: "event-1",
      type: "fixture.event",
      occurredAt: 1,
      sourceKey: "a".repeat(64),
      payload: secretPayload,
      payloadDigest: triggerPayloadDigest(secretPayload),
      cause: { rootEventId: "event-1", ancestry: [] },
    },
    claimantId: "runtime-1",
    now: 1,
    leaseUntil: 2,
  });
  assert.equal(stored.ok, false);
  const page = await persistence.claimPage({
    claimantId: "runtime-2",
    now: 3,
    leaseUntil: 4,
    limit: 64,
  });
  assert.equal(page.ok, true);
  if (page.ok) assert.deepEqual(page.value.claims, []);
});

test("restart-only ingress rejects secret-bearing and oversized durable bodies before persistence", async () => {
  const memory = createMemoryTriggerPersistence();
  let stores = 0;
  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxPayloadBytes: 64 * 1_024,
    persistence: {
      ...memory,
      async store(request) {
        stores += 1;
        return memory.store(request);
      },
    },
  });
  const publisher = bindFixture(runtime);
  const secret = await publisher.publish({
    type: "fixture.event",
    payload: { status: "READY", password: "never-persist" },
    durability: "restart-only",
  });
  const oversized = await publisher.publish({
    type: "fixture.event",
    payload: { body: "x".repeat(49 * 1_024) },
    durability: "restart-only",
  });

  assert.equal(secret.ok, false);
  if (!secret.ok) assert.equal(secret.error.code, "PERSISTENCE_FAILED");
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "PERSISTENCE_FAILED");
  assert.equal(stores, 0);

  await runtime.close();
});

test("durable replay verifies digest and restores exact causal ancestry", async () => {
  const persistence = createMemoryTriggerPersistence();
  const payload = { status: "READY", nested: { sequence: 7 } };
  const sourceKey = createHash("sha256")
    .update(
      JSON.stringify({
        kind: "fixture",
        id: "source",
        projectId: "project-a",
        sessionId: "session-a",
        trust: "untrusted",
      }),
    )
    .digest("hex");
  const stored = await persistence.store({
    record: {
      schemaVersion: 2,
      eventId: "causal-child-1",
      type: "fixture.event",
      occurredAt: 123,
      sourceKey,
      payload,
      payloadDigest: triggerPayloadDigest(payload),
      cause: {
        rootEventId: "causal-root-1",
        parentEventId: "causal-parent-1",
        ancestry: ["owner/parent"],
      },
    },
    claimantId: "writer",
    now: 0,
    leaseUntil: 1,
  });
  assert.equal(stored.ok, true);

  const delivered: TriggerDelivery["events"][number][] = [];
  const runtime = createTriggerEngine({
    hostId: "host-restart",
    persistence,
    clock: { now: () => 2 },
  });
  bindFixture(runtime);
  const reconciled = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async ({ events }) => void delivered.push(...events),
      },
    ],
  });
  assert.equal(reconciled.ok, true);
  assert.deepEqual(delivered[0]?.payload, payload);
  assert.deepEqual(delivered[0]?.cause, {
    rootEventId: "causal-root-1",
    parentEventId: "causal-parent-1",
    ancestry: ["owner/parent"],
  });

  await runtime.close();
});

test("bounds source, payload, and total envelope bytes and nodes", async () => {
  const sourceRuntime = createTriggerEngine({
    hostId: "host-a",
    maxSourceBytes: 96,
  });
  const oversizedSource = sourceRuntime.bindSource({
    kind: "fixture",
    id: "source",
    projectId: "project-a",
    trust: "untrusted",
    metadata: { padding: "x".repeat(96) },
  });
  assert.equal(oversizedSource.ok, false);
  if (!oversizedSource.ok) {
    assert.equal(oversizedSource.error.code, "SOURCE_TOO_LARGE");
  }
  await sourceRuntime.close();

  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxPayloadBytes: 1_024,
    maxEnvelopeBytes: 256,
    maxDataNodes: 4,
  });
  const publisher = bindFixture(runtime);
  const oversizedEnvelope = await publisher.publish({
    type: "fixture.event",
    payload: { body: "x".repeat(128) },
  });
  assert.equal(oversizedEnvelope.ok, false);
  if (!oversizedEnvelope.ok) {
    assert.equal(oversizedEnvelope.error.code, "ENVELOPE_TOO_LARGE");
  }
  const tooManyNodes = await publisher.publish({
    type: "fixture.event",
    payload: { one: { two: { three: { four: true } } } },
  });
  assert.equal(tooManyNodes.ok, false);
  if (!tooManyNodes.ok) {
    assert.equal(tooManyNodes.error.code, "INVALID_ARGUMENT");
  }

  await runtime.close();
});

test("failed persistence preparation rolls reconcile back atomically", async () => {
  const memory = createMemoryTriggerPersistence();
  let failRead = false;
  const persistence = {
    ...memory,
    async claimPage(request: Parameters<typeof memory.claimPage>[0]) {
      if (failRead) {
        return {
          ok: false as const,
          error: {
            code: "READ_FAILED" as const,
            message: "fixture read failure",
            retryable: true,
          },
        };
      }
      return memory.claimPage(request);
    },
  };
  const runtime = createTriggerEngine({ hostId: "host-a", persistence });
  const first = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "first",
        eventTypes: ["fixture.event"],
        deliver: async () => undefined,
      },
    ],
  });
  assert.equal(first.ok, true);

  failRead = true;
  const replacement = await runtime.engine.reconcile({
    ownerId: "replacement-owner",
    generation: 1,
    bindings: [
      {
        id: "replacement",
        eventTypes: ["fixture.event"],
        deliver: async () => undefined,
      },
    ],
  });
  assert.equal(replacement.ok, false);
  assert.deepEqual(runtime.engine.inspect().bindings, [
    { ownerId: "owner", generation: 1, bindingId: "first" },
  ]);

  await runtime.close();
});

test("concurrent owner generations reconcile serially", async () => {
  const memory = createMemoryTriggerPersistence();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let claimCalls = 0;
  const persistence = {
    ...memory,
    async claimPage(request: Parameters<typeof memory.claimPage>[0]) {
      claimCalls++;
      if (claimCalls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return memory.claimPage(request);
    },
  };
  const runtime = createTriggerEngine({ hostId: "host-a", persistence });
  const reconcile = (generation: number) =>
    runtime.engine.reconcile({
      ownerId: "owner",
      generation,
      bindings: [
        {
          id: `worker-${generation}`,
          eventTypes: ["fixture.event"],
          deliver: async () => undefined,
        },
      ],
    });
  const first = reconcile(1);
  await firstEntered.promise;
  const second = reconcile(2);
  await flush();
  assert.equal(claimCalls, 1);
  releaseFirst.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(claimCalls, 1);
  assert.deepEqual(runtime.engine.inspect().bindings, [
    { ownerId: "owner", generation: 2, bindingId: "worker-2" },
  ]);

  await runtime.close();
});

test("reconcile deep-snapshots mutable binding options", async () => {
  let calls = 0;
  const eventTypes = ["fixture.original"];
  const batch = { maxCount: 2, maxWaitMs: 10 };
  const runtime = createTriggerEngine({ hostId: "host-a" });
  const publisher = bindFixture(runtime);
  const reconciled = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes,
        batch,
        deliver: async () => void calls++,
      },
    ],
  });
  assert.equal(reconciled.ok, true);
  eventTypes[0] = "fixture.changed";
  batch.maxCount = 1;

  const publication = publisher.publish({
    type: "fixture.original",
    payload: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await publication).ok, true);
  assert.equal(calls, 1);

  await runtime.close();
});

test("globally caps active consumers and queues excess fanout", async () => {
  const releases = [deferred(), deferred(), deferred(), deferred()];
  const started: string[] = [];
  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxActiveConsumers: 2,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: releases.map((release, index) => ({
      id: `binding-${index}`,
      eventTypes: ["fixture.event"],
      deliver: async () => {
        started.push(`binding-${index}`);
        await release.promise;
      },
    })),
  });

  const publication = publisher.publish({ type: "fixture.event", payload: {} });
  await flush();
  assert.deepEqual(started, ["binding-0", "binding-1"]);
  assert.deepEqual(runtime.engine.inspect().queue, {
    count: 2,
    bytes: runtime.engine.inspect().queue.bytes,
    running: 2,
    admitting: 0,
  });

  releases[0]?.resolve();
  releases[1]?.resolve();
  await flush();
  assert.deepEqual(started, [
    "binding-0",
    "binding-1",
    "binding-2",
    "binding-3",
  ]);
  releases[2]?.resolve();
  releases[3]?.resolve();
  assert.equal((await publication).ok, true);

  await runtime.close();

  let overflowCalls = 0;
  const overflowRuntime = createTriggerEngine({
    hostId: "host-a",
    maxActiveConsumers: 2,
    maxQueueCount: 1,
  });
  const overflowPublisher = bindFixture(overflowRuntime);
  await overflowRuntime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: ["one", "two", "three", "four"].map((id) => ({
      id,
      eventTypes: ["fixture.event"],
      deliver: async () => void overflowCalls++,
    })),
  });
  const overflow = await overflowPublisher.publish({
    type: "fixture.event",
    payload: {},
  });
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.error.code, "QUEUE_FULL");
  assert.equal(overflowCalls, 0);
  await overflowRuntime.close();
});

test("hard-caps total bindings, per-binding pending work, and root fanout", async () => {
  const bindingRuntime = createTriggerEngine({
    hostId: "host-a",
    maxBindings: 2,
  });
  const tooManyBindings = await bindingRuntime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: ["one", "two", "three"].map((id) => ({
      id,
      eventTypes: ["fixture.event"],
      deliver: async () => undefined,
    })),
  });
  assert.equal(tooManyBindings.ok, false);
  if (!tooManyBindings.ok) {
    assert.equal(tooManyBindings.error.code, "CAPACITY_EXCEEDED");
  }
  assert.deepEqual(bindingRuntime.engine.inspect().bindings, []);
  await bindingRuntime.close();

  const release = deferred();
  const pendingRuntime = createTriggerEngine({
    hostId: "host-a",
    maxPendingPerBinding: 1,
  });
  const pendingPublisher = bindFixture(pendingRuntime);
  await pendingRuntime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => release.promise,
      },
    ],
  });
  const running = pendingPublisher.publish({
    type: "fixture.event",
    payload: {},
  });
  await flush();
  const waiting = pendingPublisher.publish({
    type: "fixture.event",
    payload: {},
  });
  await flush();
  const overflowing = await pendingPublisher.publish({
    type: "fixture.event",
    payload: {},
  });
  assert.equal(overflowing.ok, false);
  if (!overflowing.ok) assert.equal(overflowing.error.code, "QUEUE_FULL");
  release.resolve();
  await Promise.all([running, waiting]);
  await pendingRuntime.close();

  let fanoutCalls = 0;
  const fanoutRuntime = createTriggerEngine({
    hostId: "host-a",
    maxRootFanout: 2,
  });
  const fanoutPublisher = bindFixture(fanoutRuntime);
  await fanoutRuntime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: ["one", "two", "three"].map((id) => ({
      id,
      eventTypes: ["fixture.event"],
      deliver: async () => void fanoutCalls++,
    })),
  });
  const fanout = await fanoutPublisher.publish({
    type: "fixture.event",
    payload: {},
  });
  assert.equal(fanout.ok, false);
  if (!fanout.ok) assert.equal(fanout.error.code, "RECURSION_LIMIT");
  assert.equal(fanoutCalls, 0);
  await fanoutRuntime.close();
});

test("caps sibling firings within one causal root", async () => {
  const childResults: Awaited<ReturnType<TriggerDelivery["publish"]>>[] = [];
  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxRootFirings: 2,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "parent",
        eventTypes: ["fixture.parent"],
        deliver: async ({ publish }) => {
          childResults.push(
            await publish({ type: "fixture.child", payload: { sequence: 1 } }),
          );
          childResults.push(
            await publish({ type: "fixture.child", payload: { sequence: 2 } }),
          );
        },
      },
      {
        id: "child",
        eventTypes: ["fixture.child"],
        deliver: async () => undefined,
      },
    ],
  });
  const root = await publisher.publish({ type: "fixture.parent", payload: {} });
  assert.equal(root.ok, true);
  assert.equal(childResults[0]?.ok, true);
  assert.equal(childResults[1]?.ok, false);
  if (childResults[1] && !childResults[1].ok) {
    assert.equal(childResults[1].error.code, "RECURSION_LIMIT");
  }

  await runtime.close();
});

test("reserves queue capacity atomically across persistence awaits", async () => {
  const memory = createMemoryTriggerPersistence();
  const releaseStore = deferred();
  let storeCalls = 0;
  const persistence = {
    ...memory,
    async store(request: Parameters<typeof memory.store>[0]) {
      storeCalls++;
      await releaseStore.promise;
      return memory.store(request);
    },
  };
  const runtime = createTriggerEngine({
    hostId: "host-a",
    persistence,
    maxQueueCount: 1,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        debounceMs: 1,
        deliver: async () => undefined,
      },
    ],
  });

  const first = publisher.publish({
    type: "fixture.event",
    payload: { sequence: 1 },
    durability: "restart-only",
  });
  await flush();
  const second = publisher.publish({
    type: "fixture.event",
    payload: { sequence: 2 },
    durability: "restart-only",
  });
  await flush();
  assert.equal(storeCalls, 1);
  const secondResult = await second;
  assert.equal(secondResult.ok, false);
  if (!secondResult.ok) assert.equal(secondResult.error.code, "QUEUE_FULL");

  releaseStore.resolve();
  assert.equal((await first).ok, true);
  await runtime.close();
});

test("deadline fences every late derived publish", async () => {
  const clock = new FakeClock();
  const release = deferred();
  let childCalls = 0;
  let lateResult: Awaited<ReturnType<TriggerDelivery["publish"]>> | undefined;
  const runtime = createTriggerEngine({ hostId: "host-a", clock });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "parent",
        eventTypes: ["fixture.parent"],
        deadlineMs: 10,
        deliver: async ({ publish }) => {
          await release.promise;
          lateResult = await publish({ type: "fixture.child", payload: {} });
        },
      },
      {
        id: "child",
        eventTypes: ["fixture.child"],
        deliver: async () => void childCalls++,
      },
    ],
  });

  const parent = publisher.publish({ type: "fixture.parent", payload: {} });
  await flush();
  await clock.advance(10);
  const parentResult = await parent;
  assert.equal(parentResult.ok, true);
  if (parentResult.ok) {
    assert.equal(parentResult.value.deliveries[0]?.status, "timed-out");
  }
  release.resolve();
  await flush();
  assert.equal(lateResult?.ok, false);
  assert.equal(childCalls, 0);

  await runtime.close();
});

test("deadline fences a derived publish across persistence await", async () => {
  const clock = new FakeClock();
  const memory = createMemoryTriggerPersistence();
  const entered = deferred();
  const releaseStore = deferred();
  const persistence = {
    ...memory,
    async store(request: Parameters<typeof memory.store>[0]) {
      entered.resolve();
      await releaseStore.promise;
      return memory.store(request);
    },
  };
  let childCalls = 0;
  let childResult: Awaited<ReturnType<TriggerDelivery["publish"]>> | undefined;
  const runtime = createTriggerEngine({
    hostId: "host-a",
    clock,
    persistence,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "parent",
        eventTypes: ["fixture.parent"],
        deadlineMs: 10,
        deliver: async ({ publish }) => {
          childResult = await publish({
            type: "fixture.child",
            payload: {},
            durability: "restart-only",
          });
        },
      },
      {
        id: "child",
        eventTypes: ["fixture.child"],
        deliver: async () => void childCalls++,
      },
    ],
  });
  const root = publisher.publish({ type: "fixture.parent", payload: {} });
  await entered.promise;
  await clock.advance(10);
  releaseStore.resolve();
  await flush();
  assert.equal((await root).ok, true);
  assert.equal(childResult?.ok, false);
  assert.equal(childCalls, 0);

  await runtime.close();
});

test("close seals persistence-raced ingress and drains accepted work", async () => {
  const memory = createMemoryTriggerPersistence();
  const entered = deferred();
  const releaseStore = deferred();
  const persistence = {
    ...memory,
    async store(request: Parameters<typeof memory.store>[0]) {
      entered.resolve();
      await releaseStore.promise;
      return memory.store(request);
    },
  };
  let calls = 0;
  const runtime = createTriggerEngine({
    hostId: "host-a",
    persistence,
    closeDrainMs: 100,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => void calls++,
      },
    ],
  });

  const publication = publisher.publish({
    type: "fixture.event",
    payload: {},
    durability: "restart-only",
  });
  await entered.promise;
  let closeSettled = false;
  const closing = runtime.close().then(() => void (closeSettled = true));
  await flush();
  assert.equal(closeSettled, false);
  releaseStore.resolve();
  await closing;

  const result = await publication;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CLOSED");
  assert.equal(calls, 0);
  assert.deepEqual(runtime.engine.inspect().queue, {
    count: 0,
    bytes: 0,
    running: 0,
    admitting: 0,
  });
});

test("close boundedly drains callbacks and exposes unresolved work", async () => {
  const never = deferred();
  const runtime = createTriggerEngine({ hostId: "host-a", closeDrainMs: 5 });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => never.promise,
      },
    ],
  });
  const publication = publisher.publish({ type: "fixture.event", payload: {} });
  await flush();
  await runtime.close();
  const result = await publication;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.deliveries[0]?.status, "closed");
  assert.equal(runtime.engine.inspect().counters.unresolvedCallbacks, 1);
});

test("close prevents an accepted callback from starting after ingress seals", async () => {
  let calls = 0;
  const runtime = createTriggerEngine({ hostId: "host-a" });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => void calls++,
      },
    ],
  });
  const publication = publisher.publish({ type: "fixture.event", payload: {} });
  await runtime.close();
  const result = await publication;
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.deliveries[0]?.status, "closed");
  assert.equal(calls, 0);
});

test("coalescing reports superseded and replacement receipts truthfully", async () => {
  const clock = new FakeClock();
  const delivered: string[] = [];
  const runtime = createTriggerEngine({
    hostId: "host-a",
    clock,
    createEventId: (() => {
      let sequence = 0;
      return () => `event-${++sequence}`;
    })(),
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        debounceMs: 10,
        coalesceBy: "key",
        deliver: async ({ events }) =>
          void delivered.push(...events.map(({ id }) => id)),
      },
    ],
  });

  const first = publisher.publish({
    type: "fixture.event",
    payload: { key: "same", value: 1 },
  });
  await clock.advance(1);
  const replacement = publisher.publish({
    type: "fixture.event",
    payload: { key: "same", value: 2 },
  });
  await clock.advance(10);
  const [firstResult, replacementResult] = await Promise.all([
    first,
    replacement,
  ]);
  assert.deepEqual(delivered, ["event-2"]);
  assert.equal(firstResult.ok, true);
  assert.equal(replacementResult.ok, true);
  if (firstResult.ok && replacementResult.ok) {
    assert.equal(firstResult.value.disposition, "superseded");
    assert.deepEqual(firstResult.value.deliveries, [
      {
        ownerId: "owner",
        bindingId: "worker",
        generation: 1,
        status: "superseded",
        replacementEventId: "event-2",
      },
    ]);
    assert.equal(replacementResult.value.disposition, "coalesced");
    assert.equal(replacementResult.value.deliveries[0]?.status, "delivered");
  }
  assert.equal(runtime.engine.inspect().counters.coalesced, 1);
  assert.equal(runtime.engine.inspect().counters.superseded, 1);

  await runtime.close();
});

test("atomic durable claims prevent duplicate replay across two runtimes", async () => {
  const persistence = createMemoryTriggerPersistence();
  const writer = createTriggerEngine({
    hostId: "host-writer",
    persistence,
    createEventId: () => "durable-1",
    clock: { now: () => 100 },
  });
  const writerPublisher = bindFixture(writer);
  assert.equal(
    (
      await writerPublisher.publish({
        type: "fixture.event",
        payload: { body: "must-not-persist" },
        durability: "restart-only",
      })
    ).ok,
    true,
  );
  await writer.close();

  let calls = 0;
  const first = createTriggerEngine({
    hostId: "host-first",
    persistence,
    clock: { now: () => 200 },
  });
  const second = createTriggerEngine({
    hostId: "host-second",
    persistence,
    clock: { now: () => 200 },
  });
  bindFixture(first);
  bindFixture(second);
  const reconcile = (runtime: typeof first) =>
    runtime.engine.reconcile({
      ownerId: "owner",
      generation: 1,
      bindings: [
        {
          id: "worker",
          eventTypes: ["fixture.event"],
          deliver: async ({ events }) => {
            calls++;
            assert.deepEqual(events[0]?.payload, {});
          },
        },
      ],
    });
  const results = await Promise.all([reconcile(first), reconcile(second)]);
  assert.equal(
    results.every(({ ok }) => ok),
    true,
  );
  assert.equal(calls, 1);

  await Promise.all([first.close(), second.close()]);
});

test("failed durable acknowledgement becomes ambiguous without duplicate replay", async () => {
  const memory = createMemoryTriggerPersistence();
  let failAcknowledgement = true;
  const persistence = {
    ...memory,
    async completeAttempt(
      request: Parameters<typeof memory.completeAttempt>[0],
    ) {
      if (failAcknowledgement && request.status === "delivered") {
        failAcknowledgement = false;
        return {
          ok: false as const,
          error: {
            code: "WRITE_FAILED" as const,
            message: "fixture acknowledgement failure",
            retryable: true,
          },
        };
      }
      return memory.completeAttempt(request);
    },
  };
  let calls = 0;
  const first = createTriggerEngine({
    hostId: "host-first",
    persistence,
    createEventId: () => "durable-1",
    clock: { now: () => 100 },
  });
  const firstPublisher = bindFixture(first);
  await first.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => void calls++,
      },
    ],
  });
  const delivered = await firstPublisher.publish({
    type: "fixture.event",
    payload: {},
    durability: "restart-only",
  });
  assert.equal(delivered.ok, true);
  if (delivered.ok) {
    assert.equal(delivered.value.deliveries[0]?.status, "ambiguous");
  }
  assert.equal(calls, 1);
  await first.close();

  const second = createTriggerEngine({
    hostId: "host-second",
    persistence,
    clock: { now: () => 200 },
  });
  bindFixture(second);
  const reconciled = await second.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => void calls++,
      },
    ],
  });
  assert.equal(reconciled.ok, true);
  assert.equal(calls, 1);
  assert.equal(second.engine.inspect().counters.ambiguous, 1);

  await second.close();
});

test("failed durable deliveries remain replayable until one succeeds", async () => {
  const persistence = createMemoryTriggerPersistence();
  let calls = 0;
  const first = createTriggerEngine({
    hostId: "host-first",
    persistence,
    createEventId: () => "durable-1",
    clock: { now: () => 100 },
  });
  const firstPublisher = bindFixture(first);
  await first.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => {
          calls++;
          throw new Error("fixture failure");
        },
      },
    ],
  });
  const failed = await firstPublisher.publish({
    type: "fixture.event",
    payload: {},
    durability: "restart-only",
  });
  assert.equal(failed.ok, true);
  if (failed.ok) assert.equal(failed.value.deliveries[0]?.status, "failed");
  await first.close();

  const replay = async (hostId: string) => {
    const runtime = createTriggerEngine({
      hostId,
      persistence,
      clock: { now: () => 200 },
    });
    bindFixture(runtime);
    const result = await runtime.engine.reconcile({
      ownerId: "owner",
      generation: 1,
      bindings: [
        {
          id: "worker",
          eventTypes: ["fixture.event"],
          deliver: async () => void calls++,
        },
      ],
    });
    await runtime.close();
    return result;
  };
  assert.equal((await replay("host-second")).ok, true);
  assert.equal(calls, 2);
  assert.equal((await replay("host-third")).ok, true);
  assert.equal(calls, 2);
});

test("failed durable recovery runs only on first activation for each owner", async () => {
  const persistence = createMemoryTriggerPersistence();
  let calls = 0;
  const runtime = createTriggerEngine({
    hostId: "host-recovery-boundary",
    persistence,
    createEventId: () => "durable-owner-recovery",
    clock: { now: () => 100 },
  });
  const publisher = bindFixture(runtime);
  const binding = (ownerId: string, generation: number, fail = false) =>
    runtime.engine.reconcile({
      ownerId,
      generation,
      bindings: [
        {
          id: "worker",
          eventTypes: ["fixture.event"],
          deliver: async () => {
            calls += 1;
            if (fail) throw new Error("fixture failure");
          },
        },
      ],
    });

  assert.equal((await binding("owner-a", 1, true)).ok, true);
  const failed = await publisher.publish({
    type: "fixture.event",
    payload: {},
    durability: "restart-only",
  });
  assert.equal(failed.ok, true);
  assert.equal(calls, 1);

  const ordinaryReload = await binding("owner-a", 2);
  assert.equal(ordinaryReload.ok, true);
  if (ordinaryReload.ok) assert.equal(ordinaryReload.value.replay.claimed, 0);
  assert.equal(calls, 1);

  const secondOwnerActivation = await binding("owner-b", 1);
  assert.equal(secondOwnerActivation.ok, true);
  if (secondOwnerActivation.ok)
    assert.equal(secondOwnerActivation.value.replay.claimed, 1);
  assert.equal(calls, 2);

  const secondOwnerReload = await binding("owner-b", 2);
  assert.equal(secondOwnerReload.ok, true);
  if (secondOwnerReload.ok)
    assert.equal(secondOwnerReload.value.replay.claimed, 0);
  assert.equal(calls, 2);

  await runtime.close();
});

test("timed-out durable deliveries remain replayable", async () => {
  const persistence = createMemoryTriggerPersistence();
  const clock = new FakeClock();
  const never = deferred();
  let calls = 0;
  const first = createTriggerEngine({
    hostId: "host-first",
    persistence,
    clock,
    createEventId: () => "durable-timeout",
    closeDrainMs: 1,
  });
  const publisher = bindFixture(first);
  await first.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deadlineMs: 10,
        deliver: async () => {
          calls++;
          await never.promise;
        },
      },
    ],
  });
  const publication = publisher.publish({
    type: "fixture.event",
    payload: {},
    durability: "restart-only",
  });
  await flush();
  await clock.advance(10);
  const timedOut = await publication;
  assert.equal(timedOut.ok, true);
  if (timedOut.ok) {
    assert.equal(timedOut.value.deliveries[0]?.status, "timed-out");
  }
  await first.close();

  const second = createTriggerEngine({
    hostId: "host-second",
    persistence,
    clock: { now: () => 100 },
  });
  bindFixture(second);
  await second.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => void calls++,
      },
    ],
  });
  assert.equal(calls, 2);
  await second.close();
});

test("corrupt durable rows are boundedly decoded and quarantined", async () => {
  const memory = createMemoryTriggerPersistence();
  const quarantined: unknown[] = [];
  let returnedCorruption = false;
  const persistence = {
    ...memory,
    async claimPage() {
      if (returnedCorruption)
        return { ok: true as const, value: { claims: [] } };
      returnedCorruption = true;
      return {
        ok: true as const,
        value: {
          claims: [
            {
              claimId: "corrupt-1",
              fence: 1,
              record: {
                schemaVersion: 2,
                eventId: "corrupt-1",
                type: "fixture.event",
                occurredAt: 1,
                sourceKey: "a".repeat(64),
                payload: { status: "READY" },
                payloadDigest: "b".repeat(64),
                cause: { rootEventId: "corrupt-1", ancestry: [] },
              },
            },
          ],
        },
      };
    },
    async quarantine(request: Parameters<typeof memory.quarantine>[0]) {
      quarantined.push(structuredClone(request));
      return { ok: true as const, value: undefined };
    },
  };
  const runtime = createTriggerEngine({ hostId: "host-a", persistence });
  bindFixture(runtime);
  const reconciled = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => undefined,
      },
    ],
  });
  assert.equal(reconciled.ok, true);
  if (reconciled.ok) {
    assert.deepEqual(reconciled.value.replay, {
      claimed: 1,
      delivered: 0,
      ambiguous: 0,
      quarantined: 1,
      state: "degraded",
    });
  }
  assert.deepEqual(quarantined, [
    {
      claimId: "corrupt-1",
      claimantId:
        quarantined.length === 1
          ? (quarantined[0] as { claimantId: string }).claimantId
          : "",
      fence: 1,
      reason: "record-invalid",
    },
  ]);
  assert.deepEqual(runtime.engine.inspect().bindings, [
    { ownerId: "owner", generation: 1, bindingId: "worker" },
  ]);

  await runtime.close();
});

test("durable replay reads strict bounded pages", async () => {
  const memory = createMemoryTriggerPersistence();
  const requests: Array<Parameters<typeof memory.claimPage>[0]> = [];
  const persistence = {
    ...memory,
    async claimPage(request: Parameters<typeof memory.claimPage>[0]) {
      requests.push(structuredClone(request));
      return {
        ok: true as const,
        value:
          requests.length === 1
            ? { claims: [], nextCursor: "next-page" }
            : { claims: [] },
      };
    },
  };
  const runtime = createTriggerEngine({
    hostId: "host-a",
    persistence,
    maxPersistencePages: 2,
  });
  const reconciled = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [],
  });
  assert.equal(reconciled.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ limit, cursor }) => ({ limit, cursor })),
    [
      { limit: 64, cursor: undefined },
      { limit: 64, cursor: "next-page" },
    ],
  );

  await runtime.close();

  const oversizedPersistence = {
    ...memory,
    async claimPage() {
      return {
        ok: true as const,
        value: { claims: Array.from({ length: 65 }, () => null) },
      };
    },
  };
  const oversizedRuntime = createTriggerEngine({
    hostId: "host-b",
    persistence: oversizedPersistence,
  });
  const rejected = await oversizedRuntime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "PERSISTENCE_FAILED");
  assert.deepEqual(oversizedRuntime.engine.inspect().bindings, []);
  await oversizedRuntime.close();
});

test("rejects non-plain, cyclic, accessor, spoofed, and oversized publish data", async () => {
  let getterCalls = 0;
  const accessorPayload = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls++;
      return "must-not-run";
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  class Payload {
    value = "not-plain";
  }
  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxPayloadBytes: 24,
  });
  const publisher = bindFixture(runtime);

  for (const payload of [accessorPayload, cyclic, new Payload()]) {
    const result = await publisher.publish({
      type: "fixture.event",
      payload,
    } as Parameters<typeof publisher.publish>[0]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  }
  assert.equal(getterCalls, 0);

  const spoofed = await publisher.publish({
    type: "fixture.event",
    payload: {},
    cause: { rootEventId: "caller-controlled", ancestry: [] },
  } as unknown as Parameters<typeof publisher.publish>[0]);
  assert.equal(spoofed.ok, false);
  if (!spoofed.ok) assert.equal(spoofed.error.code, "INVALID_ARGUMENT");

  const oversized = await publisher.publish({
    type: "fixture.event",
    payload: { value: "x".repeat(24) },
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "PAYLOAD_TOO_LARGE");

  await runtime.close();
});

test("reconciles monotonic generations and routes in deterministic binding order", async () => {
  const order: string[] = [];
  const runtime = createTriggerEngine({ hostId: "host-a" });
  const publisher = bindFixture(runtime);
  const binding = (id: string, priority: number) => ({
    id,
    priority,
    eventTypes: ["fixture.event"],
    deliver: async () => void order.push(id),
  });

  assert.equal(
    (
      await runtime.engine.reconcile({
        ownerId: "z-owner",
        generation: 1,
        bindings: [binding("z-last", 20), binding("b-id", 10)],
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await runtime.engine.reconcile({
        ownerId: "a-owner",
        generation: 4,
        bindings: [binding("a-id", 10), binding("first", 0)],
      })
    ).ok,
    true,
  );

  const stale = await runtime.engine.reconcile({
    ownerId: "a-owner",
    generation: 4,
    bindings: [],
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "STALE_GENERATION");

  const duplicate = await runtime.engine.reconcile({
    ownerId: "duplicate-owner",
    generation: 1,
    bindings: [binding("same", 0), binding("same", 1)],
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "INVALID_ARGUMENT");

  await publisher.publish({
    type: "fixture.event",
    payload: {},
  });
  assert.deepEqual(order, ["first", "a-id", "b-id", "z-last"]);

  await runtime.close();
});

test("starts each binding FIFO up to its concurrency limit", async () => {
  const started: number[] = [];
  const releases = [deferred(), deferred(), deferred()];
  const runtime = createTriggerEngine({ hostId: "host-a" });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:queue",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        concurrency: 2,
        deliver: async ({ events }) => {
          const sequence = events[0]?.payload.sequence;
          if (typeof sequence !== "number") {
            throw new TypeError("Expected numeric sequence fixture.");
          }
          started.push(sequence);
          await releases[sequence - 1]?.promise;
        },
      },
    ],
  });

  const publications = [1, 2, 3].map((sequence) =>
    publisher.publish({
      type: "fixture.event",
      payload: { sequence },
    }),
  );
  await flush();
  assert.deepEqual(started, [1, 2]);

  releases[0]?.resolve();
  await flush();
  assert.deepEqual(started, [1, 2, 3]);
  releases[1]?.resolve();
  releases[2]?.resolve();
  assert.equal(
    (await Promise.all(publications)).every(({ ok }) => ok),
    true,
  );

  await runtime.close();
});

test("bounds waiting deliveries by count and serialized bytes", async () => {
  const release = deferred();
  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxQueueCount: 1,
    maxQueueBytes: 300,
    maxPayloadBytes: 1_024,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:bounded",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => release.promise,
      },
    ],
  });

  const running = publisher.publish({
    type: "fixture.event",
    payload: { sequence: 1 },
  });
  await flush();
  const queued = publisher.publish({
    type: "fixture.event",
    payload: { sequence: 2 },
  });
  await flush();
  const countOverflow = await publisher.publish({
    type: "fixture.event",
    payload: { sequence: 3 },
  });
  assert.equal(countOverflow.ok, false);
  if (!countOverflow.ok) assert.equal(countOverflow.error.code, "QUEUE_FULL");

  release.resolve();
  await Promise.all([running, queued]);
  await runtime.close();

  const byteRelease = deferred();
  const byteRuntime = createTriggerEngine({
    hostId: "host-a",
    maxQueueCount: 10,
    maxQueueBytes: 300,
    maxPayloadBytes: 1_024,
  });
  const bytePublisher = bindFixture(byteRuntime);
  await byteRuntime.engine.reconcile({
    ownerId: "monitor:bytes",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async () => byteRelease.promise,
      },
    ],
  });
  const byteRunning = bytePublisher.publish({
    type: "fixture.event",
    payload: {},
  });
  await flush();
  const byteOverflow = await bytePublisher.publish({
    type: "fixture.event",
    payload: { value: "x".repeat(280) },
  });
  assert.equal(byteOverflow.ok, false);
  if (!byteOverflow.ok) assert.equal(byteOverflow.error.code, "QUEUE_FULL");
  byteRelease.resolve();
  await byteRunning;
  await byteRuntime.close();
});

test("debounces bounded batches and coalesces queued events by payload key", async () => {
  const clock = new FakeClock();
  const batches: TriggerDelivery["events"][] = [];
  const runtime = createTriggerEngine({ hostId: "host-a", clock });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:batch",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        debounceMs: 20,
        batch: { maxCount: 3, maxWaitMs: 100 },
        coalesceBy: "key",
        deliver: async ({ events }) => void batches.push(events),
      },
    ],
  });

  const first = publisher.publish({
    type: "fixture.event",
    payload: { key: "same", value: 1 },
  });
  await clock.advance(10);
  const replacement = publisher.publish({
    type: "fixture.event",
    payload: { key: "same", value: 2 },
  });
  const second = publisher.publish({
    type: "fixture.event",
    payload: { key: "other", value: 3 },
  });

  await clock.advance(19);
  assert.equal(batches.length, 0);
  await clock.advance(1);
  assert.deepEqual(
    batches[0]?.map(({ payload }) => payload),
    [
      { key: "same", value: 2 },
      { key: "other", value: 3 },
    ],
  );
  assert.equal(
    (await Promise.all([first, replacement, second])).every(({ ok }) => ok),
    true,
  );

  await runtime.close();
});

test("aborts hard deadlines and fences late work from older generations", async () => {
  const clock = new FakeClock();
  const lateDeadline = deferred();
  let deadlineSignal: AbortSignal | undefined;
  const runtime = createTriggerEngine({ hostId: "host-a", clock });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:fenced",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deadlineMs: 50,
        deliver: async ({ signal }) => {
          deadlineSignal = signal;
          await lateDeadline.promise;
        },
      },
    ],
  });
  const timed = publisher.publish({
    type: "fixture.event",
    payload: { sequence: 1 },
  });
  await flush();
  assert.equal(deadlineSignal?.aborted, false);
  await clock.advance(49);
  assert.equal(deadlineSignal?.aborted, false);
  await clock.advance(1);
  assert.equal(deadlineSignal?.aborted, true);
  const timedResult = await timed;
  assert.equal(timedResult.ok, true);
  if (timedResult.ok) {
    assert.equal(timedResult.value.deliveries[0]?.status, "timed-out");
  }
  lateDeadline.resolve();
  await flush();

  const lateGeneration = deferred();
  let generationSignal: AbortSignal | undefined;
  await runtime.engine.reconcile({
    ownerId: "monitor:fenced",
    generation: 2,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deadlineMs: 1_000,
        deliver: async ({ signal }) => {
          generationSignal = signal;
          await lateGeneration.promise;
        },
      },
    ],
  });
  const fenced = publisher.publish({
    type: "fixture.event",
    payload: { sequence: 2 },
  });
  await flush();
  const replaced = await runtime.engine.reconcile({
    ownerId: "monitor:fenced",
    generation: 3,
    bindings: [],
  });
  assert.equal(replaced.ok, true);
  assert.equal(generationSignal?.aborted, true);
  const fencedResult = await fenced;
  assert.equal(fencedResult.ok, true);
  if (fencedResult.ok) {
    assert.equal(fencedResult.value.deliveries[0]?.status, "fenced");
  }
  lateGeneration.resolve();
  await flush();

  await runtime.close();
});

test("stamps causal ancestry and suppresses a binding's derived self-events", async () => {
  let calls = 0;
  let child: Awaited<ReturnType<TriggerDelivery["publish"]>> | undefined;
  const runtime = createTriggerEngine({
    hostId: "host-a",
    createEventId: (() => {
      let sequence = 0;
      return () => `event-${++sequence}`;
    })(),
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:self",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async ({ publish }) => {
          calls++;
          child = await publish({
            type: "fixture.event",
            payload: { derived: true },
          });
        },
      },
    ],
  });

  const root = await publisher.publish({
    type: "fixture.event",
    payload: { derived: false },
  });
  assert.equal(root.ok, true);
  assert.equal(calls, 1);
  assert.equal(child?.ok, true);
  if (child?.ok) {
    assert.deepEqual(child.value.event.cause, {
      rootEventId: "event-1",
      parentEventId: "event-1",
      ancestry: ["monitor:self/worker"],
    });
    assert.deepEqual(child.value.event.provenance.source, {
      kind: "trigger-binding",
      id: "monitor:self/worker",
      generation: 1,
    });
    assert.deepEqual(child.value.deliveries, []);
  }

  await runtime.close();
});

test("bounds causal chains across different bindings", async () => {
  let bounded: Awaited<ReturnType<TriggerDelivery["publish"]>> | undefined;
  const runtime = createTriggerEngine({ hostId: "host-a", maxCausalDepth: 1 });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:chain",
    generation: 1,
    bindings: [
      {
        id: "first",
        eventTypes: ["fixture.first"],
        deliver: async ({ publish }) => {
          await publish({
            type: "fixture.second",
            payload: {},
          });
        },
      },
      {
        id: "second",
        eventTypes: ["fixture.second"],
        deliver: async ({ publish }) => {
          bounded = await publish({
            type: "fixture.third",
            payload: {},
          });
        },
      },
    ],
  });

  const root = await publisher.publish({
    type: "fixture.first",
    payload: {},
  });
  assert.equal(root.ok, true);
  assert.equal(bounded?.ok, false);
  if (bounded && !bounded.ok) {
    assert.equal(bounded.error.code, "RECURSION_LIMIT");
  }

  await runtime.close();
});

test("restores only restart-only events through an injectable persistence port", async () => {
  const persistence = createMemoryTriggerPersistence();
  const firstRuntime = createTriggerEngine({
    hostId: "host-a",
    persistence,
    clock: { now: () => 100 },
    createEventId: (() => {
      let sequence = 0;
      return () => `persisted-${++sequence}`;
    })(),
  });
  const firstPublisher = bindFixture(firstRuntime);
  const ephemeral = await firstPublisher.publish({
    type: "fixture.event",
    payload: { durability: "ephemeral" },
  });
  const durable = await firstPublisher.publish({
    type: "fixture.event",
    payload: { durability: "restart-only" },
    durability: "restart-only",
  });
  assert.equal(ephemeral.ok, true);
  assert.equal(durable.ok, true);
  await firstRuntime.close("restart");

  const restored: TriggerDelivery["events"][number][] = [];
  const secondRuntime = createTriggerEngine({ hostId: "host-b", persistence });
  bindFixture(secondRuntime);
  await secondRuntime.engine.reconcile({
    ownerId: "monitor:unrelated",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["other.event"],
        deliver: async ({ events }) => void restored.push(...events),
      },
    ],
  });
  assert.equal(restored.length, 0);
  const reconciled = await secondRuntime.engine.reconcile({
    ownerId: "monitor:restored",
    generation: 1,
    bindings: [
      {
        id: "worker",
        eventTypes: ["fixture.event"],
        deliver: async ({ events }) => void restored.push(...events),
      },
    ],
  });
  assert.equal(reconciled.ok, true);
  assert.deepEqual(
    restored.map(({ id, occurredAt, provenance, cause, payload }) => ({
      id,
      occurredAt,
      provenance,
      cause,
      payload,
    })),
    [
      {
        id: "persisted-2",
        occurredAt: 100,
        provenance: {
          hostId: "host-b",
          projectId: "project-a",
          sessionId: "session-a",
          trust: "untrusted",
          source: { kind: "fixture", id: "source", generation: 1 },
        },
        cause: { rootEventId: "persisted-2", ancestry: [] },
        payload: { durability: "restart-only" },
      },
    ],
  );

  await secondRuntime.close();
});

test("close aborts and settles work and prevents every later delivery", async () => {
  const clock = new FakeClock();
  const late = deferred();
  let calls = 0;
  let runningSignal: AbortSignal | undefined;
  const runtime = createTriggerEngine({
    hostId: "host-a",
    clock,
    closeDrainMs: 5,
  });
  const publisher = bindFixture(runtime);
  await runtime.engine.reconcile({
    ownerId: "monitor:close",
    generation: 1,
    bindings: [
      {
        id: "running",
        eventTypes: ["running.event"],
        deliver: async ({ signal }) => {
          calls++;
          runningSignal = signal;
          await late.promise;
        },
      },
      {
        id: "debounced",
        eventTypes: ["debounced.event"],
        debounceMs: 50,
        deliver: async () => void calls++,
      },
    ],
  });
  const running = publisher.publish({
    type: "running.event",
    payload: {},
  });
  const queued = publisher.publish({
    type: "debounced.event",
    payload: {},
  });
  await flush();
  assert.equal(calls, 1);

  await runtime.close("shutdown");
  assert.equal(runningSignal?.aborted, true);
  const [runningResult, queuedResult] = await Promise.all([running, queued]);
  assert.equal(runningResult.ok, true);
  assert.equal(queuedResult.ok, true);
  if (runningResult.ok) {
    assert.equal(runningResult.value.deliveries[0]?.status, "closed");
  }
  if (queuedResult.ok) {
    assert.equal(queuedResult.value.deliveries[0]?.status, "closed");
  }
  await clock.advance(100);
  late.resolve();
  await flush();
  assert.equal(calls, 1);

  const afterClose = await publisher.publish({
    type: "running.event",
    payload: {},
  });
  assert.equal(afterClose.ok, false);
  if (!afterClose.ok) assert.equal(afterClose.error.code, "CLOSED");
  assert.equal(runtime.engine.inspect().state, "closed");
});

test("inspection is bounded, redacted, and excludes event payloads", async () => {
  const runtime = createTriggerEngine({
    hostId: "host-a",
    maxInspectionEntries: 2,
    maxInspectionBytes: 1_024,
  });
  for (let sequence = 1; sequence <= 3; sequence++) {
    const bound = runtime.bindSource({
      kind: "fixture",
      id: `token=source-secret-${sequence}`,
      projectId: "project-a",
      trust: "untrusted",
      metadata: { authorization: `payload-secret-${sequence}` },
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) continue;
    await bound.value.publish({
      type: `fixture.event.${sequence}`,
      payload: {
        password: `payload-secret-${sequence}`,
        sequence,
      },
    });
  }

  const inspection = runtime.engine.inspect();
  assert.deepEqual(inspection.queue, {
    count: 0,
    bytes: 0,
    running: 0,
    admitting: 0,
  });
  assert.equal(inspection.history.length, 2);
  assert.deepEqual(
    inspection.history.map(({ type, source }) => ({ type, source })),
    [
      {
        type: "fixture.event.2",
        source: { kind: "fixture", id: "[REDACTED]" },
      },
      {
        type: "fixture.event.3",
        source: { kind: "fixture", id: "[REDACTED]" },
      },
    ],
  );
  const serialized = JSON.stringify(inspection);
  assert.equal(serialized.includes("payload-secret"), false);
  assert.equal(serialized.includes("source-secret"), false);
  assert.ok(Buffer.byteLength(serialized) <= 1_024);

  await runtime.close();
});
