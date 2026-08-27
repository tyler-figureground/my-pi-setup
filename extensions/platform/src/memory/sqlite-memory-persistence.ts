import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { success, type Outcome } from "../core/result.ts";
import type { MemoryRecord } from "./model.ts";
import type {
  MemoryIdempotencyReceipt,
  MemoryImportPreview,
  MemoryPersistenceAdapter,
  MemoryPersistenceError,
  MemoryPersistenceResult,
  PersistedMemory,
} from "./memory-persistence.ts";
import { contradictionClaim, isConservativeNearDuplicate } from "./analysis.ts";

const SCHEMA_VERSION = 1;

type SqliteRow = Record<string, unknown>;

export interface SqliteMemoryPersistenceOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly clock?: () => number;
}

function persistenceFailure(
  message: string,
  retryable = false,
): MemoryPersistenceResult<never> {
  return {
    ok: false,
    error: { code: "storage_failed", message, retryable },
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sqliteFailure(error: unknown) {
  const text = errorText(error);
  return persistenceFailure(
    /busy|locked/i.test(text)
      ? "Memory database is busy."
      : "Memory database operation failed.",
    /busy|locked/i.test(text),
  );
}

function text(row: SqliteRow, field: string) {
  const value = row[field];
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${field}`);
  return value;
}

function optionalText(row: SqliteRow, field: string) {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${field}`);
  return value;
}

function number(row: SqliteRow, field: string) {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`Invalid SQLite ${field}`);
  return value;
}

function optionalNumber(row: SqliteRow, field: string) {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`Invalid SQLite ${field}`);
  return value;
}

function parseRecord(value: string) {
  return JSON.parse(value) as MemoryRecord;
}

function scopeKey(scope: MemoryRecord["scope"]) {
  if (scope.kind === "user") return "";
  if (scope.kind === "project") return scope.projectId;
  return `${scope.projectId}\0${scope.workspaceId}`;
}

interface DatabasePathIdentity {
  readonly parent: Stats;
  readonly file?: Stats;
}

function normalizedFileSystemPath(value: string) {
  const normalized = resolve(value).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase()
    : normalized;
}

function sameFileIdentity(left: Stats, right: Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function validateRegularCanonicalFile(candidate: string, volatile = false) {
  const isVolatileWindowsRace = (error: Error & { code?: unknown }) =>
    volatile &&
    process.platform === "win32" &&
    ["EPERM", "EACCES", "EBADF"].includes(String(error.code));
  let entry: Stats;
  try {
    entry = lstatSync(candidate);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || isVolatileWindowsRace(error))
    )
      return undefined;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new Error("Memory database path is not a regular file");
  let canonical: string;
  try {
    canonical = realpathSync.native(candidate);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || isVolatileWindowsRace(error))
    )
      return error.code === "ENOENT" ? undefined : entry;
    throw error;
  }
  const normalizedCanonical = normalizedFileSystemPath(canonical);
  if (
    volatile &&
    process.platform === "win32" &&
    normalizedCanonical.includes("/$extend/$deleted/")
  )
    return undefined;
  if (normalizedCanonical !== normalizedFileSystemPath(candidate))
    throw new Error("Memory database path is not canonical");
  return entry;
}

function validateDatabasePath(path: string, expected?: DatabasePathIdentity) {
  const parentPath = dirname(path);
  const parent = lstatSync(parentPath);
  if (parent.isSymbolicLink() || !parent.isDirectory())
    throw new Error("Memory database parent is not a real private directory");
  if (
    normalizedFileSystemPath(realpathSync.native(parentPath)) !==
    normalizedFileSystemPath(parentPath)
  )
    throw new Error("Memory database parent path is not canonical");
  if (process.platform !== "win32" && (parent.mode & 0o077) !== 0)
    throw new Error("Memory database parent directory is not private");
  const file = validateRegularCanonicalFile(path);
  validateRegularCanonicalFile(`${path}-wal`, true);
  validateRegularCanonicalFile(`${path}-shm`, true);
  if (expected) {
    if (!sameFileIdentity(expected.parent, parent))
      throw new Error("Memory database parent was replaced");
    if (expected.file && (!file || !sameFileIdentity(expected.file, file)))
      throw new Error("Memory database file was replaced");
  }
  return { parent, ...(file ? { file } : {}) };
}

function ensurePrivateDatabaseParent(path: string) {
  const parentPath = dirname(path);
  let existingPath = parentPath;
  for (;;) {
    try {
      const entry = lstatSync(existingPath);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error("Memory database ancestor is not a real directory");
      if (
        normalizedFileSystemPath(realpathSync.native(existingPath)) !==
        normalizedFileSystemPath(existingPath)
      )
        throw new Error("Memory database ancestor path is not canonical");
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      const ancestor = dirname(existingPath);
      if (ancestor === existingPath) throw error;
      existingPath = ancestor;
    }
  }
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  validateDatabasePath(path);
}

function openDatabase(
  path: string,
  busyTimeoutMs: number,
  identity = validateDatabasePath(path),
) {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    validateDatabasePath(path, identity);
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA secure_delete = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function migrate(database: DatabaseSync) {
  const row = database.prepare("PRAGMA user_version").get() as SqliteRow;
  const current = number(row, "user_version");
  if (current > SCHEMA_VERSION)
    throw new Error("Memory database schema is newer than supported.");
  if (current === SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    const locked = number(
      database.prepare("PRAGMA user_version").get() as SqliteRow,
      "user_version",
    );
    if (locked === SCHEMA_VERSION) {
      database.exec("COMMIT");
      return;
    }
    if (locked > SCHEMA_VERSION)
      throw new Error("Memory database schema is newer than supported.");
    database.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        kind_id TEXT NOT NULL,
        kind_version INTEGER NOT NULL CHECK (kind_version > 0),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'project', 'workspace')),
        scope_key TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'review')),
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX memory_exact_active_content
        ON memories (scope_kind, scope_key, kind_id, kind_version, content_digest)
        WHERE status = 'active';
      CREATE INDEX memory_scope_status_updated
        ON memories (scope_kind, scope_key, status, updated_at DESC, id);
      CREATE INDEX memory_expiry ON memories (expires_at) WHERE expires_at IS NOT NULL;

      CREATE TABLE memory_revisions (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        record_json TEXT NOT NULL,
        PRIMARY KEY (memory_id, revision)
      ) STRICT;
      CREATE TABLE memory_citations (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        citation_id TEXT NOT NULL,
        citation_json TEXT NOT NULL,
        PRIMARY KEY (memory_id, citation_id)
      ) STRICT;
      CREATE TABLE memory_relationships (
        source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, kind)
      ) STRICT;
      CREATE INDEX memory_relationship_targets
        ON memory_relationships (target_id, source_id);
      CREATE TABLE memory_receipts (
        request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        memory_id TEXT,
        state TEXT,
        duplicate_of TEXT,
        revision INTEGER,
        forgotten_at INTEGER,
        details_json TEXT
      ) STRICT;
      CREATE TABLE memory_import_previews (
        id TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        preview_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE memory_tombstones (
        memory_id TEXT PRIMARY KEY,
        forgotten_at INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE VIRTUAL TABLE memory_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO memory_fts(memory_fts, rank) VALUES('secure-delete', 1);
    `);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function secureFiles(path: string) {
  if (process.platform === "win32") return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(candidate, 0o600);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
}

function receiptFromRow(row: SqliteRow): MemoryIdempotencyReceipt {
  const operation = text(row, "operation");
  if (
    operation !== "remember" &&
    operation !== "replace" &&
    operation !== "promote" &&
    operation !== "forget" &&
    operation !== "export" &&
    operation !== "preview-import" &&
    operation !== "commit-import"
  )
    throw new Error("Invalid SQLite receipt operation");
  const state = optionalText(row, "state");
  if (
    state !== undefined &&
    state !== "created" &&
    state !== "duplicate" &&
    state !== "review-required"
  )
    throw new Error("Invalid SQLite receipt state");
  const detailsJson = optionalText(row, "details_json");
  return {
    requestId: text(row, "request_id"),
    operation,
    fingerprint: text(row, "fingerprint"),
    ...(optionalText(row, "memory_id")
      ? { memoryId: optionalText(row, "memory_id") }
      : {}),
    ...(state ? { state } : {}),
    ...(optionalText(row, "duplicate_of")
      ? { duplicateOf: optionalText(row, "duplicate_of") }
      : {}),
    ...(optionalNumber(row, "revision") !== undefined
      ? { revision: optionalNumber(row, "revision") }
      : {}),
    ...(optionalNumber(row, "forgotten_at") !== undefined
      ? { forgottenAt: optionalNumber(row, "forgotten_at") }
      : {}),
    ...(detailsJson
      ? {
          details: JSON.parse(
            detailsJson,
          ) as MemoryIdempotencyReceipt["details"],
        }
      : {}),
  };
}

function writeReceipt(
  database: DatabaseSync,
  receipt: MemoryIdempotencyReceipt,
) {
  database
    .prepare(
      `INSERT INTO memory_receipts
        (request_id, operation, fingerprint, memory_id, state, duplicate_of,
         revision, forgotten_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.requestId,
      receipt.operation,
      receipt.fingerprint,
      receipt.memoryId ?? null,
      receipt.state ?? null,
      receipt.duplicateOf ?? null,
      receipt.revision ?? null,
      receipt.forgottenAt ?? null,
      receipt.details ? JSON.stringify(receipt.details) : null,
    );
}

function insertCitations(database: DatabaseSync, memory: MemoryRecord) {
  const insert = database.prepare(
    `INSERT INTO memory_citations (memory_id, citation_id, citation_json)
     VALUES (?, ?, ?)`,
  );
  for (const citation of memory.citations)
    insert.run(memory.id, citation.id, JSON.stringify(citation));
}

function insertRelationships(database: DatabaseSync, memory: MemoryRecord) {
  const insert = database.prepare(
    `INSERT OR IGNORE INTO memory_relationships (source_id, target_id, kind)
     VALUES (?, ?, ?)`,
  );
  for (const relationship of memory.relationships)
    insert.run(memory.id, relationship.targetId, relationship.kind);
}

function memoryRow(database: DatabaseSync, id: string) {
  return database
    .prepare("SELECT rowid, * FROM memories WHERE id = ?")
    .get(id) as SqliteRow | undefined;
}

function persistedFromRow(
  database: DatabaseSync,
  row: SqliteRow,
): PersistedMemory {
  const id = text(row, "id");
  const revisions = database
    .prepare(
      `SELECT record_json FROM memory_revisions
       WHERE memory_id = ? ORDER BY revision`,
    )
    .all(id) as SqliteRow[];
  return {
    memory: parseRecord(text(row, "record_json")),
    normalizedContent: text(row, "normalized_content"),
    contentDigest: text(row, "content_digest"),
    revisions: revisions.map((revision) =>
      parseRecord(text(revision, "record_json")),
    ),
  };
}

function updateCanonical(database: DatabaseSync, entry: PersistedMemory) {
  database
    .prepare(
      `UPDATE memories SET
         revision = ?, normalized_content = ?, content_digest = ?, status = ?,
         updated_at = ?, expires_at = ?, record_json = ?
       WHERE id = ?`,
    )
    .run(
      entry.memory.revision,
      entry.normalizedContent,
      entry.contentDigest,
      entry.memory.status,
      entry.memory.updatedAt,
      entry.memory.expiresAt ?? null,
      JSON.stringify(entry.memory),
      entry.memory.id,
    );
  database
    .prepare("DELETE FROM memory_citations WHERE memory_id = ?")
    .run(entry.memory.id);
  database
    .prepare("DELETE FROM memory_relationships WHERE source_id = ?")
    .run(entry.memory.id);
  insertCitations(database, entry.memory);
  insertRelationships(database, entry.memory);
  const row = memoryRow(database, entry.memory.id);
  if (!row) throw new Error("Memory disappeared during update");
  const rowid = number(row, "rowid");
  database.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(rowid);
  database
    .prepare(
      "INSERT INTO memory_fts(rowid, memory_id, content) VALUES (?, ?, ?)",
    )
    .run(rowid, entry.memory.id, entry.memory.content);
}

function purgeExpiredDatabase(database: DatabaseSync, now: number) {
  const expiredRows = database
    .prepare(
      "SELECT id, rowid FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?",
    )
    .all(now) as SqliteRow[];
  for (const expiredRow of expiredRows) {
    const expiredId = text(expiredRow, "id");
    const relatedRows = database
      .prepare(
        `SELECT DISTINCT source_id FROM memory_relationships
         WHERE target_id = ? AND source_id <> ?`,
      )
      .all(expiredId, expiredId) as SqliteRow[];
    for (const related of relatedRows) {
      const relatedId = text(related, "source_id");
      const relatedRow = memoryRow(database, relatedId);
      if (!relatedRow) continue;
      const target = persistedFromRow(database, relatedRow);
      const scrub = (memory: MemoryRecord): MemoryRecord => ({
        ...memory,
        relationships: memory.relationships.filter(
          ({ targetId }) => targetId !== expiredId,
        ),
      });
      const scrubbed = {
        ...target,
        memory: scrub(target.memory),
        revisions: target.revisions.map(scrub),
      };
      updateCanonical(database, scrubbed);
      const updateRevision = database.prepare(
        `UPDATE memory_revisions SET record_json = ?
         WHERE memory_id = ? AND revision = ?`,
      );
      for (const revision of scrubbed.revisions)
        updateRevision.run(
          JSON.stringify(revision),
          relatedId,
          revision.revision,
        );
    }
    database
      .prepare("DELETE FROM memory_fts WHERE rowid = ?")
      .run(number(expiredRow, "rowid"));
    database
      .prepare("DELETE FROM memory_relationships WHERE target_id = ?")
      .run(expiredId);
    database.prepare("DELETE FROM memories WHERE id = ?").run(expiredId);
  }
  return expiredRows.length > 0;
}

function withDatabase<T>(
  path: string,
  busyTimeoutMs: number,
  operation: (database: DatabaseSync) => MemoryPersistenceResult<T>,
) {
  let database: DatabaseSync | undefined;
  try {
    const identity = validateDatabasePath(path);
    database = openDatabase(path, busyTimeoutMs, identity);
    const result = operation(database);
    validateDatabasePath(path, identity);
    return result;
  } catch (error) {
    return sqliteFailure(error);
  } finally {
    database?.close();
    secureFiles(path);
  }
}

function checkpoint(database: DatabaseSync) {
  const row = database
    .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
    .get() as SqliteRow;
  if (number(row, "busy") !== 0)
    throw new Error("Memory WAL checkpoint is busy");
}

function literalFtsQuery(value: string) {
  const terms = value
    .normalize("NFKC")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 64);
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function ftsHasDrift(database: DatabaseSync) {
  const counts = database
    .prepare(
      `SELECT (SELECT count(*) FROM memories) AS memory_count,
              (SELECT count(*) FROM memory_fts) AS fts_count`,
    )
    .get() as SqliteRow;
  if (number(counts, "memory_count") !== number(counts, "fts_count"))
    return true;
  const mismatch = database
    .prepare(
      `SELECT 1 AS drift
       FROM memories m LEFT JOIN memory_fts f ON f.rowid = m.rowid
       WHERE f.rowid IS NULL OR f.memory_id <> m.id
          OR f.content <> json_extract(m.record_json, '$.content')
       LIMIT 1`,
    )
    .get();
  if (mismatch) return true;
  return !!database
    .prepare(
      `SELECT 1 AS drift FROM memory_fts f
       LEFT JOIN memories m ON m.rowid = f.rowid
       WHERE m.rowid IS NULL LIMIT 1`,
    )
    .get();
}

function ensureFtsIntegrity(database: DatabaseSync) {
  if (!ftsHasDrift(database)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM memory_fts");
    const rows = database
      .prepare("SELECT rowid, id, record_json FROM memories ORDER BY rowid")
      .all() as SqliteRow[];
    const insert = database.prepare(
      "INSERT INTO memory_fts(rowid, memory_id, content) VALUES (?, ?, ?)",
    );
    for (const row of rows)
      insert.run(
        number(row, "rowid"),
        text(row, "id"),
        parseRecord(text(row, "record_json")).content,
      );
    if (ftsHasDrift(database))
      throw new Error("Memory FTS rebuild did not converge");
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function createSqliteMemoryPersistenceAdapter(
  options: SqliteMemoryPersistenceOptions,
): Outcome<MemoryPersistenceAdapter, MemoryPersistenceError> {
  const path = resolve(options.path);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const clock = options.clock ?? Date.now;
  if (
    !options.path ||
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  )
    return persistenceFailure("Memory SQLite options are invalid.");
  let database: DatabaseSync | undefined;
  try {
    ensurePrivateDatabaseParent(path);
    const identity = validateDatabasePath(path);
    database = openDatabase(path, busyTimeoutMs, identity);
    migrate(database);
    database.exec("PRAGMA journal_mode = WAL");
    let cleanedAtStart = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      const now = clock();
      cleanedAtStart = purgeExpiredDatabase(database, now);
      const deletedPreviews = database
        .prepare("DELETE FROM memory_import_previews WHERE expires_at <= ?")
        .run(now);
      cleanedAtStart ||= deletedPreviews.changes > 0;
      database.exec("COMMIT");
      if (cleanedAtStart) checkpoint(database);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      if (!/busy|locked/i.test(errorText(error))) throw error;
    }
    database.close();
    database = undefined;
    validateDatabasePath(path);
    secureFiles(path);
  } catch (error) {
    database?.close();
    return sqliteFailure(error);
  }

  const adapter: MemoryPersistenceAdapter = {
    async purgeExpired(now) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const changed = purgeExpiredDatabase(database, now);
          database.exec("COMMIT");
          if (changed) checkpoint(database);
          return success(undefined);
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async create(
      entry,
      receipt,
      contradictionIds = [],
      nearDuplicateLimit = 64,
    ) {
      return withDatabase<
        | { readonly created: true }
        | {
            readonly created: false;
            readonly existing: PersistedMemory;
            readonly replayed: boolean;
            readonly receipt: MemoryIdempotencyReceipt;
          }
      >(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const priorReceiptRow = database
            .prepare("SELECT * FROM memory_receipts WHERE request_id = ?")
            .get(receipt.requestId) as SqliteRow | undefined;
          if (priorReceiptRow) {
            const priorReceipt = receiptFromRow(priorReceiptRow);
            if (
              priorReceipt.operation !== receipt.operation ||
              priorReceipt.fingerprint !== receipt.fingerprint ||
              !priorReceipt.memoryId
            ) {
              database.exec("ROLLBACK");
              return {
                ok: false,
                error: {
                  code: "revision_conflict" as const,
                  message: "Memory request ID has conflicting intent.",
                  retryable: false,
                },
              };
            }
            const priorMemoryRow = memoryRow(database, priorReceipt.memoryId);
            if (!priorMemoryRow)
              throw new Error("Memory receipt is inconsistent");
            const existing = persistedFromRow(database, priorMemoryRow);
            database.exec("COMMIT");
            return success({
              created: false as const,
              existing,
              replayed: true,
              receipt: priorReceipt,
            });
          }
          const existingRow = database
            .prepare(
              `SELECT rowid, * FROM memories
               WHERE scope_kind = ? AND scope_key = ?
                 AND kind_id = ? AND kind_version = ? AND content_digest = ?`,
            )
            .get(
              entry.memory.scope.kind,
              scopeKey(entry.memory.scope),
              entry.memory.kind.id,
              entry.memory.kind.version,
              entry.contentDigest,
            ) as SqliteRow | undefined;
          if (existingRow) {
            const existing = persistedFromRow(database, existingRow);
            const duplicateReceipt = {
              ...receipt,
              memoryId: existing.memory.id,
              state: "duplicate" as const,
              duplicateOf: existing.memory.id,
            };
            writeReceipt(database, duplicateReceipt);
            database.exec("COMMIT");
            return success({
              created: false as const,
              existing,
              replayed: false,
              receipt: duplicateReceipt,
            });
          }
          const claim = contradictionClaim(entry.memory.content);
          const nearRows = database
            .prepare(
              `SELECT rowid, * FROM memories
               WHERE scope_kind = ? AND scope_key = ?
                 AND kind_id = ? AND kind_version = ?
                 AND (expires_at IS NULL OR expires_at > ?)
               ORDER BY updated_at DESC, id LIMIT ?`,
            )
            .all(
              entry.memory.scope.kind,
              scopeKey(entry.memory.scope),
              entry.memory.kind.id,
              entry.memory.kind.version,
              entry.memory.updatedAt,
              nearDuplicateLimit,
            ) as SqliteRow[];
          const nearDuplicate = nearRows
            .map((row) => persistedFromRow(database, row))
            .find((candidate) => {
              const other = contradictionClaim(candidate.memory.content);
              if (
                claim &&
                other?.subject === claim.subject &&
                other.value !== claim.value
              )
                return false;
              return isConservativeNearDuplicate(
                candidate.normalizedContent,
                entry.normalizedContent,
              );
            });
          if (nearDuplicate) {
            const duplicateReceipt = {
              ...receipt,
              memoryId: nearDuplicate.memory.id,
              state: "duplicate" as const,
              duplicateOf: nearDuplicate.memory.id,
            };
            writeReceipt(database, duplicateReceipt);
            database.exec("COMMIT");
            return success({
              created: false as const,
              existing: nearDuplicate,
              replayed: false,
              receipt: duplicateReceipt,
            });
          }
          const reconciledIds = new Set<string>();
          const activeClaim =
            entry.memory.status === "active" ? claim : undefined;
          if (activeClaim) {
            const currentRows = database
              .prepare(
                `SELECT rowid, * FROM memories
                 WHERE scope_kind = ? AND scope_key = ?
                   AND kind_id = ? AND kind_version = ?
                   AND status = 'active'
                   AND (expires_at IS NULL OR expires_at > ?)`,
              )
              .all(
                entry.memory.scope.kind,
                scopeKey(entry.memory.scope),
                entry.memory.kind.id,
                entry.memory.kind.version,
                entry.memory.updatedAt,
              ) as SqliteRow[];
            for (const currentRow of currentRows) {
              const current = persistedFromRow(database, currentRow);
              const other = contradictionClaim(current.memory.content);
              if (
                other?.subject === activeClaim.subject &&
                other.value !== activeClaim.value
              )
                reconciledIds.add(current.memory.id);
            }
          }
          const storedMemory: MemoryRecord = {
            ...entry.memory,
            relationships: [...reconciledIds].map((targetId) => ({
              kind: "pi/contradicts",
              targetId,
            })),
          };
          const storedEntry: PersistedMemory = {
            ...entry,
            memory: storedMemory,
            revisions: [storedMemory],
          };
          database
            .prepare(
              `INSERT INTO memories
                (id, revision, kind_id, kind_version, scope_kind, scope_key,
                 normalized_content, content_digest, status, updated_at, expires_at, record_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              storedMemory.id,
              storedMemory.revision,
              storedMemory.kind.id,
              storedMemory.kind.version,
              storedMemory.scope.kind,
              scopeKey(storedMemory.scope),
              storedEntry.normalizedContent,
              storedEntry.contentDigest,
              storedMemory.status,
              storedMemory.updatedAt,
              storedMemory.expiresAt ?? null,
              JSON.stringify(storedMemory),
            );
          const row = database
            .prepare("SELECT rowid FROM memories WHERE id = ?")
            .get(storedMemory.id) as SqliteRow;
          database
            .prepare(
              "INSERT INTO memory_fts(rowid, memory_id, content) VALUES (?, ?, ?)",
            )
            .run(number(row, "rowid"), storedMemory.id, storedMemory.content);
          database
            .prepare(
              `INSERT INTO memory_revisions (memory_id, revision, record_json)
               VALUES (?, ?, ?)`,
            )
            .run(
              storedMemory.id,
              storedMemory.revision,
              JSON.stringify(storedMemory),
            );
          insertCitations(database, storedMemory);
          insertRelationships(database, storedMemory);
          for (const targetId of reconciledIds) {
            const targetRow = memoryRow(database, targetId);
            if (!targetRow) continue;
            const target = persistedFromRow(database, targetRow);
            const memory: MemoryRecord = {
              ...target.memory,
              revision: target.memory.revision + 1,
              relationships: [
                ...target.memory.relationships,
                { kind: "pi/contradicts", targetId: storedMemory.id },
              ],
              updatedAt: storedMemory.updatedAt,
            };
            const updated = {
              ...target,
              memory,
              revisions: [...target.revisions, memory],
            };
            updateCanonical(database, updated);
            database
              .prepare(
                `INSERT INTO memory_revisions (memory_id, revision, record_json)
                 VALUES (?, ?, ?)`,
              )
              .run(memory.id, memory.revision, JSON.stringify(memory));
          }
          writeReceipt(database, receipt);
          database.exec("COMMIT");
          return success({ created: true as const });
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async get(id) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        const row = memoryRow(database, id);
        return success(row ? persistedFromRow(database, row) : undefined);
      });
    },
    async getReceipt(requestId) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        const row = database
          .prepare("SELECT * FROM memory_receipts WHERE request_id = ?")
          .get(requestId) as SqliteRow | undefined;
        if (!row) return success(undefined);
        const receipt = receiptFromRow(row);
        if (receipt.operation === "forget") checkpoint(database);
        return success(receipt);
      });
    },
    async findCandidates(scope, kind, limit) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        const rows = database
          .prepare(
            `SELECT rowid, * FROM memories
             WHERE scope_kind = ? AND scope_key = ?
               AND kind_id = ? AND kind_version = ?
             ORDER BY updated_at DESC, id LIMIT ?`,
          )
          .all(
            scope.kind,
            scopeKey(scope),
            kind.id,
            kind.version,
            limit,
          ) as SqliteRow[];
        return success(rows.map((row) => persistedFromRow(database, row)));
      });
    },
    async saveReceipt(receipt) {
      return withDatabase<{
        readonly replayed: boolean;
        readonly receipt: MemoryIdempotencyReceipt;
      }>(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = database
            .prepare("SELECT * FROM memory_receipts WHERE request_id = ?")
            .get(receipt.requestId) as SqliteRow | undefined;
          if (row) {
            const prior = receiptFromRow(row);
            if (
              prior.operation !== receipt.operation ||
              prior.fingerprint !== receipt.fingerprint
            ) {
              database.exec("ROLLBACK");
              return {
                ok: false,
                error: {
                  code: "revision_conflict" as const,
                  message: "Memory request ID has conflicting intent.",
                  retryable: false,
                },
              };
            }
            database.exec("COMMIT");
            return success({ replayed: true, receipt: prior });
          }
          writeReceipt(database, receipt);
          database.exec("COMMIT");
          return success({ replayed: false, receipt });
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async update(entry, expectedRevision, receipt, contradictionIds) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = memoryRow(database, entry.memory.id);
          if (!row || number(row, "revision") !== expectedRevision) {
            database.exec("ROLLBACK");
            return {
              ok: false,
              error: {
                code: "revision_conflict" as const,
                message: "Memory revision changed.",
                retryable: false,
              },
            };
          }
          let storedEntry = entry;
          if (contradictionIds) {
            const selected = new Set<string>();
            const claim =
              entry.memory.status === "active"
                ? contradictionClaim(entry.memory.content)
                : undefined;
            if (claim) {
              const candidates = database
                .prepare(
                  `SELECT rowid, * FROM memories
                   WHERE id <> ? AND scope_kind = ? AND scope_key = ?
                     AND kind_id = ? AND kind_version = ?
                     AND status = 'active'
                     AND (expires_at IS NULL OR expires_at > ?)`,
                )
                .all(
                  entry.memory.id,
                  entry.memory.scope.kind,
                  scopeKey(entry.memory.scope),
                  entry.memory.kind.id,
                  entry.memory.kind.version,
                  entry.memory.updatedAt,
                ) as SqliteRow[];
              for (const candidateRow of candidates) {
                const candidate = persistedFromRow(database, candidateRow);
                const other = contradictionClaim(candidate.memory.content);
                if (
                  other?.subject === claim.subject &&
                  other.value !== claim.value
                )
                  selected.add(candidate.memory.id);
              }
            }
            const existingTargets = database
              .prepare(
                `SELECT source_id FROM memory_relationships
                 WHERE target_id = ? AND source_id <> ?`,
              )
              .all(entry.memory.id, entry.memory.id) as SqliteRow[];
            const targetIds = new Set([
              ...existingTargets.map((target) => text(target, "source_id")),
              ...selected,
            ]);
            for (const targetId of targetIds) {
              const targetRow = memoryRow(database, targetId);
              if (!targetRow) continue;
              const target = persistedFromRow(database, targetRow);
              const relationships = target.memory.relationships.filter(
                ({ targetId: relatedId }) => relatedId !== entry.memory.id,
              );
              if (selected.has(targetId))
                relationships.push({
                  kind: "pi/contradicts",
                  targetId: entry.memory.id,
                });
              if (
                JSON.stringify(relationships) ===
                JSON.stringify(target.memory.relationships)
              )
                continue;
              const memory: MemoryRecord = {
                ...target.memory,
                revision: target.memory.revision + 1,
                relationships,
                updatedAt: entry.memory.updatedAt,
              };
              updateCanonical(database, {
                ...target,
                memory,
                revisions: [...target.revisions, memory],
              });
              database
                .prepare(
                  `INSERT INTO memory_revisions (memory_id, revision, record_json)
                   VALUES (?, ?, ?)`,
                )
                .run(memory.id, memory.revision, JSON.stringify(memory));
            }
            const memory: MemoryRecord = {
              ...entry.memory,
              relationships: [...selected].map((targetId) => ({
                kind: "pi/contradicts",
                targetId,
              })),
            };
            storedEntry = {
              ...entry,
              memory,
              revisions: entry.revisions.map((revision) =>
                revision.revision === memory.revision ? memory : revision,
              ),
            };
          }
          updateCanonical(database, storedEntry);
          database
            .prepare(
              `INSERT INTO memory_revisions (memory_id, revision, record_json)
               VALUES (?, ?, ?)`,
            )
            .run(
              storedEntry.memory.id,
              storedEntry.memory.revision,
              JSON.stringify(storedEntry.memory),
            );
          writeReceipt(database, receipt);
          database.exec("COMMIT");
          return success(storedEntry);
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async forget(id, expectedRevision, receipt) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = memoryRow(database, id);
          const forgottenAt = receipt.forgottenAt;
          if (forgottenAt === undefined)
            throw new Error("Forget receipt is incomplete");
          if (
            !row ||
            (expectedRevision !== undefined &&
              number(row, "revision") !== expectedRevision)
          ) {
            database.exec("ROLLBACK");
            return {
              ok: false,
              error: {
                code: "revision_conflict" as const,
                message: "Memory revision changed.",
                retryable: false,
              },
            };
          }
          const relatedRows = database
            .prepare(
              `SELECT DISTINCT source_id FROM memory_relationships
               WHERE target_id = ? AND source_id <> ?`,
            )
            .all(id, id) as SqliteRow[];
          for (const related of relatedRows) {
            const targetId = text(related, "source_id");
            const targetRow = memoryRow(database, targetId);
            if (!targetRow) continue;
            const target = persistedFromRow(database, targetRow);
            const scrub = (memory: MemoryRecord): MemoryRecord => ({
              ...memory,
              relationships: memory.relationships.filter(
                ({ targetId: relationshipTarget }) => relationshipTarget !== id,
              ),
            });
            const scrubbed = {
              ...target,
              memory: scrub(target.memory),
              revisions: target.revisions.map(scrub),
            };
            updateCanonical(database, scrubbed);
            const updateRevision = database.prepare(
              `UPDATE memory_revisions SET record_json = ?
               WHERE memory_id = ? AND revision = ?`,
            );
            for (const revision of scrubbed.revisions)
              updateRevision.run(
                JSON.stringify(revision),
                targetId,
                revision.revision,
              );
          }
          const rowid = number(row, "rowid");
          database.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(rowid);
          database
            .prepare("DELETE FROM memory_relationships WHERE target_id = ?")
            .run(id);
          database.prepare("DELETE FROM memories WHERE id = ?").run(id);
          database
            .prepare(
              `INSERT INTO memory_tombstones (memory_id, forgotten_at, request_id)
               VALUES (?, ?, ?)`,
            )
            .run(id, forgottenAt, receipt.requestId);
          writeReceipt(database, receipt);
          database.exec("COMMIT");
          checkpoint(database);
          return success(undefined);
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async list(input) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        if (input.scopes.length === 0) return success([]);
        const scopeSql = input.scopes
          .map(() => "(scope_kind = ? AND scope_key = ?)")
          .join(" OR ");
        const parameters: (string | number)[] = input.scopes.flatMap(
          (scope) => [scope.kind, scopeKey(scope)],
        );
        let suffix = "";
        if (input.status) {
          suffix += " AND status = ?";
          parameters.push(input.status);
        }
        if (input.kind) {
          suffix += " AND kind_id = ? AND kind_version = ?";
          parameters.push(input.kind.id, input.kind.version);
        }
        if (input.afterId) {
          suffix += " AND id > ?";
          parameters.push(input.afterId);
        }
        if (input.asOf !== undefined) {
          suffix += " AND (expires_at IS NULL OR expires_at > ?)";
          parameters.push(input.asOf);
        }
        parameters.push(input.limit);
        const rows = database
          .prepare(
            `SELECT rowid, * FROM memories WHERE (${scopeSql})${suffix}
             ORDER BY id LIMIT ?`,
          )
          .all(...parameters) as SqliteRow[];
        return success(rows.map((row) => persistedFromRow(database, row)));
      });
    },
    async savePreview(preview, receipt, limits) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          database
            .prepare("DELETE FROM memory_import_previews WHERE expires_at <= ?")
            .run(limits.now);
          const previewJson = JSON.stringify(preview);
          const previewBytes = Buffer.byteLength(previewJson);
          if (previewBytes > limits.maxBytes)
            throw new Error("Import preview exceeds quota");
          while (true) {
            const quota = database
              .prepare(
                `SELECT count(*) AS preview_count,
                        coalesce(sum(length(CAST(preview_json AS BLOB))), 0) AS preview_bytes
                 FROM memory_import_previews`,
              )
              .get() as SqliteRow;
            if (
              number(quota, "preview_count") < limits.maxCount &&
              number(quota, "preview_bytes") + previewBytes <= limits.maxBytes
            )
              break;
            const oldest = database
              .prepare(
                `SELECT id FROM memory_import_previews
                 ORDER BY expires_at, id LIMIT 1`,
              )
              .get() as SqliteRow | undefined;
            if (!oldest) break;
            database
              .prepare("DELETE FROM memory_import_previews WHERE id = ?")
              .run(text(oldest, "id"));
          }
          database
            .prepare(
              `INSERT INTO memory_import_previews
                (id, manifest_sha256, scope_kind, scope_key, expires_at, preview_json)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              preview.id,
              preview.manifestSha256,
              preview.scope.kind,
              scopeKey(preview.scope),
              preview.expiresAt,
              previewJson,
            );
          writeReceipt(database, receipt);
          database.exec("COMMIT");
          return success(undefined);
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async getPreview(id, now) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        const deleted = database
          .prepare("DELETE FROM memory_import_previews WHERE expires_at <= ?")
          .run(now);
        const row = database
          .prepare(
            "SELECT preview_json FROM memory_import_previews WHERE id = ?",
          )
          .get(id) as SqliteRow | undefined;
        database.exec("COMMIT");
        if (deleted.changes > 0) checkpoint(database);
        return success(
          row
            ? (JSON.parse(text(row, "preview_json")) as MemoryImportPreview)
            : undefined,
        );
      });
    },
    async commitImport(previewId, entries, receipt) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const now = clock();
          const deleted = database
            .prepare("DELETE FROM memory_import_previews WHERE expires_at <= ?")
            .run(now);
          const preview = database
            .prepare("SELECT id FROM memory_import_previews WHERE id = ?")
            .get(previewId);
          if (!preview) {
            database.exec("COMMIT");
            if (deleted.changes > 0) checkpoint(database);
            return {
              ok: false,
              error: {
                code: "preview_expired" as const,
                message: "Import preview is unavailable.",
                retryable: false,
              },
            };
          }
          for (const staged of entries) {
            const entry = staged.entry;
            database
              .prepare(
                `INSERT INTO memories
                  (id, revision, kind_id, kind_version, scope_kind, scope_key,
                   normalized_content, content_digest, status, updated_at,
                   expires_at, record_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                entry.memory.id,
                entry.memory.revision,
                entry.memory.kind.id,
                entry.memory.kind.version,
                entry.memory.scope.kind,
                scopeKey(entry.memory.scope),
                entry.normalizedContent,
                entry.contentDigest,
                entry.memory.status,
                entry.memory.updatedAt,
                entry.memory.expiresAt ?? null,
                JSON.stringify(entry.memory),
              );
            const row = database
              .prepare("SELECT rowid FROM memories WHERE id = ?")
              .get(entry.memory.id) as SqliteRow;
            database
              .prepare(
                "INSERT INTO memory_fts(rowid, memory_id, content) VALUES (?, ?, ?)",
              )
              .run(number(row, "rowid"), entry.memory.id, entry.memory.content);
            database
              .prepare(
                `INSERT INTO memory_revisions (memory_id, revision, record_json)
                 VALUES (?, ?, ?)`,
              )
              .run(
                entry.memory.id,
                entry.memory.revision,
                JSON.stringify(entry.memory),
              );
            insertCitations(database, entry.memory);
            insertRelationships(database, entry.memory);
            for (const targetId of staged.contradictionIds) {
              const targetRow = memoryRow(database, targetId);
              if (!targetRow) continue;
              const target = persistedFromRow(database, targetRow);
              const memory: MemoryRecord = {
                ...target.memory,
                revision: target.memory.revision + 1,
                relationships: [
                  ...target.memory.relationships,
                  { kind: "pi/contradicts", targetId: entry.memory.id },
                ],
                updatedAt: entry.memory.updatedAt,
              };
              const updated = {
                ...target,
                memory,
                revisions: [...target.revisions, memory],
              };
              updateCanonical(database, updated);
              database
                .prepare(
                  `INSERT INTO memory_revisions (memory_id, revision, record_json)
                   VALUES (?, ?, ?)`,
                )
                .run(memory.id, memory.revision, JSON.stringify(memory));
            }
          }
          database
            .prepare("DELETE FROM memory_import_previews WHERE id = ?")
            .run(previewId);
          writeReceipt(database, receipt);
          database.exec("COMMIT");
          if (deleted.changes > 0) checkpoint(database);
          return success(undefined);
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {}
          return sqliteFailure(error);
        }
      });
    },
    async search(input) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        if (input.scopes.length === 0) return success([]);
        ensureFtsIntegrity(database);
        const scopeSql = input.scopes
          .map(() => "(m.scope_kind = ? AND m.scope_key = ?)")
          .join(" OR ");
        const scopeParams = input.scopes.flatMap((scope) => [
          scope.kind,
          scopeKey(scope),
        ]);
        const kindSql = input.kinds?.length
          ? ` AND (${input.kinds
              .map(() => "(m.kind_id = ? AND m.kind_version = ?)")
              .join(" OR ")})`
          : "";
        const kindParams =
          input.kinds?.flatMap(({ id, version }) => [id, version]) ?? [];
        const normalized = input.text
          .trim()
          .replace(/\s+/g, " ")
          .toLocaleLowerCase();
        let rows: SqliteRow[];
        if (input.ranking === "exact") {
          rows = database
            .prepare(
              `SELECT m.rowid, m.*, 2 AS score FROM memories m
               WHERE (${scopeSql})${kindSql}
                 AND m.status = 'active'
                 AND (m.expires_at IS NULL OR m.expires_at > ?)
                 AND m.normalized_content = ?
               ORDER BY m.id LIMIT ?`,
            )
            .all(
              ...scopeParams,
              ...kindParams,
              input.asOf,
              normalized,
              input.limit,
            ) as SqliteRow[];
        } else {
          const query = literalFtsQuery(input.text);
          if (!query) return success([]);
          rows = database
            .prepare(
              `SELECT m.rowid, m.*, bm25(memory_fts) AS fts_score
               FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
               WHERE memory_fts MATCH ? AND (${scopeSql})${kindSql}
                 AND m.status = 'active'
                 AND (m.expires_at IS NULL OR m.expires_at > ?)
               ORDER BY ${
                 input.ranking === "recent"
                   ? "m.updated_at DESC, m.id"
                   : "fts_score, m.id"
               }
               LIMIT ?`,
            )
            .all(
              query,
              ...scopeParams,
              ...kindParams,
              input.asOf,
              input.limit,
            ) as SqliteRow[];
        }
        return success(
          rows.map((row) => {
            const entry = persistedFromRow(database, row);
            const exact = entry.normalizedContent === normalized;
            const rawScore = row.fts_score;
            return {
              entry,
              score: exact
                ? 2
                : typeof rawScore === "number"
                  ? Math.max(0, -rawScore)
                  : 1,
              reasons: exact
                ? (["exact"] as const)
                : input.ranking === "recent"
                  ? (["recent", "lexical"] as const)
                  : (["lexical"] as const),
            };
          }),
        );
      });
    },
  };
  return success(adapter);
}
