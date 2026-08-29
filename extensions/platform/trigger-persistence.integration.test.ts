import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMemoryStateStore,
  createSqliteStateStore,
} from "./src/core/persistence/index.ts";
import type { StateStore } from "./src/core/persistence/state-store.ts";
import {
  createStateStoreTriggerPersistence as createAuthenticatedStateStoreTriggerPersistence,
  type StateStoreTriggerPersistenceOptions,
} from "./src/automation/triggers/state-store-persistence.ts";
import { createHmacTriggerRecordAuthenticator } from "./src/automation/triggers/record-authentication.ts";
import {
  triggerPayloadDigest,
  type TriggerDurableRecord,
} from "./src/automation/triggers/persistence.ts";
import { createTriggerEngine } from "./src/automation/triggers/index.ts";

const authenticationKey = "11".repeat(32);
const authenticator = createHmacTriggerRecordAuthenticator(async () =>
  Buffer.from(authenticationKey, "hex"),
);

function createStateStoreTriggerPersistence(
  state: StateStore,
  options: Omit<StateStoreTriggerPersistenceOptions, "authenticator"> = {},
) {
  return createAuthenticatedStateStoreTriggerPersistence(state, {
    ...options,
    authenticator,
  });
}

const durablePayload = { body: "restart-safe" };
const durableRecord = {
  schemaVersion: 2,
  eventId: "event-1",
  type: "fixture.event",
  occurredAt: 1_000,
  sourceKey: "a".repeat(64),
  payload: durablePayload,
  payloadDigest: triggerPayloadDigest(durablePayload),
  cause: { rootEventId: "event-1", ancestry: [] },
} satisfies TriggerDurableRecord;

test("Trigger authentication verification never creates or rotates its key", async () => {
  let signingLoads = 0;
  let verificationLoads = 0;
  const isolated = createHmacTriggerRecordAuthenticator(
    async () => {
      signingLoads += 1;
      return Buffer.from(authenticationKey, "hex");
    },
    async () => {
      verificationLoads += 1;
      if (verificationLoads === 1)
        throw new Error("verification key unavailable");
      return Buffer.from(authenticationKey, "hex");
    },
  );
  const signature = await isolated.authenticate(durableRecord);
  assert.equal(signingLoads, 1);
  assert.equal(verificationLoads, 0);
  await assert.rejects(
    isolated.verify(durableRecord, signature),
    /verification key unavailable/,
  );
  assert.equal(signingLoads, 1);
  assert.equal(verificationLoads, 1);
  assert.equal(await isolated.verify(durableRecord, signature), true);
  assert.equal(verificationLoads, 2);
});

function claimInProcess(path: string, claimantId: string, now: number) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(import.meta.dirname, "trigger-persistence-sqlite-worker.ts"),
      path,
      claimantId,
      String(now),
      String(now + 1_000),
      authenticationKey,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise<unknown>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Trigger worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`Trigger worker returned invalid output: ${stdout}`));
      }
    });
  });
}

test("StateStore trigger persistence atomically stores bounded metadata and claims its lease", async () => {
  const state = createMemoryStateStore({ now: () => 1_000 });
  const persistence = createStateStoreTriggerPersistence(state, {
    now: () => 1_000,
  });

  const stored = await persistence.store({
    record: durableRecord,
    claimantId: "runtime-1",
    now: 1_000,
    leaseUntil: 31_000,
  });

  assert.deepEqual(stored, {
    ok: true,
    value: { claimId: "event-1", fence: 1, record: durableRecord },
  });
  const snapshot = await state.export({ format: "snapshot" });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.value.snapshot.records.length, 1);
  assert.deepEqual(snapshot.value.snapshot.records[0]?.metadata, {
    schemaVersion: 1,
    record: durableRecord,
    authentication: snapshot.value.snapshot.records[0]?.metadata.authentication,
  });
  assert.match(
    String(snapshot.value.snapshot.records[0]?.metadata.authentication),
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(snapshot.value.snapshot.events.length, 1);
  assert.equal(snapshot.value.snapshot.leases[0]?.owner, "runtime-1");
});

test("forged durable metadata with reproducible digests is quarantined before replay", async () => {
  const now = 1_000;
  const state = createMemoryStateStore({ now: () => now });
  const persistence = createStateStoreTriggerPersistence(state, {
    now: () => now,
  });
  const stored = await persistence.store({
    record: durableRecord,
    claimantId: "writer",
    now,
    leaseUntil: now + 10,
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.equal(
    (
      await persistence.releaseClaim({
        claimId: stored.value.claimId,
        claimantId: "writer",
        fence: stored.value.fence,
      })
    ).ok,
    true,
  );

  const forgedPayload = { body: "forged-managed-event" };
  const replaced = await state.transact({
    transactionId: "fixture.forge-authenticated-trigger",
    operations: [
      {
        type: "put-record",
        collection: "automation.triggers.events",
        key: durableRecord.eventId,
        expectedVersion: 1,
        metadata: {
          ...durableRecord,
          payload: forgedPayload,
          payloadDigest: triggerPayloadDigest(forgedPayload),
        },
      },
    ],
  });
  assert.equal(replaced.ok, true);

  let deliveries = 0;
  const runtime = createTriggerEngine({
    hostId: "host-authenticated-replay",
    clock: { now: () => now + 11 },
    persistence,
  });
  const source = runtime.bindSource({
    kind: "fixture",
    id: "source",
    projectId: "project",
    trust: "managed",
  });
  assert.equal(source.ok, true);
  const reconciled = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [
      {
        id: "binding",
        eventTypes: ["fixture.event"],
        deliver: () => void deliveries++,
      },
    ],
  });
  assert.equal(reconciled.ok, true);
  if (reconciled.ok) {
    assert.equal(reconciled.value.replay.quarantined, 1);
    assert.equal(reconciled.value.replay.state, "degraded");
  }
  assert.equal(deliveries, 0);
  const quarantined = await state.query({
    type: "record",
    collection: "automation.triggers.quarantine",
    key: durableRecord.eventId,
  });
  assert.equal(
    quarantined.ok &&
      quarantined.value.type === "record" &&
      quarantined.value.record?.metadata.reason,
    "record-invalid",
  );
  await runtime.close();
});

test("claim pages are strict, stable, fenced, and surface corrupt records", async () => {
  let now = 1_000;
  const state = createMemoryStateStore({ now: () => now });
  const persistence = createStateStoreTriggerPersistence(state, {
    now: () => now,
  });
  for (const eventId of ["event-c", "event-a", "event-b"]) {
    const stored = await persistence.store({
      record: { ...durableRecord, eventId },
      claimantId: `writer-${eventId}`,
      now,
      leaseUntil: now + 10,
    });
    assert.equal(stored.ok, true);
  }
  const corrupted = await state.transact({
    transactionId: "fixture.corrupt-trigger",
    operations: [
      {
        type: "put-record",
        collection: "automation.triggers.events",
        key: "event-d",
        metadata: { schemaVersion: 999, marker: "corrupt" },
        expectedVersion: null,
      },
    ],
  });
  assert.equal(corrupted.ok, true);
  now = 1_011;

  const invalid = await persistence.claimPage({
    claimantId: "reader",
    now,
    leaseUntil: now + 30_000,
    limit: 129,
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "READ_FAILED");
    assert.equal(invalid.error.retryable, false);
  }

  const first = await persistence.claimPage({
    claimantId: "reader",
    now,
    leaseUntil: now + 30_000,
    limit: 2,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  assert.deepEqual(
    first.value.claims.map((claim) => (claim as { claimId: string }).claimId),
    ["event-a", "event-b"],
  );
  assert.equal(first.value.nextCursor, "event-b");

  const second = await persistence.claimPage({
    claimantId: "reader",
    now,
    leaseUntil: now + 30_000,
    limit: 2,
    cursor: first.value.nextCursor,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok) return;
  assert.deepEqual(
    second.value.claims.map((claim) => (claim as { claimId: string }).claimId),
    ["event-c", "event-d"],
  );
  assert.equal(
    (second.value.claims[1] as { record: unknown }).record,
    undefined,
  );
  assert.equal(second.value.nextCursor, undefined);
  assert.deepEqual(
    second.value.claims.map((claim) => (claim as { fence: number }).fence),
    [2, 1],
  );
  const corruptClaim = second.value.claims[1] as {
    claimId: string;
    fence: number;
  };
  assert.deepEqual(
    await persistence.quarantine({
      claimId: corruptClaim.claimId,
      claimantId: "reader",
      fence: corruptClaim.fence,
      reason: "record-invalid",
    }),
    { ok: true, value: undefined },
  );
  const removed = await state.query({
    type: "record",
    collection: "automation.triggers.events",
    key: "event-d",
  });
  assert.deepEqual(removed, {
    ok: true,
    value: { type: "record", record: null },
  });
  const quarantine = await state.query({
    type: "record",
    collection: "automation.triggers.quarantine",
    key: "event-d",
  });
  assert.equal(quarantine.ok, true);
  if (quarantine.ok && quarantine.value.type === "record") {
    assert.deepEqual(quarantine.value.record?.metadata, {
      schemaVersion: 1,
      reason: "record-invalid",
      quarantinedAt: now,
    });
  }
});

test("attempt receipts are idempotent, per binding, replayable, and fenced", async () => {
  let now = 2_000;
  const state = createMemoryStateStore({ now: () => now });
  const persistence = createStateStoreTriggerPersistence(state, {
    now: () => now,
  });
  const stored = await persistence.store({
    record: durableRecord,
    claimantId: "runtime-1",
    now,
    leaseUntil: now + 100,
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const firstAttempt = {
    claimId: stored.value.claimId,
    claimantId: "runtime-1",
    fence: stored.value.fence,
    attemptId: "attempt-1",
    bindingKey: "c".repeat(64),
    bindingGeneration: 1,
  };

  assert.deepEqual(await persistence.beginAttempt(firstAttempt), {
    ok: true,
    value: "started",
  });
  assert.deepEqual(await persistence.beginAttempt(firstAttempt), {
    ok: true,
    value: "started",
  });
  const secondAttempt = { ...firstAttempt, attemptId: "attempt-2" };
  assert.deepEqual(await persistence.beginAttempt(secondAttempt), {
    ok: true,
    value: "ambiguous",
  });
  assert.deepEqual(
    await persistence.completeAttempt({ ...firstAttempt, status: "failed" }),
    { ok: true, value: undefined },
  );
  assert.deepEqual(await persistence.beginAttempt(secondAttempt), {
    ok: true,
    value: "started",
  });
  assert.deepEqual(
    await persistence.completeAttempt({
      ...secondAttempt,
      status: "delivered",
    }),
    { ok: true, value: undefined },
  );
  assert.deepEqual(
    await persistence.beginAttempt({
      ...secondAttempt,
      attemptId: "attempt-3",
      bindingGeneration: 2,
    }),
    { ok: true, value: "already-delivered" },
  );

  const otherBinding = {
    ...firstAttempt,
    attemptId: "attempt-other",
    bindingKey: "d".repeat(64),
  };
  assert.deepEqual(await persistence.beginAttempt(otherBinding), {
    ok: true,
    value: "started",
  });
  assert.deepEqual(
    await persistence.completeAttempt({
      ...otherBinding,
      status: "timed-out",
    }),
    { ok: true, value: undefined },
  );
  const replayedOtherBinding = {
    ...otherBinding,
    attemptId: "attempt-other-replay",
  };
  assert.deepEqual(await persistence.beginAttempt(replayedOtherBinding), {
    ok: true,
    value: "started",
  });

  now += 101;
  const reclaimed = await persistence.claimPage({
    claimantId: "runtime-2",
    now,
    leaseUntil: now + 100,
    limit: 1,
  });
  assert.equal(reclaimed.ok, true);
  if (!reclaimed.ok) return;
  assert.equal((reclaimed.value.claims[0] as { fence: number }).fence, 2);

  for (const stale of [
    persistence.completeAttempt({
      ...replayedOtherBinding,
      status: "timed-out",
    }),
    persistence.releaseClaim(firstAttempt),
    persistence.quarantine({ ...firstAttempt, reason: "record-invalid" }),
  ]) {
    const result = await stale;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "FENCE_REJECTED");
      assert.equal(result.error.retryable, false);
    }
  }
});

test("retention targets trigger records at 30 days and receipts at 24 hours", async () => {
  const day = 24 * 60 * 60 * 1_000;
  let now = 0;
  const state = createMemoryStateStore({ now: () => now });
  const persistence = createStateStoreTriggerPersistence(state, {
    now: () => now,
  });
  const unrelated = {
    transactionId: "unrelated.receipt",
    operations: [
      {
        type: "put-record" as const,
        collection: "unrelated.records",
        key: "keep",
        metadata: { keep: true },
        expectedVersion: null,
      },
      {
        type: "append-event" as const,
        stream: "unrelated.events",
        eventId: "unrelated-event",
        eventType: "keep",
        metadata: { keep: true },
      },
    ],
  };
  assert.equal((await state.transact(unrelated)).ok, true);
  const stored = await persistence.store({
    record: { ...durableRecord, occurredAt: now },
    claimantId: "runtime-retention",
    now,
    leaseUntil: 1,
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  assert.equal(
    (
      await persistence.releaseClaim({
        claimId: stored.value.claimId,
        claimantId: "runtime-retention",
        fence: stored.value.fence,
      })
    ).ok,
    true,
  );

  now = day + 1;
  await persistence.claimPage({
    claimantId: "maintenance-1",
    now,
    leaseUntil: now + 1,
    limit: 1,
  });
  const afterReceiptRetention = await state.diagnose();
  assert.equal(afterReceiptRetention.ok, true);
  if (!afterReceiptRetention.ok) return;
  assert.equal(afterReceiptRetention.value.counts.transactions, 2);
  const unrelatedReplay = await state.transact(unrelated);
  assert.equal(unrelatedReplay.ok, true);
  if (unrelatedReplay.ok) assert.equal(unrelatedReplay.value.replayed, true);

  now = 30 * day + 1;
  await persistence.claimPage({
    claimantId: "maintenance-2",
    now,
    leaseUntil: now + 1,
    limit: 1,
  });
  const snapshot = await state.export({ format: "snapshot" });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.deepEqual(
    snapshot.value.snapshot.records.map(({ collection, key }) => ({
      collection,
      key,
    })),
    [{ collection: "unrelated.records", key: "keep" }],
  );
  assert.deepEqual(
    snapshot.value.snapshot.events.map(({ stream, eventId }) => ({
      stream,
      eventId,
    })),
    [{ stream: "unrelated.events", eventId: "unrelated-event" }],
  );
});

test("bounded transaction retries preserve begin and completion ambiguity", async () => {
  const now = 3_000;
  const state = createMemoryStateStore({ now: () => now });
  let droppedBeginAcks = 1;
  let droppedCompleteAcks = 0;
  const transactionIds: string[] = [];
  const lossyState = {
    async transact(transaction) {
      transactionIds.push(transaction.transactionId);
      const committed = await state.transact(transaction);
      const shouldDrop =
        (transaction.transactionId.startsWith("trigger-persistence.begin:") &&
          droppedBeginAcks-- > 0) ||
        (transaction.transactionId.startsWith(
          "trigger-persistence.complete:",
        ) &&
          droppedCompleteAcks-- > 0);
      return shouldDrop && committed.ok
        ? {
            ok: false as const,
            error: {
              code: "STORAGE_FAILED" as const,
              message: "Fixture dropped commit acknowledgement.",
              retryable: true,
            },
          }
        : committed;
    },
    query: state.query.bind(state),
    compact: state.compact.bind(state),
    export: state.export.bind(state),
    diagnose: state.diagnose.bind(state),
  } satisfies StateStore;
  const lossy = createStateStoreTriggerPersistence(lossyState, {
    now: () => now,
    maxRetries: 3,
  });
  const direct = createStateStoreTriggerPersistence(state, { now: () => now });
  const stored = await lossy.store({
    record: durableRecord,
    claimantId: "runtime-lossy",
    now,
    leaseUntil: now + 30_000,
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const attempt = {
    claimId: stored.value.claimId,
    claimantId: "runtime-lossy",
    fence: stored.value.fence,
    attemptId: "lossy-attempt-1",
    bindingKey: "e".repeat(64),
    bindingGeneration: 1,
  };

  assert.deepEqual(await lossy.beginAttempt(attempt), {
    ok: true,
    value: "started",
  });
  const retriedBeginIds = transactionIds.filter((id) =>
    id.startsWith("trigger-persistence.begin:"),
  );
  assert.equal(retriedBeginIds.length, 2);
  assert.equal(new Set(retriedBeginIds).size, 1);
  assert.equal(
    transactionIds.every((id) => id.length <= 512),
    true,
  );

  droppedCompleteAcks = 3;
  const unacknowledged = await lossy.completeAttempt({
    ...attempt,
    status: "delivered",
  });
  assert.equal(unacknowledged.ok, false);
  if (!unacknowledged.ok) assert.equal(unacknowledged.error.retryable, true);
  assert.deepEqual(
    await direct.beginAttempt({ ...attempt, attemptId: "lossy-attempt-2" }),
    { ok: true, value: "already-delivered" },
  );

  const otherStored = await direct.store({
    record: { ...durableRecord, eventId: "event-pending-ambiguity" },
    claimantId: "runtime-lossy",
    now,
    leaseUntil: now + 30_000,
  });
  assert.equal(otherStored.ok, true);
  if (!otherStored.ok) return;
  droppedBeginAcks = 3;
  const pending = {
    ...attempt,
    claimId: otherStored.value.claimId,
    fence: otherStored.value.fence,
    attemptId: "pending-attempt-1",
  };
  const pendingAck = await lossy.beginAttempt(pending);
  assert.equal(pendingAck.ok, false);
  assert.deepEqual(await direct.beginAttempt(pending), {
    ok: true,
    value: "started",
  });
  assert.deepEqual(
    await direct.beginAttempt({ ...pending, attemptId: "pending-attempt-2" }),
    { ok: true, value: "ambiguous" },
  );
});

test("idempotent begin rechecks receipt when completion wins the race", async () => {
  const now = 3_500;
  const state = createMemoryStateStore({ now: () => now });
  const direct = createStateStoreTriggerPersistence(state, { now: () => now });
  const stored = await direct.store({
    record: durableRecord,
    claimantId: "runtime-race",
    now,
    leaseUntil: now + 30_000,
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const attempt = {
    claimId: stored.value.claimId,
    claimantId: "runtime-race",
    fence: stored.value.fence,
    attemptId: "racing-attempt",
    bindingKey: "f".repeat(64),
    bindingGeneration: 1,
  };
  assert.equal((await direct.beginAttempt(attempt)).ok, true);

  let enterBegin!: () => void;
  let releaseBegin!: () => void;
  const beginEntered = new Promise<void>((resolve) => (enterBegin = resolve));
  const beginGate = new Promise<void>((resolve) => (releaseBegin = resolve));
  let paused = false;
  const racingState = {
    async transact(transaction) {
      if (
        !paused &&
        transaction.transactionId.startsWith("trigger-persistence.begin:")
      ) {
        paused = true;
        enterBegin();
        await beginGate;
      }
      return state.transact(transaction);
    },
    query: state.query.bind(state),
    compact: state.compact.bind(state),
    export: state.export.bind(state),
    diagnose: state.diagnose.bind(state),
  } satisfies StateStore;
  const racing = createStateStoreTriggerPersistence(racingState, {
    now: () => now,
  });
  const begun = racing.beginAttempt(attempt);
  await beginEntered;
  assert.deepEqual(
    await direct.completeAttempt({ ...attempt, status: "delivered" }),
    { ok: true, value: undefined },
  );
  releaseBegin();
  assert.deepEqual(await begun, {
    ok: true,
    value: "already-delivered",
  });
});

test("two SQLite processes claim once and recover a crashed claimant after lease expiry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-trigger-persistence-"));
  const path = join(directory, "state.sqlite");
  try {
    const opened = createSqliteStateStore({ path, now: () => 0 });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    if (!opened.ok) return;
    const state = opened.value;
    const persistence = createStateStoreTriggerPersistence(state, {
      now: () => 0,
    });
    const seeded = await persistence.store({
      record: durableRecord,
      claimantId: "seed-runtime",
      now: 0,
      leaseUntil: 1,
    });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));

    const raced = await Promise.all([
      claimInProcess(path, "worker-a", 2),
      claimInProcess(path, "worker-b", 2),
    ]);
    const claims = raced.flatMap((result) => {
      if (
        !result ||
        typeof result !== "object" ||
        !("ok" in result) ||
        result.ok !== true ||
        !("value" in result) ||
        !result.value ||
        typeof result.value !== "object" ||
        !("claims" in result.value) ||
        !Array.isArray(result.value.claims)
      ) {
        assert.fail(JSON.stringify(result));
      }
      return result.value.claims as Array<{ claimId: string; fence: number }>;
    });
    assert.deepEqual(claims, [
      { claimId: durableRecord.eventId, fence: 2, record: durableRecord },
    ]);

    const beforeExpiry = await claimInProcess(path, "worker-c", 1_001);
    assert.deepEqual(beforeExpiry, {
      ok: true,
      value: { claims: [] },
    });
    const afterExpiry = await claimInProcess(path, "worker-c", 1_003);
    assert.equal(
      (
        afterExpiry as {
          ok: true;
          value: { claims: Array<{ fence: number }> };
        }
      ).value.claims[0]?.fence,
      3,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TriggerEngine restart acknowledges SQLite receipts with exact safe payload persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-trigger-engine-state-"));
  const path = join(directory, "state.sqlite");
  const payload = { body: "restart-safe-payload" };
  const clock = { now: () => 4_000 };
  let deliveries = 0;
  try {
    const firstOpened = createSqliteStateStore({ path, now: clock.now });
    assert.equal(firstOpened.ok, true, JSON.stringify(firstOpened));
    if (!firstOpened.ok) return;
    const first = createTriggerEngine({
      hostId: "host-first",
      clock,
      createEventId: () => "engine-durable-event",
      persistence: createStateStoreTriggerPersistence(firstOpened.value, {
        now: clock.now,
      }),
    });
    const firstSource = first.bindSource({
      kind: "fixture",
      id: "source",
      projectId: "project",
      trust: "managed",
    });
    assert.equal(firstSource.ok, true);
    if (!firstSource.ok) return;
    assert.equal(
      (
        await first.engine.reconcile({
          ownerId: "owner",
          generation: 1,
          bindings: [
            {
              id: "binding",
              eventTypes: ["fixture.event"],
              deliver: () => void deliveries++,
            },
          ],
        })
      ).ok,
      true,
    );
    const published = await firstSource.value.publish({
      type: "fixture.event",
      payload,
      durability: "restart-only",
    });
    assert.equal(published.ok, true);
    assert.equal(deliveries, 1);
    await first.close();

    const secondOpened = createSqliteStateStore({ path, now: clock.now });
    assert.equal(secondOpened.ok, true, JSON.stringify(secondOpened));
    if (!secondOpened.ok) return;
    const second = createTriggerEngine({
      hostId: "host-second",
      clock,
      persistence: createStateStoreTriggerPersistence(secondOpened.value, {
        now: clock.now,
      }),
    });
    const secondSource = second.bindSource({
      kind: "fixture",
      id: "source",
      projectId: "project",
      trust: "managed",
    });
    assert.equal(secondSource.ok, true);
    const replayed = await second.engine.reconcile({
      ownerId: "owner",
      generation: 1,
      bindings: [
        {
          id: "binding",
          eventTypes: ["fixture.event"],
          deliver: () => void deliveries++,
        },
      ],
    });
    assert.equal(replayed.ok, true, JSON.stringify(replayed));
    assert.equal(deliveries, 1);
    await second.close();

    assert.equal(
      [path, `${path}-wal`, `${path}-shm`]
        .filter(existsSync)
        .some((candidate) =>
          readFileSync(candidate).includes(
            Buffer.from(JSON.stringify(payload)),
          ),
        ),
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TriggerEngine quarantines corrupt StateStore trigger metadata", async () => {
  const now = 5_000;
  const state = createMemoryStateStore({ now: () => now });
  const injected = await state.transact({
    transactionId: "fixture.inject-corrupt-trigger",
    operations: [
      {
        type: "put-record",
        collection: "automation.triggers.events",
        key: "engine-corrupt-event",
        metadata: { schemaVersion: 1, unexpected: "metadata" },
        expectedVersion: null,
      },
    ],
  });
  assert.equal(injected.ok, true);
  const runtime = createTriggerEngine({
    hostId: "host-corrupt",
    clock: { now: () => now },
    persistence: createStateStoreTriggerPersistence(state, { now: () => now }),
  });
  const reconciled = await runtime.engine.reconcile({
    ownerId: "owner",
    generation: 1,
    bindings: [],
  });
  assert.deepEqual(reconciled, {
    ok: true,
    value: {
      ownerId: "owner",
      generation: 1,
      bindingCount: 0,
      replay: {
        claimed: 1,
        delivered: 0,
        ambiguous: 0,
        quarantined: 1,
        state: "degraded",
      },
    },
  });
  const removed = await state.query({
    type: "record",
    collection: "automation.triggers.events",
    key: "engine-corrupt-event",
  });
  assert.deepEqual(removed, {
    ok: true,
    value: { type: "record", record: null },
  });
  await runtime.close();
});
