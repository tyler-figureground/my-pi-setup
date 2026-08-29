import { createHash } from "node:crypto";
import type { JsonObject } from "../../core/result.ts";
import type {
  StateRecord,
  StateStore,
  StateStoreError,
} from "../../core/persistence/state-store.ts";
import type { ScheduleScope, ScheduleSnapshot } from "./model.ts";

const DEFINITION_COLLECTION_PREFIX = "scheduler.definitions";
const REQUEST_COLLECTION_PREFIX = "scheduler.requests";
const CANCELLATION_COLLECTION_PREFIX = "scheduler.cancellations";

export interface PersistedSchedule extends ScheduleSnapshot {
  readonly definitionGeneration: string;
  readonly credentialReferences: readonly string[];
  readonly pendingRunNow?: {
    readonly id: string;
    readonly dueAt: string;
  };
}

export interface PersistedScheduleRequest {
  readonly digest: string;
  readonly schedule: ScheduleSnapshot;
  readonly cancellation?: PersistedCancellationRequest;
}

export interface PersistedCancellationRequest {
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly generation: string;
  readonly action: "pause" | "delete";
  readonly claimantOwner: string;
  readonly fence: number;
  readonly requestedAt: string;
  readonly acknowledgedAt?: string;
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
      ...(persisted
        ? ["definitionGeneration", "credentialReferences", "pendingRunNow"]
        : []),
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
    (!persisted ||
      record.definitionGeneration === undefined ||
      (typeof record.definitionGeneration === "string" &&
        /^[a-f0-9]{64}$/.test(record.definitionGeneration))) &&
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
  const stored = record.metadata as unknown as PersistedSchedule;
  const value = stored.definitionGeneration
    ? stored
    : {
        ...stored,
        definitionGeneration: createHash("sha256")
          .update(
            `scheduler-legacy-definition-v1\0${projectId}\0${stored.id}\0${stored.revision}\0${stored.binding.creatorSessionId}\0${stored.promptArtifact.sha256}`,
          )
          .digest("hex"),
      };
  return {
    ok: true as const,
    value: {
      value,
      version: record.version,
    },
  };
}

function validCancellation(value: unknown, occurrenceId?: string) {
  const record = exact(
    value,
    [
      "scheduleId",
      "occurrenceId",
      "generation",
      "action",
      "claimantOwner",
      "fence",
      "requestedAt",
    ],
    ["acknowledgedAt"],
  );
  return (
    !!record &&
    typeof record.scheduleId === "string" &&
    /^[a-z][a-z0-9-]{0,127}$/.test(record.scheduleId) &&
    typeof record.occurrenceId === "string" &&
    /^[a-f0-9]{64}$/.test(record.occurrenceId) &&
    (occurrenceId === undefined || record.occurrenceId === occurrenceId) &&
    typeof record.generation === "string" &&
    /^[a-f0-9]{64}$/.test(record.generation) &&
    (record.action === "pause" || record.action === "delete") &&
    boundedString(record.claimantOwner, 512) &&
    Number.isSafeInteger(record.fence) &&
    (record.fence as number) >= 1 &&
    instant(record.requestedAt) &&
    (record.acknowledgedAt === undefined || instant(record.acknowledgedAt))
  );
}

function decodeRequest(record: StateRecord | null, projectId: string) {
  if (!record) return { ok: true as const, value: null };
  const request = exact(
    record.metadata,
    ["digest", "schedule"],
    ["cancellation"],
  );
  if (
    !request ||
    typeof request.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.digest) ||
    !validSnapshot(request.schedule, projectId, false) ||
    (request.cancellation !== undefined &&
      !validCancellation(request.cancellation))
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
  creatorSessionId: string,
) {
  const namespace = createHash("sha256").update(projectId).digest("hex");
  const creatorNamespace = createHash("sha256")
    .update(creatorSessionId)
    .digest("hex");
  const DURABLE_DEFINITION_COLLECTION = `${DEFINITION_COLLECTION_PREFIX}.${namespace}`;
  const SESSION_DEFINITION_COLLECTION = `${DEFINITION_COLLECTION_PREFIX}.${namespace}.session.${creatorNamespace}`;
  const REQUEST_COLLECTION = `${REQUEST_COLLECTION_PREFIX}.${namespace}`;
  const CANCELLATION_COLLECTION = `${CANCELLATION_COLLECTION_PREFIX}.${namespace}`;
  const REQUEST_CAPACITY_COLLECTION = `scheduler.request-capacity.${namespace}`;
  const REQUEST_CAPACITY_KEY = "gate";
  const requestKey = (_scope: ScheduleScope, requestId: string) => requestId;
  const definitionCollection = (scope: ScheduleScope) =>
    scope === "session"
      ? SESSION_DEFINITION_COLLECTION
      : DURABLE_DEFINITION_COLLECTION;
  const namespacedTransactionId = (value: string) =>
    `scheduler:${namespace}:${creatorNamespace}:${createHash("sha256").update(value).digest("hex")}`;
  const transact = (transaction: Parameters<StateStore["transact"]>[0]) =>
    state.transact({
      ...transaction,
      transactionId: namespacedTransactionId(transaction.transactionId),
    });
  const occurrenceResource = (occurrenceId: string) =>
    `scheduler.occurrence:${namespace}:${occurrenceId}`;

  const prepareRequestAdmission = async (
    limit: number,
    protectedKey?: string,
    attempt = 0,
  ): Promise<
    | { ok: false; error: StateStoreError }
    | {
        ok: true;
        value: {
          full: boolean;
          gateVersion: number | null;
          gateGeneration: number;
          evictable:
            | { record: StateRecord; cancellationRecord?: StateRecord }
            | undefined;
        };
      }
  > => {
    const gateBefore = await state.query({
      type: "record",
      collection: REQUEST_CAPACITY_COLLECTION,
      key: REQUEST_CAPACITY_KEY,
    });
    if (!gateBefore.ok) return gateBefore;
    const requests = await state.query({
      type: "records",
      collection: REQUEST_COLLECTION,
      limit,
    });
    if (!requests.ok) return requests;
    const gateAfter = await state.query({
      type: "record",
      collection: REQUEST_CAPACITY_COLLECTION,
      key: REQUEST_CAPACITY_KEY,
    });
    if (!gateAfter.ok) return gateAfter;
    if (
      requests.value.type !== "records" ||
      gateBefore.value.type !== "record" ||
      gateAfter.value.type !== "record"
    )
      return storageFailure();
    if (gateBefore.value.record?.version !== gateAfter.value.record?.version) {
      if (attempt >= 31) return storageFailure();
      return prepareRequestAdmission(limit, protectedKey, attempt + 1);
    }
    const gateRecord = gateAfter.value.record;
    const gateGeneration = gateRecord?.metadata.generation ?? 0;
    if (!Number.isSafeInteger(gateGeneration) || Number(gateGeneration) < 0)
      return storageFailure();
    const decoded = [];
    for (const record of requests.value.records) {
      const request = decodeRequest(record, projectId);
      if (!request.ok) return request;
      decoded.push({ record, request: request.value?.value });
    }
    if (decoded.length < limit) {
      return {
        ok: true as const,
        value: {
          full: false as const,
          gateVersion: gateRecord?.version ?? null,
          gateGeneration: Number(gateGeneration),
          evictable: undefined,
        },
      };
    }
    decoded.sort(
      (left, right) =>
        left.record.updatedAt - right.record.updatedAt ||
        left.record.key.localeCompare(right.record.key),
    );
    let evictable:
      { record: StateRecord; cancellationRecord?: StateRecord } | undefined;
    for (const candidate of decoded) {
      if (!candidate.request || candidate.record.key === protectedKey) continue;
      if (!candidate.request.cancellation) {
        evictable = { record: candidate.record };
        break;
      }
      const cancellation = await state.query({
        type: "record",
        collection: CANCELLATION_COLLECTION,
        key: candidate.request.cancellation.occurrenceId,
      });
      if (!cancellation.ok) return cancellation;
      if (cancellation.value.type !== "record") return storageFailure();
      const cancellationRecord = cancellation.value.record;
      if (
        cancellationRecord &&
        validCancellation(
          cancellationRecord.metadata,
          candidate.request.cancellation.occurrenceId,
        ) &&
        cancellationRecord.metadata.generation ===
          candidate.request.cancellation.generation &&
        cancellationRecord.metadata.fence ===
          candidate.request.cancellation.fence &&
        typeof cancellationRecord.metadata.acknowledgedAt === "string"
      ) {
        evictable = { record: candidate.record, cancellationRecord };
        break;
      }
    }
    return {
      ok: true as const,
      value: {
        full: !evictable,
        gateVersion: gateRecord?.version ?? null,
        gateGeneration: Number(gateGeneration),
        evictable,
      },
    };
  };

  const commitWithRequestAdmission = async (
    limit: number,
    transactionId: string,
    protectedKey: string,
    operations: readonly Parameters<
      StateStore["transact"]
    >[0]["operations"][number][],
  ) => {
    let lastConflict: Awaited<ReturnType<typeof transact>> | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const prepared = await prepareRequestAdmission(limit, protectedKey);
      if (!prepared.ok) return prepared;
      if (prepared.value.full) return storageFailure();
      const evictable = prepared.value.evictable;
      const committed = await transact({
        transactionId: `${transactionId}:admission-${prepared.value.gateGeneration}`,
        operations: [
          {
            type: "put-record",
            collection: REQUEST_CAPACITY_COLLECTION,
            key: REQUEST_CAPACITY_KEY,
            metadata: { generation: prepared.value.gateGeneration + 1 },
            expectedVersion: prepared.value.gateVersion,
          },
          ...(evictable
            ? [
                {
                  type: "delete-record" as const,
                  collection: REQUEST_COLLECTION,
                  key: evictable.record.key,
                  expectedVersion: evictable.record.version,
                },
                ...(evictable.cancellationRecord
                  ? [
                      {
                        type: "delete-record" as const,
                        collection: CANCELLATION_COLLECTION,
                        key: evictable.cancellationRecord.key,
                        expectedVersion: evictable.cancellationRecord.version,
                      },
                    ]
                  : []),
              ]
            : []),
          ...operations,
        ],
      });
      if (committed.ok || committed.error.code !== "VERSION_CONFLICT")
        return committed;
      lastConflict = committed;
    }
    return lastConflict ?? storageFailure();
  };

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
            (collection === SESSION_DEFINITION_COLLECTION ||
              collection === DURABLE_DEFINITION_COLLECTION) &&
            key === id,
        )?.version ?? fallback
      );
    },
    async definition(id: string) {
      for (const collection of [
        SESSION_DEFINITION_COLLECTION,
        DURABLE_DEFINITION_COLLECTION,
      ]) {
        const queried = await state.query({
          type: "record",
          collection,
          key: id,
        });
        if (!queried.ok) return queried;
        if (queried.value.type !== "record") return storageFailure();
        const decoded = decodeDefinition(queried.value.record, projectId);
        if (!decoded.ok) return decoded;
        if (decoded.value) return decoded;
      }
      return { ok: true as const, value: null };
    },

    async definitions(afterId?: string, limit = 1_000) {
      const byId = new Map<
        string,
        { value: PersistedSchedule; version: number }
      >();
      for (const collection of [
        DURABLE_DEFINITION_COLLECTION,
        SESSION_DEFINITION_COLLECTION,
      ]) {
        const queried = await state.query({
          type: "records",
          collection,
          limit: 1_000,
        });
        if (!queried.ok) return queried;
        if (queried.value.type !== "records") return storageFailure();
        for (const record of queried.value.records) {
          const decoded = decodeDefinition(record, projectId);
          if (!decoded.ok) return decoded;
          if (decoded.value) byId.set(decoded.value.value.id, decoded.value);
        }
      }
      const definitions = [...byId.values()]
        .filter(({ value }) => !afterId || value.id > afterId)
        .sort((left, right) => left.value.id.localeCompare(right.value.id))
        .slice(0, limit);
      return { ok: true as const, value: definitions };
    },

    async requestCapacity(limit: number) {
      const prepared = await prepareRequestAdmission(limit);
      if (!prepared.ok) return prepared;
      return {
        ok: true as const,
        value: { full: prepared.value.full },
      };
    },

    async cleanupSession(sessionId: string, limit: number) {
      if (sessionId !== creatorSessionId) return storageFailure();
      const definitions = await state.query({
        type: "records",
        collection: SESSION_DEFINITION_COLLECTION,
        limit: 1_000,
      });
      const requests = await state.query({
        type: "records",
        collection: REQUEST_COLLECTION,
        limit: 1_000,
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
            collection: SESSION_DEFINITION_COLLECTION,
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
        ) {
          targets.push({
            collection: REQUEST_COLLECTION,
            key: record.key,
            version: record.version,
          });
          const cancellation = decoded.value.value.cancellation;
          if (cancellation) {
            const queried = await state.query({
              type: "record",
              collection: CANCELLATION_COLLECTION,
              key: cancellation.occurrenceId,
            });
            if (!queried.ok) return queried;
            if (queried.value.type !== "record") return storageFailure();
            if (
              queried.value.record &&
              typeof queried.value.record.metadata.acknowledgedAt === "string"
            )
              targets.push({
                collection: CANCELLATION_COLLECTION,
                key: queried.value.record.key,
                version: queried.value.record.version,
              });
          }
        }
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

    async cancellation(occurrenceId: string) {
      const queried = await state.query({
        type: "record",
        collection: CANCELLATION_COLLECTION,
        key: occurrenceId,
      });
      if (!queried.ok) return queried;
      if (queried.value.type !== "record") return storageFailure();
      if (!queried.value.record) return { ok: true as const, value: null };
      const value = queried.value.record.metadata;
      if (!validCancellation(value, occurrenceId)) return storageFailure();
      return {
        ok: true as const,
        value: {
          value: value as unknown as PersistedCancellationRequest,
          version: queried.value.record.version,
        },
      };
    },

    requestCancellation(input: {
      readonly requestId: string;
      readonly cancellation: PersistedCancellationRequest;
    }) {
      return transact({
        transactionId: `scheduler.cancel-request:${input.requestId}`,
        operations: [
          {
            type: "put-record",
            collection: CANCELLATION_COLLECTION,
            key: input.cancellation.occurrenceId,
            metadata: json(input.cancellation),
            expectedVersion: null,
          },
        ],
      });
    },

    acknowledgeCancellation(input: {
      readonly occurrenceId: string;
      readonly cancellation: PersistedCancellationRequest;
      readonly expectedVersion: number;
    }) {
      return transact({
        transactionId: `scheduler.cancel-ack:${input.occurrenceId}:${input.cancellation.generation}`,
        operations: [
          {
            type: "put-record",
            collection: CANCELLATION_COLLECTION,
            key: input.occurrenceId,
            metadata: json(input.cancellation),
            expectedVersion: input.expectedVersion,
          },
        ],
      });
    },

    acknowledgeCancellationAndRelease(input: {
      readonly occurrenceId: string;
      readonly cancellation: PersistedCancellationRequest;
      readonly expectedVersion: number;
      readonly owner: string;
      readonly fence: number;
    }) {
      return transact({
        transactionId: `scheduler.cancel-settle:${input.occurrenceId}:${input.cancellation.generation}:${input.fence}`,
        operations: [
          {
            type: "put-record",
            collection: CANCELLATION_COLLECTION,
            key: input.occurrenceId,
            metadata: json(input.cancellation),
            expectedVersion: input.expectedVersion,
          },
          {
            type: "release-lease",
            resource: occurrenceResource(input.occurrenceId),
            owner: input.owner,
            fence: input.fence,
          },
        ],
      });
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
      readonly previousScope?: ScheduleScope;
      readonly cancellation?: PersistedCancellationRequest;
      readonly expectedCancellationVersion?: number | null;
      readonly maxRequestReceipts: number;
    }) {
      const {
        definitionGeneration: _definitionGeneration,
        credentialReferences: _credentialReferences,
        pendingRunNow: _pendingRunNow,
        ...receiptSchedule
      } = input.schedule;
      const moved =
        input.previousScope !== undefined &&
        input.previousScope !== input.schedule.scope;
      return commitWithRequestAdmission(
        input.maxRequestReceipts,
        `scheduler.change:${input.requestId}`,
        requestKey(input.schedule.scope, input.requestId),
        [
          ...(moved
            ? [
                {
                  type: "delete-record" as const,
                  collection: definitionCollection(input.previousScope!),
                  key: input.schedule.id,
                  expectedVersion: input.expectedVersion,
                },
              ]
            : []),
          {
            type: "put-record",
            collection: definitionCollection(input.schedule.scope),
            key: input.schedule.id,
            metadata: json(input.schedule),
            expectedVersion: moved ? null : input.expectedVersion,
          },
          ...(input.cancellation
            ? [
                {
                  type: "put-record" as const,
                  collection: CANCELLATION_COLLECTION,
                  key: input.cancellation.occurrenceId,
                  metadata: json(input.cancellation),
                  expectedVersion: input.expectedCancellationVersion ?? null,
                },
              ]
            : []),
          {
            type: "put-record",
            collection: REQUEST_COLLECTION,
            key: requestKey(input.schedule.scope, input.requestId),
            metadata: json({
              digest: input.digest,
              schedule: receiptSchedule,
              ...(input.cancellation
                ? { cancellation: input.cancellation }
                : {}),
            }),
            expectedVersion: null,
          },
        ],
      );
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
            collection: definitionCollection(input.schedule.scope),
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
            collection: definitionCollection(input.schedule.scope),
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
            collection: definitionCollection(input.schedule.scope),
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
            collection: definitionCollection(input.schedule.scope),
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
      readonly cancellation?: PersistedCancellationRequest;
      readonly expectedCancellationVersion?: number | null;
      readonly maxRequestReceipts: number;
    }) {
      return commitWithRequestAdmission(
        input.maxRequestReceipts,
        `scheduler.change:${input.requestId}`,
        requestKey(input.schedule.scope, input.requestId),
        [
          {
            type: "delete-record",
            collection: definitionCollection(input.schedule.scope),
            key: input.schedule.id,
            expectedVersion: input.expectedVersion,
          },
          ...(input.cancellation
            ? [
                {
                  type: "put-record" as const,
                  collection: CANCELLATION_COLLECTION,
                  key: input.cancellation.occurrenceId,
                  metadata: json(input.cancellation),
                  expectedVersion: input.expectedCancellationVersion ?? null,
                },
              ]
            : []),
          {
            type: "put-record",
            collection: REQUEST_COLLECTION,
            key: requestKey(input.schedule.scope, input.requestId),
            metadata: json({
              digest: input.digest,
              schedule: input.schedule,
              ...(input.cancellation
                ? { cancellation: input.cancellation }
                : {}),
            }),
            expectedVersion: null,
          },
        ],
      );
    },
  };
}

export type SchedulerPersistence = ReturnType<
  typeof createSchedulerPersistence
>;
