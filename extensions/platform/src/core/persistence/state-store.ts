import type { JsonObject, ModuleError, Outcome } from "../result.ts";

export const CURRENT_SCHEMA_VERSION = 5;
export const DEFAULT_METADATA_MAX_BYTES = 64 * 1024;
export const DEFAULT_TRANSACTION_MAX_BYTES = 1024 * 1024;
export const DEFAULT_TRANSACTION_MAX_OPERATIONS = 256;
export const DEFAULT_QUERY_MAX_LIMIT = 1_000;
export const DEFAULT_SNAPSHOT_MAX_ENTRIES = 10_000;
export const DEFAULT_COMPACT_MAX_LIMIT = 10_000;

export type StateStoreErrorCode =
  | "INVALID_REQUEST"
  | "METADATA_TOO_LARGE"
  | "VERSION_CONFLICT"
  | "EVENT_CONFLICT"
  | "LEASE_HELD"
  | "LEASE_LOST"
  | "TRANSACTION_CONFLICT"
  | "TRANSACTION_TOO_LARGE"
  | "EXPORT_TOO_LARGE"
  | "SCHEMA_TOO_NEW"
  | "MIGRATION_FAILED"
  | "STORAGE_FAILED"
  | "UNSUPPORTED_EXPORT";

export interface StateStoreError extends ModuleError<StateStoreErrorCode> {}
export type StateStoreResult<T> = Outcome<T, StateStoreError>;

export interface StateRecord {
  readonly collection: string;
  readonly key: string;
  readonly metadata: JsonObject;
  readonly version: number;
  readonly updatedAt: number;
}

export interface StateEvent {
  readonly sequence: number;
  readonly stream: string;
  readonly position: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly metadata: JsonObject;
  readonly occurredAt: number;
}

export interface StateLease {
  readonly resource: string;
  readonly owner: string | null;
  readonly fence: number;
  readonly expiresAt: number;
  readonly metadata: JsonObject;
}

export type StateMutation =
  | {
      readonly type: "check-record";
      readonly collection: string;
      readonly key: string;
      readonly expectedVersion: number;
    }
  | {
      readonly type: "put-record";
      readonly collection: string;
      readonly key: string;
      readonly metadata: JsonObject;
      readonly expectedVersion?: number | null;
    }
  | {
      readonly type: "delete-record";
      readonly collection: string;
      readonly key: string;
      readonly expectedVersion?: number | null;
    }
  | {
      readonly type: "append-event";
      readonly stream: string;
      readonly eventId: string;
      readonly eventType: string;
      readonly metadata: JsonObject;
    }
  | {
      readonly type: "delete-event";
      readonly stream: string;
      readonly eventId: string;
    }
  | {
      readonly type: "claim-lease";
      readonly resource: string;
      readonly owner: string;
      readonly ttlMs: number;
      readonly metadata?: JsonObject;
    }
  | {
      readonly type: "renew-lease";
      readonly resource: string;
      readonly owner: string;
      readonly fence: number;
      readonly ttlMs: number;
      readonly metadata?: JsonObject;
    }
  | {
      readonly type: "release-lease";
      readonly resource: string;
      readonly owner: string;
      readonly fence: number;
    };

export interface StateTransaction {
  readonly transactionId: string;
  readonly operations: readonly StateMutation[];
}

export interface StateTransactionResult {
  readonly transactionId: string;
  readonly replayed: boolean;
  readonly committedAt: number;
  readonly records: readonly StateRecord[];
  readonly deletedRecords: readonly {
    collection: string;
    key: string;
    version: number;
  }[];
  readonly events: readonly StateEvent[];
  readonly leases: readonly StateLease[];
}

export type StateQuery =
  | {
      readonly type: "record";
      readonly collection: string;
      readonly key: string;
    }
  | {
      readonly type: "records";
      readonly collection: string;
      readonly keyPrefix?: string;
      readonly afterKey?: string;
      readonly limit?: number;
    }
  | {
      readonly type: "events";
      readonly stream: string;
      readonly afterPosition?: number;
      readonly limit?: number;
    }
  | { readonly type: "lease"; readonly resource: string };

export type StateQueryResult =
  | { readonly type: "record"; readonly record: StateRecord | null }
  | { readonly type: "records"; readonly records: readonly StateRecord[] }
  | { readonly type: "events"; readonly events: readonly StateEvent[] }
  | { readonly type: "lease"; readonly lease: StateLease | null };

export interface StateCompactRequest {
  readonly eventsBefore?: number;
  readonly transactionsBefore?: number;
  /** Retire event-ID tombstones and their event rows older than this cutoff. */
  readonly eventIdsBefore?: number;
  /** Restrict tombstone-aware event cleanup to these event IDs. */
  readonly eventIds?: readonly string[];
  /** Remove orphan version heads only from these explicitly disposable collections. */
  readonly recordHeadCollections?: readonly string[];
  /** Bound each requested cleanup category. Existing unbounded calls remain compatible. */
  readonly limit?: number;
}

export interface StateCompactResult {
  readonly deletedEvents: number;
  readonly deletedTransactions: number;
  readonly deletedEventIds?: number;
  readonly deletedRecordHeads?: number;
}

export interface StateSnapshot {
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly records: readonly StateRecord[];
  readonly events: readonly StateEvent[];
  readonly leases: readonly StateLease[];
}

export type StateExportRequest =
  | { readonly format: "snapshot" }
  | { readonly format: "sqlite-backup"; readonly destination: string };

export type StateExportResult =
  | { readonly format: "snapshot"; readonly snapshot: StateSnapshot }
  | {
      readonly format: "sqlite-backup";
      readonly destination: string;
      readonly pages: number;
    };

export interface StateStoreDiagnostics {
  readonly adapter: "memory" | "node:sqlite";
  readonly schemaVersion: number;
  readonly integrity: "ok" | "corrupt";
  readonly journalMode: "memory" | "wal" | "unknown";
  readonly counts: {
    readonly records: number;
    readonly events: number;
    readonly leases: number;
    readonly transactions: number;
  };
  readonly issues: readonly string[];
  readonly fileMode?: number;
}

export interface StateStore {
  /** @internal Create a same-storage adapter with a shorter native lock wait. */
  withBusyTimeout?(busyTimeoutMs: number): StateStore;
  transact(
    transaction: StateTransaction,
  ): Promise<StateStoreResult<StateTransactionResult>>;
  query(query: StateQuery): Promise<StateStoreResult<StateQueryResult>>;
  compact(
    request?: StateCompactRequest,
  ): Promise<StateStoreResult<StateCompactResult>>;
  export(
    request: StateExportRequest,
  ): Promise<StateStoreResult<StateExportResult>>;
  diagnose(): Promise<StateStoreResult<StateStoreDiagnostics>>;
}

export interface StateStoreOptions {
  readonly maxMetadataBytes?: number;
  readonly maxTransactionBytes?: number;
  readonly maxTransactionOperations?: number;
  readonly maxQueryLimit?: number;
  readonly maxSnapshotEntries?: number;
  readonly now?: () => number;
}

export function isPositiveSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isValidExpectedVersion(value: unknown) {
  return value === undefined || value === null || isPositiveSafeInteger(value);
}
