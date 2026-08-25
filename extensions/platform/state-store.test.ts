import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_SCHEMA_VERSION,
  createMemoryStateStore,
  type StateStore,
} from "./src/core/persistence/index.ts";
import type { JsonObject } from "./src/core/result.ts";

async function value<T>(outcome: Awaited<ReturnType<StateStore["query"]>>) {
  if (!outcome.ok) assert.fail(outcome.error.message);
  return outcome.value as T;
}

async function events(store: StateStore, stream: string) {
  return value<{ type: "events"; events: readonly { eventId: string }[] }>(
    await store.query({ type: "events", stream }),
  );
}

test("transaction atomically writes records, events, and a fenced lease", async () => {
  const store = createMemoryStateStore({ now: () => 1_000 });
  const committed = await store.transact({
    transactionId: "tx-create-task",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "task-1",
        metadata: { status: "ready" },
      },
      {
        type: "append-event",
        stream: "task-1",
        eventId: "event-1",
        eventType: "task.created",
        metadata: { actor: "test" },
      },
      {
        type: "claim-lease",
        resource: "task-1",
        owner: "worker-1",
        ttlMs: 5_000,
      },
    ],
  });

  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  assert.equal(committed.value.records[0]?.version, 1);
  assert.equal(committed.value.events[0]?.position, 1);
  assert.equal(committed.value.leases[0]?.fence, 1);

  const record = await value<{
    type: "record";
    record: { metadata: JsonObject } | null;
  }>(await store.query({ type: "record", collection: "tasks", key: "task-1" }));
  const events = await value<{ type: "events"; events: readonly unknown[] }>(
    await store.query({ type: "events", stream: "task-1" }),
  );
  const lease = await value<{ type: "lease"; lease: { owner: string } | null }>(
    await store.query({ type: "lease", resource: "task-1" }),
  );

  assert.deepEqual(record.record?.metadata, { status: "ready" });
  assert.equal(events.events.length, 1);
  assert.equal(lease.lease?.owner, "worker-1");
});

test("transaction IDs replay once and reject different operations", async () => {
  const store = createMemoryStateStore({ now: () => 2_000 });
  const transaction = {
    transactionId: "tx-idempotent",
    operations: [
      {
        type: "append-event" as const,
        stream: "run-1",
        eventId: "event-once",
        eventType: "run.started",
        metadata: {},
      },
    ],
  };

  const first = await store.transact(transaction);
  const replay = await store.transact(transaction);
  const conflict = await store.transact({
    ...transaction,
    operations: [
      {
        ...transaction.operations[0],
        eventId: "event-different",
      },
    ],
  });

  assert.equal(first.ok && first.value.replayed, false);
  assert.equal(replay.ok && replay.value.replayed, true);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "TRANSACTION_CONFLICT");
  assert.deepEqual((await events(store, "run-1")).events, [
    {
      sequence: 1,
      stream: "run-1",
      position: 1,
      eventId: "event-once",
      eventType: "run.started",
      metadata: {},
      occurredAt: 2_000,
    },
  ]);
});

test("a failed operation rolls back every earlier operation", async () => {
  const store = createMemoryStateStore({ now: () => 3_000 });
  const outcome = await store.transact({
    transactionId: "tx-rollback",
    operations: [
      {
        type: "append-event",
        stream: "run-rollback",
        eventId: "rolled-back",
        eventType: "run.started",
        metadata: {},
      },
      {
        type: "delete-record",
        collection: "missing",
        key: "record",
        expectedVersion: 1,
      },
    ],
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "VERSION_CONFLICT");
  assert.deepEqual((await events(store, "run-rollback")).events, []);
});

test("metadata cap rejects the whole transaction", async () => {
  const store = createMemoryStateStore({ maxMetadataBytes: 20 });
  const outcome = await store.transact({
    transactionId: "tx-too-large",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "large",
        metadata: { value: "x".repeat(20) },
      },
    ],
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "METADATA_TOO_LARGE");
  const queried = await value<{ type: "record"; record: unknown }>(
    await store.query({ type: "record", collection: "tasks", key: "large" }),
  );
  assert.equal(queried.record, null);
});

test("strict JSON and aggregate bounds reject malformed or oversized requests", async () => {
  const store = createMemoryStateStore({
    maxTransactionOperations: 1,
    maxQueryLimit: 2,
  });
  const sparse: unknown[] = [];
  sparse.length = 2;
  const malformed = await store.transact({
    transactionId: "tx-sparse",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "sparse",
        metadata: { sparse } as unknown as JsonObject,
      },
    ],
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "INVALID_REQUEST");

  const oversized = await store.transact({
    transactionId: "tx-too-many",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "one",
        metadata: {},
      },
      {
        type: "put-record",
        collection: "tasks",
        key: "two",
        metadata: {},
      },
    ],
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok)
    assert.equal(oversized.error.code, "TRANSACTION_TOO_LARGE");

  const query = await store.query({
    type: "records",
    collection: "tasks",
    limit: 3,
  });
  assert.equal(query.ok, false);
  if (!query.ok) assert.equal(query.error.code, "INVALID_REQUEST");
});

test("runtime validation returns errors consistently", async () => {
  const store = createMemoryStateStore();
  const unknown = await store.transact({
    transactionId: "tx-unknown",
    operations: [{ type: "future-mutation" }],
  } as unknown as Parameters<StateStore["transact"]>[0]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "INVALID_REQUEST");

  const empty = await store.query({
    type: "record",
    collection: "",
    key: "",
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.code, "INVALID_REQUEST");

  const compacted = await store.compact({ eventsBefore: Number.NaN });
  assert.equal(compacted.ok, false);
  if (!compacted.ok) assert.equal(compacted.error.code, "INVALID_REQUEST");
});

test("record versions never repeat across delete and recreation", async () => {
  const store = createMemoryStateStore();
  const created = await store.transact({
    transactionId: "tx-record-create",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "aba",
        metadata: { generation: 1 },
      },
    ],
  });
  assert.equal(created.ok && created.value.records[0]?.version, 1);
  const deleted = await store.transact({
    transactionId: "tx-record-delete",
    operations: [
      {
        type: "delete-record",
        collection: "tasks",
        key: "aba",
        expectedVersion: 1,
      },
    ],
  });
  assert.equal(deleted.ok && deleted.value.deletedRecords[0]?.version, 2);
  const recreated = await store.transact({
    transactionId: "tx-record-recreate",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "aba",
        metadata: { generation: 2 },
        expectedVersion: null,
      },
    ],
  });
  assert.equal(recreated.ok && recreated.value.records[0]?.version, 3);
  const stale = await store.transact({
    transactionId: "tx-record-stale",
    operations: [
      {
        type: "put-record",
        collection: "tasks",
        key: "aba",
        metadata: { stale: true },
        expectedVersion: 1,
      },
    ],
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "VERSION_CONFLICT");
});

test("stale leases recover with a higher fence and reject the old holder", async () => {
  let now = 100;
  const store = createMemoryStateStore({ now: () => now });
  const first = await store.transact({
    transactionId: "tx-claim-first",
    operations: [
      {
        type: "claim-lease",
        resource: "schedule-1",
        owner: "worker-old",
        ttlMs: 10,
      },
    ],
  });
  assert.equal(first.ok && first.value.leases[0]?.fence, 1);

  const held = await store.transact({
    transactionId: "tx-claim-held",
    operations: [
      {
        type: "claim-lease",
        resource: "schedule-1",
        owner: "worker-new",
        ttlMs: 10,
      },
    ],
  });
  assert.equal(held.ok, false);
  if (!held.ok) assert.equal(held.error.code, "LEASE_HELD");

  now = 111;
  const recovered = await store.transact({
    transactionId: "tx-claim-recovered",
    operations: [
      {
        type: "claim-lease",
        resource: "schedule-1",
        owner: "worker-new",
        ttlMs: 10,
      },
    ],
  });
  assert.equal(recovered.ok && recovered.value.leases[0]?.fence, 2);

  const staleRenewal = await store.transact({
    transactionId: "tx-renew-stale",
    operations: [
      {
        type: "renew-lease",
        resource: "schedule-1",
        owner: "worker-old",
        fence: 1,
        ttlMs: 10,
      },
    ],
  });
  assert.equal(staleRenewal.ok, false);
  if (!staleRenewal.ok) assert.equal(staleRenewal.error.code, "LEASE_LOST");
});

test("query, compaction, snapshot export, and diagnostics stay plain-data", async () => {
  let now = 10;
  const store = createMemoryStateStore({ now: () => now });
  await store.transact({
    transactionId: "tx-old",
    operations: [
      {
        type: "append-event",
        stream: "history",
        eventId: "old",
        eventType: "history.old",
        metadata: {},
      },
    ],
  });
  now = 20;
  await store.transact({
    transactionId: "tx-new",
    operations: [
      {
        type: "append-event",
        stream: "history",
        eventId: "new",
        eventType: "history.new",
        metadata: {},
      },
    ],
  });

  const compacted = await store.compact({
    eventsBefore: 15,
    transactionsBefore: 15,
  });
  assert.deepEqual(compacted, {
    ok: true,
    value: { deletedEvents: 1, deletedTransactions: 1 },
  });
  assert.deepEqual(
    (await events(store, "history")).events.map((event) => event.eventId),
    ["new"],
  );

  const exported = await store.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (exported.ok && exported.value.format === "snapshot") {
    assert.equal(exported.value.snapshot.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(exported.value.snapshot.events[0]?.eventId, "new");
    assert.doesNotThrow(() => JSON.stringify(exported.value));
  }

  const diagnostics = await store.diagnose();
  assert.equal(diagnostics.ok, true);
  if (diagnostics.ok) {
    assert.equal(diagnostics.value.integrity, "ok");
    assert.deepEqual(diagnostics.value.counts, {
      records: 0,
      events: 1,
      leases: 0,
      transactions: 1,
    });
  }
});

test("event positions remain monotonic after compaction removes a stream history", async () => {
  let now = 1;
  const store = createMemoryStateStore({ now: () => now });
  await store.transact({
    transactionId: "tx-position-1",
    operations: [
      {
        type: "append-event",
        stream: "compacted-stream",
        eventId: "position-1",
        eventType: "test",
        metadata: {},
      },
    ],
  });
  now = 2;
  await store.compact({ eventsBefore: 3 });
  const appended = await store.transact({
    transactionId: "tx-position-2",
    operations: [
      {
        type: "append-event",
        stream: "compacted-stream",
        eventId: "position-2",
        eventType: "test",
        metadata: {},
      },
    ],
  });

  assert.equal(appended.ok && appended.value.events[0]?.position, 2);

  const duplicate = await store.transact({
    transactionId: "tx-duplicate-compacted-event",
    operations: [
      {
        type: "append-event",
        stream: "compacted-stream",
        eventId: "position-1",
        eventType: "test",
        metadata: {},
      },
    ],
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "EVENT_CONFLICT");
});
