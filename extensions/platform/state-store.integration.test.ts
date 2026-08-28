import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_SCHEMA_VERSION,
  createMemoryStateStore,
  createSqliteStateStore,
  type StateStore,
} from "./src/core/persistence/index.ts";

function opened(result: ReturnType<typeof createSqliteStateStore>) {
  if (!result.ok) assert.fail(result.error.message);
  return result.value as StateStore;
}

async function contentionWorker() {
  const path = process.env.PI_STATE_STORE_PATH;
  const barrier = process.env.PI_STATE_STORE_BARRIER;
  const ready = process.env.PI_STATE_STORE_READY;
  const owner = process.env.PI_STATE_STORE_OWNER;
  if (!path || !barrier || !ready || !owner) process.exit(2);

  let created = createSqliteStateStore({ path, busyTimeoutMs: 5_000 });
  for (
    let attempt = 0;
    !created.ok && created.error.retryable && attempt < 20;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    created = createSqliteStateStore({ path, busyTimeoutMs: 5_000 });
  }
  if (!created.ok) {
    process.stdout.write(
      JSON.stringify({ ok: false, code: created.error.code }),
    );
    return;
  }

  writeFileSync(ready, owner, "utf8");
  while (!existsSync(barrier)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const result = await created.value.transact({
    transactionId: `tx-contention-${owner}`,
    operations: [
      {
        type: "claim-lease",
        resource: "contended-resource",
        owner,
        ttlMs: 60_000,
      },
    ],
  });
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      code: result.ok ? undefined : result.error.code,
    }),
  );
}

const isContentionWorker = process.env.PI_STATE_STORE_CONTENTION_WORKER === "1";
if (isContentionWorker) {
  await contentionWorker();
} else {
  test("node:sqlite migrates a fresh store, enables WAL, and persists across adapters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-store-"));
    const path = join(directory, "state.sqlite");
    try {
      const first = opened(createSqliteStateStore({ path, now: () => 100 }));
      const committed = await first.transact({
        transactionId: "tx-persist",
        operations: [
          {
            type: "put-record",
            collection: "runs",
            key: "run-1",
            metadata: { status: "ready" },
          },
        ],
      });
      assert.equal(committed.ok, true);

      const second = opened(createSqliteStateStore({ path }));
      const queried = await second.query({
        type: "record",
        collection: "runs",
        key: "run-1",
      });
      assert.equal(queried.ok, true);
      if (queried.ok && queried.value.type === "record") {
        assert.deepEqual(queried.value.record?.metadata, { status: "ready" });
      }

      const diagnostics = await second.diagnose();
      assert.equal(diagnostics.ok, true);
      if (diagnostics.ok) {
        assert.equal(diagnostics.value.schemaVersion, CURRENT_SCHEMA_VERSION);
        assert.equal(diagnostics.value.journalMode, "wal");
        assert.equal(diagnostics.value.integrity, "ok");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("node:sqlite preserves transaction idempotency and fenced stale-lease recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-contract-"));
    const path = join(directory, "state.sqlite");
    let now = 1_000;
    try {
      const store = opened(
        createSqliteStateStore({ path, maxMetadataBytes: 32, now: () => now }),
      );
      const transaction = {
        transactionId: "tx-once",
        operations: [
          {
            type: "append-event" as const,
            stream: "run-1",
            eventId: "event-once",
            eventType: "run.started",
            metadata: {},
          },
          {
            type: "claim-lease" as const,
            resource: "run-1",
            owner: "worker-old",
            ttlMs: 10,
          },
        ],
      };
      const first = await store.transact(transaction);
      const replay = await store.transact(transaction);
      assert.equal(first.ok && first.value.replayed, false);
      assert.equal(replay.ok && replay.value.replayed, true);

      now = 1_011;
      const recovered = await store.transact({
        transactionId: "tx-recover",
        operations: [
          {
            type: "claim-lease",
            resource: "run-1",
            owner: "worker-new",
            ttlMs: 10,
          },
        ],
      });
      assert.equal(recovered.ok && recovered.value.leases[0]?.fence, 2);

      const tooLarge = await store.transact({
        transactionId: "tx-large",
        operations: [
          {
            type: "put-record",
            collection: "runs",
            key: "large",
            metadata: { value: "x".repeat(32) },
          },
        ],
      });
      assert.equal(tooLarge.ok, false);
      if (!tooLarge.ok) assert.equal(tooLarge.error.code, "METADATA_TOO_LARGE");

      const events = await store.query({ type: "events", stream: "run-1" });
      assert.equal(events.ok, true);
      if (events.ok && events.value.type === "events") {
        assert.equal(events.value.events.length, 1);
      }

      await store.compact({ eventsBefore: 2_000 });
      const afterCompaction = await store.transact({
        transactionId: "tx-after-compaction",
        operations: [
          {
            type: "append-event",
            stream: "run-1",
            eventId: "event-after-compaction",
            eventType: "run.resumed",
            metadata: {},
          },
        ],
      });
      assert.equal(
        afterCompaction.ok && afterCompaction.value.events[0]?.position,
        2,
      );
      const duplicateCompactedEvent = await store.transact({
        transactionId: "tx-duplicate-compacted-event",
        operations: [
          {
            type: "append-event",
            stream: "run-1",
            eventId: "event-once",
            eventType: "run.repeated",
            metadata: {},
          },
        ],
      });
      assert.equal(duplicateCompactedEvent.ok, false);
      if (!duplicateCompactedEvent.ok) {
        assert.equal(duplicateCompactedEvent.error.code, "EVENT_CONFLICT");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("node:sqlite targeted compaction removes sensitive receipts and disposable tombstones", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-compact-"));
    const path = join(directory, "state.sqlite");
    let now = 1;
    try {
      const store = opened(createSqliteStateStore({ path, now: () => now }));
      const created = await store.transact({
        transactionId: "tx-native-compact-create",
        operations: [
          {
            type: "put-record",
            collection: "session-broker.messages",
            key: "retired-message",
            metadata: { summary: "sensitive-retired-summary" },
          },
          {
            type: "put-record",
            collection: "generic-records",
            key: "preserved-head",
            metadata: {},
          },
          {
            type: "append-event",
            stream: "mailbox",
            eventId: "native-retired-event",
            eventType: "mailbox.message",
            metadata: {},
          },
          {
            type: "append-event",
            stream: "mailbox",
            eventId: "native-pending-event",
            eventType: "mailbox.message",
            metadata: {},
          },
        ],
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;

      now = 2;
      const removed = await store.transact({
        transactionId: "tx-native-compact-remove",
        operations: [
          {
            type: "delete-record",
            collection: "session-broker.messages",
            key: "retired-message",
            expectedVersion: 1,
          },
          {
            type: "delete-record",
            collection: "generic-records",
            key: "preserved-head",
            expectedVersion: 1,
          },
        ],
      });
      assert.equal(removed.ok, true);

      const compacted = await store.compact({
        eventIdsBefore: 2,
        eventIds: ["native-retired-event"],
        recordHeadCollections: ["session-broker.messages"],
        transactionsBefore: 2,
        transactionIdPrefixes: ["tx-native-compact-"],
        limit: 100,
      });
      assert.deepEqual(compacted, {
        ok: true,
        value: {
          deletedEvents: 1,
          deletedTransactions: 1,
          deletedEventIds: 1,
          deletedRecordHeads: 1,
        },
      });

      const database = new DatabaseSync(path);
      try {
        const count = (table: string, where = "") =>
          Number(
            (
              database
                .prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
                .get() as { count: number }
            ).count,
          );
        assert.equal(
          count(
            "transactions",
            "WHERE result_json LIKE '%sensitive-retired-summary%'",
          ),
          0,
        );
        assert.equal(
          count("event_ids", "WHERE event_id = 'native-retired-event'"),
          0,
        );
        assert.equal(
          count("event_ids", "WHERE event_id = 'native-pending-event'"),
          1,
        );
        assert.equal(
          count(
            "record_heads",
            "WHERE collection = 'session-broker.messages' AND record_key = 'retired-message'",
          ),
          0,
        );
        assert.equal(
          count(
            "record_heads",
            "WHERE collection = 'generic-records' AND record_key = 'preserved-head'",
          ),
          1,
        );
      } finally {
        database.close();
      }

      const recreated = await store.transact({
        transactionId: "tx-native-compact-recreate",
        operations: [
          {
            type: "put-record",
            collection: "session-broker.messages",
            key: "retired-message",
            metadata: {},
            expectedVersion: null,
          },
          {
            type: "put-record",
            collection: "generic-records",
            key: "preserved-head",
            metadata: {},
            expectedVersion: null,
          },
        ],
      });
      assert.equal(recreated.ok, true);
      if (recreated.ok) {
        assert.deepEqual(
          recreated.value.records.map(({ version }) => version),
          [1, 3],
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("node:sqlite transaction compaction honors explicit ID prefixes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-receipts-"));
    const path = join(directory, "state.sqlite");
    let now = 1;
    try {
      const store = opened(createSqliteStateStore({ path, now: () => now }));
      for (const transactionId of [
        "session-broker.send:old",
        "session-broker.heartbeat:old",
        "workspace.cleanup:old",
      ]) {
        const committed = await store.transact({
          transactionId,
          operations: [],
        });
        assert.equal(committed.ok, true);
      }

      now = 2;
      const compacted = await store.compact({
        transactionsBefore: 2,
        transactionIdPrefixes: ["session-broker."],
      });
      assert.equal(compacted.ok, true);
      if (compacted.ok) assert.equal(compacted.value.deletedTransactions, 2);

      const database = new DatabaseSync(path);
      try {
        const transactionIds = database
          .prepare(
            "SELECT transaction_id FROM transactions ORDER BY transaction_id",
          )
          .all()
          .map((row) => (row as { transaction_id: string }).transaction_id);
        assert.deepEqual(transactionIds, ["workspace.cleanup:old"]);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("node:sqlite runtime validation rejects unknown mutations and invalid compaction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-validation-"));
    const path = join(directory, "state.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      const unknown = await store.transact({
        transactionId: "tx-unknown",
        operations: [{ type: "future-mutation" }],
      } as unknown as Parameters<StateStore["transact"]>[0]);
      assert.equal(unknown.ok, false);
      if (!unknown.ok) assert.equal(unknown.error.code, "INVALID_REQUEST");
      const compacted = await store.compact({ eventsBefore: Number.NaN });
      assert.equal(compacted.ok, false);
      if (!compacted.ok) assert.equal(compacted.error.code, "INVALID_REQUEST");
      const unsafeTransactions = await store.compact({
        transactionsBefore: 1,
      });
      assert.equal(unsafeTransactions.ok, false);
      if (!unsafeTransactions.ok) {
        assert.equal(unsafeTransactions.error.code, "INVALID_REQUEST");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const adapter of ["memory", "node:sqlite"] as const) {
    test(`${adapter} rejects malformed record versions and lease fences`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-state-validation-"));
      const store =
        adapter === "memory"
          ? createMemoryStateStore()
          : opened(
              createSqliteStateStore({ path: join(directory, "state.sqlite") }),
            );
      const malformedValues: unknown[] = [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        "1",
        true,
        {},
      ];

      try {
        for (const [index, malformed] of malformedValues.entries()) {
          for (const operation of [
            {
              type: "put-record",
              collection: "records",
              key: `put-${index}`,
              metadata: {},
              expectedVersion: malformed,
            },
            {
              type: "delete-record",
              collection: "records",
              key: `delete-${index}`,
              expectedVersion: malformed,
            },
            {
              type: "renew-lease",
              resource: "lease",
              owner: "worker",
              fence: malformed,
              ttlMs: 1_000,
            },
            {
              type: "release-lease",
              resource: "lease",
              owner: "worker",
              fence: malformed,
            },
          ]) {
            const result = await store.transact({
              transactionId: `tx-${adapter}-${operation.type}-${index}`,
              operations: [operation],
            } as unknown as Parameters<StateStore["transact"]>[0]);
            assert.equal(result.ok, false, `${operation.type}: ${malformed}`);
            if (!result.ok) {
              assert.equal(
                result.error.code,
                "INVALID_REQUEST",
                `${operation.type}: ${malformed}`,
              );
            }
          }
        }
        for (const [index, malformed] of [null, undefined].entries()) {
          for (const type of ["renew-lease", "release-lease"] as const) {
            const result = await store.transact({
              transactionId: `tx-${adapter}-${type}-empty-${index}`,
              operations: [
                {
                  type,
                  resource: "lease",
                  owner: "worker",
                  fence: malformed,
                  ...(type === "renew-lease" ? { ttlMs: 1_000 } : {}),
                },
              ],
            } as unknown as Parameters<StateStore["transact"]>[0]);
            assert.equal(result.ok, false, `${type}: ${malformed}`);
            if (!result.ok) {
              assert.equal(result.error.code, "INVALID_REQUEST");
            }
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test(`${adapter} accepts null or positive safe expected versions`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-state-version-input-"));
      const store =
        adapter === "memory"
          ? createMemoryStateStore()
          : opened(
              createSqliteStateStore({ path: join(directory, "state.sqlite") }),
            );

      try {
        const created = await store.transact({
          transactionId: `tx-${adapter}-valid-create`,
          operations: [
            {
              type: "put-record",
              collection: "records",
              key: "valid-version",
              metadata: { version: 1 },
              expectedVersion: null,
            },
          ],
        });
        assert.equal(created.ok, true);

        const updated = await store.transact({
          transactionId: `tx-${adapter}-valid-update`,
          operations: [
            {
              type: "put-record",
              collection: "records",
              key: "valid-version",
              metadata: { version: 2 },
              expectedVersion: 1,
            },
          ],
        });
        assert.equal(updated.ok, true);

        const explicitlyUndefined = await store.transact({
          transactionId: `tx-${adapter}-valid-undefined`,
          operations: [
            {
              type: "put-record",
              collection: "records",
              key: "explicit-undefined",
              metadata: {},
              expectedVersion: undefined,
            },
          ],
        });
        assert.equal(explicitlyUndefined.ok, true);

        const deletedWithUndefined = await store.transact({
          transactionId: `tx-${adapter}-valid-undefined-delete`,
          operations: [
            {
              type: "delete-record",
              collection: "records",
              key: "explicit-undefined",
              expectedVersion: undefined,
            },
          ],
        });
        assert.equal(deletedWithUndefined.ok, true);

        const absentDelete = await store.transact({
          transactionId: `tx-${adapter}-valid-null-delete`,
          operations: [
            {
              type: "delete-record",
              collection: "records",
              key: "absent",
              expectedVersion: null,
            },
          ],
        });
        assert.equal(absentDelete.ok, false);
        if (!absentDelete.ok) {
          assert.equal(absentDelete.error.code, "VERSION_CONFLICT");
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("node:sqlite record versions survive delete and recreation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-record-head-"));
    const path = join(directory, "state.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      const created = await store.transact({
        transactionId: "tx-create-record-head",
        operations: [
          {
            type: "put-record",
            collection: "tasks",
            key: "aba",
            metadata: {},
          },
        ],
      });
      assert.equal(created.ok && created.value.records[0]?.version, 1);
      const deleted = await store.transact({
        transactionId: "tx-delete-record-head",
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
        transactionId: "tx-recreate-record-head",
        operations: [
          {
            type: "put-record",
            collection: "tasks",
            key: "aba",
            metadata: {},
            expectedVersion: null,
          },
        ],
      });
      assert.equal(recreated.ok && recreated.value.records[0]?.version, 3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("SQLite backup is consistent and files are restrictive where modes are supported", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-backup-"));
    const path = join(directory, "state.sqlite");
    const destination = join(directory, "backup", "state.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      await store.transact({
        transactionId: "tx-backup",
        operations: [
          {
            type: "put-record",
            collection: "runs",
            key: "run-backup",
            metadata: { status: "complete" },
          },
        ],
      });
      const exported = await store.export({
        format: "sqlite-backup",
        destination,
      });
      assert.equal(exported.ok, true);
      assert.equal(existsSync(destination), true);

      const backup = new DatabaseSync(destination, { readOnly: true });
      try {
        const row = backup
          .prepare(
            "SELECT metadata_json FROM records WHERE collection = ? AND record_key = ?",
          )
          .get("runs", "run-backup") as { metadata_json: string } | undefined;
        assert.deepEqual(JSON.parse(row?.metadata_json ?? "null"), {
          status: "complete",
        });
      } finally {
        backup.close();
      }

      assert.deepEqual(readdirSync(dirname(destination)), ["state.sqlite"]);

      if (process.platform !== "win32") {
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(destination).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("SQLite backup rejects an existing destination family", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-backup-existing-"));
    const path = join(directory, "source.sqlite");
    const destination = join(directory, "destination.sqlite");
    let staleWriter: DatabaseSync | undefined;
    try {
      const store = opened(createSqliteStateStore({ path }));
      const sourceWrite = await store.transact({
        transactionId: "tx-source-backup",
        operations: [
          {
            type: "put-record",
            collection: "runs",
            key: "source",
            metadata: { status: "source" },
          },
        ],
      });
      assert.equal(sourceWrite.ok, true);

      staleWriter = new DatabaseSync(destination);
      staleWriter.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE stale (value TEXT NOT NULL);
        INSERT INTO stale VALUES ('destination');
      `);
      assert.equal(existsSync(destination), true);
      assert.equal(existsSync(`${destination}-wal`), true);
      assert.equal(existsSync(`${destination}-shm`), true);

      const occupied = await store.export({
        format: "sqlite-backup",
        destination,
      });
      assert.equal(occupied.ok, false);
      if (!occupied.ok) assert.equal(occupied.error.code, "INVALID_REQUEST");

      staleWriter.close();
      staleWriter = undefined;
      rmSync(destination, { force: true });
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecarOnlyDestination = join(
          directory,
          `sidecar-only-${suffix.slice(1)}.sqlite`,
        );
        writeFileSync(`${sidecarOnlyDestination}${suffix}`, "stale", "utf8");
        const sidecarOnly = await store.export({
          format: "sqlite-backup",
          destination: sidecarOnlyDestination,
        });
        assert.equal(sidecarOnly.ok, false, suffix);
        if (!sidecarOnly.ok) {
          assert.equal(sidecarOnly.error.code, "INVALID_REQUEST", suffix);
        }
      }
    } finally {
      staleWriter?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    test(`SQLite backup rejects destination=<store>${suffix}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-state-backup-sidecar-"));
      const path = join(directory, "state.sqlite");
      try {
        const store = opened(createSqliteStateStore({ path }));
        const exported = await store.export({
          format: "sqlite-backup",
          destination: `${path}${suffix}`,
        });
        assert.equal(exported.ok, false);
        if (!exported.ok) assert.equal(exported.error.code, "INVALID_REQUEST");

        const diagnostics = await store.diagnose();
        assert.equal(diagnostics.ok && diagnostics.value.integrity, "ok");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test(`SQLite backup rejects when destination${suffix}=<store>`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-state-backup-reverse-"));
      const destination = join(directory, "state.sqlite");
      const path = `${destination}${suffix}`;
      try {
        const store = opened(createSqliteStateStore({ path }));
        const exported = await store.export({
          format: "sqlite-backup",
          destination,
        });
        assert.equal(exported.ok, false);
        if (!exported.ok) assert.equal(exported.error.code, "INVALID_REQUEST");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test("SQLite backup rejects a junction alias of the source database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-backup-alias-"));
    const data = join(directory, "data");
    const alias = join(directory, "alias");
    mkdirSync(data);
    symlinkSync(data, alias, process.platform === "win32" ? "junction" : "dir");
    const path = join(data, "state.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        const exported = await store.export({
          format: "sqlite-backup",
          destination: join(alias, `state.sqlite${suffix}`),
        });
        assert.equal(exported.ok, false, suffix);
        if (!exported.ok) assert.equal(exported.error.code, "INVALID_REQUEST");
      }
    } finally {
      unlinkSync(alias);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("SQLite backup rejects a hard-link alias of the source database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-backup-hardlink-"));
    const path = join(directory, "state.sqlite");
    const alias = join(directory, "state-alias.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      linkSync(path, alias);
      const exported = await store.export({
        format: "sqlite-backup",
        destination: alias,
      });
      assert.equal(exported.ok, false);
      if (!exported.ok) assert.equal(exported.error.code, "INVALID_REQUEST");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("schema version gate rejects a database created by newer code", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-version-"));
    const path = join(directory, "state.sqlite");
    try {
      const database = new DatabaseSync(path);
      database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
      database.close();

      const created = createSqliteStateStore({ path });
      assert.equal(created.ok, false);
      if (!created.ok) assert.equal(created.error.code, "SCHEMA_TOO_NEW");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("integrity diagnostics report logical invariant corruption", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-logical-corrupt-"));
    const path = join(directory, "state.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      const database = new DatabaseSync(path);
      database
        .prepare(
          `INSERT INTO records
           (collection, record_key, metadata_json, version, updated_at)
           VALUES ('', '', '{}', 1, 0)`,
        )
        .run();
      database.close();

      const diagnostics = await store.diagnose();
      assert.equal(diagnostics.ok, true);
      if (diagnostics.ok) {
        assert.equal(diagnostics.value.integrity, "corrupt");
        assert.ok(
          diagnostics.value.issues.some((issue) =>
            issue.includes("invalid identifier"),
          ),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("integrity diagnostics report file corruption without throwing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-state-corrupt-"));
    const path = join(directory, "state.sqlite");
    try {
      const store = opened(createSqliteStateStore({ path }));
      await store.transact({
        transactionId: "tx-before-corruption",
        operations: [
          {
            type: "put-record",
            collection: "runs",
            key: "run-1",
            metadata: {},
          },
        ],
      });
      writeFileSync(path, Buffer.from("not a sqlite database"));

      const diagnostics = await store.diagnose();
      assert.equal(diagnostics.ok, true);
      if (diagnostics.ok) {
        assert.equal(diagnostics.value.integrity, "corrupt");
        assert.ok(diagnostics.value.issues.length > 0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(
    "native Windows subprocess contention grants one cross-process lease",
    { skip: process.platform !== "win32" },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-state-contention-"));
      const path = join(directory, "state.sqlite");
      const barrier = join(directory, "start");
      const workerFile = fileURLToPath(import.meta.url);
      try {
        opened(createSqliteStateStore({ path }));
        const workers = Array.from({ length: 8 }, (_, index) => {
          const ready = join(directory, `ready-${index}`);
          const child = spawn(
            process.execPath,
            ["--experimental-strip-types", workerFile],
            {
              env: {
                ...process.env,
                PI_STATE_STORE_CONTENTION_WORKER: "1",
                PI_STATE_STORE_PATH: path,
                PI_STATE_STORE_BARRIER: barrier,
                PI_STATE_STORE_READY: ready,
                PI_STATE_STORE_OWNER: `worker-${index}`,
              },
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          );
          const completed = new Promise<{
            status: number | null;
            stdout: string;
            stderr: string;
          }>((resolve) => {
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => (stdout += chunk));
            child.stderr.on("data", (chunk: string) => (stderr += chunk));
            child.on("close", (status) => resolve({ status, stdout, stderr }));
          });
          return { ready, completed };
        });

        const readyDeadline = Date.now() + 10_000;
        while (
          workers.some((worker) => !existsSync(worker.ready)) &&
          Date.now() < readyDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          workers.every((worker) => existsSync(worker.ready)),
          true,
          "all native workers reached the contention barrier",
        );
        writeFileSync(barrier, "start", "utf8");

        const completed = await Promise.all(
          workers.map((worker) => worker.completed),
        );
        for (const worker of completed) {
          assert.equal(worker.status, 0, worker.stderr);
        }
        const outcomes = completed.map(
          (worker) =>
            JSON.parse(worker.stdout) as { ok: boolean; code?: string },
        );
        assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
        assert.equal(
          outcomes.filter((outcome) => outcome.code === "LEASE_HELD").length,
          7,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
