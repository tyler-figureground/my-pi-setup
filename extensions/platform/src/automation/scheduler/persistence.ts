import { createHash } from "node:crypto";
import type { JsonObject } from "../../core/result.ts";
import type {
  StateRecord,
  StateStore,
} from "../../core/persistence/state-store.ts";
import type { ScheduleSnapshot } from "./model.ts";

const DEFINITION_COLLECTION_PREFIX = "scheduler.definitions";
const REQUEST_COLLECTION_PREFIX = "scheduler.requests";

export interface PersistedSchedule extends ScheduleSnapshot {
  readonly credentialReferences: readonly string[];
  readonly pendingRunNow?: {
    readonly id: string;
    readonly dueAt: string;
  };
}

export interface PersistedScheduleRequest {
  readonly digest: string;
  readonly schedule: ScheduleSnapshot;
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function storageFailure<T>() {
  return {
    ok: false as const,
    error: {
      code: "STORAGE_FAILED" as const,
      message: "Scheduler state is unavailable.",
      retryable: false,
    },
  };
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => allowed.has(key))
    ? record
    : null;
}

function boundedString(value: unknown, maximum = 4_096) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function instant(value: unknown) {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validArtifact(value: unknown) {
  const record = exact(value, ["id", "sha256", "size"], ["mediaType"]);
  return (
    !!record &&
    typeof record.id === "string" &&
    /^[a-f0-9]{64}$/.test(record.id) &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    Number.isSafeInteger(record.size) &&
    (record.size as number) >= 0 &&
    (record.size as number) <= 16 * 1024 * 1024 &&
    (record.mediaType === undefined ||
      (typeof record.mediaType === "string" &&
        /^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/i.test(record.mediaType)))
  );
}

function validSchedule(value: unknown) {
  const record = exact(
    value,
    ["kind"],
    ["at", "anchor", "everyMs", "expression", "timeZone"],
  );
  if (!record) return false;
  if (record.kind === "one-shot")
    return !!exact(value, ["kind", "at"]) && instant(record.at);
  if (record.kind === "interval")
    return (
      !!exact(value, ["kind", "anchor", "everyMs"]) &&
      instant(record.anchor) &&
      Number.isSafeInteger(record.everyMs) &&
      (record.everyMs as number) > 0
    );
  return (
    record.kind === "cron" &&
    !!exact(value, ["kind", "expression", "timeZone"]) &&
    boundedString(record.expression, 256) &&
    boundedString(record.timeZone, 128)
  );
}

function validOccurrence(value: unknown) {
  const record = exact(
    value,
    ["id", "kind", "dueAt", "state", "attempt"],
    [
      "claimedAt",
      "startedAt",
      "completedAt",
      "resultArtifact",
      "delivered",
      "error",
    ],
  );
  const error =
    record?.error === undefined
      ? undefined
      : exact(record.error, ["code", "message"]);
  return (
    !!record &&
    typeof record.id === "string" &&
    /^[a-f0-9]{64}$/.test(record.id) &&
    (record.kind === "regular" || record.kind === "run-now") &&
    instant(record.dueAt) &&
    new Set([
      "claimed",
      "running",
      "retry-wait",
      "completed",
      "failed",
      "unknown",
    ]).has(String(record.state)) &&
    Number.isSafeInteger(record.attempt) &&
    (record.attempt as number) >= 0 &&
    (record.attempt as number) <= 1_000 &&
    [record.claimedAt, record.startedAt, record.completedAt].every(
      (value) => value === undefined || instant(value),
    ) &&
    (record.resultArtifact === undefined ||
      validArtifact(record.resultArtifact)) &&
    (record.delivered === undefined || typeof record.delivered === "boolean") &&
    (record.error === undefined ||
      (!!error &&
        boundedString(error.code, 128) &&
        boundedString(error.message, 1_000)))
  );
}

function validSnapshot(value: unknown, projectId: string, persisted: boolean) {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return false;
  } catch {
    return false;
  }
  const record = exact(
    value,
    [
      "id",
      "revision",
      "scope",
      "state",
      "schedule",
      "missedRunPolicy",
      "nextAt",
      "binding",
      "profile",
      "promptArtifact",
      "policy",
      "credentialReferenceCount",
      "currentOccurrence",
      "recentOccurrences",
    ],
    [
      "blockedReason",
      ...(persisted ? ["credentialReferences", "pendingRunNow"] : []),
    ],
  );
  if (!record) return false;
  const binding = exact(record.binding, [
    "projectId",
    "cwd",
    "creatorSessionId",
    "resultRoute",
    "executionRole",
  ]);
  const route = binding && exact(binding.resultRoute, ["kind", "sessionId"]);
  const profile = exact(record.profile, ["name", "contentDigest", "source"]);
  const source = profile && exact(profile.source, ["scope", "path"]);
  const policy = exact(record.policy, [
    "timeoutMs",
    "maxRetries",
    "maxOutputBytes",
  ]);
  const pending =
    record.pendingRunNow === undefined
      ? undefined
      : exact(record.pendingRunNow, ["id", "dueAt"]);
  const credentials =
    persisted && Array.isArray(record.credentialReferences)
      ? record.credentialReferences
      : persisted
        ? null
        : [];
  return (
    typeof record.id === "string" &&
    /^[a-z][a-z0-9-]{0,127}$/.test(record.id) &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) > 0 &&
    (record.scope === "session" || record.scope === "durable") &&
    new Set(["active", "paused", "blocked", "deleted"]).has(
      String(record.state),
    ) &&
    validSchedule(record.schedule) &&
    (record.missedRunPolicy === "skip" ||
      record.missedRunPolicy === "run-once") &&
    (record.nextAt === null || instant(record.nextAt)) &&
    !!binding &&
    binding.projectId === projectId &&
    boundedString(binding.cwd) &&
    boundedString(binding.creatorSessionId, 512) &&
    binding.executionRole === "scheduled" &&
    !!route &&
    route.kind === "session" &&
    boundedString(route.sessionId, 512) &&
    !!profile &&
    typeof profile.name === "string" &&
    /^[a-z][a-z0-9-]{0,127}$/.test(profile.name) &&
    typeof profile.contentDigest === "string" &&
    /^[a-f0-9]{64}$/.test(profile.contentDigest) &&
    !!source &&
    new Set(["managed", "user", "project"]).has(String(source.scope)) &&
    boundedString(source.path) &&
    validArtifact(record.promptArtifact) &&
    !!policy &&
    Number.isSafeInteger(policy.timeoutMs) &&
    (policy.timeoutMs as number) >= 1_000 &&
    (policy.timeoutMs as number) <= 3_600_000 &&
    Number.isSafeInteger(policy.maxRetries) &&
    (policy.maxRetries as number) >= 0 &&
    (policy.maxRetries as number) <= 5 &&
    Number.isSafeInteger(policy.maxOutputBytes) &&
    (policy.maxOutputBytes as number) > 0 &&
    (policy.maxOutputBytes as number) <= 16 * 1024 * 1024 &&
    Number.isSafeInteger(record.credentialReferenceCount) &&
    (record.credentialReferenceCount as number) >= 0 &&
    (record.credentialReferenceCount as number) <= 32 &&
    (record.currentOccurrence === null ||
      validOccurrence(record.currentOccurrence)) &&
    Array.isArray(record.recentOccurrences) &&
    record.recentOccurrences.length <= 1_000 &&
    record.recentOccurrences.every(validOccurrence) &&
    credentials !== null &&
    (!persisted || credentials.length === record.credentialReferenceCount) &&
    credentials.every(
      (reference) =>
        typeof reference === "string" &&
        /^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(reference),
    ) &&
    (record.blockedReason === undefined ||
      boundedString(record.blockedReason, 1_000)) &&
    (record.pendingRunNow === undefined ||
      (!!pending &&
        typeof pending.id === "string" &&
        /^[a-f0-9]{64}$/.test(pending.id) &&
        instant(pending.dueAt)))
  );
}

function decodeDefinition(record: StateRecord | null, projectId: string) {
  if (!record) return { ok: true as const, value: null };
  if (!validSnapshot(record.metadata, projectId, true)) return storageFailure();
  return {
    ok: true as const,
    value: {
      value: record.metadata as unknown as PersistedSchedule,
      version: record.version,
    },
  };
}

function decodeRequest(record: StateRecord | null, projectId: string) {
  if (!record) return { ok: true as const, value: null };
  const request = exact(record.metadata, ["digest", "schedule"]);
  if (
    !request ||
    typeof request.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.digest) ||
    !validSnapshot(request.schedule, projectId, false)
  )
    return storageFailure();
  return {
    ok: true as const,
    value: {
      value: request as unknown as PersistedScheduleRequest,
      version: record.version,
    },
  };
}

function canonicalIntent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIntent);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalIntent(record[key])]),
  );
}

export function scheduleCommandDigest(command: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalIntent(command)))
    .digest("hex");
}

export function createSchedulerPersistence(
  state: StateStore,
  projectId: string,
) {
  const namespace = createHash("sha256").update(projectId).digest("hex");
  const DEFINITION_COLLECTION = `${DEFINITION_COLLECTION_PREFIX}.${namespace}`;
  const REQUEST_COLLECTION = `${REQUEST_COLLECTION_PREFIX}.${namespace}`;
  const namespacedTransactionId = (value: string) =>
    `scheduler:${namespace}:${createHash("sha256").update(value).digest("hex")}`;
  const transact = (transaction: Parameters<StateStore["transact"]>[0]) =>
    state.transact({
      ...transaction,
      transactionId: namespacedTransactionId(transaction.transactionId),
    });
  const occurrenceResource = (occurrenceId: string) =>
    `scheduler.occurrence:${namespace}:${occurrenceId}`;
  return {
    occurrenceResource,
    definitionVersion(
      result: {
        readonly records: readonly {
          collection: string;
          key: string;
          version: number;
        }[];
      },
      id: string,
      fallback: number,
    ) {
      return (
        result.records.find(
          ({ collection, key }) =>
            collection === DEFINITION_COLLECTION && key === id,
        )?.version ?? fallback
      );
    },
    async definition(id: string) {
      const queried = await state.query({
        type: "record",
        collection: DEFINITION_COLLECTION,
        key: id,
      });
      if (!queried.ok) return queried;
      if (queried.value.type !== "record") return storageFailure();
      return decodeDefinition(queried.value.record, projectId);
    },

    async definitions(afterId?: string, limit = 1_000) {
      const queried = await state.query({
        type: "records",
        collection: DEFINITION_COLLECTION,
        ...(afterId ? { afterKey: afterId } : {}),
        limit,
      });
      if (!queried.ok) return queried;
      if (queried.value.type !== "records") return storageFailure();
      const definitions: { value: PersistedSchedule; version: number }[] = [];
      for (const record of queried.value.records) {
        const decoded = decodeDefinition(record, projectId);
        if (!decoded.ok) return decoded;
        if (decoded.value) definitions.push(decoded.value);
      }
      return { ok: true as const, value: definitions };
    },

    async requestCapacity(limit: number) {
      const queried = await state.query({
        type: "records",
        collection: REQUEST_COLLECTION,
        limit,
      });
      if (!queried.ok) return queried;
      if (queried.value.type !== "records") return storageFailure();
      for (const record of queried.value.records) {
        const decoded = decodeRequest(record, projectId);
        if (!decoded.ok) return decoded;
      }
      return {
        ok: true as const,
        value: { full: queried.value.records.length >= limit },
      };
    },

    async cleanupSession(sessionId: string, limit: number) {
      const definitions = await state.query({
        type: "records",
        collection: DEFINITION_COLLECTION,
        limit,
      });
      const requests = await state.query({
        type: "records",
        collection: REQUEST_COLLECTION,
        limit,
      });
      if (
        !definitions.ok ||
        !requests.ok ||
        definitions.value.type !== "records" ||
        requests.value.type !== "records"
      )
        return storageFailure();
      const targets: { collection: string; key: string; version: number }[] =
        [];
      const sessionScheduleIds = new Set<string>();
      for (const record of definitions.value.records) {
        const decoded = decodeDefinition(record, projectId);
        if (!decoded.ok) return decoded;
        if (
          decoded.value?.value.scope === "session" &&
          decoded.value.value.binding.creatorSessionId === sessionId
        ) {
          sessionScheduleIds.add(decoded.value.value.id);
          targets.push({
            collection: DEFINITION_COLLECTION,
            key: record.key,
            version: record.version,
          });
        }
      }
      for (const record of requests.value.records) {
        const decoded = decodeRequest(record, projectId);
        if (!decoded.ok) return decoded;
        if (
          decoded.value &&
          (sessionScheduleIds.has(decoded.value.value.schedule.id) ||
            (decoded.value.value.schedule.scope === "session" &&
              decoded.value.value.schedule.binding.creatorSessionId ===
                sessionId))
        )
          targets.push({
            collection: REQUEST_COLLECTION,
            key: record.key,
            version: record.version,
          });
      }
      for (let offset = 0; offset < targets.length; offset += 200) {
        const chunk = targets.slice(offset, offset + 200);
        const removed = await transact({
          transactionId: `session-close:${sessionId}:${offset}`,
          operations: chunk.map((target) => ({
            type: "delete-record" as const,
            collection: target.collection,
            key: target.key,
            expectedVersion: target.version,
          })),
        });
        if (!removed.ok) return removed;
      }
      await state.compact({
        transactionsBefore: Number.MAX_SAFE_INTEGER,
        transactionIdPrefixes: [`scheduler:${namespace}:`],
        limit,
      });
      return { ok: true as const, value: undefined };
    },

    async occurrenceLease(occurrenceId: string) {
      const queried = await state.query({
        type: "lease",
        resource: occurrenceResource(occurrenceId),
      });
      if (!queried.ok) return queried;
      if (queried.value.type !== "lease") return storageFailure();
      const lease = queried.value.lease;
      if (!lease) return { ok: true as const, value: null };
      const metadata = exact(lease.metadata, [
        "scheduleId",
        "occurrenceId",
        "projectId",
      ]);
      if (
        lease.resource !== occurrenceResource(occurrenceId) ||
        (lease.owner !== null && !boundedString(lease.owner, 512)) ||
        !Number.isSafeInteger(lease.fence) ||
        lease.fence < 1 ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt < 0 ||
        !metadata ||
        typeof metadata.scheduleId !== "string" ||
        !/^[a-z][a-z0-9-]{0,127}$/.test(metadata.scheduleId) ||
        metadata.occurrenceId !== occurrenceId ||
        metadata.projectId !== projectId
      )
        return storageFailure();
      return { ok: true as const, value: lease };
    },

    async request(requestId: string) {
      const queried = await state.query({
        type: "record",
        collection: REQUEST_COLLECTION,
        key: requestId,
      });
      if (!queried.ok) return queried;
      if (queried.value.type !== "record") return storageFailure();
      return decodeRequest(queried.value.record, projectId);
    },

    commitDefinition(input: {
      readonly requestId: string;
      readonly digest: string;
      readonly schedule: PersistedSchedule;
      readonly expectedVersion: number | null;
    }) {
      const {
        credentialReferences: _credentialReferences,
        pendingRunNow: _pendingRunNow,
        ...receiptSchedule
      } = input.schedule;
      return transact({
        transactionId: `scheduler.change:${input.requestId}`,
        operations: [
          {
            type: "put-record",
            collection: DEFINITION_COLLECTION,
            key: input.schedule.id,
            metadata: json(input.schedule),
            expectedVersion: input.expectedVersion,
          },
          {
            type: "put-record",
            collection: REQUEST_COLLECTION,
            key: input.requestId,
            metadata: json({ digest: input.digest, schedule: receiptSchedule }),
            expectedVersion: null,
          },
        ],
      });
    },

    claimOccurrence(input: {
      readonly transactionId: string;
      readonly schedule: PersistedSchedule;
      readonly expectedVersion: number;
      readonly resource: string;
      readonly owner: string;
      readonly ttlMs: number;
    }) {
      return transact({
        transactionId: input.transactionId,
        operations: [
          {
            type: "put-record",
            collection: DEFINITION_COLLECTION,
            key: input.schedule.id,
            metadata: json(input.schedule),
            expectedVersion: input.expectedVersion,
          },
          {
            type: "claim-lease",
            resource: input.resource,
            owner: input.owner,
            ttlMs: input.ttlMs,
            metadata: {
              scheduleId: input.schedule.id,
              occurrenceId: input.schedule.currentOccurrence?.id ?? "",
              projectId,
            },
          },
        ],
      });
    },

    updateFenced(input: {
      readonly transactionId: string;
      readonly schedule: PersistedSchedule;
      readonly expectedVersion: number;
      readonly resource: string;
      readonly owner: string;
      readonly fence: number;
      readonly ttlMs: number;
    }) {
      return transact({
        transactionId: input.transactionId,
        operations: [
          {
            type: "put-record",
            collection: DEFINITION_COLLECTION,
            key: input.schedule.id,
            metadata: json(input.schedule),
            expectedVersion: input.expectedVersion,
          },
          {
            type: "renew-lease",
            resource: input.resource,
            owner: input.owner,
            fence: input.fence,
            ttlMs: input.ttlMs,
          },
        ],
      });
    },

    releaseLease(input: {
      readonly transactionId: string;
      readonly resource: string;
      readonly owner: string;
      readonly fence: number;
    }) {
      return transact({
        transactionId: input.transactionId,
        operations: [
          {
            type: "release-lease",
            resource: input.resource,
            owner: input.owner,
            fence: input.fence,
          },
        ],
      });
    },

    releaseOccurrence(input: {
      readonly transactionId: string;
      readonly schedule: PersistedSchedule;
      readonly expectedVersion: number;
      readonly resource: string;
      readonly owner: string;
      readonly fence: number;
    }) {
      return transact({
        transactionId: input.transactionId,
        operations: [
          {
            type: "put-record",
            collection: DEFINITION_COLLECTION,
            key: input.schedule.id,
            metadata: json(input.schedule),
            expectedVersion: input.expectedVersion,
          },
          {
            type: "release-lease",
            resource: input.resource,
            owner: input.owner,
            fence: input.fence,
          },
        ],
      });
    },

    updateRuntime(input: {
      readonly transactionId: string;
      readonly schedule: PersistedSchedule;
      readonly expectedVersion: number;
    }) {
      return transact({
        transactionId: input.transactionId,
        operations: [
          {
            type: "put-record",
            collection: DEFINITION_COLLECTION,
            key: input.schedule.id,
            metadata: json(input.schedule),
            expectedVersion: input.expectedVersion,
          },
        ],
      });
    },

    commitDelete(input: {
      readonly requestId: string;
      readonly digest: string;
      readonly schedule: ScheduleSnapshot;
      readonly expectedVersion: number;
    }) {
      return transact({
        transactionId: `scheduler.change:${input.requestId}`,
        operations: [
          {
            type: "delete-record",
            collection: DEFINITION_COLLECTION,
            key: input.schedule.id,
            expectedVersion: input.expectedVersion,
          },
          {
            type: "put-record",
            collection: REQUEST_COLLECTION,
            key: input.requestId,
            metadata: json({ digest: input.digest, schedule: input.schedule }),
            expectedVersion: null,
          },
        ],
      });
    },
  };
}

export type SchedulerPersistence = ReturnType<
  typeof createSchedulerPersistence
>;
