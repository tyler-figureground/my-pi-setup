import { chmodSync, mkdirSync } from "node:fs";
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

const SCHEMA_VERSION = 1;

type SqliteRow = Record<string, unknown>;

export interface SqliteMemoryPersistenceOptions {
  readonly path: string;
  readonly busyTimeoutMs?: number;
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

function withDatabase<T>(
  path: string,
  busyTimeoutMs: number,
  operation: (database: DatabaseSync) => MemoryPersistenceResult<T>,
) {
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(path, busyTimeoutMs);
    return operation(database);
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

export function createSqliteMemoryPersistenceAdapter(
  options: SqliteMemoryPersistenceOptions,
): Outcome<MemoryPersistenceAdapter, MemoryPersistenceError> {
  const path = resolve(options.path);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (
    !options.path ||
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  )
    return persistenceFailure("Memory SQLite options are invalid.");
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    database = openDatabase(path, busyTimeoutMs);
    migrate(database);
    database.exec("PRAGMA journal_mode = WAL");
    database.close();
    database = undefined;
    secureFiles(path);
  } catch (error) {
    database?.close();
    return sqliteFailure(error);
  }

  const adapter: MemoryPersistenceAdapter = {
    async create(entry, receipt, contradictionIds = []) {
      return withDatabase<
        | { readonly created: true }
        | { readonly created: false; readonly existing: PersistedMemory }
      >(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
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
            writeReceipt(database, {
              ...receipt,
              memoryId: existing.memory.id,
              state: "duplicate",
              duplicateOf: existing.memory.id,
            });
            database.exec("COMMIT");
            return success({ created: false as const, existing });
          }
          database
            .prepare(
              `INSERT INTO memories
                (id, revision, kind_id, kind_version, scope_kind, scope_key,
                 normalized_content, content_digest, status, updated_at, expires_at, record_json)
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
          for (const targetId of contradictionIds) {
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
      return withDatabase(path, busyTimeoutMs, (database) => {
        try {
          writeReceipt(database, receipt);
          return success(undefined);
        } catch (error) {
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
          if (contradictionIds) {
            const existingTargets = database
              .prepare(
                `SELECT source_id FROM memory_relationships
                 WHERE target_id = ? AND source_id <> ?`,
              )
              .all(entry.memory.id, entry.memory.id) as SqliteRow[];
            const targetIds = new Set([
              ...existingTargets.map((target) => text(target, "source_id")),
              ...contradictionIds,
            ]);
            const selected = new Set(contradictionIds);
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
          }
          updateCanonical(database, entry);
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
    async savePreview(preview, receipt) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        database.exec("BEGIN IMMEDIATE");
        try {
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
              JSON.stringify(preview),
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
    async getPreview(id) {
      return withDatabase(path, busyTimeoutMs, (database) => {
        const row = database
          .prepare(
            "SELECT preview_json FROM memory_import_previews WHERE id = ?",
          )
          .get(id) as SqliteRow | undefined;
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
          const preview = database
            .prepare("SELECT id FROM memory_import_previews WHERE id = ?")
            .get(previewId);
          if (!preview) throw new Error("Import preview is unavailable");
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
