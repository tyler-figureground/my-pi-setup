import { createHash, timingSafeEqual } from "node:crypto";
import { failure, success } from "../../core/result.ts";
import type { JsonObject, ModuleError, Outcome } from "../../core/result.ts";
import type { TriggerDeliveryResult } from "./model.ts";
import { hasExactKeys, isPlainData } from "./validation.ts";

export type TriggerPersistenceErrorCode =
  "READ_FAILED" | "WRITE_FAILED" | "CLAIM_FAILED" | "FENCE_REJECTED";

export interface TriggerPersistenceError extends ModuleError<TriggerPersistenceErrorCode> {}

export type TriggerPersistenceOutcome<T> = Outcome<T, TriggerPersistenceError>;

export const TRIGGER_DURABLE_RECORD_MAX_BYTES = 48 * 1_024;

export interface TriggerDurableRecord {
  readonly schemaVersion: 2;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: number;
  readonly sourceKey: string;
  readonly payload: JsonObject;
  readonly payloadDigest: string;
  readonly cause: {
    readonly rootEventId: string;
    readonly parentEventId?: string;
    readonly ancestry: readonly string[];
  };
}

export interface TriggerPersistenceClaim {
  readonly claimId: string;
  readonly fence: number;
  readonly record: unknown;
}

export interface TriggerPersistenceStoreRequest {
  readonly record: TriggerDurableRecord;
  readonly claimantId: string;
  readonly now: number;
  readonly leaseUntil: number;
}

export interface TriggerPersistenceClaimPageRequest {
  readonly claimantId: string;
  readonly now: number;
  readonly leaseUntil: number;
  readonly limit: number;
  readonly cursor?: string;
}

export interface TriggerPersistenceClaimPage {
  readonly claims: readonly unknown[];
  readonly nextCursor?: string;
}

export interface TriggerPersistenceAttemptRequest {
  readonly claimId: string;
  readonly claimantId: string;
  readonly fence: number;
  readonly attemptId: string;
  readonly bindingKey: string;
  readonly bindingGeneration: number;
}

export type TriggerPersistenceAttemptDisposition =
  "started" | "already-delivered" | "ambiguous";

export interface TriggerPersistenceCompleteRequest extends TriggerPersistenceAttemptRequest {
  readonly status: TriggerDeliveryResult["status"];
}

export interface TriggerPersistenceClaimRequest {
  readonly claimId: string;
  readonly claimantId: string;
  readonly fence: number;
}

export interface TriggerPersistenceQuarantineRequest extends TriggerPersistenceClaimRequest {
  readonly reason:
    "claim-invalid" | "record-invalid" | "record-oversized" | "source-unbound";
}

export interface TriggerPersistencePort {
  store(
    request: TriggerPersistenceStoreRequest,
  ): Promise<TriggerPersistenceOutcome<TriggerPersistenceClaim>>;
  claimPage(
    request: TriggerPersistenceClaimPageRequest,
  ): Promise<TriggerPersistenceOutcome<TriggerPersistenceClaimPage>>;
  beginAttempt(
    request: TriggerPersistenceAttemptRequest,
  ): Promise<TriggerPersistenceOutcome<TriggerPersistenceAttemptDisposition>>;
  completeAttempt(
    request: TriggerPersistenceCompleteRequest,
  ): Promise<TriggerPersistenceOutcome<void>>;
  releaseClaim(
    request: TriggerPersistenceClaimRequest,
  ): Promise<TriggerPersistenceOutcome<void>>;
  quarantine(
    request: TriggerPersistenceQuarantineRequest,
  ): Promise<TriggerPersistenceOutcome<void>>;
}

interface MemoryAttempt {
  readonly bindingKey: string;
  readonly bindingGeneration: number;
  readonly fence: number;
  status: TriggerDeliveryResult["status"] | "pending";
}

interface MemoryRecord {
  readonly record: TriggerDurableRecord;
  fence: number;
  claim?: { readonly claimantId: string; leaseUntil: number };
  readonly attempts: Map<string, MemoryAttempt>;
  readonly receipts: Set<string>;
  quarantined?: TriggerPersistenceQuarantineRequest["reason"];
}

function persistenceFailure(
  code: TriggerPersistenceErrorCode,
  message: string,
  retryable: boolean,
) {
  return failure({ code, message, retryable });
}

function claimEnvelope(stored: MemoryRecord): TriggerPersistenceClaim {
  return {
    claimId: stored.record.eventId,
    fence: stored.fence,
    record: structuredClone(stored.record),
  };
}

const SECRET_FIELD =
  /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|token|session|bearer|oauth|credential|client[-_]?secret|api[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|oauth[-_]?code|authorization[-_]?code|code[-_]?verifier|signature|sig)$/i;
const SECRET_ASSIGNMENT =
  /(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|token|session|bearer|oauth|credential|client[-_]?secret|api[-_]?key|session[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer[-_]?token|oauth[-_]?code|authorization[-_]?code|code[-_]?verifier|signature|sig)\s*[:=]/i;

function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === "string") {
    return (
      SECRET_ASSIGNMENT.test(value) ||
      /\bbearer\s+[a-z0-9._~+\-/]+=*/i.test(value) ||
      /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/i.test(
        value,
      ) ||
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+(?::[^\s/@]*)?@/i.test(value)
    );
  }
  if (Array.isArray(value))
    return value.some((item) => containsSecret(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => SECRET_FIELD.test(key) || containsSecret(item, depth + 1),
  );
}

export function triggerPayloadDigest(payload: JsonObject) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function snapshotTriggerDurableRecord(value: unknown) {
  if (
    !isPlainData(value, { maxDepth: 20, maxNodes: 10_000 }) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "eventId",
      "type",
      "occurredAt",
      "sourceKey",
      "payload",
      "payloadDigest",
      "cause",
    ]) ||
    Object.keys(value).length !== 8
  ) {
    return undefined;
  }
  const record = value as unknown as TriggerDurableRecord;
  if (
    record.schemaVersion !== 2 ||
    typeof record.eventId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(record.eventId) ||
    typeof record.type !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,256}$/.test(record.type) ||
    !Number.isSafeInteger(record.occurredAt) ||
    record.occurredAt < 0 ||
    typeof record.sourceKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sourceKey) ||
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload) ||
    containsSecret(record.payload) ||
    typeof record.payloadDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.payloadDigest) ||
    !record.cause ||
    typeof record.cause !== "object" ||
    Array.isArray(record.cause) ||
    !hasExactKeys(record.cause as unknown as Record<string, unknown>, [
      "rootEventId",
      "parentEventId",
      "ancestry",
    ]) ||
    Object.keys(record.cause).length !==
      (record.cause.parentEventId === undefined ? 2 : 3) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(record.cause.rootEventId) ||
    (record.cause.parentEventId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,256}$/.test(record.cause.parentEventId)) ||
    !Array.isArray(record.cause.ancestry) ||
    record.cause.ancestry.length > 16 ||
    record.cause.ancestry.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > 513 ||
        /[\u0000-\u001f\u007f]/.test(entry),
    )
  ) {
    return undefined;
  }
  const expectedDigest = triggerPayloadDigest(record.payload);
  if (
    !timingSafeEqual(
      Buffer.from(record.payloadDigest, "hex"),
      Buffer.from(expectedDigest, "hex"),
    )
  ) {
    return undefined;
  }
  const snapshot = structuredClone(record);
  return Buffer.byteLength(JSON.stringify(snapshot)) <=
    TRIGGER_DURABLE_RECORD_MAX_BYTES
    ? snapshot
    : undefined;
}

export function createMemoryTriggerPersistence(
  options: { readonly maxRecords?: number } = {},
) {
  const records = new Map<string, MemoryRecord>();
  const maxRecords = options.maxRecords ?? 4_096;

  const claimed = (request: TriggerPersistenceClaimRequest) => {
    const stored = records.get(request.claimId);
    if (
      !stored ||
      stored.quarantined !== undefined ||
      stored.fence !== request.fence ||
      stored.claim?.claimantId !== request.claimantId
    ) {
      return undefined;
    }
    return stored;
  };

  return {
    async store(request) {
      const record = snapshotTriggerDurableRecord(request.record);
      if (!record) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger metadata is invalid.",
          false,
        );
      }
      const serialized = JSON.stringify(record);
      let stored = records.get(record.eventId);
      if (!stored) {
        if (records.size >= maxRecords) {
          return persistenceFailure(
            "WRITE_FAILED",
            "Durable trigger record capacity reached.",
            true,
          );
        }
        stored = {
          record,
          fence: 0,
          attempts: new Map(),
          receipts: new Set(),
        };
        records.set(record.eventId, stored);
      } else if (JSON.stringify(stored.record) !== serialized) {
        return persistenceFailure(
          "WRITE_FAILED",
          "Durable trigger event identity conflicts with stored metadata.",
          false,
        );
      }
      if (
        stored.claim &&
        stored.claim.claimantId !== request.claimantId &&
        stored.claim.leaseUntil > request.now
      ) {
        return persistenceFailure(
          "CLAIM_FAILED",
          "Durable trigger event is claimed by another runtime.",
          true,
        );
      }
      stored.fence++;
      stored.claim = {
        claimantId: request.claimantId,
        leaseUntil: request.leaseUntil,
      };
      return success(claimEnvelope(stored));
    },

    async claimPage(request) {
      if (
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 128
      ) {
        return persistenceFailure(
          "READ_FAILED",
          "Durable trigger page limit is invalid.",
          false,
        );
      }
      const candidates = [...records.values()]
        .filter(
          ({ record, quarantined }) =>
            quarantined === undefined &&
            (request.cursor === undefined || record.eventId > request.cursor),
        )
        .sort((left, right) =>
          left.record.eventId.localeCompare(right.record.eventId),
        );
      const claims: TriggerPersistenceClaim[] = [];
      let scanned = 0;
      for (const stored of candidates) {
        scanned++;
        if (
          stored.claim &&
          stored.claim.claimantId !== request.claimantId &&
          stored.claim.leaseUntil > request.now
        ) {
          continue;
        }
        if (stored.claim?.claimantId !== request.claimantId) stored.fence++;
        stored.claim = {
          claimantId: request.claimantId,
          leaseUntil: request.leaseUntil,
        };
        claims.push(claimEnvelope(stored));
        if (claims.length === request.limit) break;
      }
      const lastScanned = candidates[scanned - 1];
      const nextCursor =
        lastScanned && scanned < candidates.length
          ? lastScanned.record.eventId
          : undefined;
      return success({
        claims,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      });
    },

    async beginAttempt(request) {
      const stored = claimed(request);
      if (!stored) {
        return persistenceFailure(
          "FENCE_REJECTED",
          "Durable trigger claim fence is stale.",
          false,
        );
      }
      if (stored.receipts.has(request.bindingKey)) {
        return success("already-delivered" as const);
      }
      if (
        [...stored.attempts.values()].some(
          (attempt) =>
            attempt.bindingKey === request.bindingKey &&
            attempt.status === "pending",
        )
      ) {
        return success("ambiguous" as const);
      }
      stored.attempts.set(request.attemptId, {
        bindingKey: request.bindingKey,
        bindingGeneration: request.bindingGeneration,
        fence: request.fence,
        status: "pending",
      });
      return success("started" as const);
    },

    async completeAttempt(request) {
      const stored = claimed(request);
      const attempt = stored?.attempts.get(request.attemptId);
      if (
        !stored ||
        !attempt ||
        attempt.status !== "pending" ||
        attempt.bindingKey !== request.bindingKey ||
        attempt.bindingGeneration !== request.bindingGeneration ||
        attempt.fence !== request.fence
      ) {
        return persistenceFailure(
          "FENCE_REJECTED",
          "Durable trigger attempt fence is stale.",
          false,
        );
      }
      attempt.status = request.status;
      if (request.status === "delivered") {
        stored.receipts.add(request.bindingKey);
      }
      return success(undefined);
    },

    async releaseClaim(request) {
      const stored = claimed(request);
      if (!stored) {
        return persistenceFailure(
          "FENCE_REJECTED",
          "Durable trigger claim fence is stale.",
          false,
        );
      }
      stored.claim = undefined;
      return success(undefined);
    },

    async quarantine(request) {
      const stored = claimed(request);
      if (!stored) {
        return persistenceFailure(
          "FENCE_REJECTED",
          "Durable trigger claim fence is stale.",
          false,
        );
      }
      stored.quarantined = request.reason;
      stored.claim = undefined;
      return success(undefined);
    },
  } satisfies TriggerPersistencePort;
}
