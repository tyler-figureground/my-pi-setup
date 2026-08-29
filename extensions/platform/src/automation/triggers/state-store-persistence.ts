import { createHash } from "node:crypto";
import { failure, success, type JsonObject } from "../../core/result.ts";
import type {
  StateLease,
  StateMutation,
  StateRecord,
  StateStore,
  StateStoreError,
  StateTransaction,
} from "../../core/persistence/state-store.ts";
import type {
  TriggerDurableRecord,
  TriggerPersistenceErrorCode,
  TriggerPersistencePort,
} from "./persistence.ts";
import { hasExactKeys, isPlainData } from "./validation.ts";

const EVENT_COLLECTION = "automation.triggers.events";
const DELIVERY_COLLECTION = "automation.triggers.deliveries";
const QUARANTINE_COLLECTION = "automation.triggers.quarantine";
const EVENT_STREAM = "automation.triggers.retention";
const LEASE_PREFIX = "automation.triggers.event:";
const TRANSACTION_PREFIX = "trigger-persistence.";
const TRANSACTION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const MAINTENANCE_LIMIT = 128;

export interface StateStoreTriggerPersistenceOptions {
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
  readonly maxRetries?: number;
}

function persistenceFailure(
  code: TriggerPersistenceErrorCode,
  message: string,
  retryable: boolean,
) {
  return failure({ code, message, retryable });
}

function digest(...parts: readonly (number | string)[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const text = String(part);
    hash.update(String(Buffer.byteLength(text)));
    hash.update(":");
    hash.update(text);
  }
  return hash.digest("hex");
}

function transactionId(kind: string, ...parts: readonly (number | string)[]) {
  return `${TRANSACTION_PREFIX}${kind}:${digest(...parts)}`;
}

function leaseResource(eventId: string) {
  return `${LEASE_PREFIX}${digest(eventId)}`;
}

function retentionEventId(eventId: string) {
  return `${TRANSACTION_PREFIX}event:${digest(eventId)}`;
}

function deliveryKey(eventId: string, bindingKey: string) {
  return `${digest(eventId)}:${digest(bindingKey)}`;
}

const DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "timed-out",
  "fenced",
  "closed",
  "superseded",
  "acknowledged",
  "ambiguous",
] as const;

type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

interface DeliveryState {
  readonly schemaVersion: 1;
  readonly attemptKey: string;
  readonly bindingGeneration: number;
  readonly fence: number;
  readonly status: DeliveryStatus;
}

function decodeDeliveryState(value: unknown) {
  if (
    !isPlainData(value, { maxDepth: 2, maxNodes: 8 }) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "attemptKey",
      "bindingGeneration",
      "fence",
      "status",
    ])
  ) {
    return undefined;
  }
  const delivery = value as unknown as DeliveryState;
  if (
    delivery.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(delivery.attemptKey) ||
    !Number.isSafeInteger(delivery.bindingGeneration) ||
    delivery.bindingGeneration < 1 ||
    !Number.isSafeInteger(delivery.fence) ||
    delivery.fence < 1 ||
    !DELIVERY_STATUSES.includes(delivery.status)
  ) {
    return undefined;
  }
  return { ...delivery };
}

function validClaimIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function validAttemptRequest(value: {
  readonly claimId: unknown;
  readonly claimantId: unknown;
  readonly fence: unknown;
  readonly attemptId: unknown;
  readonly bindingKey: unknown;
  readonly bindingGeneration: unknown;
}) {
  return (
    validClaimIdentifier(value.claimId) &&
    validClaimIdentifier(value.claimantId) &&
    typeof value.attemptId === "string" &&
    value.attemptId.length > 0 &&
    value.attemptId.length <= 512 &&
    !value.attemptId.includes("\u0000") &&
    typeof value.bindingKey === "string" &&
    /^[A-Za-z0-9._:-]{1,256}$/.test(value.bindingKey) &&
    Number.isSafeInteger(value.fence) &&
    Number(value.fence) > 0 &&
    Number.isSafeInteger(value.bindingGeneration) &&
    Number(value.bindingGeneration) > 0
  );
}

function snapshotDurableRecord(value: unknown) {
  if (
    !isPlainData(value, { maxDepth: 2, maxNodes: 8 }) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "eventId",
      "type",
      "occurredAt",
      "sourceKey",
      "payloadDigest",
    ])
  ) {
    return undefined;
  }
  const record = value as unknown as TriggerDurableRecord;
  if (
    record.schemaVersion !== 1 ||
    typeof record.eventId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(record.eventId) ||
    typeof record.type !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,256}$/.test(record.type) ||
    !Number.isSafeInteger(record.occurredAt) ||
    record.occurredAt < 0 ||
    typeof record.sourceKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sourceKey) ||
    typeof record.payloadDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.payloadDigest)
  ) {
    return undefined;
  }
  const snapshot = {
    schemaVersion: 1 as const,
    eventId: record.eventId,
    type: record.type,
    occurredAt: record.occurredAt,
    sourceKey: record.sourceKey,
    payloadDigest: record.payloadDigest,
  };
  return Buffer.byteLength(JSON.stringify(snapshot)) <= 1_024
    ? snapshot
    : undefined;
}

function mapStateError(
  error: StateStoreError,
  fallback: "READ_FAILED" | "WRITE_FAILED" | "CLAIM_FAILED",
) {
  if (error.code === "LEASE_LOST") {
    return persistenceFailure(
      "FENCE_REJECTED",
      "Durable trigger claim fence is stale.",
      false,
    );
  }
  return persistenceFailure(fallback, error.message, error.retryable);
}

export function createStateStoreTriggerPersistence(
  state: StateStore,
  options: StateStoreTriggerPersistenceOptions = {},
) {
  const busyTimeoutMs = options.busyTimeoutMs ?? 50;
  const maxRetries = options.maxRetries ?? 3;
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 5_000 ||
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 1 ||
    maxRetries > 8
  ) {
    throw new TypeError("Trigger persistence retry options are invalid.");
  }
  const writeState = state.withBusyTimeout?.(busyTimeoutMs) ?? state;
  let lastMaintenanceAt = Number.NEGATIVE_INFINITY;
  let maintenanceTail = Promise.resolve();
  const maintenanceAfterKey = new Map<string, string>();

  const transact = async (transaction: StateTransaction) => {
    let last;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        last = await writeState.transact(transaction);
      } catch (error) {
        last = {
          ok: false as const,
          error: {
            code: "STORAGE_FAILED" as const,
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        };
      }
      if (
        last.ok ||
        !last.error.retryable ||
        last.error.code !== "STORAGE_FAILED"
      ) {
        return last;
      }
    }
    return last!;
  };

  const query = async (request: Parameters<StateStore["query"]>[0]) => {
    try {
      return await state.query(request);
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code: "STORAGE_FAILED" as const,
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  };

  const readEvent = async (eventId: string) => {
    const loaded = await query({
      type: "record",
      collection: EVENT_COLLECTION,
      key: eventId,
    });
    if (!loaded.ok) return loaded;
    if (loaded.value.type !== "record") {
      return {
        ok: false as const,
        error: {
          code: "STORAGE_FAILED" as const,
          message: "StateStore returned an unexpected trigger record result.",
          retryable: false,
        },
      };
    }
    return success(loaded.value.record);
  };

  const readLease = async (eventId: string) => {
    const loaded = await query({
      type: "lease",
      resource: leaseResource(eventId),
    });
    if (!loaded.ok) return loaded;
    if (loaded.value.type !== "lease") {
      return {
        ok: false as const,
        error: {
          code: "STORAGE_FAILED" as const,
          message: "StateStore returned an unexpected trigger lease result.",
          retryable: false,
        },
      };
    }
    return success(loaded.value.lease);
  };

  const readDelivery = async (eventId: string, bindingKey: string) => {
    const loaded = await query({
      type: "record",
      collection: DELIVERY_COLLECTION,
      key: deliveryKey(eventId, bindingKey),
    });
    if (!loaded.ok) return loaded;
    if (loaded.value.type !== "record") {
      return {
        ok: false as const,
        error: {
          code: "STORAGE_FAILED" as const,
          message: "StateStore returned an unexpected trigger delivery result.",
          retryable: false,
        },
      };
    }
    return success(loaded.value.record);
  };

  const currentClaim = async (request: {
    readonly claimId: string;
    readonly claimantId: string;
    readonly fence: number;
  }) => {
    const [record, lease] = await Promise.all([
      readEvent(request.claimId),
      readLease(request.claimId),
    ]);
    if (!record.ok) return record;
    if (!lease.ok) return lease;
    const checkedAt = options.now?.() ?? Date.now();
    if (
      !record.value ||
      !lease.value ||
      lease.value.owner !== request.claimantId ||
      lease.value.fence !== request.fence ||
      lease.value.expiresAt <= checkedAt
    ) {
      return success(null);
    }
    return success({ record: record.value, lease: lease.value, checkedAt });
  };

  const renewClaim = (
    claim: { readonly lease: StateLease; readonly checkedAt: number },
    claimantId: string,
  ) => {
    const ttlMs = claim.lease.expiresAt - claim.checkedAt;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return undefined;
    return {
      type: "renew-lease",
      resource: claim.lease.resource,
      owner: claimantId,
      fence: claim.lease.fence,
      ttlMs,
    } satisfies StateMutation;
  };

  const claimExisting = async (
    initial: StateRecord,
    request: {
      readonly claimantId: string;
      readonly now: number;
      readonly leaseUntil: number;
    },
  ) => {
    let record: StateRecord | null = initial;
    for (let attempt = 0; attempt < maxRetries && record; attempt++) {
      const loadedLease = await readLease(record.key);
      if (!loadedLease.ok) return loadedLease;
      const current = loadedLease.value;
      const ttlMs = request.leaseUntil - request.now;
      const leaseOperation: StateMutation =
        current?.owner === request.claimantId && current.expiresAt > request.now
          ? {
              type: "renew-lease",
              resource: leaseResource(record.key),
              owner: request.claimantId,
              fence: current.fence,
              ttlMs,
              metadata: { eventKey: digest(record.key) },
            }
          : {
              type: "claim-lease",
              resource: leaseResource(record.key),
              owner: request.claimantId,
              ttlMs,
              metadata: { eventKey: digest(record.key) },
            };
      const committed = await transact({
        transactionId: transactionId(
          "claim",
          record.key,
          record.version,
          request.claimantId,
          request.now,
          request.leaseUntil,
          current?.fence ?? 0,
          current?.expiresAt ?? 0,
        ),
        operations: [
          {
            type: "check-record",
            collection: EVENT_COLLECTION,
            key: record.key,
            expectedVersion: record.version,
          },
          leaseOperation,
        ],
      });
      if (committed.ok) {
        const claimedLease = committed.value.leases.find(
          ({ resource }) => resource === leaseResource(record!.key),
        );
        if (!claimedLease) {
          return {
            ok: false as const,
            error: {
              code: "STORAGE_FAILED" as const,
              message: "StateStore returned no trigger lease fence.",
              retryable: false,
            },
          };
        }
        return success({ record, lease: claimedLease });
      }
      if (committed.error.code === "LEASE_HELD") return success(null);
      if (committed.error.code !== "VERSION_CONFLICT") return committed;
      const refreshed = await readEvent(record.key);
      if (!refreshed.ok) return refreshed;
      record = refreshed.value;
    }
    return success(null);
  };

  const maintain = (maintenanceNow: number) => {
    if (maintenanceNow - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) {
      return maintenanceTail;
    }
    lastMaintenanceAt = maintenanceNow;
    const next = maintenanceTail.then(async () => {
      const cutoff = maintenanceNow - RECORD_RETENTION_MS;
      const expired: StateRecord[] = [];
      for (const collection of [
        EVENT_COLLECTION,
        DELIVERY_COLLECTION,
        QUARANTINE_COLLECTION,
      ]) {
        const afterKey = maintenanceAfterKey.get(collection);
        const loaded = await query({
          type: "records",
          collection,
          ...(afterKey === undefined ? {} : { afterKey }),
          limit: MAINTENANCE_LIMIT,
        });
        if (!loaded.ok || loaded.value.type !== "records") continue;
        const last = loaded.value.records.at(-1);
        if (!last || loaded.value.records.length < MAINTENANCE_LIMIT) {
          maintenanceAfterKey.delete(collection);
        } else {
          maintenanceAfterKey.set(collection, last.key);
        }
        expired.push(
          ...loaded.value.records.filter(({ updatedAt }) => updatedAt < cutoff),
        );
      }
      const selected = expired.slice(0, MAINTENANCE_LIMIT);
      let deletedEventIds: string[] = [];
      if (selected.length > 0) {
        const deleted = await transact({
          transactionId: transactionId(
            "maintenance-records",
            maintenanceNow,
            ...selected.flatMap(({ collection, key, version }) => [
              collection,
              key,
              version,
            ]),
          ),
          operations: selected.map(({ collection, key, version }) => ({
            type: "delete-record" as const,
            collection,
            key,
            expectedVersion: version,
          })),
        });
        if (deleted.ok) {
          deletedEventIds = selected
            .filter(({ collection }) => collection === EVENT_COLLECTION)
            .map(({ key }) => retentionEventId(key));
        }
      }
      try {
        await writeState.compact({
          transactionsBefore: maintenanceNow - TRANSACTION_RETENTION_MS,
          transactionIdPrefixes: [TRANSACTION_PREFIX],
          ...(deletedEventIds.length === 0
            ? {}
            : {
                eventIdsBefore: cutoff,
                eventIds: deletedEventIds,
              }),
          recordHeadCollections: [
            EVENT_COLLECTION,
            DELIVERY_COLLECTION,
            QUARANTINE_COLLECTION,
          ],
          limit: MAINTENANCE_LIMIT,
        });
      } catch {}
    });
    maintenanceTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    async store(request) {
      const record = snapshotDurableRecord(request.record);
      const ttlMs = request.leaseUntil - request.now;
      if (
        !record ||
        !/^[A-Za-z0-9._:-]{1,256}$/.test(request.claimantId) ||
        !Number.isSafeInteger(request.now) ||
        !Number.isSafeInteger(request.leaseUntil) ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs <= 0
      ) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger store request is invalid.",
          false,
        );
      }
      await maintain(request.now);
      const metadata = { ...record } satisfies JsonObject;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const existing = await readEvent(record.eventId);
        if (!existing.ok) return mapStateError(existing.error, "WRITE_FAILED");
        if (existing.value) {
          const existingRecord = snapshotDurableRecord(existing.value.metadata);
          if (
            !existingRecord ||
            JSON.stringify(existingRecord) !== JSON.stringify(record)
          ) {
            return persistenceFailure(
              "WRITE_FAILED",
              "Durable trigger event identity conflicts with stored metadata.",
              false,
            );
          }
          const claimed = await claimExisting(existing.value, request);
          if (!claimed.ok) return mapStateError(claimed.error, "CLAIM_FAILED");
          if (!claimed.value) {
            return persistenceFailure(
              "CLAIM_FAILED",
              "Durable trigger event is claimed by another runtime.",
              true,
            );
          }
          return success({
            claimId: record.eventId,
            fence: claimed.value.lease.fence,
            record,
          });
        }
        const committed = await transact({
          transactionId: transactionId(
            "store",
            record.eventId,
            JSON.stringify(record),
            request.claimantId,
            request.now,
            request.leaseUntil,
          ),
          operations: [
            {
              type: "put-record",
              collection: EVENT_COLLECTION,
              key: record.eventId,
              metadata,
              expectedVersion: null,
            },
            {
              type: "append-event",
              stream: EVENT_STREAM,
              eventId: retentionEventId(record.eventId),
              eventType: "stored",
              metadata: { eventKey: digest(record.eventId) },
            },
            {
              type: "claim-lease",
              resource: leaseResource(record.eventId),
              owner: request.claimantId,
              ttlMs,
              metadata: { eventKey: digest(record.eventId) },
            },
          ],
        });
        if (!committed.ok) {
          if (committed.error.code === "VERSION_CONFLICT") continue;
          return mapStateError(committed.error, "WRITE_FAILED");
        }
        const fence = committed.value.leases[0]?.fence;
        if (fence === undefined) {
          return persistenceFailure(
            "WRITE_FAILED",
            "StateStore returned no trigger lease fence.",
            false,
          );
        }
        return success({ claimId: record.eventId, fence, record });
      }
      return persistenceFailure(
        "WRITE_FAILED",
        "Durable trigger store conflicted repeatedly.",
        true,
      );
    },

    async claimPage(request) {
      const ttlMs = request.leaseUntil - request.now;
      if (
        !/^[A-Za-z0-9._:-]{1,256}$/.test(request.claimantId) ||
        !Number.isSafeInteger(request.now) ||
        !Number.isSafeInteger(request.leaseUntil) ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs <= 0 ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 128 ||
        (request.cursor !== undefined &&
          !/^[A-Za-z0-9._:-]{1,256}$/.test(request.cursor))
      ) {
        return persistenceFailure(
          "READ_FAILED",
          "Durable trigger page request is invalid.",
          false,
        );
      }
      await maintain(request.now);
      const loaded = await query({
        type: "records",
        collection: EVENT_COLLECTION,
        ...(request.cursor === undefined ? {} : { afterKey: request.cursor }),
        limit: 128,
      });
      if (!loaded.ok) return mapStateError(loaded.error, "READ_FAILED");
      if (loaded.value.type !== "records") {
        return persistenceFailure(
          "READ_FAILED",
          "StateStore returned an unexpected trigger page result.",
          false,
        );
      }
      const claims: Array<{
        claimId: string;
        fence: number;
        record: unknown;
      }> = [];
      let lastScanned: StateRecord | undefined;
      for (const candidate of loaded.value.records) {
        lastScanned = candidate;
        const claimed = await claimExisting(candidate, request);
        if (!claimed.ok) return mapStateError(claimed.error, "CLAIM_FAILED");
        if (claimed.value) {
          claims.push({
            claimId: claimed.value.record.key,
            fence: claimed.value.lease.fence,
            record: structuredClone(claimed.value.record.metadata),
          });
        }
        if (claims.length === request.limit) break;
      }
      const scannedAll =
        lastScanned === loaded.value.records.at(-1) &&
        loaded.value.records.length < 128;
      return success({
        claims,
        ...(scannedAll || !lastScanned ? {} : { nextCursor: lastScanned.key }),
      });
    },

    async beginAttempt(request) {
      if (!validAttemptRequest(request)) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger attempt request is invalid.",
          false,
        );
      }
      const attemptKey = digest(request.attemptId);
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const claim = await currentClaim(request);
        if (!claim.ok) return mapStateError(claim.error, "WRITE_FAILED");
        if (!claim.value) {
          return persistenceFailure(
            "FENCE_REJECTED",
            "Durable trigger claim fence is stale.",
            false,
          );
        }
        const current = await readDelivery(request.claimId, request.bindingKey);
        if (!current.ok) return mapStateError(current.error, "WRITE_FAILED");
        const delivery = current.value
          ? decodeDeliveryState(current.value.metadata)
          : undefined;
        if (current.value && !delivery) {
          return persistenceFailure(
            "WRITE_FAILED",
            "Durable trigger delivery metadata is corrupt.",
            false,
          );
        }
        const disposition =
          delivery?.status === "delivered"
            ? ("already-delivered" as const)
            : delivery?.status === "pending" &&
                (delivery.attemptKey !== attemptKey ||
                  delivery.bindingGeneration !== request.bindingGeneration ||
                  delivery.fence !== request.fence)
              ? ("ambiguous" as const)
              : ("started" as const);
        const renew = renewClaim(claim.value, request.claimantId);
        if (!renew) {
          return persistenceFailure(
            "FENCE_REJECTED",
            "Durable trigger claim fence is stale.",
            false,
          );
        }
        const shouldWrite =
          disposition === "started" &&
          !(
            delivery?.status === "pending" &&
            delivery.attemptKey === attemptKey &&
            delivery.bindingGeneration === request.bindingGeneration &&
            delivery.fence === request.fence
          );
        const pending = {
          schemaVersion: 1 as const,
          attemptKey,
          bindingGeneration: request.bindingGeneration,
          fence: request.fence,
          status: "pending" as const,
        } satisfies JsonObject;
        const committed = await transact({
          transactionId: transactionId(
            "begin",
            request.claimId,
            request.claimantId,
            request.fence,
            attemptKey,
            request.bindingKey,
            request.bindingGeneration,
            current.value?.version ?? 0,
            disposition,
          ),
          operations: [
            ...(shouldWrite
              ? ([
                  {
                    type: "put-record" as const,
                    collection: DELIVERY_COLLECTION,
                    key: deliveryKey(request.claimId, request.bindingKey),
                    metadata: pending,
                    expectedVersion: current.value?.version ?? null,
                  },
                ] satisfies StateMutation[])
              : current.value
                ? ([
                    {
                      type: "check-record" as const,
                      collection: DELIVERY_COLLECTION,
                      key: current.value.key,
                      expectedVersion: current.value.version,
                    },
                  ] satisfies StateMutation[])
                : []),
            renew,
          ],
        });
        if (committed.ok) return success(disposition);
        if (committed.error.code === "VERSION_CONFLICT") continue;
        return mapStateError(committed.error, "WRITE_FAILED");
      }
      return persistenceFailure(
        "WRITE_FAILED",
        "Durable trigger attempt conflicted repeatedly.",
        true,
      );
    },

    async completeAttempt(request) {
      if (
        !validAttemptRequest(request) ||
        !DELIVERY_STATUSES.includes(request.status)
      ) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger completion request is invalid.",
          false,
        );
      }
      const attemptKey = digest(request.attemptId);
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const claim = await currentClaim(request);
        if (!claim.ok) return mapStateError(claim.error, "WRITE_FAILED");
        const current = await readDelivery(request.claimId, request.bindingKey);
        if (!current.ok) return mapStateError(current.error, "WRITE_FAILED");
        const delivery = current.value
          ? decodeDeliveryState(current.value.metadata)
          : undefined;
        if (
          !claim.value ||
          !current.value ||
          !delivery ||
          delivery.status !== "pending" ||
          delivery.attemptKey !== attemptKey ||
          delivery.bindingGeneration !== request.bindingGeneration ||
          delivery.fence !== request.fence
        ) {
          return persistenceFailure(
            "FENCE_REJECTED",
            "Durable trigger attempt fence is stale.",
            false,
          );
        }
        const renew = renewClaim(claim.value, request.claimantId);
        if (!renew) {
          return persistenceFailure(
            "FENCE_REJECTED",
            "Durable trigger attempt fence is stale.",
            false,
          );
        }
        const completed = {
          ...delivery,
          status: request.status,
        } satisfies JsonObject;
        const committed = await transact({
          transactionId: transactionId(
            "complete",
            request.claimId,
            request.claimantId,
            request.fence,
            attemptKey,
            request.bindingKey,
            request.bindingGeneration,
            request.status,
            current.value.version,
          ),
          operations: [
            {
              type: "put-record",
              collection: DELIVERY_COLLECTION,
              key: current.value.key,
              metadata: completed,
              expectedVersion: current.value.version,
            },
            renew,
          ],
        });
        if (committed.ok) return success(undefined);
        if (committed.error.code === "VERSION_CONFLICT") continue;
        return mapStateError(committed.error, "WRITE_FAILED");
      }
      return persistenceFailure(
        "WRITE_FAILED",
        "Durable trigger completion conflicted repeatedly.",
        true,
      );
    },

    async releaseClaim(request) {
      if (
        !validClaimIdentifier(request.claimId) ||
        !validClaimIdentifier(request.claimantId) ||
        !Number.isSafeInteger(request.fence) ||
        request.fence < 1
      ) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger release request is invalid.",
          false,
        );
      }
      const committed = await transact({
        transactionId: transactionId(
          "release",
          request.claimId,
          request.claimantId,
          request.fence,
        ),
        operations: [
          {
            type: "release-lease",
            resource: leaseResource(request.claimId),
            owner: request.claimantId,
            fence: request.fence,
          },
        ],
      });
      if (!committed.ok) return mapStateError(committed.error, "WRITE_FAILED");
      return success(undefined);
    },

    async quarantine(request) {
      if (
        !validClaimIdentifier(request.claimId) ||
        !validClaimIdentifier(request.claimantId) ||
        !Number.isSafeInteger(request.fence) ||
        request.fence < 1 ||
        ![
          "claim-invalid",
          "record-invalid",
          "record-oversized",
          "source-unbound",
        ].includes(request.reason)
      ) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger quarantine request is invalid.",
          false,
        );
      }
      const claim = await currentClaim(request);
      if (!claim.ok) return mapStateError(claim.error, "WRITE_FAILED");
      if (!claim.value) {
        return persistenceFailure(
          "FENCE_REJECTED",
          "Durable trigger claim fence is stale.",
          false,
        );
      }
      const quarantinedAt = options.now?.() ?? Date.now();
      const committed = await transact({
        transactionId: transactionId(
          "quarantine",
          request.claimId,
          request.claimantId,
          request.fence,
          request.reason,
        ),
        operations: [
          {
            type: "delete-record",
            collection: EVENT_COLLECTION,
            key: request.claimId,
            expectedVersion: claim.value.record.version,
          },
          {
            type: "put-record",
            collection: QUARANTINE_COLLECTION,
            key: request.claimId,
            metadata: {
              schemaVersion: 1,
              reason: request.reason,
              quarantinedAt,
            },
            expectedVersion: null,
          },
          {
            type: "release-lease",
            resource: leaseResource(request.claimId),
            owner: request.claimantId,
            fence: request.fence,
          },
        ],
      });
      if (!committed.ok) return mapStateError(committed.error, "WRITE_FAILED");
      return success(undefined);
    },
  } satisfies TriggerPersistencePort;
}
