import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { failure, success, type JsonObject } from "../result.ts";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_COMPACT_MAX_LIMIT,
  DEFAULT_METADATA_MAX_BYTES,
  DEFAULT_QUERY_MAX_LIMIT,
  DEFAULT_SNAPSHOT_MAX_ENTRIES,
  DEFAULT_TRANSACTION_MAX_BYTES,
  DEFAULT_TRANSACTION_MAX_OPERATIONS,
  isPositiveSafeInteger,
  isValidExpectedVersion,
  type StateCompactRequest,
  type StateEvent,
  type StateExportRequest,
  type StateLease,
  type StateMutation,
  type StateQuery,
  type StateRecord,
  type StateStore,
  type StateStoreError,
  type StateStoreErrorCode,
  type StateStoreOptions,
  type StateStoreResult,
  type StateTransaction,
  type StateTransactionResult,
} from "./state-store.ts";
import { canonicalJson, canonicalStateTransaction } from "./json.ts";

export interface SqliteStateStoreOptions extends StateStoreOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
}

type SqliteRow = Record<string, null | number | bigint | string | Uint8Array>;

function stateFailure(
  code: StateStoreErrorCode,
  message: string,
  retryable = false,
  details?: JsonObject,
): StateStoreResult<never> {
  const error: StateStoreError = { code, message, retryable, details };
  return failure(error);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function storageFailure(error: unknown) {
  const message = errorMessage(error);
  return stateFailure("STORAGE_FAILED", message, /busy|locked/i.test(message));
}

function validName(value: string) {
  return value.length > 0 && value.length <= 512 && !value.includes("\u0000");
}

function validateMetadata(metadata: JsonObject, maxBytes: number) {
  let serialized: string;
  try {
    serialized = canonicalJson(metadata);
  } catch {
    return stateFailure(
      "INVALID_REQUEST",
      "Metadata must be JSON-compatible plain data",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return stateFailure(
      "METADATA_TOO_LARGE",
      `Metadata exceeds ${maxBytes} byte limit`,
      false,
      { maxMetadataBytes: maxBytes },
    );
  }
  return success(serialized);
}

function validateTransaction(
  transaction: StateTransaction,
  maxMetadataBytes: number,
  maxOperations: number,
  maxTransactionBytes: number,
) {
  if (!validName(transaction.transactionId)) {
    return stateFailure(
      "INVALID_REQUEST",
      "Transaction ID must be 1 to 512 characters",
    );
  }
  if (transaction.operations.length > maxOperations) {
    return stateFailure(
      "TRANSACTION_TOO_LARGE",
      `Transaction exceeds ${maxOperations} operation limit`,
    );
  }
  for (const operation of transaction.operations) {
    if (
      !operation ||
      typeof operation !== "object" ||
      ![
        "check-record",
        "put-record",
        "delete-record",
        "append-event",
        "delete-event",
        "claim-lease",
        "renew-lease",
        "release-lease",
      ].includes((operation as { type?: string }).type ?? "")
    ) {
      return stateFailure("INVALID_REQUEST", "Unknown state mutation type");
    }
    const names =
      operation.type === "check-record" ||
      operation.type === "put-record" ||
      operation.type === "delete-record"
        ? [operation.collection, operation.key]
        : operation.type === "append-event"
          ? [operation.stream, operation.eventId, operation.eventType]
          : operation.type === "delete-event"
            ? [operation.stream, operation.eventId]
            : [operation.resource, operation.owner];
    if (!names.every(validName)) {
      return stateFailure(
        "INVALID_REQUEST",
        "State identifiers must be 1 to 512 characters",
      );
    }
    if (
      (operation.type === "check-record" &&
        !isPositiveSafeInteger(operation.expectedVersion)) ||
      ((operation.type === "put-record" ||
        operation.type === "delete-record") &&
        !isValidExpectedVersion(operation.expectedVersion))
    ) {
      return stateFailure(
        "INVALID_REQUEST",
        "Expected record version must be null or a positive safe integer",
      );
    }
    if (
      (operation.type === "renew-lease" ||
        operation.type === "release-lease") &&
      !isPositiveSafeInteger(operation.fence)
    ) {
      return stateFailure(
        "INVALID_REQUEST",
        "Lease fence must be a positive safe integer",
      );
    }
    if (
      (operation.type === "claim-lease" || operation.type === "renew-lease") &&
      !isPositiveSafeInteger(operation.ttlMs)
    ) {
      return stateFailure(
        "INVALID_REQUEST",
        "Lease TTL must be a positive safe integer",
      );
    }
    if ("metadata" in operation && operation.metadata !== undefined) {
      const checked = validateMetadata(operation.metadata, maxMetadataBytes);
      if (!checked.ok) return checked;
    }
  }
  try {
    const request = canonicalStateTransaction(transaction);
    if (Buffer.byteLength(request, "utf8") > maxTransactionBytes) {
      return stateFailure(
        "TRANSACTION_TOO_LARGE",
        `Transaction exceeds ${maxTransactionBytes} byte limit`,
      );
    }
    return success(request);
  } catch {
    return stateFailure(
      "INVALID_REQUEST",
      "Transaction must be JSON-compatible plain data",
    );
  }
}

function numberColumn(row: SqliteRow | undefined, key: string) {
  const value = row?.[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`Expected numeric SQLite column ${key}`);
}

function textColumn(row: SqliteRow | undefined, key: string) {
  const value = row?.[key];
  if (typeof value === "string") return value;
  throw new TypeError(`Expected text SQLite column ${key}`);
}

function nullableTextColumn(row: SqliteRow | undefined, key: string) {
  const value = row?.[key];
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new TypeError(`Expected nullable text SQLite column ${key}`);
}

function parseMetadata(row: SqliteRow, key = "metadata_json") {
  const value = JSON.parse(textColumn(row, key)) as unknown;
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected JSON object in SQLite column ${key}`);
  }
  return value as JsonObject;
}

function parseTransactionResult(
  text: string,
  expectedTransactionId: string,
): StateTransactionResult {
  const value = JSON.parse(text) as unknown;
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Stored transaction receipt is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.transactionId !== expectedTransactionId ||
    candidate.replayed !== false ||
    !Number.isSafeInteger(candidate.committedAt) ||
    !Array.isArray(candidate.records) ||
    !Array.isArray(candidate.deletedRecords) ||
    !Array.isArray(candidate.events) ||
    !Array.isArray(candidate.leases)
  ) {
    throw new TypeError("Stored transaction receipt failed validation");
  }
  return candidate as unknown as StateTransactionResult;
}

function readRecord(row: SqliteRow): StateRecord {
  return {
    collection: textColumn(row, "collection"),
    key: textColumn(row, "record_key"),
    metadata: parseMetadata(row),
    version: numberColumn(row, "version"),
    updatedAt: numberColumn(row, "updated_at"),
  };
}

function readEvent(row: SqliteRow): StateEvent {
  return {
    sequence: numberColumn(row, "sequence"),
    stream: textColumn(row, "stream"),
    position: numberColumn(row, "position"),
    eventId: textColumn(row, "event_id"),
    eventType: textColumn(row, "event_type"),
    metadata: parseMetadata(row),
    occurredAt: numberColumn(row, "occurred_at"),
  };
}

function readLease(row: SqliteRow): StateLease {
  return {
    resource: textColumn(row, "resource"),
    owner: nullableTextColumn(row, "owner"),
    fence: numberColumn(row, "fence"),
    expiresAt: numberColumn(row, "expires_at"),
    metadata: parseMetadata(row),
  };
}

function canonicalFileCandidate(path: string) {
  const candidate = resolve(realpathSync.native(dirname(path)), basename(path));
  return process.platform === "win32" ? candidate.toLowerCase() : candidate;
}

const SQLITE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

function sqliteFileFamily(path: string) {
  return SQLITE_FILE_SUFFIXES.map((suffix) => `${path}${suffix}`);
}

function sameFileIdentity(left: string, right: string) {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sqliteFileFamiliesCollide(left: string, right: string) {
  return sqliteFileFamily(left).some((leftCandidate) =>
    sqliteFileFamily(right).some(
      (rightCandidate) =>
        canonicalFileCandidate(leftCandidate) ===
          canonicalFileCandidate(rightCandidate) ||
        sameFileIdentity(leftCandidate, rightCandidate),
    ),
  );
}

function fileEntryExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sqliteFileFamilyExists(path: string) {
  return sqliteFileFamily(path).some(fileEntryExists);
}

function promoteTemporarySqliteBackup(temporary: string, destination: string) {
  if (sqliteFileFamilyExists(destination)) return false;
  try {
    linkSync(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  if (sqliteFileFamily(destination).slice(1).some(fileEntryExists)) {
    unlinkSync(destination);
    return false;
  }
  unlinkSync(temporary);
  return true;
}

function removeTemporarySqliteBackup(directory: string, path: string) {
  for (const candidate of sqliteFileFamily(path)) {
    rmSync(candidate, { force: true });
  }
  rmdirSync(directory);
}

function verifySqliteBackup(path: string) {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    const rows = database
      .prepare("PRAGMA integrity_check")
      .all() as SqliteRow[];
    if (
      rows.length !== 1 ||
      textColumn(rows[0], "integrity_check").toLowerCase() !== "ok"
    ) {
      throw new Error("SQLite backup integrity verification failed");
    }
    const schemaVersion = numberColumn(
      database.prepare("PRAGMA user_version").get() as SqliteRow,
      "user_version",
    );
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `SQLite backup schema verification failed: expected ${CURRENT_SCHEMA_VERSION}, got ${schemaVersion}`,
      );
    }
  } finally {
    database.close();
  }
}

function secureFiles(path: string) {
  if (process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(candidate, 0o600);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
}

function openDatabase(path: string, busyTimeoutMs: number) {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = NORMAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        record_key TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (collection, record_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        UNIQUE (stream, position)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS leases (
        resource TEXT PRIMARY KEY,
        owner TEXT,
        fence INTEGER NOT NULL CHECK (fence > 0),
        expires_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_stream_position
        ON events (stream, position);
      CREATE INDEX IF NOT EXISTS events_occurred_at
        ON events (occurred_at);
      CREATE INDEX IF NOT EXISTS transactions_committed_at
        ON transactions (committed_at);
      CREATE INDEX IF NOT EXISTS records_collection_key
        ON records (collection, record_key);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS stream_heads (
        stream TEXT PRIMARY KEY,
        last_position INTEGER NOT NULL CHECK (last_position > 0)
      ) STRICT;
      INSERT INTO stream_heads (stream, last_position)
        SELECT stream, MAX(position) FROM events GROUP BY stream
        ON CONFLICT (stream) DO UPDATE SET
          last_position = MAX(last_position, excluded.last_position);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS event_ids (
        event_id TEXT PRIMARY KEY
      ) STRICT;
      INSERT OR IGNORE INTO event_ids (event_id)
        SELECT event_id FROM events;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS record_heads (
        collection TEXT NOT NULL,
        record_key TEXT NOT NULL,
        last_version INTEGER NOT NULL CHECK (last_version > 0),
        PRIMARY KEY (collection, record_key)
      ) STRICT;
      INSERT INTO record_heads (collection, record_key, last_version)
        SELECT collection, record_key, version FROM records WHERE 1
        ON CONFLICT (collection, record_key) DO UPDATE SET
          last_version = MAX(last_version, excluded.last_version);
    `,
  },
] as const;

function migrate(database: DatabaseSync) {
  const current = numberColumn(
    database.prepare("PRAGMA user_version").get() as SqliteRow | undefined,
    "user_version",
  );
  if (current > CURRENT_SCHEMA_VERSION) {
    return stateFailure(
      "SCHEMA_TOO_NEW",
      `Database schema ${current} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    try {
      database.exec("BEGIN IMMEDIATE");
      const lockedVersion = numberColumn(
        database.prepare("PRAGMA user_version").get() as SqliteRow,
        "user_version",
      );
      if (lockedVersion > CURRENT_SCHEMA_VERSION) {
        database.exec("ROLLBACK");
        return stateFailure(
          "SCHEMA_TOO_NEW",
          `Database schema ${lockedVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
        );
      }
      if (lockedVersion >= migration.version) {
        database.exec("COMMIT");
        continue;
      }
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      return stateFailure(
        "MIGRATION_FAILED",
        `Schema migration ${migration.version} failed: ${errorMessage(error)}`,
        /busy|locked/i.test(errorMessage(error)),
      );
    }
  }
  return success(undefined);
}

function applyMutation(
  database: DatabaseSync,
  operation: StateMutation,
  now: number,
  result: {
    records: StateRecord[];
    deletedRecords: { collection: string; key: string; version: number }[];
    events: StateEvent[];
    leases: StateLease[];
  },
): StateStoreResult<undefined> {
  if (operation.type === "check-record") {
    const row = database
      .prepare(
        "SELECT version FROM records WHERE collection = ? AND record_key = ?",
      )
      .get(operation.collection, operation.key) as SqliteRow | undefined;
    const actualVersion = row ? numberColumn(row, "version") : null;
    if (actualVersion !== operation.expectedVersion) {
      return stateFailure(
        "VERSION_CONFLICT",
        "Record version does not match",
        true,
        {
          collection: operation.collection,
          key: operation.key,
          actualVersion,
        },
      );
    }
    return success(undefined);
  }

  if (operation.type === "put-record") {
    const row = database
      .prepare(
        "SELECT collection, record_key, metadata_json, version, updated_at FROM records WHERE collection = ? AND record_key = ?",
      )
      .get(operation.collection, operation.key) as SqliteRow | undefined;
    const existing = row ? readRecord(row) : undefined;
    const head = database
      .prepare(
        "SELECT last_version FROM record_heads WHERE collection = ? AND record_key = ?",
      )
      .get(operation.collection, operation.key) as SqliteRow | undefined;
    if (
      (operation.expectedVersion === null && existing !== undefined) ||
      (typeof operation.expectedVersion === "number" &&
        existing?.version !== operation.expectedVersion)
    ) {
      return stateFailure(
        "VERSION_CONFLICT",
        "Record version does not match",
        true,
        {
          collection: operation.collection,
          key: operation.key,
          actualVersion: existing?.version ?? null,
        },
      );
    }
    const record: StateRecord = {
      collection: operation.collection,
      key: operation.key,
      metadata: structuredClone(operation.metadata),
      version: (head ? numberColumn(head, "last_version") : 0) + 1,
      updatedAt: now,
    };
    database
      .prepare(
        `INSERT INTO records (collection, record_key, metadata_json, version, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (collection, record_key) DO UPDATE SET
           metadata_json = excluded.metadata_json,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.collection,
        record.key,
        canonicalJson(record.metadata),
        record.version,
        record.updatedAt,
      );
    database
      .prepare(
        `INSERT INTO record_heads (collection, record_key, last_version)
         VALUES (?, ?, ?)
         ON CONFLICT (collection, record_key) DO UPDATE SET
           last_version = excluded.last_version`,
      )
      .run(record.collection, record.key, record.version);
    result.records.push(record);
    return success(undefined);
  }

  if (operation.type === "delete-record") {
    const row = database
      .prepare(
        "SELECT collection, record_key, metadata_json, version, updated_at FROM records WHERE collection = ? AND record_key = ?",
      )
      .get(operation.collection, operation.key) as SqliteRow | undefined;
    const existing = row ? readRecord(row) : undefined;
    if (
      !existing ||
      (operation.expectedVersion !== undefined &&
        existing.version !== operation.expectedVersion)
    ) {
      return stateFailure(
        "VERSION_CONFLICT",
        "Record version does not match",
        true,
        {
          collection: operation.collection,
          key: operation.key,
          actualVersion: existing?.version ?? null,
        },
      );
    }
    database
      .prepare("DELETE FROM records WHERE collection = ? AND record_key = ?")
      .run(operation.collection, operation.key);
    const deletedVersion = existing.version + 1;
    database
      .prepare(
        `INSERT INTO record_heads (collection, record_key, last_version)
         VALUES (?, ?, ?)
         ON CONFLICT (collection, record_key) DO UPDATE SET
           last_version = excluded.last_version`,
      )
      .run(existing.collection, existing.key, deletedVersion);
    result.deletedRecords.push({
      collection: existing.collection,
      key: existing.key,
      version: deletedVersion,
    });
    return success(undefined);
  }

  if (operation.type === "append-event") {
    const duplicate = database
      .prepare("SELECT event_id FROM event_ids WHERE event_id = ?")
      .get(operation.eventId);
    if (duplicate) {
      return stateFailure("EVENT_CONFLICT", "Event ID already exists", false, {
        eventId: operation.eventId,
      });
    }
    const head = database
      .prepare("SELECT last_position FROM stream_heads WHERE stream = ?")
      .get(operation.stream) as SqliteRow | undefined;
    const position = (head ? numberColumn(head, "last_position") : 0) + 1;
    const inserted = database
      .prepare(
        `INSERT INTO events (stream, position, event_id, event_type, metadata_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.stream,
        position,
        operation.eventId,
        operation.eventType,
        canonicalJson(operation.metadata),
        now,
      );
    database
      .prepare(
        `INSERT INTO stream_heads (stream, last_position) VALUES (?, ?)
         ON CONFLICT (stream) DO UPDATE SET last_position = excluded.last_position`,
      )
      .run(operation.stream, position);
    database
      .prepare("INSERT INTO event_ids (event_id) VALUES (?)")
      .run(operation.eventId);
    const event: StateEvent = {
      sequence: Number(inserted.lastInsertRowid),
      stream: operation.stream,
      position,
      eventId: operation.eventId,
      eventType: operation.eventType,
      metadata: structuredClone(operation.metadata),
      occurredAt: now,
    };
    result.events.push(event);
    return success(undefined);
  }

  if (operation.type === "delete-event") {
    database
      .prepare("DELETE FROM events WHERE stream = ? AND event_id = ?")
      .run(operation.stream, operation.eventId);
    return success(undefined);
  }

  const row = database
    .prepare(
      "SELECT resource, owner, fence, expires_at, metadata_json FROM leases WHERE resource = ?",
    )
    .get(operation.resource) as SqliteRow | undefined;
  const current = row ? readLease(row) : undefined;

  if (operation.type === "claim-lease") {
    if (current && current.owner !== null && current.expiresAt > now) {
      return stateFailure(
        "LEASE_HELD",
        "Lease is held by another transaction",
        true,
        {
          resource: operation.resource,
          owner: current.owner,
          expiresAt: current.expiresAt,
        },
      );
    }
    const lease: StateLease = {
      resource: operation.resource,
      owner: operation.owner,
      fence: (current?.fence ?? 0) + 1,
      expiresAt: now + operation.ttlMs,
      metadata: structuredClone(operation.metadata ?? {}),
    };
    database
      .prepare(
        `INSERT INTO leases (resource, owner, fence, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (resource) DO UPDATE SET
           owner = excluded.owner,
           fence = excluded.fence,
           expires_at = excluded.expires_at,
           metadata_json = excluded.metadata_json`,
      )
      .run(
        lease.resource,
        lease.owner,
        lease.fence,
        lease.expiresAt,
        canonicalJson(lease.metadata),
      );
    result.leases.push(lease);
    return success(undefined);
  }

  if (
    !current ||
    current.owner !== operation.owner ||
    current.fence !== operation.fence ||
    current.expiresAt <= now
  ) {
    return stateFailure(
      "LEASE_LOST",
      "Lease ownership or fence is stale",
      false,
      {
        resource: operation.resource,
        fence: operation.fence,
      },
    );
  }

  if (operation.type === "renew-lease") {
    const lease: StateLease = {
      ...current,
      expiresAt: now + operation.ttlMs,
      metadata: structuredClone(operation.metadata ?? current.metadata),
    };
    database
      .prepare(
        "UPDATE leases SET expires_at = ?, metadata_json = ? WHERE resource = ?",
      )
      .run(lease.expiresAt, canonicalJson(lease.metadata), lease.resource);
    result.leases.push(lease);
    return success(undefined);
  }

  const released: StateLease = { ...current, owner: null, expiresAt: now };
  database
    .prepare(
      "UPDATE leases SET owner = NULL, expires_at = ? WHERE resource = ?",
    )
    .run(now, released.resource);
  result.leases.push(released);
  return success(undefined);
}

function createAdapter(
  path: string,
  busyTimeoutMs: number,
  maxMetadataBytes: number,
  maxTransactionBytes: number,
  maxTransactionOperations: number,
  maxQueryLimit: number,
  maxSnapshotEntries: number,
  now: () => number,
): StateStore {
  return {
    withBusyTimeout(nextBusyTimeoutMs) {
      if (!Number.isSafeInteger(nextBusyTimeoutMs) || nextBusyTimeoutMs < 0) {
        throw new TypeError("Busy timeout must be a non-negative integer");
      }
      return createAdapter(
        path,
        nextBusyTimeoutMs,
        maxMetadataBytes,
        maxTransactionBytes,
        maxTransactionOperations,
        maxQueryLimit,
        maxSnapshotEntries,
        now,
      );
    },
    async transact(transaction) {
      const valid = validateTransaction(
        transaction,
        maxMetadataBytes,
        maxTransactionOperations,
        maxTransactionBytes,
      );
      if (!valid.ok) return valid;
      let database: DatabaseSync | undefined;
      let transactionOpen = false;
      try {
        database = openDatabase(path, busyTimeoutMs);
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        const request = valid.value;
        const receipt = database
          .prepare(
            "SELECT request_json, result_json FROM transactions WHERE transaction_id = ?",
          )
          .get(transaction.transactionId) as SqliteRow | undefined;
        if (receipt) {
          if (textColumn(receipt, "request_json") !== request) {
            database.exec("ROLLBACK");
            transactionOpen = false;
            return stateFailure(
              "TRANSACTION_CONFLICT",
              "Transaction ID was already used for different operations",
            );
          }
          const stored = parseTransactionResult(
            textColumn(receipt, "result_json"),
            transaction.transactionId,
          );
          database.exec("COMMIT");
          transactionOpen = false;
          return success({ ...stored, replayed: true });
        }

        const committedAt = Math.floor(now());
        const mutable = {
          records: [] as StateRecord[],
          deletedRecords: [] as {
            collection: string;
            key: string;
            version: number;
          }[],
          events: [] as StateEvent[],
          leases: [] as StateLease[],
        };
        for (const operation of transaction.operations) {
          const applied = applyMutation(
            database,
            operation,
            committedAt,
            mutable,
          );
          if (!applied.ok) {
            database.exec("ROLLBACK");
            transactionOpen = false;
            return applied;
          }
        }
        const result: StateTransactionResult = {
          transactionId: transaction.transactionId,
          replayed: false,
          committedAt,
          ...mutable,
        };
        const serializedResult = canonicalJson(result);
        if (Buffer.byteLength(serializedResult, "utf8") > maxTransactionBytes) {
          database.exec("ROLLBACK");
          transactionOpen = false;
          return stateFailure(
            "TRANSACTION_TOO_LARGE",
            `Transaction result exceeds ${maxTransactionBytes} byte limit`,
          );
        }
        database
          .prepare(
            "INSERT INTO transactions (transaction_id, request_json, result_json, committed_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            transaction.transactionId,
            request,
            serializedResult,
            committedAt,
          );
        database.exec("COMMIT");
        transactionOpen = false;
        return success(result);
      } catch (error) {
        if (transactionOpen && database) {
          try {
            database.exec("ROLLBACK");
          } catch {}
        }
        return storageFailure(error);
      } finally {
        database?.close();
        secureFiles(path);
      }
    },

    async query(query: StateQuery) {
      if (
        (query.type === "record" &&
          ![query.collection, query.key].every(validName)) ||
        (query.type === "records" && !validName(query.collection)) ||
        (query.type === "events" && !validName(query.stream)) ||
        (query.type === "lease" && !validName(query.resource))
      ) {
        return stateFailure(
          "INVALID_REQUEST",
          "State identifiers must be 1 to 512 characters",
        );
      }
      let database: DatabaseSync | undefined;
      try {
        database = openDatabase(path, busyTimeoutMs);
        if (query.type === "record") {
          const row = database
            .prepare(
              "SELECT collection, record_key, metadata_json, version, updated_at FROM records WHERE collection = ? AND record_key = ?",
            )
            .get(query.collection, query.key) as SqliteRow | undefined;
          return success({
            type: "record" as const,
            record: row ? readRecord(row) : null,
          });
        }
        if (query.type === "records") {
          const limit = query.limit ?? 100;
          if (
            !Number.isSafeInteger(limit) ||
            limit <= 0 ||
            limit > maxQueryLimit
          ) {
            return stateFailure(
              "INVALID_REQUEST",
              `Query limit must be between 1 and ${maxQueryLimit}`,
            );
          }
          const rows = database
            .prepare(
              `SELECT collection, record_key, metadata_json, version, updated_at
               FROM records
               WHERE collection = ?
                 AND (? IS NULL OR record_key > ?)
                 AND (? IS NULL OR substr(record_key, 1, ?) = ?)
               ORDER BY record_key LIMIT ?`,
            )
            .all(
              query.collection,
              query.afterKey ?? null,
              query.afterKey ?? null,
              query.keyPrefix ?? null,
              query.keyPrefix?.length ?? null,
              query.keyPrefix ?? null,
              limit,
            );
          return success({
            type: "records" as const,
            records: (rows as SqliteRow[]).map(readRecord),
          });
        }
        if (query.type === "events") {
          const limit = query.limit ?? 100;
          if (
            !Number.isSafeInteger(limit) ||
            limit <= 0 ||
            limit > maxQueryLimit
          ) {
            return stateFailure(
              "INVALID_REQUEST",
              `Query limit must be between 1 and ${maxQueryLimit}`,
            );
          }
          const rows = database
            .prepare(
              `SELECT sequence, stream, position, event_id, event_type, metadata_json, occurred_at
               FROM events WHERE stream = ? AND position > ? ORDER BY position LIMIT ?`,
            )
            .all(query.stream, query.afterPosition ?? 0, limit) as SqliteRow[];
          return success({
            type: "events" as const,
            events: rows.map(readEvent),
          });
        }
        const row = database
          .prepare(
            "SELECT resource, owner, fence, expires_at, metadata_json FROM leases WHERE resource = ?",
          )
          .get(query.resource) as SqliteRow | undefined;
        return success({
          type: "lease" as const,
          lease: row ? readLease(row) : null,
        });
      } catch (error) {
        return storageFailure(error);
      } finally {
        database?.close();
        secureFiles(path);
      }
    },

    async compact(request: StateCompactRequest = {}) {
      for (const threshold of [
        request.eventsBefore,
        request.eventIdsBefore,
        request.transactionsBefore,
      ]) {
        if (threshold !== undefined && !Number.isSafeInteger(threshold)) {
          return stateFailure(
            "INVALID_REQUEST",
            "Compaction thresholds must be safe integers",
          );
        }
      }
      if (
        request.limit !== undefined &&
        (!isPositiveSafeInteger(request.limit) ||
          request.limit > DEFAULT_COMPACT_MAX_LIMIT)
      ) {
        return stateFailure(
          "INVALID_REQUEST",
          `Compaction limit must be between 1 and ${DEFAULT_COMPACT_MAX_LIMIT}`,
        );
      }
      if (
        request.eventIds !== undefined &&
        request.eventIdsBefore === undefined
      ) {
        return stateFailure(
          "INVALID_REQUEST",
          "Event ID compaction requires a tombstone cutoff",
        );
      }
      for (const identifiers of [
        request.eventIds,
        request.recordHeadCollections,
      ]) {
        if (
          identifiers !== undefined &&
          (!Array.isArray(identifiers) ||
            identifiers.length > DEFAULT_COMPACT_MAX_LIMIT ||
            !identifiers.every(
              (identifier) =>
                typeof identifier === "string" && validName(identifier),
            ))
        ) {
          return stateFailure(
            "INVALID_REQUEST",
            `Compaction identifiers must contain at most ${DEFAULT_COMPACT_MAX_LIMIT} valid names`,
          );
        }
      }
      const compactLimit =
        request.limit ??
        (request.eventIdsBefore !== undefined ||
        request.recordHeadCollections !== undefined
          ? DEFAULT_COMPACT_MAX_LIMIT
          : undefined);
      let database: DatabaseSync | undefined;
      let transactionOpen = false;
      try {
        database = openDatabase(path, busyTimeoutMs);
        database.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        let deletedEventIds = 0;
        let deletedEvents = 0;
        if (request.eventIdsBefore !== undefined) {
          if (request.eventIds === undefined || request.eventIds.length > 0) {
            const hasEventIds = request.eventIds !== undefined;
            const placeholders = hasEventIds
              ? request.eventIds!.map(() => "?").join(", ")
              : "";
            const eventIdFilter = hasEventIds
              ? ` AND event_id IN (${placeholders})`
              : "";
            const limit = compactLimit ?? DEFAULT_COMPACT_MAX_LIMIT;
            deletedEventIds = Number(
              database
                .prepare(
                  `DELETE FROM event_ids WHERE event_id IN (
                     SELECT event_id FROM events
                     WHERE occurred_at < ?${eventIdFilter}
                     ORDER BY sequence LIMIT ?
                   )`,
                )
                .run(request.eventIdsBefore, ...(request.eventIds ?? []), limit)
                .changes,
            );
            deletedEvents = Number(
              database
                .prepare(
                  `DELETE FROM events WHERE sequence IN (
                     SELECT sequence FROM events
                     WHERE occurred_at < ?${eventIdFilter}
                     ORDER BY sequence LIMIT ?
                   )`,
                )
                .run(request.eventIdsBefore, ...(request.eventIds ?? []), limit)
                .changes,
            );
          }
        }
        if (request.eventsBefore !== undefined) {
          if (compactLimit === undefined) {
            deletedEvents += Number(
              database
                .prepare("DELETE FROM events WHERE occurred_at < ?")
                .run(request.eventsBefore).changes,
            );
          } else {
            deletedEvents += Number(
              database
                .prepare(
                  `DELETE FROM events WHERE sequence IN (
                     SELECT sequence FROM events WHERE occurred_at < ?
                     ORDER BY sequence LIMIT ?
                   )`,
                )
                .run(request.eventsBefore, compactLimit).changes,
            );
          }
        }

        let deletedRecordHeads = 0;
        if (
          request.recordHeadCollections !== undefined &&
          request.recordHeadCollections.length > 0
        ) {
          const placeholders = request.recordHeadCollections
            .map(() => "?")
            .join(", ");
          deletedRecordHeads = Number(
            database
              .prepare(
                `DELETE FROM record_heads WHERE rowid IN (
                   SELECT heads.rowid FROM record_heads heads
                   WHERE heads.collection IN (${placeholders})
                     AND NOT EXISTS (
                       SELECT 1 FROM records
                       WHERE records.collection = heads.collection
                         AND records.record_key = heads.record_key
                     )
                   ORDER BY heads.collection, heads.record_key LIMIT ?
                 )`,
              )
              .run(
                ...request.recordHeadCollections,
                compactLimit ?? DEFAULT_COMPACT_MAX_LIMIT,
              ).changes,
          );
        }
        const deletedTransactions =
          request.transactionsBefore === undefined
            ? 0
            : compactLimit === undefined
              ? Number(
                  database
                    .prepare("DELETE FROM transactions WHERE committed_at < ?")
                    .run(request.transactionsBefore).changes,
                )
              : Number(
                  database
                    .prepare(
                      `DELETE FROM transactions WHERE transaction_id IN (
                       SELECT transaction_id FROM transactions
                       WHERE committed_at < ?
                       ORDER BY committed_at, transaction_id LIMIT ?
                     )`,
                    )
                    .run(request.transactionsBefore, compactLimit).changes,
                );
        database.exec("COMMIT");
        transactionOpen = false;
        database.exec("PRAGMA wal_checkpoint(PASSIVE)");
        return success({
          deletedEvents,
          deletedTransactions,
          ...(request.eventIdsBefore === undefined ? {} : { deletedEventIds }),
          ...(request.recordHeadCollections === undefined
            ? {}
            : { deletedRecordHeads }),
        });
      } catch (error) {
        if (transactionOpen && database) {
          try {
            database.exec("ROLLBACK");
          } catch {}
        }
        return storageFailure(error);
      } finally {
        database?.close();
        secureFiles(path);
      }
    },

    async export(request: StateExportRequest) {
      let database: DatabaseSync | undefined;
      let snapshotOpen = false;
      try {
        database = openDatabase(path, busyTimeoutMs);
        if (request.format === "sqlite-backup") {
          const destination = resolve(request.destination);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          if (sqliteFileFamiliesCollide(destination, path)) {
            return stateFailure(
              "INVALID_REQUEST",
              "Backup destination and sidecars must differ from store files",
            );
          }
          if (sqliteFileFamilyExists(destination)) {
            return stateFailure(
              "INVALID_REQUEST",
              "Backup destination and sidecars must not already exist",
            );
          }
          const temporaryDirectory = mkdtempSync(
            join(dirname(destination), `.${basename(destination)}.backup-`),
          );
          const temporaryDestination = join(
            temporaryDirectory,
            basename(destination),
          );
          try {
            // Let Windows release handles from a just-closed backup before promotion.
            await new Promise((resolve) => setImmediate(resolve));
            const pages = await backup(database, temporaryDestination);
            verifySqliteBackup(temporaryDestination);
            if (process.platform !== "win32") {
              chmodSync(temporaryDestination, 0o600);
            }
            if (
              !promoteTemporarySqliteBackup(temporaryDestination, destination)
            ) {
              return stateFailure(
                "INVALID_REQUEST",
                "Backup destination and sidecars must not already exist",
              );
            }
            return success({
              format: "sqlite-backup" as const,
              destination,
              pages,
            });
          } finally {
            removeTemporarySqliteBackup(
              temporaryDirectory,
              temporaryDestination,
            );
          }
        }
        database.exec("BEGIN");
        snapshotOpen = true;
        const entryCount = numberColumn(
          database
            .prepare(
              `SELECT
                (SELECT COUNT(*) FROM records) +
                (SELECT COUNT(*) FROM events) +
                (SELECT COUNT(*) FROM leases) AS count`,
            )
            .get() as SqliteRow,
          "count",
        );
        if (entryCount > maxSnapshotEntries) {
          database.exec("ROLLBACK");
          snapshotOpen = false;
          return stateFailure(
            "EXPORT_TOO_LARGE",
            `Snapshot exceeds ${maxSnapshotEntries} entry limit`,
          );
        }
        const records = database
          .prepare(
            "SELECT collection, record_key, metadata_json, version, updated_at FROM records ORDER BY collection, record_key",
          )
          .all() as SqliteRow[];
        const events = database
          .prepare(
            "SELECT sequence, stream, position, event_id, event_type, metadata_json, occurred_at FROM events ORDER BY sequence",
          )
          .all() as SqliteRow[];
        const leases = database
          .prepare(
            "SELECT resource, owner, fence, expires_at, metadata_json FROM leases ORDER BY resource",
          )
          .all() as SqliteRow[];
        database.exec("COMMIT");
        snapshotOpen = false;
        return success({
          format: "snapshot" as const,
          snapshot: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            exportedAt: Math.floor(now()),
            records: records.map(readRecord),
            events: events.map(readEvent),
            leases: leases.map(readLease),
          },
        });
      } catch (error) {
        if (snapshotOpen && database) {
          try {
            database.exec("ROLLBACK");
          } catch {}
        }
        return storageFailure(error);
      } finally {
        database?.close();
        secureFiles(path);
      }
    },

    async diagnose() {
      let database: DatabaseSync | undefined;
      try {
        database = openDatabase(path, busyTimeoutMs);
        const integrityRows = database
          .prepare("PRAGMA integrity_check")
          .all() as SqliteRow[];
        const issues = integrityRows
          .map((row) => textColumn(row, "integrity_check"))
          .filter((issue) => issue !== "ok");
        for (const table of ["records", "events", "leases"] as const) {
          const rows = database
            .prepare(
              `SELECT metadata_json FROM ${table} LIMIT ${maxSnapshotEntries + 1}`,
            )
            .all() as SqliteRow[];
          if (rows.length > maxSnapshotEntries) {
            issues.push(`${table} metadata scan exceeded diagnostic limit`);
            continue;
          }
          for (const row of rows) {
            try {
              parseMetadata(row);
            } catch (error) {
              issues.push(`${table}: ${errorMessage(error)}`);
            }
          }
        }
        const recordRows = database
          .prepare(
            `SELECT r.collection, r.record_key, r.version, h.last_version
             FROM records r
             LEFT JOIN record_heads h
               ON h.collection = r.collection AND h.record_key = r.record_key
             LIMIT ${maxSnapshotEntries + 1}`,
          )
          .all() as SqliteRow[];
        for (const row of recordRows) {
          const collection = textColumn(row, "collection");
          const key = textColumn(row, "record_key");
          const version = numberColumn(row, "version");
          const head =
            row.last_version === null
              ? undefined
              : numberColumn(row, "last_version");
          if (!validName(collection) || !validName(key)) {
            issues.push("records: invalid identifier");
          }
          if (!Number.isSafeInteger(version) || !head || head < version) {
            issues.push(
              `records: invalid version head for ${collection}/${key}`,
            );
          }
        }
        const eventRows = database
          .prepare(
            `SELECT e.stream, e.event_id, e.event_type, e.position, h.last_position
             FROM events e
             LEFT JOIN stream_heads h ON h.stream = e.stream
             LIMIT ${maxSnapshotEntries + 1}`,
          )
          .all() as SqliteRow[];
        for (const row of eventRows) {
          const stream = textColumn(row, "stream");
          const eventId = textColumn(row, "event_id");
          const eventType = textColumn(row, "event_type");
          const position = numberColumn(row, "position");
          const head =
            row.last_position === null
              ? undefined
              : numberColumn(row, "last_position");
          if (![stream, eventId, eventType].every(validName)) {
            issues.push("events: invalid identifier");
          }
          if (!Number.isSafeInteger(position) || !head || head < position) {
            issues.push(`events: invalid stream head for ${stream}`);
          }
        }
        const leaseRows = database
          .prepare(
            `SELECT resource, owner, fence, expires_at FROM leases
             LIMIT ${maxSnapshotEntries + 1}`,
          )
          .all() as SqliteRow[];
        for (const row of leaseRows) {
          const resource = textColumn(row, "resource");
          const owner = nullableTextColumn(row, "owner");
          const fence = numberColumn(row, "fence");
          const expiresAt = numberColumn(row, "expires_at");
          if (
            !validName(resource) ||
            (owner !== null && !validName(owner)) ||
            !Number.isSafeInteger(fence) ||
            fence <= 0 ||
            !Number.isSafeInteger(expiresAt)
          ) {
            issues.push(`leases: invalid invariant for ${resource}`);
          }
        }
        const receipts = database
          .prepare(
            `SELECT transaction_id, result_json FROM transactions LIMIT ${maxSnapshotEntries + 1}`,
          )
          .all() as SqliteRow[];
        if (receipts.length > maxSnapshotEntries) {
          issues.push("transaction receipt scan exceeded diagnostic limit");
        } else {
          for (const receipt of receipts) {
            try {
              parseTransactionResult(
                textColumn(receipt, "result_json"),
                textColumn(receipt, "transaction_id"),
              );
            } catch (error) {
              issues.push(`transactions: ${errorMessage(error)}`);
            }
          }
        }
        const journal = textColumn(
          database.prepare("PRAGMA journal_mode").get() as SqliteRow,
          "journal_mode",
        ).toLowerCase();
        const count = (table: string) =>
          numberColumn(
            database!
              .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
              .get() as SqliteRow,
            "count",
          );
        return success({
          adapter: "node:sqlite" as const,
          schemaVersion: numberColumn(
            database.prepare("PRAGMA user_version").get() as SqliteRow,
            "user_version",
          ),
          integrity:
            issues.length === 0 ? ("ok" as const) : ("corrupt" as const),
          journalMode:
            journal === "wal" ? ("wal" as const) : ("unknown" as const),
          counts: {
            records: count("records"),
            events: count("events"),
            leases: count("leases"),
            transactions: count("transactions"),
          },
          issues,
          ...(process.platform === "win32"
            ? {}
            : { fileMode: statSync(path).mode & 0o777 }),
        });
      } catch (error) {
        return success({
          adapter: "node:sqlite" as const,
          schemaVersion: 0,
          integrity: "corrupt" as const,
          journalMode: "unknown" as const,
          counts: { records: 0, events: 0, leases: 0, transactions: 0 },
          issues: [errorMessage(error)],
          ...(process.platform === "win32" || !statSafe(path)
            ? {}
            : { fileMode: statSync(path).mode & 0o777 }),
        });
      } finally {
        database?.close();
        secureFiles(path);
      }
    },
  };
}

function statSafe(path: string) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function createSqliteStateStore(options: SqliteStateStoreOptions) {
  if (!options.path) {
    return stateFailure("INVALID_REQUEST", "SQLite store path is required");
  }
  const path = resolve(options.path);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const maxMetadataBytes =
    options.maxMetadataBytes ?? DEFAULT_METADATA_MAX_BYTES;
  const maxTransactionBytes =
    options.maxTransactionBytes ?? DEFAULT_TRANSACTION_MAX_BYTES;
  const maxTransactionOperations =
    options.maxTransactionOperations ?? DEFAULT_TRANSACTION_MAX_OPERATIONS;
  const maxQueryLimit = options.maxQueryLimit ?? DEFAULT_QUERY_MAX_LIMIT;
  const maxSnapshotEntries =
    options.maxSnapshotEntries ?? DEFAULT_SNAPSHOT_MAX_ENTRIES;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    return stateFailure(
      "INVALID_REQUEST",
      "Busy timeout must be a non-negative integer",
    );
  }
  for (const [name, value] of Object.entries({
    maxMetadataBytes,
    maxTransactionBytes,
    maxTransactionOperations,
    maxQueryLimit,
    maxSnapshotEntries,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return stateFailure(
        "INVALID_REQUEST",
        `${name} must be a positive safe integer`,
      );
    }
  }

  let database: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    database = openDatabase(path, busyTimeoutMs);
    const migrated = migrate(database);
    if (!migrated.ok) return migrated;
    database.exec("PRAGMA journal_mode = WAL");
    database.close();
    database = undefined;
    secureFiles(path);
    return success(
      createAdapter(
        path,
        busyTimeoutMs,
        maxMetadataBytes,
        maxTransactionBytes,
        maxTransactionOperations,
        maxQueryLimit,
        maxSnapshotEntries,
        options.now ?? Date.now,
      ),
    );
  } catch (error) {
    return storageFailure(error);
  } finally {
    database?.close();
    secureFiles(path);
  }
}
