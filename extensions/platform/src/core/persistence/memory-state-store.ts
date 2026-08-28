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
  type StateLease,
  type StateMutation,
  type StateQuery,
  type StateRecord,
  type StateStoreError,
  type StateStoreErrorCode,
  type StateStoreOptions,
  type StateStoreResult,
  type StateTransaction,
  type StateTransactionResult,
} from "./state-store.ts";
import { canonicalJson, canonicalStateTransaction } from "./json.ts";

interface MemoryReceipt {
  request: string;
  result: StateTransactionResult;
}

interface MemoryState {
  records: Map<string, StateRecord>;
  recordVersions: Map<string, number>;
  events: StateEvent[];
  eventIds: Set<string>;
  streamPositions: Map<string, number>;
  leases: Map<string, StateLease>;
  receipts: Map<string, MemoryReceipt>;
  nextSequence: number;
}

function stateFailure(
  code: StateStoreErrorCode,
  message: string,
  retryable = false,
  details?: JsonObject,
): StateStoreResult<never> {
  const error: StateStoreError = { code, message, retryable, details };
  return failure(error);
}

function recordId(collection: string, key: string) {
  return `${collection}\u0000${key}`;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    records: new Map(
      [...state.records].map(([key, record]) => [key, structuredClone(record)]),
    ),
    recordVersions: new Map(state.recordVersions),
    events: structuredClone(state.events),
    eventIds: new Set(state.eventIds),
    streamPositions: new Map(state.streamPositions),
    leases: new Map(
      [...state.leases].map(([key, lease]) => [key, structuredClone(lease)]),
    ),
    receipts: new Map(
      [...state.receipts].map(([key, receipt]) => [
        key,
        structuredClone(receipt),
      ]),
    ),
    nextSequence: state.nextSequence,
  };
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

function applyMutation(
  state: MemoryState,
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
    const existing = state.records.get(
      recordId(operation.collection, operation.key),
    );
    if (existing?.version !== operation.expectedVersion) {
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
    return success(undefined);
  }

  if (operation.type === "put-record") {
    const id = recordId(operation.collection, operation.key);
    const existing = state.records.get(id);
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
      version: (state.recordVersions.get(id) ?? 0) + 1,
      updatedAt: now,
    };
    state.records.set(id, record);
    state.recordVersions.set(id, record.version);
    result.records.push(record);
    return success(undefined);
  }

  if (operation.type === "delete-record") {
    const id = recordId(operation.collection, operation.key);
    const existing = state.records.get(id);
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
    state.records.delete(id);
    const deletedVersion = existing.version + 1;
    state.recordVersions.set(id, deletedVersion);
    result.deletedRecords.push({
      collection: existing.collection,
      key: existing.key,
      version: deletedVersion,
    });
    return success(undefined);
  }

  if (operation.type === "append-event") {
    if (state.eventIds.has(operation.eventId)) {
      return stateFailure("EVENT_CONFLICT", "Event ID already exists", false, {
        eventId: operation.eventId,
      });
    }
    const position = (state.streamPositions.get(operation.stream) ?? 0) + 1;
    const event: StateEvent = {
      sequence: state.nextSequence++,
      stream: operation.stream,
      position,
      eventId: operation.eventId,
      eventType: operation.eventType,
      metadata: structuredClone(operation.metadata),
      occurredAt: now,
    };
    state.events.push(event);
    state.eventIds.add(operation.eventId);
    state.streamPositions.set(operation.stream, position);
    result.events.push(event);
    return success(undefined);
  }

  if (operation.type === "delete-event") {
    const index = state.events.findIndex(
      ({ stream, eventId }) =>
        stream === operation.stream && eventId === operation.eventId,
    );
    if (index >= 0) state.events.splice(index, 1);
    return success(undefined);
  }

  const current = state.leases.get(operation.resource);
  if (operation.type === "claim-lease") {
    if (
      current?.owner !== null &&
      current !== undefined &&
      current.expiresAt > now
    ) {
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
    state.leases.set(operation.resource, lease);
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
    state.leases.set(operation.resource, lease);
    result.leases.push(lease);
    return success(undefined);
  }

  const released: StateLease = { ...current, owner: null, expiresAt: now };
  state.leases.set(operation.resource, released);
  result.leases.push(released);
  return success(undefined);
}

export function createMemoryStateStore(options: StateStoreOptions = {}) {
  const maxMetadataBytes =
    options.maxMetadataBytes ?? DEFAULT_METADATA_MAX_BYTES;
  const maxTransactionBytes =
    options.maxTransactionBytes ?? DEFAULT_TRANSACTION_MAX_BYTES;
  const maxTransactionOperations =
    options.maxTransactionOperations ?? DEFAULT_TRANSACTION_MAX_OPERATIONS;
  const maxQueryLimit = options.maxQueryLimit ?? DEFAULT_QUERY_MAX_LIMIT;
  const maxSnapshotEntries =
    options.maxSnapshotEntries ?? DEFAULT_SNAPSHOT_MAX_ENTRIES;
  for (const [name, value] of Object.entries({
    maxMetadataBytes,
    maxTransactionBytes,
    maxTransactionOperations,
    maxQueryLimit,
    maxSnapshotEntries,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  const now = options.now ?? Date.now;
  let state: MemoryState = {
    records: new Map(),
    recordVersions: new Map(),
    events: [],
    eventIds: new Set(),
    streamPositions: new Map(),
    leases: new Map(),
    receipts: new Map(),
    nextSequence: 1,
  };

  return {
    async transact(transaction: StateTransaction) {
      const valid = validateTransaction(
        transaction,
        maxMetadataBytes,
        maxTransactionOperations,
        maxTransactionBytes,
      );
      if (!valid.ok) return valid;
      const request = valid.value;
      const receipt = state.receipts.get(transaction.transactionId);
      if (receipt) {
        if (receipt.request !== request) {
          return stateFailure(
            "TRANSACTION_CONFLICT",
            "Transaction ID was already used for different operations",
          );
        }
        return success(structuredClone({ ...receipt.result, replayed: true }));
      }

      const staged = cloneState(state);
      const committedAt = Math.floor(now());
      const result: StateTransactionResult = {
        transactionId: transaction.transactionId,
        replayed: false,
        committedAt,
        records: [],
        deletedRecords: [],
        events: [],
        leases: [],
      };
      for (const operation of transaction.operations) {
        const applied = applyMutation(staged, operation, committedAt, {
          records: result.records as StateRecord[],
          deletedRecords: result.deletedRecords as {
            collection: string;
            key: string;
            version: number;
          }[],
          events: result.events as StateEvent[],
          leases: result.leases as StateLease[],
        });
        if (!applied.ok) return applied;
      }
      if (
        Buffer.byteLength(canonicalJson(result), "utf8") > maxTransactionBytes
      ) {
        return stateFailure(
          "TRANSACTION_TOO_LARGE",
          `Transaction result exceeds ${maxTransactionBytes} byte limit`,
        );
      }
      staged.receipts.set(transaction.transactionId, {
        request,
        result: structuredClone(result),
      });
      state = staged;
      return success(structuredClone(result));
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
      if (query.type === "record") {
        return success({
          type: "record" as const,
          record: structuredClone(
            state.records.get(recordId(query.collection, query.key)) ?? null,
          ),
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
        const records = [...state.records.values()]
          .filter(
            (record) =>
              record.collection === query.collection &&
              (query.afterKey === undefined || record.key > query.afterKey) &&
              (query.keyPrefix === undefined ||
                record.key.startsWith(query.keyPrefix)),
          )
          .sort((left, right) => left.key.localeCompare(right.key))
          .slice(0, limit);
        return success({
          type: "records" as const,
          records: structuredClone(records),
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
        const events = state.events
          .filter(
            (event) =>
              event.stream === query.stream &&
              event.position > (query.afterPosition ?? 0),
          )
          .slice(0, limit);
        return success({
          type: "events" as const,
          events: structuredClone(events),
        });
      }
      return success({
        type: "lease" as const,
        lease: structuredClone(state.leases.get(query.resource) ?? null),
      });
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
      if (
        (request.transactionIdPrefixes === undefined) !==
        (request.transactionsBefore === undefined)
      ) {
        return stateFailure(
          "INVALID_REQUEST",
          "Transaction compaction requires both a cutoff and explicit ID prefixes",
        );
      }
      for (const identifiers of [
        request.eventIds,
        request.recordHeadCollections,
        request.transactionIdPrefixes,
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
      const limit =
        request.limit ??
        (request.eventIdsBefore !== undefined ||
        request.recordHeadCollections !== undefined ||
        request.transactionIdPrefixes !== undefined
          ? DEFAULT_COMPACT_MAX_LIMIT
          : Number.POSITIVE_INFINITY);
      const requestedEventIds =
        request.eventIds === undefined ? undefined : new Set(request.eventIds);
      const retiredEvents =
        request.eventIdsBefore === undefined
          ? []
          : state.events
              .filter(
                (event) =>
                  event.occurredAt < request.eventIdsBefore! &&
                  (requestedEventIds === undefined ||
                    requestedEventIds.has(event.eventId)),
              )
              .slice(0, limit);
      const retiredSequences = new Set(
        retiredEvents.map(({ sequence }) => sequence),
      );
      let deletedEventIds = 0;
      if (request.eventIdsBefore !== undefined) {
        for (const { eventId } of retiredEvents) {
          if (state.eventIds.delete(eventId)) deletedEventIds += 1;
        }
      }
      if (retiredSequences.size > 0) {
        state.events = state.events.filter(
          ({ sequence }) => !retiredSequences.has(sequence),
        );
      }
      const compactedEvents =
        request.eventsBefore === undefined
          ? []
          : state.events
              .filter((event) => event.occurredAt < request.eventsBefore!)
              .slice(0, limit);
      if (compactedEvents.length > 0) {
        const sequences = new Set(
          compactedEvents.map(({ sequence }) => sequence),
        );
        state.events = state.events.filter(
          ({ sequence }) => !sequences.has(sequence),
        );
      }

      let deletedRecordHeads = 0;
      if (request.recordHeadCollections !== undefined) {
        const collections = new Set(request.recordHeadCollections);
        for (const id of state.recordVersions.keys()) {
          if (deletedRecordHeads >= limit) break;
          const separator = id.indexOf("\u0000");
          if (
            collections.has(id.slice(0, separator)) &&
            !state.records.has(id)
          ) {
            state.recordVersions.delete(id);
            deletedRecordHeads += 1;
          }
        }
      }

      const beforeTransactions = state.receipts.size;
      if (
        request.transactionsBefore !== undefined &&
        request.transactionIdPrefixes !== undefined
      ) {
        for (const [id, receipt] of state.receipts) {
          if (beforeTransactions - state.receipts.size >= limit) break;
          if (
            receipt.result.committedAt < request.transactionsBefore &&
            request.transactionIdPrefixes.some((prefix) =>
              id.startsWith(prefix),
            )
          ) {
            state.receipts.delete(id);
          }
        }
      }
      return success({
        deletedEvents: retiredEvents.length + compactedEvents.length,
        deletedTransactions: beforeTransactions - state.receipts.size,
        ...(request.eventIdsBefore === undefined ? {} : { deletedEventIds }),
        ...(request.recordHeadCollections === undefined
          ? {}
          : { deletedRecordHeads }),
      });
    },

    async export(request: import("./state-store.ts").StateExportRequest) {
      if (request.format === "sqlite-backup") {
        return stateFailure(
          "UNSUPPORTED_EXPORT",
          "The memory adapter cannot create a SQLite backup",
        );
      }
      if (
        state.records.size + state.events.length + state.leases.size >
        maxSnapshotEntries
      ) {
        return stateFailure(
          "EXPORT_TOO_LARGE",
          `Snapshot exceeds ${maxSnapshotEntries} entry limit`,
        );
      }
      return success({
        format: "snapshot" as const,
        snapshot: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          exportedAt: Math.floor(now()),
          records: structuredClone([...state.records.values()]),
          events: structuredClone(state.events),
          leases: structuredClone([...state.leases.values()]),
        },
      });
    },

    async diagnose() {
      return success({
        adapter: "memory" as const,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        integrity: "ok" as const,
        journalMode: "memory" as const,
        counts: {
          records: state.records.size,
          events: state.events.length,
          leases: state.leases.size,
          transactions: state.receipts.size,
        },
        issues: [],
      });
    },
  } satisfies import("./state-store.ts").StateStore;
}
