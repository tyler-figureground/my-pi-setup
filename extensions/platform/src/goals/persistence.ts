import { createHash } from "node:crypto";
import type {
  StateMutation,
  StateCompactRequest,
  StateRecord,
  StateStore,
  StateStoreError,
  StateTransactionResult,
} from "../core/persistence/state-store.ts";
import {
  DEFAULT_METADATA_MAX_BYTES,
  DEFAULT_QUERY_MAX_LIMIT,
} from "../core/persistence/state-store.ts";
import type { JsonObject } from "../core/result.ts";
import { canonicalize } from "./digest.ts";
import {
  GOAL_IDENTIFIER,
  GOAL_LIMITS,
  type GoalArtifactReference,
  type GoalAttemptPhase,
  type GoalBudget,
  type GoalCancellationStatus,
  type GoalCriterion,
  type GoalEvidence,
  type GoalHistoryEntry,
  type GoalNodeDefinition,
  type GoalNodeState,
  type GoalOutcome,
  type GoalProfilePin,
  type GoalReservation,
  type GoalState,
} from "./model.ts";
import {
  GOAL_ATTEMPT_PHASES,
  GOAL_NODE_STATES,
  GOAL_STATES,
} from "./transitions.ts";

/**
 * Bounded, project-namespaced persistence.
 *
 * Records are small and split by concern (head, node, attempt) so a 128-node
 * Goal never approaches the State Record metadata bound and so two nodes can
 * settle concurrently without contending on one optimistic version. Everything
 * read back from storage is revalidated: persisted state is trusted for
 * coordination, never for shape.
 */

export interface StoredGoalHead {
  readonly goalId: string;
  readonly generationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly state: GoalState;
  readonly definitionRevision: number;
  readonly runGeneration: number;
  readonly objective: string;
  readonly criteria: readonly GoalCriterion[];
  readonly budget: GoalBudget;
  readonly order: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly history: readonly GoalHistoryEntry[];
  readonly blockedReason: string | null;
  /** Retained cancellation intent. Absent until a Goal is cancelled. */
  readonly cancellation?: GoalCancellationStatus | null;
  readonly revisionDigest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredGoalNode {
  readonly goalId: string;
  readonly generationId: string;
  readonly nodeId: string;
  readonly definition: GoalNodeDefinition;
  readonly state: GoalNodeState;
  readonly attemptCount: number;
  readonly nextAttemptAt: number | null;
  readonly currentAttempt: number | null;
  readonly profile: GoalProfilePin;
  readonly evidence: readonly GoalEvidence[];
  readonly blockedReason: string | null;
  readonly lastError: {
    readonly code: string;
    readonly message: string;
  } | null;
  readonly updatedAt: number;
}

export interface StoredGoalAttempt {
  readonly goalId: string;
  readonly generationId: string;
  readonly nodeId: string;
  readonly number: number;
  readonly attemptKey: string;
  readonly phase: GoalAttemptPhase;
  readonly fence: number;
  readonly owner: string;
  readonly runGeneration: number;
  readonly reservation: GoalReservation;
  readonly profile: GoalProfilePin;
  readonly workspaceId: string | null;
  readonly cwd: string;
  readonly startedAt: number;
  readonly settledAt: number | null;
  readonly accountedAt: number | null;
  readonly certainty: "not-started" | "started" | "unknown" | null;
  readonly usage: {
    readonly tokens: number;
    readonly authoritative: boolean;
    readonly costMicros?: number;
    readonly costAuthoritative?: boolean;
  } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly artifact: GoalArtifactReference | null;
}

export interface StoredGoalRequest {
  readonly digest: string;
  readonly goalId: string;
  readonly eventPosition: number;
  readonly eventId?: string;
}

export interface StoredGoalDelivery {
  readonly goalId: string;
  readonly generationId: string;
  readonly state: GoalState;
  readonly runGeneration: number;
  readonly deliveredAt: number;
  readonly result: string;
}

export interface Versioned<T> {
  readonly value: T;
  readonly version: number;
}

export interface KeyedVersioned<T> extends Versioned<T> {
  readonly key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum = 4_096) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function whole(value: unknown, minimum = 0) {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function nullableWhole(value: unknown) {
  return value === null || whole(value);
}

function nullableText(value: unknown, maximum = 1_000) {
  return value === null || text(value, maximum);
}

function amounts(value: unknown) {
  return (
    isRecord(value) &&
    whole(value.calls) &&
    whole(value.runtimeMs) &&
    whole(value.tokens) &&
    whole(value.costMicros)
  );
}

function budget(value: unknown) {
  if (!isRecord(value) || !isRecord(value.limits)) return false;
  const limits = value.limits;
  return (
    whole(limits.maxConcurrency, 1) &&
    whole(limits.maxAgentCalls, 1) &&
    whole(limits.maxRuntimeMs, 1) &&
    (limits.maxTokens === null || whole(limits.maxTokens, 1)) &&
    (limits.maxCostMicros === null || whole(limits.maxCostMicros, 1)) &&
    amounts(value.reserved) &&
    amounts(value.consumed)
  );
}

function profilePin(value: unknown) {
  return (
    isRecord(value) &&
    text(value.name, GOAL_LIMITS.maxIdentifierLength) &&
    typeof value.contentDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.contentDigest) &&
    whole(value.catalogGeneration) &&
    isRecord(value.source) &&
    ["managed", "user", "project"].includes(String(value.source.scope)) &&
    text(value.source.path)
  );
}

function evidenceEntry(value: unknown) {
  return (
    isRecord(value) &&
    text(value.id, 128) &&
    text(value.kind, 64) &&
    text(value.trust, 64) &&
    text(value.criterionId, GOAL_LIMITS.maxIdentifierLength) &&
    (value.scope === "goal" || value.scope === "node") &&
    (value.nodeId === null ||
      text(value.nodeId, GOAL_LIMITS.maxIdentifierLength)) &&
    nullableWhole(value.attemptNumber) &&
    whole(value.definitionRevision, 1) &&
    typeof value.summary === "string" &&
    value.summary.length <= GOAL_LIMITS.maxDescriptionLength &&
    (value.artifact === null || isRecord(value.artifact)) &&
    whole(value.recordedAt)
  );
}

function historyEntry(value: unknown) {
  return (
    isRecord(value) &&
    whole(value.position) &&
    text(value.type, 128) &&
    (value.actor === "direct-user" || value.actor === "agent") &&
    text(value.actorId, 512) &&
    whole(value.at) &&
    nullableText(value.reason, GOAL_LIMITS.maxReasonLength) &&
    isRecord(value.details)
  );
}

function criterion(value: unknown) {
  return (
    isRecord(value) &&
    text(value.id, GOAL_LIMITS.maxIdentifierLength) &&
    text(value.description, GOAL_LIMITS.maxDescriptionLength) &&
    Array.isArray(value.acceptedEvidenceKinds) &&
    value.acceptedEvidenceKinds.length > 0 &&
    value.acceptedEvidenceKinds.every((kind) => text(kind, 64)) &&
    whole(value.minimumEvidenceCount, 1) &&
    text(value.minimumTrust, 64)
  );
}

function nodeDefinition(value: unknown) {
  return (
    isRecord(value) &&
    text(value.id, GOAL_LIMITS.maxIdentifierLength) &&
    text(value.title, GOAL_LIMITS.maxTitleLength) &&
    text(value.prompt, GOAL_LIMITS.maxPromptLength) &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.length <= GOAL_LIMITS.maxDependenciesPerNode &&
    value.dependsOn.every((id) => text(id, GOAL_LIMITS.maxIdentifierLength)) &&
    text(value.profileName, GOAL_LIMITS.maxIdentifierLength) &&
    typeof value.required === "boolean" &&
    isRecord(value.policy) &&
    whole(value.policy.timeoutMs, 1) &&
    whole(value.policy.maxAttempts, 1) &&
    whole(value.policy.retryDelayMs) &&
    whole(value.policy.maxOutputBytes, 1) &&
    isRecord(value.reservation) &&
    whole(value.reservation.runtimeMs) &&
    whole(value.reservation.tokens) &&
    whole(value.reservation.costMicros) &&
    Array.isArray(value.criteria) &&
    value.criteria.length <= GOAL_LIMITS.maxCriteria &&
    value.criteria.every(criterion) &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}

function cancellationStatus(value: unknown) {
  if (value === undefined || value === null) return true;
  return (
    isRecord(value) &&
    whole(value.requestedAt) &&
    nullableWhole(value.reconciledAt) &&
    Array.isArray(value.unresolved) &&
    value.unresolved.length <= GOAL_LIMITS.maxNodes &&
    value.unresolved.every((id) => text(id, GOAL_LIMITS.maxIdentifierLength)) &&
    ["pending", "settled", "unknown"].includes(String(value.certainty))
  );
}

function validHead(value: unknown, projectId: string) {
  return (
    isRecord(value) &&
    text(value.goalId, GOAL_LIMITS.maxIdentifierLength) &&
    GOAL_IDENTIFIER.test(String(value.goalId)) &&
    text(value.generationId, 64) &&
    value.projectId === projectId &&
    text(value.sessionId, 512) &&
    GOAL_STATES.includes(value.state as GoalState) &&
    whole(value.definitionRevision, 1) &&
    whole(value.runGeneration, 1) &&
    text(value.objective, GOAL_LIMITS.maxObjectiveLength) &&
    Array.isArray(value.criteria) &&
    value.criteria.length <= GOAL_LIMITS.maxCriteria &&
    value.criteria.every(criterion) &&
    budget(value.budget) &&
    Array.isArray(value.order) &&
    value.order.length <= GOAL_LIMITS.maxNodes &&
    value.order.every((id) => text(id, GOAL_LIMITS.maxIdentifierLength)) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= GOAL_LIMITS.maxEvidencePerNode &&
    value.evidence.every(evidenceEntry) &&
    Array.isArray(value.history) &&
    value.history.length <= GOAL_LIMITS.maxHistoryEntries &&
    value.history.every(historyEntry) &&
    nullableText(value.blockedReason) &&
    cancellationStatus(value.cancellation) &&
    typeof value.revisionDigest === "string" &&
    whole(value.createdAt) &&
    whole(value.updatedAt)
  );
}

function validNode(value: unknown, goalId: string) {
  return (
    isRecord(value) &&
    value.goalId === goalId &&
    text(value.generationId, 64) &&
    text(value.nodeId, GOAL_LIMITS.maxIdentifierLength) &&
    nodeDefinition(value.definition) &&
    GOAL_NODE_STATES.includes(value.state as GoalNodeState) &&
    whole(value.attemptCount) &&
    Number(value.attemptCount) <= GOAL_LIMITS.maxAttemptsPerNode &&
    nullableWhole(value.nextAttemptAt) &&
    nullableWhole(value.currentAttempt) &&
    profilePin(value.profile) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= GOAL_LIMITS.maxEvidencePerNode &&
    value.evidence.every(evidenceEntry) &&
    nullableText(value.blockedReason) &&
    (value.lastError === null ||
      (isRecord(value.lastError) &&
        text(value.lastError.code, 128) &&
        text(value.lastError.message, 1_000))) &&
    whole(value.updatedAt)
  );
}

function validAttempt(value: unknown, goalId: string) {
  return (
    isRecord(value) &&
    value.goalId === goalId &&
    text(value.generationId, 64) &&
    text(value.nodeId, GOAL_LIMITS.maxIdentifierLength) &&
    whole(value.number, 1) &&
    typeof value.attemptKey === "string" &&
    /^[a-f0-9]{64}$/.test(value.attemptKey) &&
    GOAL_ATTEMPT_PHASES.includes(value.phase as GoalAttemptPhase) &&
    whole(value.fence) &&
    text(value.owner, 512) &&
    whole(value.runGeneration, 1) &&
    isRecord(value.reservation) &&
    profilePin(value.profile) &&
    (value.workspaceId === null || text(value.workspaceId, 512)) &&
    text(value.cwd) &&
    whole(value.startedAt) &&
    nullableWhole(value.settledAt) &&
    (value.accountedAt === undefined || nullableWhole(value.accountedAt))
  );
}

function storageFailure(detail: string): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code: "storage_failed",
      message: `Goal state is unavailable: ${detail}.`,
      retryable: false,
    },
  };
}

export function stateErrorToGoalError(
  error: StateStoreError,
): GoalOutcome<never> {
  if (
    error.code === "VERSION_CONFLICT" ||
    error.code === "TRANSACTION_CONFLICT"
  )
    return {
      ok: false,
      error: {
        code: "revision_conflict",
        message: "Goal state changed concurrently.",
        retryable: true,
        details: { stateCode: error.code },
      },
    };
  if (error.code === "LEASE_HELD" || error.code === "LEASE_LOST")
    return {
      ok: false,
      error: {
        code: "lease_lost",
        message: "Goal node lease is held by another owner or fence.",
        retryable: false,
        details: { stateCode: error.code },
      },
    };
  return {
    ok: false,
    error: {
      code: "storage_failed",
      message: "Goal state store rejected the operation.",
      retryable: !!error.retryable,
      details: { stateCode: error.code },
    },
  };
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

const HEAD_METADATA_TARGET_BYTES = DEFAULT_METADATA_MAX_BYTES - 1_024;

function boundedHeadMetadata(head: StoredGoalHead) {
  let history = [...head.history];
  let evidence = [...head.evidence];
  let metadata = json({ ...head, history, evidence });
  while (
    Buffer.byteLength(JSON.stringify(metadata)) > HEAD_METADATA_TARGET_BYTES &&
    history.length > 1
  ) {
    history = history.slice(1);
    metadata = json({ ...head, history, evidence });
  }
  while (
    Buffer.byteLength(JSON.stringify(metadata)) > HEAD_METADATA_TARGET_BYTES &&
    evidence.length > 0
  ) {
    evidence = evidence.slice(1);
    metadata = json({ ...head, history, evidence });
  }
  return metadata;
}

function boundedNodeMetadata(node: StoredGoalNode) {
  let evidence = [...node.evidence];
  let metadata = json({ ...node, evidence });
  while (
    Buffer.byteLength(JSON.stringify(metadata)) > HEAD_METADATA_TARGET_BYTES &&
    evidence.length > 0
  ) {
    evidence = evidence.slice(1);
    metadata = json({ ...node, evidence });
  }
  return metadata;
}

export function createGoalPersistence(state: StateStore, projectId: string) {
  const namespace = createHash("sha256")
    .update(projectId)
    .digest("hex")
    .slice(0, 32);
  const HEADS = `goals.head.${namespace}`;
  const NODES = `goals.node.${namespace}`;
  const ATTEMPTS = `goals.attempt.${namespace}`;
  const REQUESTS = `goals.request.${namespace}`;
  const OUTBOX = `goals.outbox.${namespace}`;
  const CAPACITY = `goals.capacity.${namespace}`;
  const CAPACITY_KEY = "goals";

  const nodeKey = (goalId: string, nodeId: string) => `${goalId}:${nodeId}`;
  const attemptKeyFor = (goalId: string, nodeId: string, attempt: number) =>
    `${goalId}:${nodeId}:${String(attempt).padStart(2, "0")}`;
  const eventStream = (goalId: string) => `goals.${namespace}.${goalId}`;
  const leaseResource = (goalId: string, nodeId: string) =>
    `goal.node.${namespace}.${goalId}.${nodeId}`;
  // Request identifiers are project-wide idempotency keys while retained.
  // Goal ownership lives in metadata so terminal cleanup can select them.
  const requestKey = (_goalId: string, requestId: string) => requestId;
  const deliveryKey = (goalId: string, deliveryId: string) =>
    `${goalId}:${deliveryId}`;

  const query = async (request: Parameters<StateStore["query"]>[0]) => {
    const result = await state.query(request);
    return result;
  };

  const loadHead = async (
    goalId: string,
  ): Promise<GoalOutcome<Versioned<StoredGoalHead> | null>> => {
    const result = await query({
      type: "record",
      collection: HEADS,
      key: goalId,
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "record") return storageFailure("head");
    const record = result.value.record;
    if (!record) return { ok: true, value: null };
    if (!validHead(record.metadata, projectId)) return storageFailure("head");
    return {
      ok: true,
      value: {
        value: record.metadata as unknown as StoredGoalHead,
        version: record.version,
      },
    };
  };

  const listHeads = async (
    limit: number,
    afterKey?: string,
  ): Promise<GoalOutcome<readonly Versioned<StoredGoalHead>[]>> => {
    const result = await query({
      type: "records",
      collection: HEADS,
      limit,
      ...(afterKey === undefined ? {} : { afterKey }),
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "records") return storageFailure("heads");
    const heads: Versioned<StoredGoalHead>[] = [];
    for (const record of result.value.records) {
      if (!validHead(record.metadata, projectId)) return storageFailure("head");
      heads.push({
        value: record.metadata as unknown as StoredGoalHead,
        version: record.version,
      });
    }
    return { ok: true, value: heads };
  };

  const decodeNodes = (
    records: readonly StateRecord[],
    goalId: string,
  ): GoalOutcome<readonly Versioned<StoredGoalNode>[]> => {
    const nodes: Versioned<StoredGoalNode>[] = [];
    for (const record of records) {
      if (!validNode(record.metadata, goalId)) return storageFailure("node");
      nodes.push({
        value: record.metadata as unknown as StoredGoalNode,
        version: record.version,
      });
    }
    return { ok: true, value: nodes };
  };

  const loadNodes = async (goalId: string) => {
    const result = await query({
      type: "records",
      collection: NODES,
      keyPrefix: `${goalId}:`,
      limit: GOAL_LIMITS.maxNodes,
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "records") return storageFailure("nodes");
    return decodeNodes(result.value.records, goalId);
  };

  const loadNode = async (
    goalId: string,
    nodeId: string,
  ): Promise<GoalOutcome<Versioned<StoredGoalNode> | null>> => {
    const result = await query({
      type: "record",
      collection: NODES,
      key: nodeKey(goalId, nodeId),
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "record") return storageFailure("node");
    const record = result.value.record;
    if (!record) return { ok: true, value: null };
    if (!validNode(record.metadata, goalId)) return storageFailure("node");
    return {
      ok: true,
      value: {
        value: record.metadata as unknown as StoredGoalNode,
        version: record.version,
      },
    };
  };

  const loadAttempts = async (
    goalId: string,
    nodeId: string,
  ): Promise<GoalOutcome<readonly Versioned<StoredGoalAttempt>[]>> => {
    const result = await query({
      type: "records",
      collection: ATTEMPTS,
      keyPrefix: `${goalId}:${nodeId}:`,
      limit: GOAL_LIMITS.maxAttemptsPerNode,
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "records") return storageFailure("attempts");
    const attempts: Versioned<StoredGoalAttempt>[] = [];
    for (const record of result.value.records) {
      if (!validAttempt(record.metadata, goalId))
        return storageFailure("attempt");
      attempts.push({
        value: record.metadata as unknown as StoredGoalAttempt,
        version: record.version,
      });
    }
    return { ok: true, value: attempts };
  };

  const loadRequest = async (
    goalId: string,
    requestId: string,
  ): Promise<GoalOutcome<Versioned<StoredGoalRequest> | null>> => {
    const result = await query({
      type: "record",
      collection: REQUESTS,
      key: requestKey(goalId, requestId),
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "record") return storageFailure("request");
    const record = result.value.record;
    if (!record) return { ok: true, value: null };
    const metadata = record.metadata;
    if (
      !isRecord(metadata) ||
      !text(metadata.digest, 128) ||
      !text(metadata.goalId, GOAL_LIMITS.maxIdentifierLength) ||
      !whole(metadata.eventPosition) ||
      (metadata.eventId !== undefined && !text(metadata.eventId, 128))
    )
      return storageFailure("request");
    return {
      ok: true,
      value: {
        value: metadata as unknown as StoredGoalRequest,
        version: record.version,
      },
    };
  };

  const loadDelivery = async (
    goalId: string,
    deliveryId: string,
  ): Promise<GoalOutcome<Versioned<StoredGoalDelivery> | null>> => {
    const result = await query({
      type: "record",
      collection: OUTBOX,
      key: deliveryKey(goalId, deliveryId),
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "record") return storageFailure("delivery");
    const record = result.value.record;
    if (!record) return { ok: true, value: null };
    if (
      !isRecord(record.metadata) ||
      !text(record.metadata.goalId, 64) ||
      !text(record.metadata.generationId, 64)
    )
      return storageFailure("delivery");
    return {
      ok: true,
      value: {
        value: record.metadata as unknown as StoredGoalDelivery,
        version: record.version,
      },
    };
  };

  const findEventPosition = async (goalId: string, eventId: string) => {
    let afterPosition: number | undefined;
    for (let page = 0; page < 8; page += 1) {
      const result = await query({
        type: "events",
        stream: eventStream(goalId),
        limit: 1_000,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      if (!result.ok) return stateErrorToGoalError(result.error);
      if (result.value.type !== "events") return storageFailure("events");
      const found = result.value.events.find(
        (event) => event.eventId === eventId,
      );
      if (found) return { ok: true as const, value: found.position };
      if (result.value.events.length < 1_000)
        return { ok: true as const, value: null };
      afterPosition = result.value.events.at(-1)?.position;
    }
    return { ok: true as const, value: null };
  };

  const listDeliveries = async (limit: number, afterKey?: string) => {
    const result = await query({
      type: "records",
      collection: OUTBOX,
      limit,
      ...(afterKey === undefined ? {} : { afterKey }),
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "records") return storageFailure("deliveries");
    const deliveries: KeyedVersioned<StoredGoalDelivery>[] = [];
    for (const record of result.value.records) {
      if (
        !isRecord(record.metadata) ||
        !text(record.metadata.goalId, 64) ||
        !text(record.metadata.generationId, 64)
      )
        return storageFailure("delivery");
      deliveries.push({
        key: record.key,
        value: record.metadata as unknown as StoredGoalDelivery,
        version: record.version,
      });
    }
    return { ok: true as const, value: deliveries };
  };

  const listGoalRecords = async (
    collection: string,
    goalId: string,
    limit: number,
    afterKey?: string,
  ) => {
    const result = await query({
      type: "records",
      collection,
      keyPrefix: `${goalId}:`,
      limit,
      ...(afterKey === undefined ? {} : { afterKey }),
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "records") return storageFailure("goal records");
    return {
      ok: true as const,
      value: result.value.records.map((record) => ({
        key: record.key,
        version: record.version,
      })),
    };
  };

  const listGoalRequests = async (
    goalId: string,
    limit: number,
    afterKey?: string,
  ) => {
    const requests: { key: string; version: number }[] = [];
    let cursor = afterKey;
    // Each query and the overall scan are bounded. If a project somehow holds
    // more than one million retained receipts, compaction fails closed and
    // keeps the Goal head instead of declaring incomplete cleanup successful.
    for (let page = 0; page < GOAL_LIMITS.maxGoals; page += 1) {
      const result = await query({
        type: "records",
        collection: REQUESTS,
        limit: DEFAULT_QUERY_MAX_LIMIT,
        ...(cursor === undefined ? {} : { afterKey: cursor }),
      });
      if (!result.ok) return stateErrorToGoalError(result.error);
      if (result.value.type !== "records")
        return storageFailure("goal requests");
      for (const record of result.value.records) {
        if (!isRecord(record.metadata) || !text(record.metadata.goalId, 64))
          return storageFailure("request");
        if (record.metadata.goalId === goalId) {
          requests.push({
            key: record.key,
            version: record.version,
          });
          if (requests.length >= limit)
            return { ok: true as const, value: requests };
        }
      }
      if (result.value.records.length < DEFAULT_QUERY_MAX_LIMIT)
        return { ok: true as const, value: requests };
      cursor = result.value.records.at(-1)?.key;
    }
    return storageFailure("request cleanup bound");
  };

  const listGoalEvents = async (goalId: string, limit: number) => {
    const result = await query({
      type: "events",
      stream: eventStream(goalId),
      limit,
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "events") return storageFailure("events");
    return { ok: true as const, value: result.value.events };
  };

  /**
   * Commit one logical step. The transaction ID is derived from the exact
   * operations, so an identical retry replays instead of double-applying, while
   * a different payload is a different transaction guarded by record versions.
   */
  const commit = async (
    label: string,
    operations: readonly StateMutation[],
  ): Promise<GoalOutcome<StateTransactionResult>> => {
    const payload = JSON.stringify(canonicalize(operations));
    const recordScope = operations.find(
      (operation) =>
        (operation.type === "put-record" ||
          operation.type === "delete-record" ||
          operation.type === "check-record") &&
        operation.collection !== CAPACITY,
    );
    const eventScope = operations.find(
      (operation) => operation.type === "append-event",
    );
    const scope =
      recordScope &&
      (recordScope.type === "put-record" ||
        recordScope.type === "delete-record" ||
        recordScope.type === "check-record")
        ? recordScope.key.split(":", 1)[0]
        : eventScope?.type === "append-event"
          ? eventScope.stream.slice(`goals.${namespace}.`.length)
          : "shared";
    const transactionId = `goal:${namespace}:${scope}:${label}:${createHash(
      "sha256",
    )
      .update(payload)
      .digest("hex")}`;
    const result = await state.transact({ transactionId, operations });
    if (!result.ok) return stateErrorToGoalError(result.error);
    return { ok: true, value: result.value };
  };

  /**
   * Live Goal count.
   *
   * The count is a record like any other, so incrementing it is part of the
   * same transaction that creates a Goal and decrementing it is part of the
   * one that compacts a Goal away. Two processes racing for the last slot
   * therefore collide on its version instead of both being admitted.
   */
  const loadCapacity = async (): Promise<
    GoalOutcome<Versioned<{ count: number }> | null>
  > => {
    const result = await query({
      type: "record",
      collection: CAPACITY,
      key: CAPACITY_KEY,
    });
    if (!result.ok) return stateErrorToGoalError(result.error);
    if (result.value.type !== "record") return storageFailure("capacity");
    const record = result.value.record;
    if (!record) return { ok: true, value: null };
    if (!isRecord(record.metadata) || !whole(record.metadata.count))
      return storageFailure("capacity");
    return {
      ok: true,
      value: {
        value: { count: Number(record.metadata.count) },
        version: record.version,
      },
    };
  };

  return {
    namespace,
    collections: { HEADS, NODES, ATTEMPTS, REQUESTS, OUTBOX, CAPACITY },
    loadCapacity,
    nodeKey,
    attemptKeyFor,
    eventStream,
    leaseResource,
    loadHead,
    listHeads,
    loadNode,
    loadNodes,
    loadAttempts,
    loadRequest,
    findEventPosition,
    loadDelivery,
    listDeliveries,
    listGoalRequests,
    listGoalDeliveries: (goalId: string, limit: number, afterKey?: string) =>
      listGoalRecords(OUTBOX, goalId, limit, afterKey),
    listGoalEvents,
    async compact(request: StateCompactRequest) {
      const result = await state.compact(request);
      if (!result.ok) return stateErrorToGoalError(result.error);
      return { ok: true as const, value: result.value };
    },
    commit,
    putHead(
      head: StoredGoalHead,
      expectedVersion: number | null,
    ): StateMutation {
      return {
        type: "put-record",
        collection: HEADS,
        key: head.goalId,
        metadata: boundedHeadMetadata(head),
        expectedVersion,
      };
    },
    putNode(
      node: StoredGoalNode,
      expectedVersion: number | null,
    ): StateMutation {
      return {
        type: "put-record",
        collection: NODES,
        key: nodeKey(node.goalId, node.nodeId),
        metadata: boundedNodeMetadata(node),
        expectedVersion,
      };
    },
    putAttempt(
      attempt: StoredGoalAttempt,
      expectedVersion: number | null,
    ): StateMutation {
      return {
        type: "put-record",
        collection: ATTEMPTS,
        key: attemptKeyFor(attempt.goalId, attempt.nodeId, attempt.number),
        metadata: json(attempt),
        expectedVersion,
      };
    },
    putRequest(requestId: string, request: StoredGoalRequest): StateMutation {
      return {
        type: "put-record",
        collection: REQUESTS,
        key: requestKey(request.goalId, requestId),
        metadata: json(request),
        expectedVersion: null,
      };
    },
    putDelivery(
      deliveryId: string,
      delivery: StoredGoalDelivery,
      expectedVersion: number | null,
    ): StateMutation {
      return {
        type: "put-record",
        collection: OUTBOX,
        key: deliveryKey(delivery.goalId, deliveryId),
        metadata: json(delivery),
        expectedVersion,
      };
    },
    appendEvent(
      goalId: string,
      eventId: string,
      eventType: string,
      metadata: JsonObject,
    ): StateMutation {
      return {
        type: "append-event",
        stream: eventStream(goalId),
        eventId,
        eventType,
        metadata,
      };
    },
    checkRecord(
      collection: string,
      key: string,
      expectedVersion: number,
    ): StateMutation {
      return { type: "check-record", collection, key, expectedVersion };
    },
    putCapacity(count: number, expectedVersion: number | null): StateMutation {
      return {
        type: "put-record",
        collection: CAPACITY,
        key: CAPACITY_KEY,
        metadata: { count },
        expectedVersion,
      };
    },
    deleteHead(goalId: string, expectedVersion: number): StateMutation {
      return {
        type: "delete-record",
        collection: HEADS,
        key: goalId,
        expectedVersion,
      };
    },
    deleteNode(
      goalId: string,
      nodeId: string,
      expectedVersion: number,
    ): StateMutation {
      return {
        type: "delete-record",
        collection: NODES,
        key: nodeKey(goalId, nodeId),
        expectedVersion,
      };
    },
    deleteAttempt(
      attempt: StoredGoalAttempt,
      expectedVersion: number,
    ): StateMutation {
      return {
        type: "delete-record",
        collection: ATTEMPTS,
        key: attemptKeyFor(attempt.goalId, attempt.nodeId, attempt.number),
        expectedVersion,
      };
    },
    deleteRequest(key: string, expectedVersion: number): StateMutation {
      return {
        type: "delete-record",
        collection: REQUESTS,
        key,
        expectedVersion,
      };
    },
    deleteDelivery(key: string, expectedVersion: number): StateMutation {
      return {
        type: "delete-record",
        collection: OUTBOX,
        key,
        expectedVersion,
      };
    },
  };
}

export type GoalPersistence = ReturnType<typeof createGoalPersistence>;
