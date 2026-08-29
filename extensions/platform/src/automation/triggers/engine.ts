import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { success } from "../../core/result.ts";
import type {
  TriggerBinding,
  TriggerBindingIdentity,
  TriggerDeliveryResult,
  TriggerEngineOptions,
  TriggerError,
  TriggerEvent,
  TriggerOwnerReconciliation,
  TriggerOutcome,
  TriggerPublishInput,
  TriggerPublishResult,
  TriggerReconcileResult,
  TriggerSourceBinding,
  TriggerSourcePublisher,
} from "./model.ts";
import {
  hasExactKeys,
  isBoundedIdentifier,
  isPlainData,
} from "./validation.ts";
import type {
  TriggerDurableRecord,
  TriggerPersistenceAttemptRequest,
  TriggerPersistenceClaim,
} from "./persistence.ts";

interface QueuedDelivery {
  event: import("./model.ts").TriggerEvent;
  resolves: ((result: TriggerDeliveryResult) => void)[];
  bytes: number;
  readonly counted: boolean;
  readonly enqueuedAt: number;
  readonly attempt?: TriggerPersistenceAttemptRequest;
}

interface BindingState {
  readonly identity: TriggerBindingIdentity;
  readonly binding: TriggerBinding;
  readonly queue: QueuedDelivery[];
  active: number;
  reserved: number;
  reservedActive: number;
  timer?: unknown;
  firstQueuedAt?: number;
  lastQueuedAt?: number;
  readonly running: Set<RunningDelivery>;
  retired: boolean;
}

interface RunningDelivery {
  readonly controller: AbortController;
  finish(status: TriggerDeliveryResult["status"]): void;
}

interface OwnerState {
  readonly generation: number;
  readonly bindings: readonly BindingState[];
}

interface RootBudget {
  firings: number;
  fanout: number;
  active: number;
}

interface SourceAuthority extends TriggerSourceBinding {
  readonly generation: number;
  readonly sourceKey: string;
  readonly identityKey: string;
}

function dataDescriptors(
  value: unknown,
  allowed: readonly string[],
  array = false,
) {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    (array ? !Array.isArray(value) : Array.isArray(value)) ||
    (!array && Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as PropertyDescriptorMap;
  const keys = Object.keys(descriptors);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    Object.entries(descriptors).some(
      ([key, descriptor]) =>
        (key !== "length" && !descriptor.enumerable) ||
        !("value" in descriptor),
    )
  ) {
    return undefined;
  }
  return descriptors;
}

function dataArray(value: unknown, maxLength: number) {
  if (isProxy(value) || !Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    value,
  ) as unknown as PropertyDescriptorMap;
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maxLength ||
    Object.keys(descriptors).length !== length + 1
  ) {
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return undefined;
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function decodeBinding(value: unknown) {
  const fields = dataDescriptors(value, [
    "id",
    "eventTypes",
    "priority",
    "concurrency",
    "debounceMs",
    "batch",
    "coalesceBy",
    "deadlineMs",
    "deliver",
  ]);
  if (!fields) return undefined;
  const eventTypes = dataArray(fields.eventTypes?.value, 64);
  if (
    !isBoundedIdentifier(fields.id?.value) ||
    !eventTypes ||
    eventTypes.length === 0 ||
    !eventTypes.every((type) => isBoundedIdentifier(type)) ||
    (fields.priority !== undefined &&
      (!Number.isSafeInteger(fields.priority.value) ||
        Math.abs(fields.priority.value) > 1_000_000)) ||
    (fields.concurrency !== undefined &&
      (!Number.isSafeInteger(fields.concurrency.value) ||
        fields.concurrency.value < 1 ||
        fields.concurrency.value > 64)) ||
    (fields.debounceMs !== undefined &&
      (!Number.isSafeInteger(fields.debounceMs.value) ||
        fields.debounceMs.value < 0 ||
        fields.debounceMs.value > 60_000)) ||
    (fields.coalesceBy !== undefined &&
      !isBoundedIdentifier(fields.coalesceBy.value)) ||
    (fields.deadlineMs !== undefined &&
      (!Number.isSafeInteger(fields.deadlineMs.value) ||
        fields.deadlineMs.value < 1 ||
        fields.deadlineMs.value > 10 * 60_000)) ||
    typeof fields.deliver?.value !== "function"
  ) {
    return undefined;
  }
  let batch: TriggerBinding["batch"];
  if (fields.batch !== undefined) {
    const batchFields = dataDescriptors(fields.batch.value, [
      "maxCount",
      "maxWaitMs",
    ]);
    if (
      !batchFields ||
      Object.keys(batchFields).length !== 2 ||
      !Number.isSafeInteger(batchFields.maxCount?.value) ||
      batchFields.maxCount.value < 1 ||
      batchFields.maxCount.value > 1_000 ||
      !Number.isSafeInteger(batchFields.maxWaitMs?.value) ||
      batchFields.maxWaitMs.value < 1 ||
      batchFields.maxWaitMs.value > 60_000
    ) {
      return undefined;
    }
    batch = Object.freeze({
      maxCount: batchFields.maxCount.value,
      maxWaitMs: batchFields.maxWaitMs.value,
    });
  }
  return Object.freeze({
    id: fields.id.value,
    eventTypes: Object.freeze([...eventTypes]) as readonly string[],
    ...(fields.priority === undefined
      ? {}
      : { priority: fields.priority.value }),
    ...(fields.concurrency === undefined
      ? {}
      : { concurrency: fields.concurrency.value }),
    ...(fields.debounceMs === undefined
      ? {}
      : { debounceMs: fields.debounceMs.value }),
    ...(batch === undefined ? {} : { batch }),
    ...(fields.coalesceBy === undefined
      ? {}
      : { coalesceBy: fields.coalesceBy.value }),
    ...(fields.deadlineMs === undefined
      ? {}
      : { deadlineMs: fields.deadlineMs.value }),
    deliver: fields.deliver.value,
  }) satisfies TriggerBinding;
}

function decodeReconciliation(value: unknown) {
  const fields = dataDescriptors(value, ["ownerId", "generation", "bindings"]);
  const rawBindings = dataArray(fields?.bindings?.value, 1_024);
  if (
    !fields ||
    Object.keys(fields).length !== 3 ||
    !isBoundedIdentifier(fields.ownerId?.value) ||
    !Number.isSafeInteger(fields.generation?.value) ||
    fields.generation.value <= 0 ||
    !rawBindings
  ) {
    return undefined;
  }
  const bindings = rawBindings.map(decodeBinding);
  if (
    bindings.some((binding) => binding === undefined) ||
    new Set(bindings.map((binding) => binding?.id)).size !== bindings.length
  ) {
    return undefined;
  }
  return Object.freeze({
    ownerId: fields.ownerId.value as string,
    generation: fields.generation.value as number,
    bindings: Object.freeze(bindings) as readonly TriggerBinding[],
  });
}

function decodeClaimEnvelope(value: unknown) {
  const claim = dataDescriptors(value, ["claimId", "fence", "record"]);
  if (
    !claim ||
    Object.keys(claim).length !== 3 ||
    !isBoundedIdentifier(claim.claimId?.value) ||
    !Number.isSafeInteger(claim.fence?.value) ||
    claim.fence.value < 1
  ) {
    return undefined;
  }
  return {
    claimId: claim.claimId.value as string,
    fence: claim.fence.value as number,
    record: claim.record?.value,
  };
}

function decodeDurableClaim(value: unknown) {
  const claim = decodeClaimEnvelope(value);
  const record = dataDescriptors(claim?.record, [
    "schemaVersion",
    "eventId",
    "type",
    "occurredAt",
    "sourceKey",
    "payloadDigest",
  ]);
  if (
    !claim ||
    !record ||
    Object.keys(record).length !== 6 ||
    record.schemaVersion?.value !== 1 ||
    record.eventId?.value !== claim.claimId ||
    !isBoundedIdentifier(record.type?.value) ||
    !Number.isSafeInteger(record.occurredAt?.value) ||
    record.occurredAt.value < 0 ||
    typeof record.sourceKey?.value !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sourceKey.value) ||
    typeof record.payloadDigest?.value !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.payloadDigest.value)
  ) {
    return undefined;
  }
  const durableRecord = {
    schemaVersion: 1 as const,
    eventId: record.eventId.value as string,
    type: record.type.value as string,
    occurredAt: record.occurredAt.value as number,
    sourceKey: record.sourceKey.value,
    payloadDigest: record.payloadDigest.value,
  } satisfies TriggerDurableRecord;
  if (Buffer.byteLength(JSON.stringify(durableRecord)) > 1_024) {
    return undefined;
  }
  return {
    claim: {
      claimId: claim.claimId,
      fence: claim.fence,
      record: durableRecord,
    } satisfies TriggerPersistenceClaim,
    record: durableRecord,
  };
}

function decodeClaimPage(value: unknown) {
  const fields = dataDescriptors(value, ["claims", "nextCursor"]);
  const claims = dataArray(fields?.claims?.value, 64);
  if (
    !fields ||
    !claims ||
    (fields.nextCursor !== undefined &&
      !isBoundedIdentifier(fields.nextCursor.value))
  ) {
    return undefined;
  }
  const decoded: NonNullable<ReturnType<typeof decodeDurableClaim>>[] = [];
  const corrupt: NonNullable<ReturnType<typeof decodeClaimEnvelope>>[] = [];
  for (const claim of claims) {
    const envelope = decodeClaimEnvelope(claim);
    if (!envelope) return undefined;
    const durable = decodeDurableClaim(claim);
    if (durable) decoded.push(durable);
    else corrupt.push(envelope);
  }
  return {
    claims: decoded,
    corrupt,
    nextCursor: fields.nextCursor?.value as string | undefined,
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if ("value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function createTriggerEngine(options: TriggerEngineOptions) {
  const clock = {
    now: options.clock?.now ?? Date.now,
    setTimeout:
      options.clock?.setTimeout ??
      ((callback: () => void, delayMs: number) =>
        globalThis.setTimeout(callback, delayMs)),
    clearTimeout:
      options.clock?.clearTimeout ??
      ((handle: unknown) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)),
  };
  const createEventId = options.createEventId ?? randomUUID;
  const maxPayloadBytes = boundedOption(
    options.maxPayloadBytes,
    64 * 1024,
    1,
    64 * 1024,
  );
  const maxSourceBytes = boundedOption(
    options.maxSourceBytes,
    8 * 1024,
    1,
    8 * 1024,
  );
  const maxEnvelopeBytes = boundedOption(
    options.maxEnvelopeBytes,
    maxPayloadBytes + 16 * 1024,
    1,
    80 * 1024,
  );
  const maxDataNodes = boundedOption(options.maxDataNodes, 10_000, 1, 10_000);
  const maxQueueCount = boundedOption(options.maxQueueCount, 1_024, 1, 1_024);
  const maxQueueBytes = boundedOption(
    options.maxQueueBytes,
    4 * 1024 * 1024,
    1,
    4 * 1024 * 1024,
  );
  const maxActiveConsumers = boundedOption(options.maxActiveConsumers, 8, 1, 8);
  const maxBindings = boundedOption(options.maxBindings, 1_024, 1, 1_024);
  const maxPendingPerBinding = boundedOption(
    options.maxPendingPerBinding,
    128,
    1,
    128,
  );
  const maxRootFanout = boundedOption(options.maxRootFanout, 1_024, 1, 1_024);
  const maxRootFirings = boundedOption(options.maxRootFirings, 256, 1, 256);
  const persistence = options.persistence;
  const maxInspectionEntries = boundedOption(
    options.maxInspectionEntries,
    100,
    1,
    100,
  );
  const maxInspectionBytes = boundedOption(
    options.maxInspectionBytes,
    64 * 1024,
    512,
    64 * 1024,
  );
  const maxCausalDepth = boundedOption(options.maxCausalDepth, 16, 1, 16);
  const closeDrainMs = boundedOption(options.closeDrainMs, 1_000, 0, 10_000);
  const persistenceClaimMs = 30_000;
  const maxPersistencePages = boundedOption(
    options.maxPersistencePages,
    4,
    1,
    16,
  );
  const runtimeId = randomUUID();
  const owners = new Map<string, OwnerState>();
  const rootBudgets = new Map<string, RootBudget>();
  const eventSourceKeys = new WeakMap<TriggerEvent, string>();
  const sourceAuthorities = new WeakMap<
    TriggerSourcePublisher,
    SourceAuthority
  >();
  const sourcesByKey = new Map<string, SourceAuthority>();
  const activeSources = new Map<string, SourceAuthority>();
  const sourceGenerations = new Map<string, number>();
  let closed = false;
  let queuedCount = 0;
  let queuedBytes = 0;
  let reservedCount = 0;
  let reservedBytes = 0;
  let globalActive = 0;
  let reservedActive = 0;
  let nextHistorySequence = 0;
  let nextAttemptSequence = 0;
  let reconcileTail = Promise.resolve();
  const history: import("./model.ts").TriggerInspection["history"][number][] =
    [];
  const acceptedOperations = new Set<Promise<unknown>>();
  const callbackTasks = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let replayCursor: string | undefined;
  const counters = {
    coalesced: 0,
    superseded: 0,
    dropped: 0,
    quarantined: 0,
    ambiguous: 0,
  };

  const track = <T>(set: Set<Promise<unknown>>, task: Promise<T>) => {
    set.add(task);
    void task.then(
      () => set.delete(task),
      () => set.delete(task),
    );
    return task;
  };

  const redact = (value: string) =>
    /(?:authorization|cookie|password|secret|token|api[-_]?key)\s*[:=]/i.test(
      value,
    )
      ? "[REDACTED]"
      : value.slice(0, 256);

  const appendHistory = (
    event: TriggerEvent,
    deliveries: readonly TriggerDeliveryResult[],
  ) => {
    history.push({
      sequence: ++nextHistorySequence,
      eventId: redact(event.id),
      type: redact(event.type),
      source: {
        kind: redact(event.provenance.source.kind),
        id: redact(event.provenance.source.id),
      },
      durability: event.durability,
      routed: deliveries.length,
      outcomes: deliveries.map(({ status }) => status),
    });
    while (history.length > maxInspectionEntries) history.shift();
  };

  const retire = (
    state: BindingState,
    status: TriggerDeliveryResult["status"],
  ) => {
    state.retired = true;
    if (state.timer !== undefined) clock.clearTimeout(state.timer);
    state.timer = undefined;
    for (const queued of state.queue.splice(0)) {
      if (queued.counted) {
        queuedCount--;
        queuedBytes -= queued.bytes;
      }
      const result = { ...state.identity, status };
      for (const resolve of queued.resolves) resolve(result);
    }
    for (const running of [...state.running]) {
      running.controller.abort(status);
      running.finish(status);
    }
  };

  const serializeReconcile = async <T>(operation: () => Promise<T>) => {
    const previous = reconcileTail;
    let release!: () => void;
    reconcileTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const reconcile = async (
    input: TriggerOwnerReconciliation,
  ): Promise<TriggerOutcome<TriggerReconcileResult>> => {
    const snapshot = decodeReconciliation(input);
    if (closed || !snapshot) {
      return {
        ok: false as const,
        error: {
          code: closed ? ("CLOSED" as const) : ("INVALID_ARGUMENT" as const),
          message: closed
            ? "TriggerEngine is closed."
            : "Trigger reconciliation is invalid.",
          retryable: false,
        },
      };
    }
    return serializeReconcile<TriggerOutcome<TriggerReconcileResult>>(
      async () => {
        if (closed) {
          return {
            ok: false,
            error: {
              code: "CLOSED" as const,
              message: "TriggerEngine is closed.",
              retryable: false,
            },
          };
        }
        const previous = owners.get(snapshot.ownerId);
        if (previous && snapshot.generation <= previous.generation) {
          const error: TriggerError = {
            code: "STALE_GENERATION",
            message: "Owner generation must increase monotonically.",
            retryable: false,
            details: { currentGeneration: previous.generation },
          };
          return {
            ok: false,
            error,
          };
        }
        const totalBindings =
          [...owners.entries()].reduce(
            (total, [ownerId, owner]) =>
              total +
              (ownerId === snapshot.ownerId ? 0 : owner.bindings.length),
            0,
          ) + snapshot.bindings.length;
        if (totalBindings > maxBindings) {
          const error: TriggerError = {
            code: "CAPACITY_EXCEEDED",
            message: "Trigger binding capacity reached.",
            retryable: false,
            details: { maxBindings },
          };
          return {
            ok: false,
            error,
          };
        }
        const replayClaims: NonNullable<
          ReturnType<typeof decodeDurableClaim>
        >[] = [];
        let replayQuarantined = 0;
        if (persistence) {
          const releasePreparedClaims = async () => {
            await Promise.allSettled(
              replayClaims.map(({ claim }) =>
                persistence.releaseClaim({
                  claimId: claim.claimId,
                  claimantId: runtimeId,
                  fence: claim.fence,
                }),
              ),
            );
          };
          let cursor = replayCursor;
          for (let page = 0; page < maxPersistencePages; page++) {
            const loaded = await persistence.claimPage({
              claimantId: runtimeId,
              now: clock.now(),
              leaseUntil: clock.now() + persistenceClaimMs,
              limit: 64,
              ...(cursor === undefined ? {} : { cursor }),
            });
            if (!loaded.ok) {
              await releasePreparedClaims();
              return {
                ok: false,
                error: {
                  code: "PERSISTENCE_FAILED" as const,
                  message: "Trigger persistence claim failed.",
                  retryable: loaded.error.retryable,
                },
              };
            }
            const decoded = decodeClaimPage(loaded.value);
            if (!decoded) {
              await releasePreparedClaims();
              return {
                ok: false,
                error: {
                  code: "PERSISTENCE_FAILED" as const,
                  message: "Trigger persistence returned an invalid page.",
                  retryable: false,
                },
              };
            }
            replayClaims.push(...decoded.claims);
            for (const corrupt of decoded.corrupt) {
              const quarantined = await persistence.quarantine({
                claimId: corrupt.claimId,
                claimantId: runtimeId,
                fence: corrupt.fence,
                reason: "record-invalid",
              });
              if (!quarantined.ok) {
                await releasePreparedClaims();
                return {
                  ok: false,
                  error: {
                    code: "PERSISTENCE_FAILED" as const,
                    message: "Trigger persistence quarantine failed.",
                    retryable: quarantined.error.retryable,
                  },
                };
              }
              replayQuarantined++;
              counters.quarantined++;
            }
            if (closed) {
              await releasePreparedClaims();
              return {
                ok: false,
                error: {
                  code: "CLOSED" as const,
                  message: "TriggerEngine is closed.",
                  retryable: false,
                },
              };
            }
            cursor = decoded.nextCursor;
            replayCursor = cursor;
            if (cursor === undefined) break;
          }
        }
        const prepared: OwnerState = {
          generation: snapshot.generation,
          bindings: snapshot.bindings.map((binding) => ({
            identity: Object.freeze({
              ownerId: snapshot.ownerId,
              generation: snapshot.generation,
              bindingId: binding.id,
            }),
            binding,
            queue: [],
            active: 0,
            reserved: 0,
            reservedActive: 0,
            running: new Set(),
            retired: false,
          })),
        };
        owners.set(snapshot.ownerId, prepared);
        if (previous) {
          for (const state of previous.bindings) retire(state, "fenced");
        }
        let replayDelivered = 0;
        let replayAmbiguous = 0;
        let replayDegraded = replayQuarantined > 0;
        for (const { claim, record } of replayClaims) {
          const authority = sourcesByKey.get(record.sourceKey);
          if (!authority || !persistence) {
            replayDegraded ||= authority === undefined;
            if (persistence) {
              const released = await persistence.releaseClaim({
                claimId: claim.claimId,
                claimantId: runtimeId,
                fence: claim.fence,
              });
              replayDegraded ||= !released.ok;
            }
            continue;
          }
          const restoredEvent: TriggerEvent = {
            id: record.eventId,
            type: record.type,
            occurredAt: record.occurredAt,
            provenance: {
              hostId: options.hostId,
              projectId: authority.projectId,
              ...(authority.sessionId === undefined
                ? {}
                : { sessionId: authority.sessionId }),
              trust: authority.trust,
              source: {
                kind: authority.kind,
                id: authority.id,
                generation: authority.generation,
                ...(authority.metadata === undefined
                  ? {}
                  : { metadata: structuredClone(authority.metadata) }),
              },
            },
            cause: { rootEventId: record.eventId, ancestry: [] },
            payload: {},
            durability: "restart-only",
          };
          const replayed = await publishStamped(
            { type: record.type, payload: {}, durability: "restart-only" },
            authority,
            undefined,
            restoredEvent,
            claim,
            () =>
              !closed &&
              sourcesByKey.get(record.sourceKey) === authority &&
              activeSources.get(authority.identityKey) === authority,
          );
          if (!replayed.ok) {
            replayDegraded = true;
            continue;
          }
          replayDelivered += replayed.value.deliveries.filter(
            ({ status }) => status === "delivered",
          ).length;
          replayAmbiguous += replayed.value.deliveries.filter(
            ({ status }) => status === "ambiguous",
          ).length;
          replayDegraded ||= replayAmbiguous > 0;
        }
        return success({
          ownerId: snapshot.ownerId,
          generation: snapshot.generation,
          bindingCount: snapshot.bindings.length,
          replay: {
            claimed: replayClaims.length + replayQuarantined,
            delivered: replayDelivered,
            ambiguous: replayAmbiguous,
            quarantined: replayQuarantined,
            state: replayDegraded
              ? ("degraded" as const)
              : ("healthy" as const),
          },
        });
      },
    );
  };

  const publishStamped = async (
    input: TriggerPublishInput,
    sourceAuthority: SourceAuthority,
    parent?: {
      rootEventId: string;
      eventId: string;
      ancestry: readonly string[];
    },
    restoredEvent?: TriggerEvent,
    restoredClaim?: TriggerPersistenceClaim,
    fence?: () => boolean,
  ): Promise<TriggerOutcome<TriggerPublishResult>> => {
    if (closed) {
      return {
        ok: false,
        error: {
          code: "CLOSED" as const,
          message: "TriggerEngine is closed.",
          retryable: false,
        },
      };
    }
    if (fence && !fence()) {
      return {
        ok: false,
        error: {
          code: "STALE_GENERATION" as const,
          message: "Trigger delivery attempt is no longer current.",
          retryable: false,
        },
      };
    }
    if (parent && parent.ancestry.length > maxCausalDepth) {
      return {
        ok: false,
        error: {
          code: "RECURSION_LIMIT" as const,
          message: "Trigger causal ancestry limit reached.",
          retryable: false,
          details: { maxCausalDepth },
        },
      };
    }
    const candidate: unknown = input;
    if (
      !isPlainData(candidate, { maxNodes: maxDataNodes }) ||
      candidate === null ||
      Array.isArray(candidate) ||
      typeof candidate !== "object" ||
      !hasExactKeys(candidate as Record<string, unknown>, [
        "type",
        "payload",
        "durability",
      ]) ||
      !isBoundedIdentifier(input.type) ||
      !isPlainData(input.payload) ||
      Array.isArray(input.payload) ||
      (input.durability !== undefined &&
        input.durability !== "ephemeral" &&
        input.durability !== "restart-only")
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT" as const,
          message:
            "Trigger event must contain bounded plain data without accessors or cycles.",
          retryable: false,
        },
      };
    }
    if (Buffer.byteLength(JSON.stringify(input.payload)) > maxPayloadBytes) {
      return {
        ok: false,
        error: {
          code: "PAYLOAD_TOO_LARGE" as const,
          message: `Trigger payload exceeds ${maxPayloadBytes} bytes.`,
          retryable: false,
          details: { maxPayloadBytes },
        },
      };
    }
    const id = restoredEvent?.id ?? createEventId();
    const event = deepFreeze<TriggerEvent>(
      restoredEvent ?? {
        id,
        type: input.type,
        occurredAt: clock.now(),
        provenance: {
          hostId: options.hostId,
          projectId: sourceAuthority.projectId,
          ...(sourceAuthority.sessionId === undefined
            ? {}
            : { sessionId: sourceAuthority.sessionId }),
          trust: sourceAuthority.trust,
          source: {
            kind: sourceAuthority.kind,
            id: sourceAuthority.id,
            generation: sourceAuthority.generation,
            ...(sourceAuthority.metadata === undefined
              ? {}
              : { metadata: structuredClone(sourceAuthority.metadata) }),
          },
        },
        cause: parent
          ? {
              rootEventId: parent.rootEventId,
              parentEventId: parent.eventId,
              ancestry: [...parent.ancestry],
            }
          : { rootEventId: id, ancestry: [] },
        payload: structuredClone(input.payload),
        durability: input.durability ?? "ephemeral",
      },
    );
    eventSourceKeys.set(event, sourceAuthority.sourceKey);
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    if (eventBytes > maxEnvelopeBytes) {
      return {
        ok: false,
        error: {
          code: "ENVELOPE_TOO_LARGE" as const,
          message: `Trigger envelope exceeds ${maxEnvelopeBytes} bytes.`,
          retryable: false,
          details: { maxEnvelopeBytes },
        },
      };
    }
    const pump = (state: BindingState) => {
      while (
        !closed &&
        !state.retired &&
        globalActive < maxActiveConsumers &&
        state.active < (state.binding.concurrency ?? 1) &&
        state.queue.length > 0
      ) {
        const batchSize =
          state.binding.batch?.maxCount ??
          (state.binding.debounceMs === undefined ? 1 : state.queue.length);
        const queued = state.queue.splice(0, batchSize);
        if (queued.length === 0) break;
        for (const item of queued) {
          if (!item.counted) continue;
          queuedCount--;
          queuedBytes -= item.bytes;
        }
        state.active++;
        globalActive++;
        const events = queued.map(({ event: queuedEvent }) => queuedEvent);
        const queuedEvent = events.at(-1)!;
        const controller = new AbortController();
        let finished = false;
        let deadline: unknown;
        const running: RunningDelivery = {
          controller,
          finish(status) {
            if (finished) return;
            finished = true;
            if (deadline !== undefined) clock.clearTimeout(deadline);
            state.running.delete(running);
            state.active--;
            globalActive--;
            for (const owner of owners.values()) {
              for (const candidate of owner.bindings) pump(candidate);
            }
            const settlement = (async () => {
              for (const item of queued) {
                let settledStatus = status;
                if (item.attempt && persistence) {
                  const completed = await persistence.completeAttempt({
                    ...item.attempt,
                    status,
                  });
                  if (!completed.ok) {
                    settledStatus = "ambiguous";
                    counters.ambiguous++;
                  }
                }
                const result = { ...state.identity, status: settledStatus };
                for (const resolve of item.resolves) resolve(result);
              }
            })();
            track(acceptedOperations, settlement);
          },
        };
        state.running.add(running);
        deadline = clock.setTimeout(() => {
          controller.abort("deadline");
          running.finish("timed-out");
        }, state.binding.deadlineMs ?? 30_000);
        const callbackTask = Promise.resolve()
          .then(() => {
            if (
              finished ||
              closed ||
              state.retired ||
              owners.get(state.identity.ownerId)?.generation !==
                state.identity.generation
            ) {
              return;
            }
            return state.binding.deliver({
              binding: state.identity,
              events,
              signal: controller.signal,
              publish: (child) => {
                if (
                  finished ||
                  controller.signal.aborted ||
                  state.retired ||
                  owners.get(state.identity.ownerId)?.generation !==
                    state.identity.generation
                ) {
                  return Promise.resolve({
                    ok: false as const,
                    error: {
                      code: closed
                        ? ("CLOSED" as const)
                        : ("STALE_GENERATION" as const),
                      message: closed
                        ? "TriggerEngine is closed."
                        : "Trigger delivery attempt is no longer current.",
                      retryable: false,
                    },
                  });
                }
                return publishStamped(
                  child,
                  {
                    kind: "trigger-binding",
                    id: `${state.identity.ownerId}/${state.identity.bindingId}`,
                    generation: state.identity.generation,
                    projectId: queuedEvent.provenance.projectId,
                    ...(queuedEvent.provenance.sessionId === undefined
                      ? {}
                      : { sessionId: queuedEvent.provenance.sessionId }),
                    trust: queuedEvent.provenance.trust,
                    sourceKey:
                      eventSourceKeys.get(queuedEvent) ??
                      createHash("sha256")
                        .update(
                          JSON.stringify({
                            kind: "trigger-binding",
                            id: `${state.identity.ownerId}/${state.identity.bindingId}`,
                            projectId: queuedEvent.provenance.projectId,
                            sessionId: queuedEvent.provenance.sessionId,
                            trust: queuedEvent.provenance.trust,
                          }),
                        )
                        .digest("hex"),
                    identityKey: createHash("sha256")
                      .update(
                        `trigger-binding\u0000${state.identity.ownerId}/${state.identity.bindingId}`,
                      )
                      .digest("hex"),
                  },
                  {
                    rootEventId: queuedEvent.cause.rootEventId,
                    eventId: queuedEvent.id,
                    ancestry: [
                      ...queuedEvent.cause.ancestry,
                      `${state.identity.ownerId}/${state.identity.bindingId}`,
                    ],
                  },
                  undefined,
                  undefined,
                  () =>
                    !finished &&
                    !controller.signal.aborted &&
                    !state.retired &&
                    owners.get(state.identity.ownerId)?.generation ===
                      state.identity.generation,
                );
              },
            });
          })
          .then(
            () => running.finish("delivered"),
            () => running.finish("failed"),
          );
        track(callbackTasks, callbackTask);
      }
    };
    const schedule = (state: BindingState) => {
      if (state.timer !== undefined) clock.clearTimeout(state.timer);
      const now = clock.now();
      const debounceAt =
        state.binding.debounceMs === undefined
          ? Number.POSITIVE_INFINITY
          : (state.lastQueuedAt ?? now) + state.binding.debounceMs;
      const maxWaitAt =
        state.binding.batch === undefined
          ? Number.POSITIVE_INFINITY
          : (state.firstQueuedAt ?? now) + state.binding.batch.maxWaitMs;
      const dueAt = Math.min(debounceAt, maxWaitAt);
      state.timer = clock.setTimeout(
        () => {
          state.timer = undefined;
          state.firstQueuedAt = undefined;
          state.lastQueuedAt = undefined;
          pump(state);
        },
        Math.max(0, dueAt - now),
      );
    };
    const delayed = (state: BindingState) =>
      state.binding.debounceMs !== undefined ||
      state.binding.batch !== undefined;
    const coalesceValue = (state: BindingState) =>
      state.binding.coalesceBy === undefined
        ? undefined
        : event.payload[state.binding.coalesceBy];
    const existingFor = (state: BindingState) => {
      if (event.durability === "restart-only") return undefined;
      const value = coalesceValue(state);
      if (value === undefined) return undefined;
      return state.queue.find(
        ({ event: queuedEvent }) =>
          queuedEvent.payload[state.binding.coalesceBy!] === value,
      );
    };
    const enqueue = (
      state: BindingState,
      existing?: QueuedDelivery,
      attempt?: TriggerPersistenceAttemptRequest,
    ) =>
      new Promise<TriggerDeliveryResult>((resolve) => {
        const now = clock.now();
        if (existing) {
          if (existing.counted) queuedBytes += eventBytes - existing.bytes;
          const superseded = {
            ...state.identity,
            status: "superseded" as const,
            replacementEventId: event.id,
          };
          for (const settle of existing.resolves) settle(superseded);
          counters.coalesced++;
          counters.superseded += existing.resolves.length;
          existing.event = event;
          existing.bytes = eventBytes;
          existing.resolves = [resolve];
          state.lastQueuedAt = now;
          schedule(state);
          return;
        }
        const counted =
          delayed(state) ||
          globalActive >= maxActiveConsumers ||
          state.active >= (state.binding.concurrency ?? 1) ||
          state.queue.length > 0;
        if (counted) {
          queuedCount++;
          queuedBytes += eventBytes;
        }
        state.queue.push({
          event,
          resolves: [resolve],
          bytes: eventBytes,
          counted,
          enqueuedAt: now,
          ...(attempt === undefined ? {} : { attempt }),
        });
        state.firstQueuedAt ??= now;
        state.lastQueuedAt = now;
        if (
          delayed(state) &&
          state.queue.length < (state.binding.batch?.maxCount ?? Infinity)
        ) {
          schedule(state);
        } else {
          if (state.timer !== undefined) clock.clearTimeout(state.timer);
          state.timer = undefined;
          state.firstQueuedAt = undefined;
          state.lastQueuedAt = undefined;
          pump(state);
        }
      });

    const routes = [...owners].flatMap(([ownerId, owner]) =>
      owner.bindings.map((state) => ({ ownerId, owner, state })),
    );
    routes.sort(
      (left, right) =>
        (left.state.binding.priority ?? 0) -
          (right.state.binding.priority ?? 0) ||
        left.ownerId.localeCompare(right.ownerId) ||
        left.state.binding.id.localeCompare(right.state.binding.id),
    );
    const matched = routes.filter(
      ({ state }) =>
        state.binding.eventTypes.includes(event.type) &&
        !event.cause.ancestry.includes(
          `${state.identity.ownerId}/${state.identity.bindingId}`,
        ),
    );
    const rootEventId = event.cause.rootEventId;
    const rootBudget = rootBudgets.get(rootEventId) ?? {
      firings: 0,
      fanout: 0,
      active: 0,
    };
    if (
      rootBudget.firings + 1 > maxRootFirings ||
      rootBudget.fanout + matched.length > maxRootFanout
    ) {
      counters.dropped++;
      return {
        ok: false,
        error: {
          code: "RECURSION_LIMIT" as const,
          message: "Trigger root firing or fanout limit reached.",
          retryable: false,
          details: { maxRootFirings, maxRootFanout },
        },
      };
    }
    rootBudget.firings++;
    rootBudget.fanout += matched.length;
    rootBudget.active++;
    rootBudgets.set(rootEventId, rootBudget);
    const releaseRoot = () => {
      rootBudget.active--;
      if (rootBudget.active === 0) rootBudgets.delete(rootEventId);
    };
    let availableActive = Math.max(
      0,
      maxActiveConsumers - globalActive - reservedActive,
    );
    const plannedActive = new Map<BindingState, number>();
    const plans = matched.map(({ state }) => {
      const existing = existingFor(state);
      const canStart =
        existing === undefined &&
        !delayed(state) &&
        state.queue.length + state.reserved === 0 &&
        state.active + state.reservedActive + (plannedActive.get(state) ?? 0) <
          (state.binding.concurrency ?? 1) &&
        availableActive > 0;
      if (canStart) {
        availableActive--;
        plannedActive.set(state, (plannedActive.get(state) ?? 0) + 1);
      }
      return {
        state,
        existing,
        willQueue: !canStart && existing === undefined,
      };
    });
    const countDelta = plans.filter(({ willQueue }) => willQueue).length;
    const byteDelta = plans.reduce((total, { existing, willQueue }) => {
      if (existing) return total + Math.max(0, eventBytes - existing.bytes);
      return total + (willQueue ? eventBytes : 0);
    }, 0);
    if (
      plans.some(
        ({ state, willQueue }) =>
          willQueue &&
          state.queue.length + state.reserved + 1 > maxPendingPerBinding,
      ) ||
      queuedCount + reservedCount + countDelta > maxQueueCount ||
      queuedBytes + reservedBytes + byteDelta > maxQueueBytes
    ) {
      counters.dropped++;
      releaseRoot();
      return {
        ok: false,
        error: {
          code: "QUEUE_FULL" as const,
          message: "Trigger queue count or byte capacity reached.",
          retryable: true,
          details: { maxQueueCount, maxQueueBytes },
        },
      };
    }
    const reservedStates = plans
      .filter(({ willQueue }) => willQueue)
      .map(({ state }) => state);
    const reservedActiveStates = plans
      .filter(({ existing, willQueue }) => existing === undefined && !willQueue)
      .map(({ state }) => state);
    reservedCount += countDelta;
    reservedBytes += byteDelta;
    for (const state of reservedStates) state.reserved++;
    reservedActive += reservedActiveStates.length;
    for (const state of reservedActiveStates) state.reservedActive++;
    let reservationsReleased = false;
    const releaseReservations = () => {
      if (reservationsReleased) return;
      reservationsReleased = true;
      reservedCount -= countDelta;
      reservedBytes -= byteDelta;
      for (const state of reservedStates) state.reserved--;
      reservedActive -= reservedActiveStates.length;
      for (const state of reservedActiveStates) state.reservedActive--;
    };
    let durableClaim: TriggerPersistenceClaim | undefined = restoredClaim;
    if (event.durability === "restart-only" && !restoredEvent) {
      if (!persistence) {
        releaseReservations();
        releaseRoot();
        return {
          ok: false,
          error: {
            code: "PERSISTENCE_FAILED" as const,
            message: "Restart-only trigger events require persistence.",
            retryable: false,
          },
        };
      }
      const saved = await persistence.store({
        record: {
          schemaVersion: 1,
          eventId: event.id,
          type: event.type,
          occurredAt: event.occurredAt,
          sourceKey: sourceAuthority.sourceKey,
          payloadDigest: createHash("sha256")
            .update(JSON.stringify(event.payload))
            .digest("hex"),
        },
        claimantId: runtimeId,
        now: clock.now(),
        leaseUntil: clock.now() + persistenceClaimMs,
      });
      if (!saved.ok) {
        releaseReservations();
        releaseRoot();
        return {
          ok: false,
          error: {
            code: "PERSISTENCE_FAILED" as const,
            message: "Trigger persistence write failed.",
            retryable: saved.error.retryable,
          },
        };
      }
      durableClaim = saved.value;
      if (closed || (fence && !fence())) {
        await persistence.releaseClaim({
          claimId: durableClaim.claimId,
          claimantId: runtimeId,
          fence: durableClaim.fence,
        });
        releaseReservations();
        releaseRoot();
        return {
          ok: false,
          error: {
            code: closed ? ("CLOSED" as const) : ("STALE_GENERATION" as const),
            message: closed
              ? "TriggerEngine is closed."
              : "Trigger delivery attempt is no longer current.",
            retryable: false,
          },
        };
      }
    }
    const immediateDeliveries: TriggerDeliveryResult[] = [];
    const deliveryPlans: Array<
      (typeof plans)[number] & {
        readonly attempt?: TriggerPersistenceAttemptRequest;
      }
    > = [];
    for (const plan of plans) {
      if (!durableClaim || !persistence) {
        deliveryPlans.push(plan);
        continue;
      }
      const attempt = {
        claimId: durableClaim.claimId,
        claimantId: runtimeId,
        fence: durableClaim.fence,
        attemptId: `${runtimeId}:${++nextAttemptSequence}`,
        bindingKey: createHash("sha256")
          .update(
            `${plan.state.identity.ownerId}\u0000${plan.state.identity.bindingId}`,
          )
          .digest("hex"),
        bindingGeneration: plan.state.identity.generation,
      } satisfies TriggerPersistenceAttemptRequest;
      const begun = await persistence.beginAttempt(attempt);
      if (closed || (fence && !fence())) {
        const startedAttempts = deliveryPlans.flatMap((started) =>
          started.attempt === undefined ? [] : [started.attempt],
        );
        if (begun.ok && begun.value === "started")
          startedAttempts.push(attempt);
        for (const started of startedAttempts) {
          await persistence.completeAttempt({
            ...started,
            status: closed ? "closed" : "fenced",
          });
        }
        await persistence.releaseClaim({
          claimId: durableClaim.claimId,
          claimantId: runtimeId,
          fence: durableClaim.fence,
        });
        releaseReservations();
        releaseRoot();
        return {
          ok: false,
          error: {
            code: closed ? ("CLOSED" as const) : ("STALE_GENERATION" as const),
            message: closed
              ? "TriggerEngine is closed."
              : "Trigger delivery attempt is no longer current.",
            retryable: false,
          },
        };
      }
      if (!begun.ok || begun.value === "ambiguous") {
        counters.ambiguous++;
        immediateDeliveries.push({
          ...plan.state.identity,
          status: "ambiguous",
        });
        continue;
      }
      if (begun.value === "already-delivered") {
        immediateDeliveries.push({
          ...plan.state.identity,
          status: "acknowledged",
        });
        continue;
      }
      if (
        closed ||
        plan.state.retired ||
        owners.get(plan.state.identity.ownerId)?.generation !==
          plan.state.identity.generation
      ) {
        const status = closed ? ("closed" as const) : ("fenced" as const);
        await persistence.completeAttempt({ ...attempt, status });
        immediateDeliveries.push({ ...plan.state.identity, status });
        continue;
      }
      deliveryPlans.push({ ...plan, attempt });
    }
    releaseReservations();
    const deliveries = [
      ...immediateDeliveries,
      ...(await Promise.all(
        deliveryPlans.map(({ state, existing, attempt }) =>
          enqueue(state, existing, attempt),
        ),
      )),
    ];
    if (durableClaim && persistence) {
      const released = await persistence.releaseClaim({
        claimId: durableClaim.claimId,
        claimantId: runtimeId,
        fence: durableClaim.fence,
      });
      if (!released.ok) {
        releaseRoot();
        return {
          ok: false,
          error: {
            code: "PERSISTENCE_FAILED" as const,
            message: "Trigger persistence claim release failed.",
            retryable: released.error.retryable,
          },
        };
      }
    }
    appendHistory(event, deliveries);
    const disposition = deliveries.some(({ status }) => status === "superseded")
      ? ("superseded" as const)
      : plans.some(({ existing }) => existing !== undefined)
        ? ("coalesced" as const)
        : deliveries.length === 0
          ? ("unrouted" as const)
          : ("routed" as const);
    releaseRoot();
    return success({ event, deliveries, disposition });
  };

  const inspect = () => {
    const snapshot = {
      state: closed ? ("closed" as const) : ("open" as const),
      bindings: [...owners].flatMap(([ownerId, owner]) =>
        owner.bindings.map(({ binding }) => ({
          ownerId: redact(ownerId),
          generation: owner.generation,
          bindingId: redact(binding.id),
        })),
      ),
      queue: {
        count: queuedCount + reservedCount,
        bytes: queuedBytes + reservedBytes,
        running: [...owners.values()].reduce(
          (total, owner) =>
            total +
            owner.bindings.reduce(
              (ownerTotal, state) => ownerTotal + state.active,
              0,
            ),
          0,
        ),
        admitting: reservedActive,
      },
      counters: {
        ...counters,
        unresolvedCallbacks: callbackTasks.size,
        unresolvedOperations: acceptedOperations.size,
      },
      history: history.map((entry) => structuredClone(entry)),
    };
    while (
      Buffer.byteLength(JSON.stringify(snapshot)) > maxInspectionBytes &&
      snapshot.history.length > 0
    ) {
      snapshot.history.shift();
    }
    while (
      Buffer.byteLength(JSON.stringify(snapshot)) > maxInspectionBytes &&
      snapshot.bindings.length > 0
    ) {
      snapshot.bindings.pop();
    }
    return snapshot;
  };

  const publish = (
    source: TriggerSourcePublisher,
    input: TriggerPublishInput,
  ) => {
    const authority = sourceAuthorities.get(source);
    if (!authority) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: "INVALID_ARGUMENT" as const,
          message: "Trigger source publisher is not bound to this runtime.",
          retryable: false,
        },
      });
    }
    if (activeSources.get(authority.identityKey) !== authority) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: "STALE_GENERATION" as const,
          message: "Trigger source publisher generation is stale.",
          retryable: false,
        },
      });
    }
    return track(
      acceptedOperations,
      publishStamped(
        input,
        authority,
        undefined,
        undefined,
        undefined,
        () => !closed && activeSources.get(authority.identityKey) === authority,
      ),
    );
  };

  const bindSource = (input: TriggerSourceBinding) => {
    if (closed) {
      return {
        ok: false as const,
        error: {
          code: "CLOSED" as const,
          message: "TriggerEngine is closed.",
          retryable: false,
        },
      };
    }
    const candidate: unknown = input;
    if (
      !isPlainData(candidate, { maxNodes: maxDataNodes }) ||
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      !hasExactKeys(candidate as Record<string, unknown>, [
        "kind",
        "id",
        "projectId",
        "sessionId",
        "trust",
        "metadata",
      ]) ||
      !isBoundedIdentifier(input.kind) ||
      !isBoundedIdentifier(input.id) ||
      !isBoundedIdentifier(input.projectId) ||
      (input.sessionId !== undefined &&
        !isBoundedIdentifier(input.sessionId)) ||
      !["managed", "user", "trusted-project", "untrusted"].includes(input.trust)
    ) {
      return {
        ok: false as const,
        error: {
          code: "INVALID_ARGUMENT" as const,
          message: "Trigger source binding is invalid.",
          retryable: false,
        },
      };
    }
    const snapshot = structuredClone(input);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > maxSourceBytes) {
      return {
        ok: false as const,
        error: {
          code: "SOURCE_TOO_LARGE" as const,
          message: `Trigger source binding exceeds ${maxSourceBytes} bytes.`,
          retryable: false,
          details: { maxSourceBytes },
        },
      };
    }
    const identityKey = createHash("sha256")
      .update(`${snapshot.kind}\u0000${snapshot.id}`)
      .digest("hex");
    const sourceKey = createHash("sha256")
      .update(
        JSON.stringify({
          kind: snapshot.kind,
          id: snapshot.id,
          projectId: snapshot.projectId,
          sessionId: snapshot.sessionId,
          trust: snapshot.trust,
        }),
      )
      .digest("hex");
    const authority = {
      ...snapshot,
      generation: (sourceGenerations.get(identityKey) ?? 0) + 1,
      sourceKey,
      identityKey,
    };
    sourceGenerations.set(identityKey, authority.generation);
    const previous = activeSources.get(identityKey);
    if (previous) sourcesByKey.delete(previous.sourceKey);
    let publisher!: TriggerSourcePublisher;
    publisher = Object.freeze({
      publish: (event: TriggerPublishInput) => publish(publisher, event),
    });
    sourceAuthorities.set(publisher, authority);
    sourcesByKey.set(authority.sourceKey, authority);
    activeSources.set(identityKey, authority);
    return success(publisher);
  };

  return {
    engine: {
      reconcile: (input: TriggerOwnerReconciliation) =>
        track(acceptedOperations, reconcile(input)),
      publish,
      inspect,
    },
    bindSource,
    close(_reason = "close") {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        for (const owner of owners.values()) {
          for (const state of owner.bindings) retire(state, "closed");
        }
        owners.clear();
        const draining = Promise.allSettled([
          ...acceptedOperations,
          ...callbackTasks,
        ]);
        let handle: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          draining,
          new Promise<void>((resolve) => {
            handle = globalThis.setTimeout(resolve, closeDrainMs);
          }),
        ]);
        if (handle !== undefined) globalThis.clearTimeout(handle);
      })();
      return closePromise;
    },
  };
}
