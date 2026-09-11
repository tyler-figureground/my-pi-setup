/**
 * Public barrel for StateStore: the interface, its limits, and both adapters.
 * Production composes `createSqliteStateStore` (ADR 0002);
 * `createMemoryStateStore` is the in-process adapter tests use behind the
 * same interface.
 *
 * See: docs/adr/0002-state-store-node-sqlite.md
 */

export { createMemoryStateStore } from "./memory-state-store.ts";
export { createSqliteStateStore } from "./sqlite-state-store.ts";
export type { SqliteStateStoreOptions } from "./sqlite-state-store.ts";
export {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_METADATA_MAX_BYTES,
  DEFAULT_QUERY_MAX_LIMIT,
  DEFAULT_SNAPSHOT_MAX_ENTRIES,
  DEFAULT_TRANSACTION_MAX_BYTES,
  DEFAULT_TRANSACTION_MAX_OPERATIONS,
} from "./state-store.ts";
export type {
  StateCompactRequest,
  StateCompactResult,
  StateEvent,
  StateExportRequest,
  StateExportResult,
  StateLease,
  StateMutation,
  StateQuery,
  StateQueryResult,
  StateRecord,
  StateSnapshot,
  StateStore,
  StateStoreDiagnostics,
  StateStoreError,
  StateStoreErrorCode,
  StateStoreOptions,
  StateStoreResult,
  StateTransaction,
  StateTransactionResult,
} from "./state-store.ts";
