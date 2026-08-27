import { success, type JsonObject, type Outcome } from "../core/result.ts";
import type { MemoryRecord } from "./model.ts";

export interface MemoryPersistenceError {
  readonly code: "storage_failed" | "revision_conflict";
  readonly message: string;
  readonly retryable: boolean;
}

export type MemoryPersistenceResult<T> = Outcome<T, MemoryPersistenceError>;

export interface PersistedMemory {
  readonly memory: MemoryRecord;
  readonly normalizedContent: string;
  readonly contentDigest: string;
  readonly revisions: readonly MemoryRecord[];
}

export interface MemoryIdempotencyReceipt {
  readonly requestId: string;
  readonly operation:
    | "remember"
    | "replace"
    | "promote"
    | "forget"
    | "export"
    | "preview-import"
    | "commit-import";
  readonly fingerprint: string;
  readonly memoryId?: string;
  readonly state?: "created" | "duplicate" | "review-required";
  readonly duplicateOf?: string;
  readonly revision?: number;
  readonly forgottenAt?: number;
  readonly details?: JsonObject;
}

export interface StagedMemoryEntry {
  readonly entry: PersistedMemory;
  readonly collision: boolean;
  readonly contradictionIds: readonly string[];
}

export interface MemoryImportPreview {
  readonly id: string;
  readonly manifestSha256: string;
  readonly scope: MemoryRecord["scope"];
  readonly entries: readonly StagedMemoryEntry[];
  readonly unsupportedKinds: number;
  readonly expiresAt: number;
}

export interface MemorySearchCandidate {
  readonly entry: PersistedMemory;
  readonly score: number;
  readonly reasons: readonly ("exact" | "lexical" | "recent")[];
}

export interface MemoryPersistenceAdapter {
  create(
    entry: PersistedMemory,
    receipt: MemoryIdempotencyReceipt,
    contradictionIds?: readonly string[],
  ): Promise<
    MemoryPersistenceResult<
      | { readonly created: true }
      | { readonly created: false; readonly existing: PersistedMemory }
    >
  >;
  get(
    id: string,
  ): Promise<MemoryPersistenceResult<PersistedMemory | undefined>>;
  getReceipt(
    requestId: string,
  ): Promise<MemoryPersistenceResult<MemoryIdempotencyReceipt | undefined>>;
  findCandidates(
    scope: MemoryRecord["scope"],
    kind: MemoryRecord["kind"],
    limit: number,
  ): Promise<MemoryPersistenceResult<readonly PersistedMemory[]>>;
  saveReceipt(
    receipt: MemoryIdempotencyReceipt,
  ): Promise<MemoryPersistenceResult<void>>;
  update(
    entry: PersistedMemory,
    expectedRevision: number,
    receipt: MemoryIdempotencyReceipt,
    contradictionIds?: readonly string[],
  ): Promise<MemoryPersistenceResult<void>>;
  forget(
    id: string,
    expectedRevision: number | undefined,
    receipt: MemoryIdempotencyReceipt,
  ): Promise<MemoryPersistenceResult<void>>;
  list(input: {
    readonly scopes: readonly MemoryRecord["scope"][];
    readonly status?: MemoryRecord["status"];
    readonly kind?: MemoryRecord["kind"];
    readonly afterId?: string;
    readonly limit: number;
    readonly asOf?: number;
  }): Promise<MemoryPersistenceResult<readonly PersistedMemory[]>>;
  savePreview(
    preview: MemoryImportPreview,
    receipt: MemoryIdempotencyReceipt,
  ): Promise<MemoryPersistenceResult<void>>;
  getPreview(
    id: string,
  ): Promise<MemoryPersistenceResult<MemoryImportPreview | undefined>>;
  commitImport(
    previewId: string,
    entries: readonly StagedMemoryEntry[],
    receipt: MemoryIdempotencyReceipt,
  ): Promise<MemoryPersistenceResult<void>>;
  search(input: {
    readonly text: string;
    readonly scopes: readonly MemoryRecord["scope"][];
    readonly kinds?: readonly MemoryRecord["kind"][];
    readonly ranking: "relevant" | "recent" | "exact";
    readonly limit: number;
    readonly asOf: number;
  }): Promise<MemoryPersistenceResult<readonly MemorySearchCandidate[]>>;
}

export function createInMemoryMemoryPersistenceAdapter(): MemoryPersistenceAdapter {
  const entries = new Map<string, PersistedMemory>();
  const receipts = new Map<string, MemoryIdempotencyReceipt>();
  const previews = new Map<string, MemoryImportPreview>();
  return {
    async create(entry, receipt, contradictionIds = []) {
      const existing = [...entries.values()].find(
        (candidate) =>
          JSON.stringify(candidate.memory.scope) ===
            JSON.stringify(entry.memory.scope) &&
          candidate.memory.kind.id === entry.memory.kind.id &&
          candidate.memory.kind.version === entry.memory.kind.version &&
          candidate.contentDigest === entry.contentDigest,
      );
      if (existing) {
        receipts.set(receipt.requestId, {
          ...structuredClone(receipt),
          memoryId: existing.memory.id,
          state: "duplicate",
          duplicateOf: existing.memory.id,
        });
        return success({
          created: false as const,
          existing: structuredClone(existing),
        });
      }
      for (const targetId of contradictionIds) {
        const target = entries.get(targetId);
        if (!target) continue;
        const memory = {
          ...target.memory,
          revision: target.memory.revision + 1,
          relationships: [
            ...target.memory.relationships,
            { kind: "pi/contradicts" as const, targetId: entry.memory.id },
          ],
          updatedAt: entry.memory.updatedAt,
        };
        entries.set(targetId, {
          ...target,
          memory,
          revisions: [...target.revisions, memory],
        });
      }
      entries.set(entry.memory.id, structuredClone(entry));
      receipts.set(receipt.requestId, structuredClone(receipt));
      return success({ created: true as const });
    },
    async get(id) {
      const entry = entries.get(id);
      return success(entry ? structuredClone(entry) : undefined);
    },
    async getReceipt(requestId) {
      const receipt = receipts.get(requestId);
      return success(receipt ? structuredClone(receipt) : undefined);
    },
    async findCandidates(scope, kind, limit) {
      return success(
        [...entries.values()]
          .filter(
            ({ memory }) =>
              JSON.stringify(memory.scope) === JSON.stringify(scope) &&
              memory.kind.id === kind.id &&
              memory.kind.version === kind.version,
          )
          .slice(0, limit)
          .map((entry) => structuredClone(entry)),
      );
    },
    async saveReceipt(receipt) {
      receipts.set(receipt.requestId, structuredClone(receipt));
      return success(undefined);
    },
    async update(entry, expectedRevision, receipt, contradictionIds) {
      const current = entries.get(entry.memory.id);
      if (!current || current.memory.revision !== expectedRevision)
        return {
          ok: false,
          error: {
            code: "revision_conflict",
            message: "Memory revision changed.",
            retryable: false,
          },
        };
      if (contradictionIds) {
        const targets = new Set(contradictionIds);
        for (const [targetId, target] of entries) {
          if (targetId === entry.memory.id) continue;
          const relationships = target.memory.relationships.filter(
            ({ targetId: relatedId }) => relatedId !== entry.memory.id,
          );
          if (targets.has(targetId))
            relationships.push({
              kind: "pi/contradicts",
              targetId: entry.memory.id,
            });
          if (
            JSON.stringify(relationships) !==
            JSON.stringify(target.memory.relationships)
          ) {
            const memory = {
              ...target.memory,
              revision: target.memory.revision + 1,
              relationships,
              updatedAt: entry.memory.updatedAt,
            };
            entries.set(targetId, {
              ...target,
              memory,
              revisions: [...target.revisions, memory],
            });
          }
        }
      }
      entries.set(entry.memory.id, structuredClone(entry));
      receipts.set(receipt.requestId, structuredClone(receipt));
      return success(undefined);
    },
    async forget(id, expectedRevision, receipt) {
      const current = entries.get(id);
      if (
        !current ||
        (expectedRevision !== undefined &&
          current.memory.revision !== expectedRevision)
      )
        return {
          ok: false,
          error: {
            code: "revision_conflict",
            message: "Memory revision changed.",
            retryable: false,
          },
        };
      entries.delete(id);
      for (const [targetId, target] of entries) {
        const scrub = (memory: MemoryRecord): MemoryRecord => ({
          ...memory,
          relationships: memory.relationships.filter(
            ({ targetId: relatedId }) => relatedId !== id,
          ),
        });
        entries.set(targetId, {
          ...target,
          memory: scrub(target.memory),
          revisions: target.revisions.map(scrub),
        });
      }
      receipts.set(receipt.requestId, structuredClone(receipt));
      return success(undefined);
    },
    async list(input) {
      const scopeKeys = new Set(
        input.scopes.map((scope) => JSON.stringify(scope)),
      );
      return success(
        [...entries.values()]
          .filter(
            ({ memory }) =>
              scopeKeys.has(JSON.stringify(memory.scope)) &&
              (!input.status || memory.status === input.status) &&
              (!input.kind ||
                (memory.kind.id === input.kind.id &&
                  memory.kind.version === input.kind.version)) &&
              (!input.afterId || memory.id > input.afterId) &&
              (input.asOf === undefined ||
                memory.expiresAt === undefined ||
                memory.expiresAt > input.asOf),
          )
          .sort((left, right) => left.memory.id.localeCompare(right.memory.id))
          .slice(0, input.limit)
          .map((entry) => structuredClone(entry)),
      );
    },
    async savePreview(preview, receipt) {
      previews.set(preview.id, structuredClone(preview));
      receipts.set(receipt.requestId, structuredClone(receipt));
      return success(undefined);
    },
    async getPreview(id) {
      const preview = previews.get(id);
      return success(preview ? structuredClone(preview) : undefined);
    },
    async commitImport(previewId, stagedEntries, receipt) {
      if (!previews.has(previewId))
        return {
          ok: false,
          error: {
            code: "storage_failed",
            message: "Import preview is unavailable.",
            retryable: false,
          },
        };
      for (const staged of stagedEntries) {
        entries.set(staged.entry.memory.id, structuredClone(staged.entry));
        for (const targetId of staged.contradictionIds) {
          const target = entries.get(targetId);
          if (!target) continue;
          const memory = {
            ...target.memory,
            revision: target.memory.revision + 1,
            relationships: [
              ...target.memory.relationships,
              {
                kind: "pi/contradicts" as const,
                targetId: staged.entry.memory.id,
              },
            ],
            updatedAt: staged.entry.memory.updatedAt,
          };
          entries.set(targetId, {
            ...target,
            memory,
            revisions: [...target.revisions, memory],
          });
        }
      }
      previews.delete(previewId);
      receipts.set(receipt.requestId, structuredClone(receipt));
      return success(undefined);
    },
    async search(input) {
      const query = input.text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
      const scopeKeys = new Set(
        input.scopes.map((scope) => JSON.stringify(scope)),
      );
      const kindKeys = input.kinds
        ? new Set(input.kinds.map(({ id, version }) => `${id}\0${version}`))
        : undefined;
      const candidates = [...entries.values()]
        .filter(
          ({ memory, normalizedContent }) =>
            memory.status === "active" &&
            (memory.expiresAt === undefined || memory.expiresAt > input.asOf) &&
            scopeKeys.has(JSON.stringify(memory.scope)) &&
            (!kindKeys ||
              kindKeys.has(`${memory.kind.id}\0${memory.kind.version}`)) &&
            (input.ranking === "exact"
              ? normalizedContent === query
              : normalizedContent.includes(query)),
        )
        .map((entry) => {
          const exact = entry.normalizedContent === query;
          return {
            entry: structuredClone(entry),
            score:
              input.ranking === "recent"
                ? entry.memory.updatedAt
                : exact
                  ? 2
                  : 1,
            reasons: exact
              ? (["exact"] as const)
              : input.ranking === "recent"
                ? (["recent", "lexical"] as const)
                : (["lexical"] as const),
          };
        })
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.entry.memory.id.localeCompare(right.entry.memory.id),
        )
        .slice(0, input.limit);
      return success(candidates);
    },
  };
}
