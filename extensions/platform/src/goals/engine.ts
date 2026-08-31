import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "../core/artifacts/model.ts";
import type {
  StateMutation,
  StateStore,
} from "../core/persistence/state-store.ts";
import {
  goalCommandDigest,
  verifyGoalAuthority,
  type GoalAuthorityVerifier,
} from "./authority.ts";
import {
  chargeForAttempt,
  initialBudget,
  reserveAttempt,
  settleAttempt,
  validateBudgetMetering,
  type GoalAttemptSettlement,
  type GoalMeteringCapabilities,
} from "./budget.ts";
import { digestOfText } from "./digest.ts";
import { applyGoalEdits } from "./edits.ts";
import {
  appendEvidence,
  createEvidence,
  evaluateCriteria,
} from "./evidence.ts";
import {
  GOAL_LIMITS,
  type GoalAttemptSnapshot,
  type GoalArtifactReference,
  type GoalCancelCommand,
  type GoalCommandAuthority,
  type GoalEngine,
  type GoalErrorCode,
  type GoalEvidence,
  type GoalHistoryEntry,
  type GoalMutationReceipt,
  type GoalNodeSnapshot,
  type GoalNodeState,
  type GoalObservation,
  type GoalObservationQuery,
  type GoalOutcome,
  type GoalPauseCommand,
  type GoalProfilePin,
  type GoalResumeCommand,
  type GoalSnapshot,
  type GoalState,
  type GoalSubmitCommand,
  type GoalSummary,
} from "./model.ts";
import {
  createGoalPersistence,
  type StoredGoalAttempt,
  type StoredGoalHead,
  type StoredGoalNode,
} from "./persistence.ts";
import type {
  GoalClock,
  GoalDeliveryPort,
  GoalExecutorPort,
  GoalExecutorRequest,
  GoalHostBinding,
  GoalProfilePort,
  GoalReviewPort,
  GoalWorkspacePort,
} from "./ports.ts";
import {
  planSchedule,
  recoveryDecision,
  retryDecision,
  retryDelayFor,
  type GoalExecutionCertainty,
} from "./scheduling.ts";
import {
  GOAL_NODE_STATES,
  deriveGoalState,
  goalTransitionAllowed,
  nodeTransitionAllowed,
} from "./transitions.ts";
import { validateGoalSubmission } from "./validation.ts";

/**
 * Goal Mode runtime.
 *
 * The public seam is five methods. Everything else — claims, fenced leases,
 * budget reservation, retries, recovery, evidence, workspace disposition, and
 * delivery — lives behind it. Two invariants shape the whole file:
 *
 * 1. Local state transitions are exactly-once, guarded by optimistic record
 *    versions plus a fencing token per node.
 * 2. External Agent execution is at-most-once. Whenever the executor cannot
 *    prove what happened, the Attempt becomes `unknown` and the Goal blocks for
 *    a direct user decision instead of dispatching a second child.
 */

export interface GoalRuntimeOptions {
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly clock: GoalClock;
  readonly executor: GoalExecutorPort;
  readonly profiles: GoalProfilePort;
  /**
   * Host-owned Guarded Workspace lifecycle. Omit it only when the executor
   * declares `workspaceOwnership: "executor"`; an isolated Agent Profile with
   * neither owner blocks instead of running outside a workspace.
   */
  readonly workspaces?: GoalWorkspacePort;
  readonly review: GoalReviewPort;
  readonly delivery: GoalDeliveryPort;
  readonly binding: GoalHostBinding;
  /** Lease owner identity for this Session Incarnation. */
  readonly ownerId: string;
  readonly leaseTtlMs?: number;
  /** Live Goals this deployment admits at once. */
  readonly maxGoals?: number;
  /** How long a finished Goal keeps its records before compaction. */
  readonly terminalRetentionMs?: number;
  /**
   * Host issuer for direct user approvals. Without it the runtime accepts no
   * direct user command at all, because an opaque token it cannot check is
   * indistinguishable from one a model invented.
   */
  readonly authority?: GoalAuthorityVerifier;
}

export interface GoalRuntime {
  readonly engine: GoalEngine;
  /** Authoritative dimensions declared by the bound executor. */
  readonly metering: GoalMeteringCapabilities;
  /**
   * Host and test barrier: resolves when nothing is in flight and nothing is
   * dispatchable at the current clock reading.
   */
  drain(): Promise<void>;
  close(): Promise<void>;
}

interface ClaimContext {
  readonly goalId: string;
  readonly nodeId: string;
  readonly attempt: StoredGoalAttempt;
  readonly attemptVersion: number;
  readonly definition: StoredGoalNode["definition"];
}

/** Head pages one filtered observation may scan before it yields a cursor. */
const OBSERVATION_SCAN_PAGES = 16;
/** Head pages one capacity count or compaction pass may scan. */
const CAPACITY_SCAN_PAGES = 32;
/** Records removed per compaction transaction, well inside the store bound. */
const COMPACTION_CHUNK = 64;
/** Submissions retried when another process moves the capacity record first. */
const CAPACITY_COMMIT_ATTEMPTS = 4;

const TERMINAL_GOAL_STATES: readonly GoalState[] = [
  "done",
  "failed",
  "cancelled",
];

function goalError(
  code: GoalErrorCode,
  message: string,
  reason?: string,
  retryable = false,
): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(reason === undefined ? {} : { details: { reason } }),
    },
  };
}

export function createGoalRuntime(options: GoalRuntimeOptions): GoalRuntime {
  const {
    state,
    artifacts,
    clock,
    executor,
    profiles,
    workspaces,
    review,
    delivery,
    binding,
    ownerId,
  } = options;
  const leaseTtlMs = options.leaseTtlMs ?? 300_000;
  const maxGoals = Math.max(
    1,
    Math.min(
      options.maxGoals ?? GOAL_LIMITS.defaultMaxGoals,
      GOAL_LIMITS.maxGoals,
    ),
  );
  const terminalRetentionMs = Math.max(
    0,
    options.terminalRetentionMs ?? GOAL_LIMITS.defaultTerminalRetentionMs,
  );
  const store = createGoalPersistence(state, binding.projectId);
  const metering: GoalMeteringCapabilities = executor.metering ?? {
    tokens: false,
    cost: false,
  };
  // Exactly one component owns a Guarded Workspace for an Attempt. When the
  // executor owns it, this runtime neither prepares nor disposes one; it only
  // records the identifier the executor reports so the Attempt stays auditable.
  const executorOwnsWorkspaces = executor.workspaceOwnership === "executor";

  let closed = false;
  let activity = 0;
  let recovery: Promise<void> | null = null;
  let recoveryCursor: string | undefined;
  let deliveryCursor: string | undefined;
  let recoverySweepCancel: (() => void) | null = null;
  const idleWaiters: (() => void)[] = [];
  const chains = new Map<string, Promise<void>>();
  const timers = new Map<string, () => void>();
  const aborts = new Map<string, AbortController>();

  function track<T>(promise: Promise<T>) {
    activity += 1;
    return promise.finally(() => {
      activity -= 1;
      if (activity === 0) for (const wake of idleWaiters.splice(0)) wake();
    });
  }

  function kick(goalId: string) {
    if (closed) return;
    const previous = chains.get(goalId) ?? Promise.resolve();
    const next = previous.then(() => tick(goalId)).catch(() => {});
    chains.set(goalId, next);
    void track(next);
  }

  function armWake(goalId: string, at: number) {
    timers.get(goalId)?.();
    timers.set(
      goalId,
      clock.arm(at, () => {
        timers.delete(goalId);
        kick(goalId);
      }),
    );
  }

  function eventId(
    goalId: string,
    generationId: string,
    label: string,
    ...parts: readonly string[]
  ) {
    return digestOfText(
      "goal-event-v1",
      binding.projectId,
      goalId,
      generationId,
      label,
      ...parts,
    );
  }

  function historyEntry(
    head: StoredGoalHead,
    type: string,
    actor: GoalCommandAuthority["actor"],
    actorId: string,
    reason: string | null,
    details: GoalHistoryEntry["details"] = {},
  ): GoalHistoryEntry {
    return {
      position: (head.history.at(-1)?.position ?? 0) + 1,
      type,
      actor,
      actorId: actorId.slice(0, 512),
      at: clock.now(),
      reason:
        reason === null ? null : reason.slice(0, GOAL_LIMITS.maxReasonLength),
      details,
    };
  }

  function withHistory(head: StoredGoalHead, entry: GoalHistoryEntry) {
    return [...head.history, entry].slice(-GOAL_LIMITS.maxHistoryEntries);
  }

  function attemptKeyFor(
    goalId: string,
    generationId: string,
    nodeId: string,
    runGeneration: number,
    attemptNumber: number,
  ) {
    return digestOfText(
      "goal-attempt-v1",
      binding.projectId,
      goalId,
      generationId,
      nodeId,
      String(runGeneration),
      String(attemptNumber),
    );
  }

  function attemptSnapshot(attempt: StoredGoalAttempt): GoalAttemptSnapshot {
    return {
      number: attempt.number,
      attemptKey: attempt.attemptKey,
      phase: attempt.phase,
      fence: attempt.fence,
      reservation: attempt.reservation,
      startedAt: attempt.startedAt,
      settledAt: attempt.settledAt,
      workspaceId: attempt.workspaceId,
      certainty: attempt.certainty,
      usage: attempt.usage,
      error: attempt.error,
    };
  }

  async function nodeSnapshots(
    goalId: string,
    nodes: readonly StoredGoalNode[],
  ): Promise<GoalOutcome<readonly GoalNodeSnapshot[]>> {
    const snapshots: GoalNodeSnapshot[] = [];
    for (const node of nodes) {
      const attempts = await store.loadAttempts(goalId, node.nodeId);
      if (!attempts.ok) return attempts;
      const ordered = [...attempts.value]
        .map((entry) => entry.value)
        .sort((left, right) => left.number - right.number);
      snapshots.push({
        id: node.nodeId,
        title: node.definition.title,
        state: node.state,
        required: node.definition.required,
        dependsOn: node.definition.dependsOn,
        definitionDigest: node.definition.digest,
        profile: node.profile,
        attemptCount: node.attemptCount,
        nextAttemptAt: node.nextAttemptAt,
        currentAttempt:
          ordered.find((entry) => entry.number === node.currentAttempt) ===
          undefined
            ? null
            : attemptSnapshot(
                ordered.find((entry) => entry.number === node.currentAttempt)!,
              ),
        attempts: ordered.map(attemptSnapshot),
        evidence: node.evidence,
        blockedReason: node.blockedReason,
        lastError: node.lastError,
      });
    }
    return { ok: true, value: snapshots };
  }

  function orderNodes(head: StoredGoalHead, nodes: readonly StoredGoalNode[]) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    return head.order
      .map((id) => byId.get(id))
      .filter((node): node is StoredGoalNode => node !== undefined);
  }

  async function loadSnapshot(
    goalId: string,
  ): Promise<GoalOutcome<GoalSnapshot>> {
    const head = await store.loadHead(goalId);
    if (!head.ok) return head;
    if (!head.value)
      return goalError("not_found", `Goal ${goalId} does not exist.`);
    const nodes = await store.loadNodes(goalId);
    if (!nodes.ok) return nodes;
    const ordered = orderNodes(
      head.value.value,
      nodes.value.map((entry) => entry.value),
    );
    const snapshots = await nodeSnapshots(goalId, ordered);
    if (!snapshots.ok) return snapshots;
    const stored = head.value.value;
    return {
      ok: true,
      value: {
        goalId: stored.goalId,
        state: stored.state,
        definitionRevision: stored.definitionRevision,
        runGeneration: stored.runGeneration,
        objective: stored.objective,
        criteria: stored.criteria,
        budget: stored.budget,
        nodes: snapshots.value,
        evidence: stored.evidence,
        history: stored.history,
        blockedReason: stored.blockedReason,
        cancellation: stored.cancellation ?? null,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      },
    };
  }

  function summarize(head: StoredGoalHead, nodes: readonly StoredGoalNode[]) {
    const counts = Object.fromEntries(
      GOAL_NODE_STATES.map((state) => [state, 0]),
    ) as Record<GoalNodeState, number>;
    for (const node of nodes) counts[node.state] += 1;
    const summary: GoalSummary = {
      goalId: head.goalId,
      state: head.state,
      definitionRevision: head.definitionRevision,
      runGeneration: head.runGeneration,
      objective: head.objective,
      counts,
      budget: head.budget,
      blockedReason: head.blockedReason,
      updatedAt: head.updatedAt,
    };
    return summary;
  }

  async function receiptFor(
    goalId: string,
    replayed: boolean,
    eventPosition: number,
  ): Promise<GoalOutcome<GoalMutationReceipt>> {
    const snapshot = await loadSnapshot(goalId);
    if (!snapshot.ok) return snapshot;
    return {
      ok: true,
      value: { goal: snapshot.value, replayed, eventPosition },
    };
  }

  async function replayReceipt(
    goalId: string,
    requestId: string,
    digest: string,
  ): Promise<GoalOutcome<GoalMutationReceipt> | null> {
    const existing = await store.loadRequest(goalId, requestId);
    if (!existing.ok) return existing;
    if (!existing.value) return null;
    if (existing.value.value.digest !== digest)
      return goalError(
        "invalid_request",
        "Request identifier was already used for a different command.",
        "request_conflict",
      );
    const stored = existing.value.value;
    const resolvedPosition = stored.eventId
      ? await store.findEventPosition(stored.goalId, stored.eventId)
      : null;
    if (resolvedPosition && !resolvedPosition.ok) return resolvedPosition;
    return receiptFor(
      stored.goalId,
      true,
      resolvedPosition?.ok && resolvedPosition.value !== null
        ? resolvedPosition.value
        : stored.eventPosition,
    );
  }

  /**
   * How many Goals exist right now.
   *
   * The capacity record is the fast path; a deployment that has never written
   * one is counted once, bounded, and the count is created transactionally by
   * the submission that needed it. Losing that race is an ordinary version
   * conflict, which is exactly what makes the cap hold across processes.
   */
  async function countGoals(): Promise<GoalOutcome<number>> {
    let cursor: string | undefined;
    let count = 0;
    const page = GOAL_LIMITS.maxObservationPageSize;
    for (let index = 0; index < CAPACITY_SCAN_PAGES; index += 1) {
      const heads = await store.listHeads(page, cursor);
      if (!heads.ok) return heads;
      count += heads.value.length;
      if (heads.value.length < page) break;
      cursor = heads.value.at(-1)?.value.goalId;
    }
    return { ok: true, value: count };
  }

  async function readCapacity(): Promise<
    GoalOutcome<{ readonly count: number; readonly version: number | null }>
  > {
    const stored = await store.loadCapacity();
    if (!stored.ok) return stored;
    if (stored.value)
      return {
        ok: true,
        value: {
          count: stored.value.value.count,
          version: stored.value.version,
        },
      };
    const counted = await countGoals();
    if (!counted.ok) return counted;
    return { ok: true, value: { count: counted.value, version: null } };
  }

  /**
   * Retire one finished Goal's records.
   *
   * Compaction is record retention and nothing else. It never disposes a
   * Guarded Workspace, never touches an Artifact, and refuses any Goal holding
   * an Attempt that never settled, because such an Attempt still owes a lease
   * and a reservation. Records go in bounded chunks with the head last, so a
   * process that dies mid-compaction leaves a terminal Goal with fewer records
   * rather than a head with none.
   */
  async function compactGoal(head: {
    readonly value: StoredGoalHead;
    readonly version: number;
  }): Promise<boolean> {
    const goalId = head.value.goalId;
    const nodes = await store.loadNodes(goalId);
    if (!nodes.ok) return false;
    const deletions: StateMutation[] = [];
    for (const node of nodes.value) {
      const attempts = await store.loadAttempts(goalId, node.value.nodeId);
      if (!attempts.ok) return false;
      for (const attempt of attempts.value) {
        if (!settledAttempt(attempt.value)) return false;
        deletions.push(store.deleteAttempt(attempt.value, attempt.version));
      }
      deletions.push(store.deleteNode(goalId, node.value.nodeId, node.version));
    }
    for (let index = 0; index < deletions.length; index += COMPACTION_CHUNK) {
      const removed = await store.commit(
        "compact-records",
        deletions.slice(index, index + COMPACTION_CHUNK),
      );
      if (!removed.ok) return false;
    }
    const deleteAuxiliaryRecords = async (
      list: (
        goalId: string,
        limit: number,
        afterKey?: string,
      ) => ReturnType<typeof store.listGoalRequests>,
      remove: (key: string, version: number) => StateMutation,
      label: string,
    ) => {
      let cursor: string | undefined;
      for (let page = 0; page < CAPACITY_SCAN_PAGES; page += 1) {
        const records = await list(goalId, COMPACTION_CHUNK, cursor);
        if (!records.ok) return false;
        if (records.value.length > 0) {
          const removed = await store.commit(label, [
            store.checkRecord(store.collections.HEADS, goalId, head.version),
            ...records.value.map((record) =>
              remove(record.key, record.version),
            ),
          ]);
          if (!removed.ok) return false;
        }
        if (records.value.length < COMPACTION_CHUNK) return true;
        cursor = records.value.at(-1)?.key;
      }
      return false;
    };
    if (
      !(await deleteAuxiliaryRecords(
        store.listGoalRequests,
        store.deleteRequest,
        "compact-requests",
      )) ||
      !(await deleteAuxiliaryRecords(
        store.listGoalDeliveries,
        store.deleteDelivery,
        "compact-outbox",
      ))
    )
      return false;
    for (let page = 0; page < CAPACITY_SCAN_PAGES; page += 1) {
      const events = await store.listGoalEvents(goalId, COMPACTION_CHUNK);
      if (!events.ok) return false;
      if (events.value.length === 0) break;
      const removed = await store.compact({
        eventIdsBefore: clock.now() + 1,
        eventIds: events.value.map((event) => event.eventId),
        limit: COMPACTION_CHUNK,
      });
      if (
        !removed.ok ||
        removed.value.deletedEvents !== events.value.length ||
        removed.value.deletedEventIds !== events.value.length
      ) {
        // Another lifecycle owner may have retired the same exact event set.
        // Only accept that race when the stream is now empty.
        const remaining = await store.listGoalEvents(goalId, 1);
        if (!remaining.ok || remaining.value.length > 0) return false;
        break;
      }
      if (events.value.length < COMPACTION_CHUNK) break;
      if (page === CAPACITY_SCAN_PAGES - 1) return false;
    }
    const compactMetadata = async () => {
      for (let page = 0; page < CAPACITY_SCAN_PAGES; page += 1) {
        const compacted = await store.compact({
          transactionsBefore: clock.now() + 1,
          transactionIdPrefixes: [`goal:${store.namespace}:${goalId}:`],
          recordHeadCollections: [
            store.collections.HEADS,
            store.collections.NODES,
            store.collections.ATTEMPTS,
            store.collections.REQUESTS,
            store.collections.OUTBOX,
          ],
          limit: 1_000,
        });
        if (!compacted.ok) return false;
        if (
          compacted.value.deletedTransactions < 1_000 &&
          (compacted.value.deletedRecordHeads ?? 0) < 1_000
        )
          return true;
      }
      return false;
    };
    // Clear the potentially large body of transaction receipts and orphaned
    // record heads while the terminal head still makes an interrupted sweep
    // discoverable and retryable.
    if (!(await compactMetadata())) return false;
    const capacity = await readCapacity();
    if (!capacity.ok) return false;
    const finished = await store.commit("compact-goal", [
      store.deleteHead(goalId, head.version),
      store.putCapacity(
        Math.max(0, capacity.value.count - 1),
        capacity.value.version,
      ),
    ]);
    if (!finished.ok) {
      // Head removal and capacity release are atomic. A missing head proves a
      // competing lifecycle owner completed this retirement.
      const current = await store.loadHead(goalId);
      if (!current.ok || current.value) return false;
    }
    // The final transaction added only its own receipt and the head's version
    // tombstone after the complete pre-pass above.
    await compactMetadata();
    return true;
  }

  /** Free capacity from Goals that finished long enough ago to retire. */
  async function compactTerminalGoals(now: number, wanted: number) {
    let cursor: string | undefined;
    let freed = 0;
    const page = GOAL_LIMITS.maxObservationPageSize;
    for (
      let index = 0;
      index < CAPACITY_SCAN_PAGES && freed < wanted;
      index += 1
    ) {
      const heads = await store.listHeads(page, cursor);
      if (!heads.ok) return freed;
      for (const head of heads.value) {
        if (freed >= wanted) break;
        if (!TERMINAL_GOAL_STATES.includes(head.value.state)) continue;
        if (head.value.updatedAt + terminalRetentionMs > now) continue;
        // A cancellation still owing reconciliation keeps every record it needs.
        if (
          head.value.cancellation &&
          head.value.cancellation.reconciledAt === null
        )
          continue;
        if (await compactGoal(head)) freed += 1;
      }
      if (heads.value.length < page) break;
      cursor = heads.value.at(-1)?.value.goalId;
    }
    return freed;
  }

  async function submit(
    command: GoalSubmitCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>> {
    if (closed) return goalError("closed", "Goal runtime is closed.");
    await ensureRecovered();
    const definition = validateGoalSubmission(command);
    if (!definition.ok) return definition;
    const admitted = validateBudgetMetering(definition.value.budget, metering);
    if (!admitted.ok) return admitted;
    const authorized = verifyGoalAuthority(command, authority, {
      now: clock.now(),
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      requireDirectUser: true,
      verifier: options.authority,
    });
    if (!authorized.ok) return authorized;

    const digest = goalCommandDigest(command);
    const replay = await replayReceipt(
      command.goalId,
      command.requestId,
      digest,
    );
    if (replay) return replay;

    const existing = await store.loadHead(command.goalId);
    if (!existing.ok) return existing;
    if (existing.value)
      return goalError(
        "already_exists",
        `Goal ${command.goalId} already exists.`,
        "goal_exists",
      );

    const pins = new Map<string, GoalProfilePin>();
    for (const node of definition.value.nodes) {
      if (pins.has(node.profileName)) continue;
      const resolved = await profiles.resolve(node.profileName);
      if (!resolved.ok)
        return goalError(
          "profile_denied",
          `Agent Profile ${node.profileName} is unavailable.`,
          "unresolved",
        );
      if (resolved.value.role !== "goal-worker")
        return goalError(
          "profile_denied",
          `Agent Profile ${node.profileName} does not carry the goal-worker Execution Role.`,
          "role_denied",
        );
      pins.set(node.profileName, {
        name: resolved.value.name,
        contentDigest: resolved.value.contentDigest,
        catalogGeneration: resolved.value.catalogGeneration,
        source: resolved.value.source,
      });
    }

    const now = clock.now();
    const activate = command.activate !== false;
    const head: StoredGoalHead = {
      goalId: definition.value.goalId,
      generationId: randomUUID(),
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      state: activate ? "ready" : "draft",
      definitionRevision: 1,
      runGeneration: 1,
      objective: definition.value.objective,
      criteria: definition.value.criteria,
      budget: initialBudget(definition.value.budget),
      order: definition.value.order,
      evidence: [],
      history: [],
      blockedReason: null,
      revisionDigest: definition.value.revisionDigest,
      createdAt: now,
      updatedAt: now,
    };
    const submitted = historyEntry(
      head,
      "goal.submitted",
      authority.actor,
      authority.actorId,
      null,
      { nodes: definition.value.nodes.length, activated: activate },
    );
    const withAudit: StoredGoalHead = {
      ...head,
      history: withHistory(head, submitted),
    };
    const submittedEventId = eventId(
      head.goalId,
      head.generationId,
      "submitted",
      definition.value.revisionDigest,
    );
    const operations: StateMutation[] = [store.putHead(withAudit, null)];
    for (const node of definition.value.nodes) {
      operations.push(
        store.putNode(
          {
            goalId: head.goalId,
            generationId: head.generationId,
            nodeId: node.id,
            definition: node,
            state: "waiting",
            attemptCount: 0,
            nextAttemptAt: null,
            currentAttempt: null,
            profile: pins.get(node.profileName)!,
            evidence: [],
            blockedReason: null,
            lastError: null,
            updatedAt: now,
          },
          null,
        ),
      );
    }
    operations.push(
      store.appendEvent(head.goalId, submittedEventId, "goal.submitted", {
        goalId: head.goalId,
        revision: 1,
        actor: authority.actor,
        actorId: authority.actorId,
        digest: definition.value.revisionDigest,
      }),
      store.putRequest(command.requestId, {
        digest,
        goalId: head.goalId,
        eventPosition: submitted.position,
        eventId: submittedEventId,
      }),
    );
    // Capacity is claimed in the same transaction that creates the Goal, so a
    // replay never counts twice and two processes cannot both take the last
    // slot. A conflict here means somebody else moved first, not failure.
    for (let attempt = 0; attempt < CAPACITY_COMMIT_ATTEMPTS; attempt += 1) {
      const capacity = await readCapacity();
      if (!capacity.ok) return capacity;
      if (capacity.value.count >= maxGoals) {
        const freed = await compactTerminalGoals(
          clock.now(),
          capacity.value.count - maxGoals + 1,
        );
        if (freed > 0) continue;
        return goalError(
          "capacity_exceeded",
          `This project already holds its maximum of ${maxGoals} Goals.`,
          "goal_capacity",
        );
      }
      const committed = await store.commit("submit", [
        ...operations,
        store.putCapacity(capacity.value.count + 1, capacity.value.version),
      ]);
      if (!committed.ok) {
        if (committed.error.code !== "revision_conflict") return committed;
        // Losing this race means somebody else wrote first. If they created
        // this very Goal, say so plainly instead of blaming capacity.
        const raced = await store.loadHead(command.goalId);
        if (!raced.ok) return raced;
        if (raced.value)
          return goalError(
            "already_exists",
            `Goal ${command.goalId} already exists.`,
            "goal_exists",
          );
        continue;
      }
      if (activate) kick(head.goalId);
      const position =
        committed.value.events.find(
          (event) => event.eventId === submittedEventId,
        )?.position ?? submitted.position;
      return receiptFor(head.goalId, false, position);
    }
    return goalError(
      "capacity_exceeded",
      "Goal capacity is contended; retry this submission.",
      "capacity_contended",
      true,
    );
  }

  async function loadForCommand(
    goalId: string,
    expectedRevision: number,
  ): Promise<
    GoalOutcome<{
      head: StoredGoalHead;
      version: number;
      nodes: readonly { value: StoredGoalNode; version: number }[];
    }>
  > {
    const head = await store.loadHead(goalId);
    if (!head.ok) return head;
    if (!head.value)
      return goalError("not_found", `Goal ${goalId} does not exist.`);
    if (head.value.value.definitionRevision !== expectedRevision)
      return goalError(
        "revision_conflict",
        `Goal ${goalId} is at revision ${head.value.value.definitionRevision}.`,
        "revision_mismatch",
      );
    const nodes = await store.loadNodes(goalId);
    if (!nodes.ok) return nodes;
    return {
      ok: true,
      value: {
        head: head.value.value,
        version: head.value.version,
        nodes: nodes.value,
      },
    };
  }

  function abortNode(goalId: string, nodeId: string) {
    const controller = aborts.get(`${goalId}:${nodeId}`);
    controller?.abort();
  }

  async function pause(
    command: GoalPauseCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>> {
    if (closed) return goalError("closed", "Goal runtime is closed.");
    await ensureRecovered();
    const authorized = verifyGoalAuthority(command, authority, {
      now: clock.now(),
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      requireDirectUser: false,
      verifier: options.authority,
    });
    if (!authorized.ok) return authorized;
    const digest = goalCommandDigest(command);
    const replay = await replayReceipt(
      command.goalId,
      command.requestId,
      digest,
    );
    if (replay) return replay;
    const loaded = await loadForCommand(
      command.goalId,
      command.expectedRevision,
    );
    if (!loaded.ok) return loaded;
    const { head, version } = loaded.value;
    if (head.state === "paused") {
      const position = head.history.at(-1)?.position ?? 0;
      const recorded = await store.commit("pause-noop", [
        store.putRequest(command.requestId, {
          digest,
          goalId: command.goalId,
          eventPosition: position,
        }),
      ]);
      if (!recorded.ok) return recorded;
      return receiptFor(command.goalId, false, position);
    }
    if (!goalTransitionAllowed(head.state, "paused"))
      return goalError(
        "state_conflict",
        `Goal ${command.goalId} cannot be paused from ${head.state}.`,
        "state_conflict",
      );
    for (const node of loaded.value.nodes)
      abortNode(command.goalId, node.value.nodeId);
    const now = clock.now();
    const entry = historyEntry(
      head,
      "goal.paused",
      authority.actor,
      authority.actorId,
      command.reason ?? null,
    );
    const next: StoredGoalHead = {
      ...head,
      state: "paused",
      updatedAt: now,
      history: withHistory(head, entry),
    };
    const pausedEventId = eventId(
      command.goalId,
      head.generationId,
      "paused",
      String(entry.position),
    );
    const committed = await store.commit("pause", [
      store.putHead(next, version),
      store.appendEvent(command.goalId, pausedEventId, "goal.paused", {
        goalId: command.goalId,
        actor: authority.actor,
        actorId: authority.actorId,
        reason: command.reason ?? null,
      }),
      store.putRequest(command.requestId, {
        digest,
        goalId: command.goalId,
        eventPosition: entry.position,
        eventId: pausedEventId,
      }),
    ]);
    if (!committed.ok) return committed;
    timers.get(command.goalId)?.();
    timers.delete(command.goalId);
    const position =
      committed.value.events.find((event) => event.eventId === pausedEventId)
        ?.position ?? entry.position;
    return receiptFor(command.goalId, false, position);
  }

  async function cancel(
    command: GoalCancelCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>> {
    if (closed) return goalError("closed", "Goal runtime is closed.");
    await ensureRecovered();
    const authorized = verifyGoalAuthority(command, authority, {
      now: clock.now(),
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      requireDirectUser: false,
      verifier: options.authority,
    });
    if (!authorized.ok) return authorized;
    const digest = goalCommandDigest(command);
    const replay = await replayReceipt(
      command.goalId,
      command.requestId,
      digest,
    );
    if (replay) return replay;
    const loaded = await loadForCommand(
      command.goalId,
      command.expectedRevision,
    );
    if (!loaded.ok) return loaded;
    const { head, version, nodes } = loaded.value;
    if (!goalTransitionAllowed(head.state, "cancelled"))
      return goalError(
        "state_conflict",
        `Goal ${command.goalId} cannot be cancelled from ${head.state}.`,
        "state_conflict",
      );
    for (const node of nodes) abortNode(command.goalId, node.value.nodeId);
    const now = clock.now();
    const entry = historyEntry(
      head,
      "goal.cancelled",
      authority.actor,
      authority.actorId,
      command.reason ?? null,
    );
    // A cancelled Goal is terminal for the user immediately, but an Attempt
    // already in flight is not. The nodes still holding one are retained in the
    // same transaction, so a process killed right here leaves a durable record
    // of what recovery still owes: release the lease and the reservation, and
    // say plainly whether the child's outcome could be proven.
    const inFlight = nodes
      .filter(
        (node) =>
          node.value.state === "running" && node.value.currentAttempt !== null,
      )
      .map((node) => node.value.nodeId);
    const cancellation = {
      requestedAt: now,
      reconciledAt: inFlight.length === 0 ? now : null,
      unresolved: inFlight,
      certainty:
        inFlight.length === 0 ? ("settled" as const) : ("pending" as const),
    };
    const next: StoredGoalHead = {
      ...head,
      state: "cancelled",
      blockedReason: null,
      cancellation,
      updatedAt: now,
      history: withHistory(head, entry),
    };
    const cancelledEventId = eventId(
      command.goalId,
      head.generationId,
      "cancelled",
      String(entry.position),
    );
    const operations: StateMutation[] = [store.putHead(next, version)];
    for (const node of nodes) {
      if (!nodeTransitionAllowed(node.value.state, "cancelled")) continue;
      operations.push(
        store.putNode(
          { ...node.value, state: "cancelled", updatedAt: now },
          node.version,
        ),
      );
    }
    operations.push(
      store.appendEvent(command.goalId, cancelledEventId, "goal.cancelled", {
        goalId: command.goalId,
        actor: authority.actor,
        actorId: authority.actorId,
        reason: command.reason ?? null,
        unresolved: inFlight.join(","),
      }),
      store.putRequest(command.requestId, {
        digest,
        goalId: command.goalId,
        eventPosition: entry.position,
        eventId: cancelledEventId,
      }),
    );
    const committed = await store.commit("cancel", operations);
    if (!committed.ok) return committed;
    timers.get(command.goalId)?.();
    timers.delete(command.goalId);
    const position =
      committed.value.events.find((event) => event.eventId === cancelledEventId)
        ?.position ?? entry.position;
    return receiptFor(command.goalId, false, position);
  }

  const RESUMABLE_STATES: readonly GoalState[] = [
    "draft",
    "paused",
    "blocked",
    "failed",
  ];
  const EDITABLE_STATES: readonly GoalState[] = ["draft", "paused", "blocked"];

  /**
   * Apply audited edits and manual dispositions, optionally invalidate a
   * selected node and its transitive dependents, then activate the graph.
   *
   * Resuming needs direct user authority. Edits additionally need a Goal that
   * is not running, and every Unknown Attempt must be resolved in the same
   * command. Nothing here can restart ambiguous external work by itself.
   */
  async function resume(
    command: GoalResumeCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>> {
    if (closed) return goalError("closed", "Goal runtime is closed.");
    await ensureRecovered();
    const edits = command.edits ?? [];
    const authorized = verifyGoalAuthority(command, authority, {
      now: clock.now(),
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      requireDirectUser: true,
      verifier: options.authority,
    });
    if (!authorized.ok) return authorized;
    const digest = goalCommandDigest(command);
    const replay = await replayReceipt(
      command.goalId,
      command.requestId,
      digest,
    );
    if (replay) return replay;
    const artifactReferences = new Map<string, GoalArtifactReference>();
    for (const edit of edits) {
      if (
        (edit.kind !== "disposition" && edit.kind !== "resolve-unknown") ||
        !edit.evidence?.artifactId ||
        artifactReferences.has(edit.evidence.artifactId)
      )
        continue;
      const artifact = await artifacts.get(edit.evidence.artifactId);
      if (!artifact.ok)
        return goalError(
          "invalid_request",
          "Manual evidence Artifact could not be verified by the host.",
          "invalid_artifact_id",
        );
      artifactReferences.set(edit.evidence.artifactId, {
        id: artifact.value.metadata.id,
        sha256: artifact.value.metadata.sha256,
        size: artifact.value.metadata.size,
        ...(artifact.value.metadata.mediaType === undefined
          ? {}
          : { mediaType: artifact.value.metadata.mediaType }),
      });
    }
    const loaded = await loadForCommand(
      command.goalId,
      command.expectedRevision,
    );
    if (!loaded.ok) return loaded;
    const { head, version, nodes } = loaded.value;
    if (
      (edits.length > 0 || command.invalidateNode !== undefined) &&
      !EDITABLE_STATES.includes(head.state)
    )
      return goalError(
        "state_conflict",
        "Edits and manual dispositions require a draft, paused, or blocked Goal.",
        "edits_require_pause",
      );
    if (!RESUMABLE_STATES.includes(head.state))
      return goalError(
        "state_conflict",
        `Goal ${command.goalId} cannot resume from ${head.state}.`,
        "not_resumable",
      );
    const unresolved = nodes.filter(
      (node) =>
        node.value.blockedReason === "unknown-attempt" &&
        !edits.some(
          (edit) =>
            edit.kind === "resolve-unknown" &&
            edit.nodeId === node.value.nodeId,
        ),
    );
    if (unresolved.length > 0)
      return goalError(
        "state_conflict",
        "Resolve every unknown Attempt before resuming this Goal.",
        "unknown_attempt_unresolved",
      );

    const attemptVersions = new Map<string, number>();
    const attempts: StoredGoalAttempt[] = [];
    for (const node of nodes) {
      const loadedAttempts = await store.loadAttempts(
        command.goalId,
        node.value.nodeId,
      );
      if (!loadedAttempts.ok) return loadedAttempts;
      for (const entry of loadedAttempts.value) {
        attempts.push(entry.value);
        attemptVersions.set(
          `${entry.value.nodeId}:${entry.value.number}`,
          entry.version,
        );
      }
    }

    const now = clock.now();
    const applied = applyGoalEdits(
      {
        head,
        nodes: nodes.map((entry) => entry.value),
        attempts,
        actor: authority.actor,
        actorId: authority.actorId,
        reason: command.reason ?? null,
        now,
        artifactReferences,
      },
      edits,
      command.invalidateNode,
    );
    if (!applied.ok) return applied;

    const edited = applied.value;
    const activated: StoredGoalHead = {
      ...edited.head,
      state: "ready",
      runGeneration: edited.head.runGeneration + 1,
      blockedReason: null,
      updatedAt: now,
    };
    const resumedEntry = historyEntry(
      activated,
      "goal.resumed",
      authority.actor,
      authority.actorId,
      command.reason ?? null,
      { generation: activated.runGeneration },
    );
    const withAudit: StoredGoalHead = {
      ...activated,
      history: withHistory(activated, resumedEntry),
    };
    const resumedEventId = eventId(
      command.goalId,
      withAudit.generationId,
      "resumed",
      String(resumedEntry.position),
    );
    const operations: StateMutation[] = [store.putHead(withAudit, version)];
    for (const node of nodes) {
      const changed = edited.nodes.get(node.value.nodeId);
      if (changed) {
        operations.push(store.putNode(changed, node.version));
        continue;
      }
      // A node blocked by a condition the user just addressed returns to the
      // ordinary waiting state; scheduling decides what is ready.
      if (node.value.state !== "blocked") continue;
      operations.push(
        store.putNode(
          {
            ...node.value,
            state: "waiting",
            blockedReason: null,
            nextAttemptAt: null,
            updatedAt: now,
          },
          node.version,
        ),
      );
    }
    for (const attempt of edited.attempts) {
      const attemptVersion = attemptVersions.get(
        `${attempt.nodeId}:${attempt.number}`,
      );
      if (attemptVersion === undefined) continue;
      operations.push(store.putAttempt(attempt, attemptVersion));
    }
    for (const event of edited.events) {
      operations.push(
        store.appendEvent(
          command.goalId,
          eventId(command.goalId, withAudit.generationId, event.label),
          event.type,
          event.metadata,
        ),
      );
    }
    operations.push(
      store.appendEvent(command.goalId, resumedEventId, "goal.resumed", {
        goalId: command.goalId,
        actor: authority.actor,
        actorId: authority.actorId,
        reason: command.reason ?? null,
        generation: withAudit.runGeneration,
        revision: withAudit.definitionRevision,
        invalidated: edited.invalidated.join(","),
      }),
      store.putRequest(command.requestId, {
        digest,
        goalId: command.goalId,
        eventPosition: resumedEntry.position,
        eventId: resumedEventId,
      }),
    );
    const committed = await store.commit("resume", operations);
    if (!committed.ok) return committed;
    kick(command.goalId);
    const position =
      committed.value.events.find((event) => event.eventId === resumedEventId)
        ?.position ?? resumedEntry.position;
    return receiptFor(command.goalId, false, position);
  }

  async function observe(
    query: GoalObservationQuery = {},
  ): Promise<GoalOutcome<GoalObservation>> {
    if (closed) return goalError("closed", "Goal runtime is closed.");
    await ensureRecovered();
    if (query.goalId !== undefined) {
      const head = await store.loadHead(query.goalId);
      if (!head.ok) return head;
      if (!head.value)
        return goalError("not_found", `Goal ${query.goalId} does not exist.`);
      const snapshot = await loadSnapshot(query.goalId);
      if (!snapshot.ok) return snapshot;
      const detail =
        query.includeHistory === false
          ? { ...snapshot.value, history: [] }
          : snapshot.value;
      const nodes = await store.loadNodes(query.goalId);
      if (!nodes.ok) return nodes;
      return {
        ok: true,
        value: {
          goals: [
            summarize(
              head.value.value,
              nodes.value.map((entry) => entry.value),
            ),
          ],
          detail,
          nextCursor: null,
          truncated: false,
        },
      };
    }
    const limit = Math.min(
      Math.max(1, query.limit ?? GOAL_LIMITS.defaultObservationPageSize),
      GOAL_LIMITS.maxObservationPageSize,
    );
    /**
     * A state filter is applied while scanning, not after one page of heads.
     * Otherwise a page whose matches all sort later reports an empty final
     * page and the caller silently loses every remaining Goal. Scanning stays
     * bounded: at most `OBSERVATION_SCAN_PAGES` pages, and a scan that stops on
     * that bound reports the last key it read so the caller can resume exactly
     * where this one gave up.
     */
    const scan = Math.max(limit + 1, GOAL_LIMITS.maxObservationPageSize);
    const matched: StoredGoalHead[] = [];
    let cursor = query.afterGoalId;
    let scanned: string | undefined;
    let exhausted = false;
    for (let page = 0; page < OBSERVATION_SCAN_PAGES; page += 1) {
      const heads = await store.listHeads(scan, cursor);
      if (!heads.ok) return heads;
      for (const entry of heads.value) {
        scanned = entry.value.goalId;
        if (query.state !== undefined && entry.value.state !== query.state)
          continue;
        matched.push(entry.value);
      }
      exhausted = heads.value.length < scan;
      cursor = scanned;
      if (exhausted || matched.length > limit) break;
    }
    const page = matched.slice(0, limit);
    const summaries: GoalSummary[] = [];
    for (const entry of page) {
      const nodes = await store.loadNodes(entry.goalId);
      if (!nodes.ok) return nodes;
      summaries.push(
        summarize(
          entry,
          nodes.value.map((node) => node.value),
        ),
      );
    }
    const moreMatches = matched.length > limit;
    const stoppedEarly = !exhausted && !moreMatches;
    return {
      ok: true,
      value: {
        goals: summaries,
        detail: null,
        nextCursor: moreMatches
          ? (page.at(-1)?.goalId ?? null)
          : stoppedEarly
            ? (scanned ?? null)
            : null,
        truncated: moreMatches || stoppedEarly,
      },
    };
  }

  /**
   * Commit one logical step, rebuilding it from fresh state after an optimistic
   * conflict. Two nodes settling at the same instant both touch the Goal head
   * budget, so a conflict here means "someone else moved first", never "give up".
   */
  async function commitWithRetry(
    label: string,
    build: () => Promise<readonly StateMutation[] | null>,
    attempts = 8,
  ) {
    for (let index = 0; index < attempts; index += 1) {
      const operations = await build();
      if (!operations) return null;
      const committed = await store.commit(label, operations);
      if (committed.ok) return committed;
      if (committed.error.code !== "revision_conflict") return null;
    }
    return null;
  }

  async function blockNode(
    goalId: string,
    nodeId: string,
    reason: string,
    error?: { code: string; message: string },
  ) {
    await commitWithRetry("block-node", async () => {
      const node = await store.loadNode(goalId, nodeId);
      if (!node.ok || !node.value) return null;
      if (!nodeTransitionAllowed(node.value.value.state, "blocked"))
        return null;
      const now = clock.now();
      return [
        store.putNode(
          {
            ...node.value.value,
            state: "blocked",
            blockedReason: reason,
            lastError: error ?? node.value.value.lastError,
            updatedAt: now,
          },
          node.value.version,
        ),
        store.appendEvent(
          goalId,
          eventId(
            goalId,
            node.value.value.generationId,
            "node-blocked",
            nodeId,
            reason,
            String(node.value.version),
          ),
          "goal.node-blocked",
          { goalId, nodeId, reason },
        ),
      ];
    });
  }

  async function tick(goalId: string): Promise<void> {
    if (closed) return;
    const head = await store.loadHead(goalId);
    if (!head.ok || !head.value) return;
    const stored = head.value.value;
    if (stored.state !== "ready" && stored.state !== "running") return;
    const nodes = await store.loadNodes(goalId);
    if (!nodes.ok) return;
    const ordered = orderNodes(
      stored,
      nodes.value.map((entry) => entry.value),
    );
    const byId = new Map(
      nodes.value.map((entry) => [entry.value.nodeId, entry]),
    );
    const plan = planSchedule(
      ordered.map((node) => ({
        id: node.nodeId,
        state: node.state,
        dependsOn: node.definition.dependsOn,
        nextAttemptAt: node.nextAttemptAt,
      })),
      {
        now: clock.now(),
        maxConcurrency: stored.budget.limits.maxConcurrency,
        order: stored.order,
      },
    );

    if (plan.promote.length > 0 || plan.block.length > 0) {
      const now = clock.now();
      const operations: StateMutation[] = [];
      for (const id of plan.promote) {
        const node = byId.get(id);
        if (!node || !nodeTransitionAllowed(node.value.state, "ready"))
          continue;
        operations.push(
          store.putNode(
            {
              ...node.value,
              state: "ready",
              nextAttemptAt: null,
              updatedAt: now,
            },
            node.version,
          ),
        );
      }
      for (const blocked of plan.block) {
        const node = byId.get(blocked.id);
        if (!node || !nodeTransitionAllowed(node.value.state, "blocked"))
          continue;
        operations.push(
          store.putNode(
            {
              ...node.value,
              state: "blocked",
              blockedReason: blocked.reason,
              updatedAt: now,
            },
            node.version,
          ),
          store.appendEvent(
            goalId,
            eventId(
              goalId,
              stored.generationId,
              "node-blocked",
              blocked.id,
              blocked.reason,
              String(node.version),
            ),
            "goal.node-blocked",
            { goalId, nodeId: blocked.id, reason: blocked.reason },
          ),
        );
      }
      if (operations.length > 0) {
        const committed = await store.commit("plan", operations);
        if (!committed.ok) return;
        kick(goalId);
        return;
      }
    }

    for (const nodeId of plan.dispatch) {
      const claimed = await claimAttempt(goalId, nodeId);
      if (claimed) void track(runAttempt(claimed));
    }
    await refreshGoal(goalId);
    if (plan.wakeAt !== null) armWake(goalId, plan.wakeAt);
  }

  /**
   * Claim protocol steps one and two: reserve worst-case budget, create the
   * Attempt, and claim the node lease in one transaction, then bind the returned
   * fence before any external work can start.
   */
  async function claimAttempt(
    goalId: string,
    nodeId: string,
  ): Promise<ClaimContext | null> {
    const captured: {
      attempt?: StoredGoalAttempt;
      definition?: StoredGoalNode["definition"];
    } = {};
    const claim = await commitWithRetry("claim", async () => {
      const head = await store.loadHead(goalId);
      if (!head.ok || !head.value) return null;
      const node = await store.loadNode(goalId, nodeId);
      if (!node.ok || !node.value) return null;
      const stored = node.value.value;
      if (stored.state !== "ready") return null;
      if (
        head.value.value.budget.reserved.calls >=
        head.value.value.budget.limits.maxConcurrency
      )
        return null;
      const attemptNumber = stored.attemptCount + 1;
      if (attemptNumber > stored.definition.policy.maxAttempts) {
        await blockNode(goalId, nodeId, "attempts-exhausted");
        return null;
      }
      const existingAttempts = await store.loadAttempts(goalId, nodeId);
      if (!existingAttempts.ok) return null;
      // A reclaimed or invalidated node reuses its Attempt number, so the record
      // is overwritten at its current version rather than created afresh.
      const priorVersion =
        existingAttempts.value.find(
          (entry) => entry.value.number === attemptNumber,
        )?.version ?? null;
      const reserved = reserveAttempt(
        head.value.value.budget,
        stored.definition.reservation,
        metering,
      );
      if (!reserved.ok) {
        await blockNode(goalId, nodeId, reserved.error.code, {
          code: reserved.error.code,
          message: reserved.error.message,
        });
        return null;
      }
      const now = clock.now();
      const attempt: StoredGoalAttempt = {
        goalId,
        generationId: head.value.value.generationId,
        nodeId,
        number: attemptNumber,
        attemptKey: attemptKeyFor(
          goalId,
          head.value.value.generationId,
          nodeId,
          head.value.value.runGeneration,
          attemptNumber,
        ),
        phase: "reserved",
        fence: 0,
        owner: ownerId,
        runGeneration: head.value.value.runGeneration,
        reservation: stored.definition.reservation,
        profile: stored.profile,
        workspaceId: null,
        cwd: binding.cwd,
        startedAt: now,
        settledAt: null,
        accountedAt: null,
        certainty: null,
        usage: null,
        error: null,
        artifact: null,
      };
      captured.attempt = attempt;
      captured.definition = stored.definition;
      return [
        store.putHead(
          {
            ...head.value.value,
            budget: reserved.value,
            state:
              head.value.value.state === "ready"
                ? "running"
                : head.value.value.state,
            updatedAt: now,
          },
          head.value.version,
        ),
        store.putNode(
          {
            ...stored,
            state: "running",
            attemptCount: attemptNumber,
            currentAttempt: attemptNumber,
            nextAttemptAt: null,
            updatedAt: now,
          },
          node.value.version,
        ),
        store.putAttempt(attempt, priorVersion),
        {
          type: "claim-lease",
          resource: store.leaseResource(goalId, nodeId),
          owner: ownerId,
          ttlMs: leaseTtlMs,
          metadata: { goalId, nodeId, attempt: attemptNumber },
        },
        store.appendEvent(
          goalId,
          eventId(
            goalId,
            attempt.generationId,
            "attempt-claimed",
            attempt.attemptKey,
            String((priorVersion ?? 0) + 1),
          ),
          "goal.attempt-claimed",
          {
            goalId,
            nodeId,
            attempt: attemptNumber,
            attemptKey: attempt.attemptKey,
          },
        ),
      ];
    });
    const attempt = captured.attempt;
    const definition = captured.definition;
    if (!claim || !attempt || !definition) return null;

    const fence = claim.value.leases.at(-1)?.fence ?? 0;
    const attemptVersion =
      claim.value.records.find(
        (record) => record.collection === store.collections.ATTEMPTS,
      )?.version ?? 1;
    const bound: StoredGoalAttempt = { ...attempt, phase: "prepared", fence };
    const context: ClaimContext = {
      goalId,
      nodeId,
      attempt: bound,
      attemptVersion: attemptVersion + 1,
      definition,
    };
    const fenced = await store.commit("bind-fence", [
      store.putAttempt(bound, attemptVersion),
      {
        type: "renew-lease",
        resource: store.leaseResource(goalId, nodeId),
        owner: ownerId,
        fence,
        ttlMs: leaseTtlMs,
      },
    ]);
    if (!fenced.ok) {
      await abandonAttempt(
        context,
        "claim_failed",
        "The Attempt fence could not be bound.",
        "ready",
      );
      return null;
    }
    return context;
  }

  /**
   * Keep one Attempt's node lease alive while its child runs.
   *
   * A node lease is deliberately shorter than an Attempt may run: it is what a
   * replacement incarnation waits on before taking the node over. Renewal is
   * armed on the injected clock, bounded by the Attempt's own timeout plus one
   * lease of grace, and every renewal carries its own sequence so an identical
   * transaction is never mistaken for a replay of the previous one.
   *
   * A renewal that cannot be committed means this incarnation no longer owns
   * the node. The exact worker is aborted so its settlement is fenced rather
   * than applied, and a success that arrives afterwards is downgraded to an
   * ambiguous outcome instead of silently overwriting the new owner's view.
   */
  function renewLeaseWhileRunning(input: {
    readonly goalId: string;
    readonly nodeId: string;
    readonly attemptNumber: number;
    readonly fence: number;
    readonly controller: AbortController;
    readonly deadline: number;
  }) {
    const period = Math.max(1_000, Math.floor(leaseTtlMs / 3));
    let stopped = false;
    let cancelTimer: (() => void) | null = null;
    let renewals = 0;
    let lost = false;
    const stop = () => {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    };
    const arm = () => {
      if (stopped || closed) return;
      cancelTimer = clock.arm(clock.now() + period, () => {
        cancelTimer = null;
        void track(renew());
      });
    };
    const renew = async () => {
      if (stopped || closed) return;
      // Bounded: an Attempt past its own timeout plus a lease of grace stops
      // holding the node, and its worker is abandoned rather than renewed.
      if (clock.now() >= input.deadline) {
        stop();
        input.controller.abort();
        return;
      }
      renewals += 1;
      const renewed = await store.commit("renew-node-lease", [
        {
          type: "renew-lease",
          resource: store.leaseResource(input.goalId, input.nodeId),
          owner: ownerId,
          fence: input.fence,
          ttlMs: leaseTtlMs,
          metadata: {
            goalId: input.goalId,
            nodeId: input.nodeId,
            attempt: input.attemptNumber,
            renewal: renewals,
          },
        },
      ]);
      if (stopped) return;
      if (!renewed.ok) {
        lost = true;
        stop();
        input.controller.abort();
        return;
      }
      arm();
    };
    arm();
    return {
      stop,
      get lost() {
        return lost;
      },
    };
  }

  /** Release a reservation for an Attempt that provably never dispatched. */
  async function abandonAttempt(
    context: ClaimContext,
    code: string,
    message: string,
    nodeState: GoalNodeState,
    blockedReason?: string,
  ) {
    await commitWithRetry("abandon", async () => {
      const head = await store.loadHead(context.goalId);
      const node = await store.loadNode(context.goalId, context.nodeId);
      if (!head.ok || !head.value || !node.ok || !node.value) return null;
      const attempts = await store.loadAttempts(context.goalId, context.nodeId);
      if (!attempts.ok) return null;
      const current = attempts.value.find(
        (entry) => entry.value.number === context.attempt.number,
      );
      if (!current) return null;
      const now = clock.now();
      const budget = settleAttempt(
        head.value.value.budget,
        context.attempt.reservation,
        { kind: "not-started" },
        metering,
      );
      return [
        store.putHead(
          { ...head.value.value, budget, updatedAt: now },
          head.value.version,
        ),
        store.putNode(
          {
            ...node.value.value,
            state: nodeTransitionAllowed(node.value.value.state, nodeState)
              ? nodeState
              : node.value.value.state,
            attemptCount: Math.max(0, node.value.value.attemptCount - 1),
            currentAttempt: null,
            blockedReason: blockedReason ?? node.value.value.blockedReason,
            lastError: { code, message },
            updatedAt: now,
          },
          node.value.version,
        ),
        store.putAttempt(
          {
            ...current.value,
            phase: "cancelled",
            certainty: "not-started",
            settledAt: now,
            accountedAt: now,
            error: { code, message },
          },
          current.version,
        ),
        {
          type: "release-lease",
          resource: store.leaseResource(context.goalId, context.nodeId),
          owner: ownerId,
          fence: context.attempt.fence,
        },
        store.appendEvent(
          context.goalId,
          eventId(
            context.goalId,
            context.attempt.generationId,
            "attempt-abandoned",
            context.attempt.attemptKey,
            code,
            String(context.attempt.fence),
          ),
          "goal.attempt-abandoned",
          {
            goalId: context.goalId,
            nodeId: context.nodeId,
            attemptKey: context.attempt.attemptKey,
            code,
          },
        ),
      ];
    });
  }

  /**
   * Claim protocol steps three to five: revalidate the pinned Agent Profile,
   * prepare an isolated workspace when the profile asks for one, persist
   * `dispatching`, and only then invoke the executor.
   */
  async function runAttempt(context: ClaimContext) {
    const { goalId, nodeId, definition } = context;
    let attempt = context.attempt;
    let attemptVersion = context.attemptVersion;
    const controller = new AbortController();
    aborts.set(`${goalId}:${nodeId}`, controller);

    try {
      const resolved = await profiles.resolve(definition.profileName);
      if (
        !resolved.ok ||
        resolved.value.role !== "goal-worker" ||
        resolved.value.contentDigest !== attempt.profile.contentDigest ||
        resolved.value.catalogGeneration !== attempt.profile.catalogGeneration
      ) {
        await abandonAttempt(
          context,
          "profile_changed",
          "The pinned Agent Profile no longer matches the catalog.",
          "blocked",
          "profile_changed",
        );
        kick(goalId);
        return;
      }

      let cwd = binding.cwd;
      let workspaceId: string | null = null;
      if (
        resolved.value.workspacePolicy === "isolated" &&
        !executorOwnsWorkspaces
      ) {
        if (!workspaces) {
          await abandonAttempt(
            context,
            "workspace_failed",
            "An isolated Agent Profile requires a Guarded Workspace owner.",
            "blocked",
            "workspace_failed",
          );
          kick(goalId);
          return;
        }
        const prepared = await workspaces.prepare({
          goalId,
          nodeId,
          attemptKey: attempt.attemptKey,
          projectId: binding.projectId,
          fence: attempt.fence,
        });
        if (!prepared.ok) {
          await abandonAttempt(
            context,
            "workspace_failed",
            "A Guarded Workspace could not be prepared.",
            "blocked",
            "workspace_failed",
          );
          kick(goalId);
          return;
        }
        cwd = prepared.value.cwd;
        workspaceId = prepared.value.workspaceId;
      }

      const dispatchHead = await store.loadHead(goalId);
      const dispatchNode = await store.loadNode(goalId, nodeId);
      const dispatchAllowed =
        !controller.signal.aborted &&
        dispatchHead.ok &&
        !!dispatchHead.value &&
        dispatchNode.ok &&
        !!dispatchNode.value &&
        (dispatchHead.value.value.state === "ready" ||
          dispatchHead.value.value.state === "running") &&
        dispatchHead.value.value.runGeneration === attempt.runGeneration &&
        dispatchNode.value.value.state === "running" &&
        dispatchNode.value.value.currentAttempt === attempt.number;
      if (!dispatchAllowed) {
        await abandonAttempt(
          context,
          "dispatch_fenced",
          "The Goal changed before dispatch.",
          "ready",
        );
        kick(goalId);
        return;
      }

      const dispatching: StoredGoalAttempt = {
        ...attempt,
        phase: "dispatching",
        workspaceId,
        cwd,
      };
      const marked = await store.commit("dispatch", [
        store.checkRecord(
          store.collections.HEADS,
          goalId,
          dispatchHead.value.version,
        ),
        store.checkRecord(
          store.collections.NODES,
          store.nodeKey(goalId, nodeId),
          dispatchNode.value.version,
        ),
        store.putAttempt(dispatching, attemptVersion),
        {
          type: "renew-lease",
          resource: store.leaseResource(goalId, nodeId),
          owner: ownerId,
          fence: attempt.fence,
          ttlMs: leaseTtlMs,
        },
      ]);
      if (!marked.ok) {
        await abandonAttempt(
          context,
          "lease_lost",
          "The Attempt lease was lost before dispatch.",
          "ready",
        );
        kick(goalId);
        return;
      }
      attempt = dispatching;
      attemptVersion += 1;

      if (controller.signal.aborted) {
        await abandonAttempt(
          { ...context, attempt, attemptVersion },
          "dispatch_fenced",
          "The Goal changed before dispatch.",
          "ready",
        );
        kick(goalId);
        return;
      }
      const request: GoalExecutorRequest = {
        attemptKey: attempt.attemptKey,
        prompt: definition.prompt,
        cwd,
        projectId: binding.projectId,
        profile: attempt.profile,
        timeoutMs: definition.policy.timeoutMs,
        maxOutputBytes: definition.policy.maxOutputBytes,
        ...(metering.tokens && definition.reservation.tokens > 0
          ? { maxTokens: definition.reservation.tokens }
          : {}),
        ...(metering.cost && definition.reservation.costMicros > 0
          ? { maxCostMicros: definition.reservation.costMicros }
          : {}),
      };
      const renewal = renewLeaseWhileRunning({
        goalId,
        nodeId,
        attemptNumber: attempt.number,
        fence: attempt.fence,
        controller,
        deadline:
          clock.now() +
          Math.min(definition.policy.timeoutMs, GOAL_LIMITS.maxTimeoutMs) +
          leaseTtlMs,
      });
      let outcome;
      try {
        outcome = await executor.run(request, controller.signal);
      } catch (error) {
        outcome = {
          ok: false as const,
          error: {
            code: "run_failed",
            message: error instanceof Error ? error.message : "Executor threw.",
            retryable: false,
            certainty: "unknown" as GoalExecutionCertainty,
          },
        };
      } finally {
        renewal.stop();
      }
      // A worker that reports success after this incarnation lost the node
      // proves nothing: another owner may already have acted on the Attempt.
      if (renewal.lost && outcome.ok) {
        outcome = {
          ok: false as const,
          error: {
            code: "lease_lost",
            message:
              "The Attempt lease was lost while the worker ran; its outcome cannot be proven here.",
            retryable: false,
            certainty: "unknown" as GoalExecutionCertainty,
            ...(outcome.value.workspaceId === undefined
              ? {}
              : { workspaceId: outcome.value.workspaceId }),
          },
        };
      }
      await settleAttemptOutcome({ ...context, attempt }, outcome);
      // A Goal cancelled while this worker ran is waiting on exactly this
      // settlement before its reconciliation can close.
      const settledHead = await store.loadHead(goalId);
      if (settledHead.ok && settledHead.value)
        await reconcileCancellation(settledHead.value.value);
      kick(goalId);
    } finally {
      aborts.delete(`${goalId}:${nodeId}`);
    }
  }

  /**
   * Claim protocol step five: turn one executor outcome into evidence, node
   * state, budget consumption, an Attempt record, an audit event, and a released
   * lease — transactionally, or not at all.
   */
  async function settleAttemptOutcome(
    context: ClaimContext,
    outcome: Awaited<ReturnType<GoalExecutorPort["run"]>>,
  ) {
    const { goalId, nodeId, definition } = context;
    const attempt = context.attempt;
    const head = await store.loadHead(goalId);
    const node = await store.loadNode(goalId, nodeId);
    if (!head.ok || !head.value || !node.ok || !node.value) return;
    const now = clock.now();
    const definitionRevision = head.value.value.definitionRevision;
    const runtimeMs = Math.max(0, now - attempt.startedAt);
    // An executor that owns the Guarded Workspace reports its identifier with
    // the outcome. Record it on the Attempt so inspection, audit, and the
    // review binding all name the tree the work actually happened in.
    const reportedWorkspaceId =
      (outcome.ok ? outcome.value.workspaceId : outcome.error.workspaceId) ??
      null;
    const workspaceId = attempt.workspaceId ?? reportedWorkspaceId;

    let artifact = null as null | {
      id: string;
      sha256: string;
      size: number;
      mediaType?: string;
    };
    let failure = outcome.ok
      ? null
      : {
          code: outcome.error.code,
          message: outcome.error.message.slice(0, 1_000),
          retryable: outcome.error.retryable,
          certainty: outcome.error.certainty,
        };
    const usage = outcome.ok ? outcome.value.usage : outcome.error.usage;
    const executionStarted =
      outcome.ok || outcome.error.certainty === "started";
    const authoritative = usage?.authoritative === true;
    const reportedTokens = usage?.tokens;
    const reportedCost = usage?.costMicros;
    const tokensMeasured =
      authoritative &&
      Number.isSafeInteger(reportedTokens) &&
      reportedTokens !== undefined &&
      reportedTokens >= 0;
    const costMeasured =
      authoritative &&
      Number.isSafeInteger(reportedCost) &&
      reportedCost !== undefined &&
      reportedCost >= 0;
    const missingMeter =
      executionStarted &&
      ((head.value.value.budget.limits.maxTokens !== null && !tokensMeasured) ||
        (head.value.value.budget.limits.maxCostMicros !== null &&
          !costMeasured));
    if (missingMeter) {
      failure = {
        code: "metering_unavailable",
        message:
          "Authoritative Goal token or cost usage was unavailable at settlement.",
        retryable: false,
        certainty: "started",
      };
    }
    const produced: GoalEvidence[] = [];

    if (outcome.ok && !failure) {
      const candidate = outcome.value.artifact;
      // Artifacts are content addressed, so identical worker output from two
      // Attempts is one body. Attempt provenance belongs to the Goal Evidence
      // record, never to the shared immutable metadata.
      let put = await artifacts.put({
        body: candidate.body,
        filename: candidate.filename,
        mediaType: candidate.mediaType,
        title: "Goal Evidence",
        creator: "goal-worker",
        projectId: binding.projectId,
        kind:
          candidate.mediaType === "application/json"
            ? "json"
            : candidate.mediaType.startsWith("image/")
              ? "image"
              : candidate.mediaType === "text/html"
                ? "html"
                : "other",
        sensitivity: "internal",
        metadata: {
          kind: candidate.metadata.kind,
          trust: candidate.metadata.trust,
        },
      });
      if (!put.ok && put.error.code === "metadata_conflict") {
        const existing = await artifacts.get(candidate.sha256);
        if (existing.ok) put = { ok: true, value: existing.value.metadata };
      }
      if (!put.ok) {
        failure = {
          code: "artifact_failed",
          message: "The worker output could not be stored.",
          retryable: false,
          certainty: "started",
        };
      } else if (
        put.value.sha256 !== candidate.sha256 ||
        put.value.size !== candidate.size
      ) {
        failure = {
          code: "artifact_failed",
          message: "The worker misreported its output digest or size.",
          retryable: false,
          certainty: "started",
        };
      } else {
        artifact = {
          id: put.value.id,
          sha256: put.value.sha256,
          size: put.value.size,
          ...(put.value.mediaType === undefined
            ? {}
            : { mediaType: put.value.mediaType }),
        };
        const outputCriteria = definition.criteria.filter((criterion) =>
          criterion.acceptedEvidenceKinds.includes("worker-output"),
        );
        const targets =
          outputCriteria.length > 0
            ? outputCriteria.map((criterion) => criterion.id)
            : ["output"];
        for (const criterionId of targets) {
          produced.push(
            createEvidence({
              scope: "node",
              nodeId,
              criterionId,
              kind: "worker-output",
              trust: "worker-reported",
              summary: `Worker output for ${nodeId}`,
              attemptNumber: attempt.number,
              definitionRevision,
              artifact,
              discriminator: attempt.attemptKey,
              recordedAt: now,
            }),
          );
        }
        for (const criterion of definition.criteria) {
          if (
            evaluateCriteria([criterion], produced, definitionRevision)
              .satisfied
          )
            continue;
          const verdict = await review.verify({
            goalId,
            nodeId,
            attemptKey: attempt.attemptKey,
            criterionId: criterion.id,
            acceptedEvidenceKinds: criterion.acceptedEvidenceKinds,
            artifact,
            cwd: attempt.cwd,
            workspaceId,
          });
          if (!verdict.ok || !verdict.value.satisfied) continue;
          produced.push(
            createEvidence({
              scope: "node",
              nodeId,
              criterionId: criterion.id,
              kind: verdict.value.kind,
              trust: "host-verified",
              summary: verdict.value.summary,
              attemptNumber: attempt.number,
              definitionRevision,
              artifact: verdict.value.artifact ?? null,
              discriminator: `${attempt.attemptKey}:${criterion.id}`,
              recordedAt: now,
            }),
          );
        }
        const gate = evaluateCriteria(
          definition.criteria,
          [...node.value.value.evidence, ...produced],
          definitionRevision,
        );
        if (!gate.satisfied) {
          failure = {
            code: "evidence_missing",
            message: `Unmet criteria: ${gate.unmet
              .map((entry) => `${entry.criterionId} (${entry.reason})`)
              .join(", ")}`,
            retryable: true,
            certainty: "started",
          };
        }
      }
    }

    const settlement: GoalAttemptSettlement =
      failure?.certainty === "unknown"
        ? { kind: "unknown" }
        : !outcome.ok && outcome.error.certainty === "not-started"
          ? { kind: "not-started" }
          : {
              kind: "settled",
              usage: {
                runtimeMs,
                ...(usage?.tokens === undefined
                  ? {}
                  : { tokens: usage.tokens }),
                ...(usage?.costMicros === undefined
                  ? {}
                  : { costMicros: usage.costMicros }),
                authoritative: usage?.authoritative ?? false,
              },
            };
    const charge = chargeForAttempt(attempt.reservation, settlement, metering);
    const decision = failure
      ? retryDecision({
          retryable: failure.retryable,
          certainty: failure.certainty,
          attemptCount: node.value.value.attemptCount,
          maxAttempts: definition.policy.maxAttempts,
        })
      : "done";
    const nodeState: GoalNodeState =
      decision === "done"
        ? "done"
        : decision === "retry"
          ? "retry-wait"
          : decision === "fail"
            ? "failed"
            : "blocked";
    const phase =
      decision === "done"
        ? ("succeeded" as const)
        : decision === "block"
          ? ("unknown" as const)
          : ("failed" as const);
    const nextAttemptAt =
      decision === "retry"
        ? now + retryDelayFor(definition.policy.retryDelayMs, attempt.number)
        : null;

    await commitWithRetry("settle", async () => {
      const currentHead = await store.loadHead(goalId);
      const currentNode = await store.loadNode(goalId, nodeId);
      const attempts = await store.loadAttempts(goalId, nodeId);
      if (
        !currentHead.ok ||
        !currentHead.value ||
        !currentNode.ok ||
        !currentNode.value ||
        !attempts.ok
      )
        return null;
      const record = attempts.value.find(
        (entry) => entry.value.number === attempt.number,
      );
      if (!record) return null;
      const late =
        record.value.fence !== attempt.fence || record.value.owner !== ownerId;
      if (late) {
        const lateAt = clock.now();
        const operations: StateMutation[] = [
          store.appendEvent(
            goalId,
            eventId(
              goalId,
              attempt.generationId,
              "late-settlement",
              attempt.attemptKey,
              phase,
              String(attempt.fence),
            ),
            "goal.late-settlement",
            {
              goalId,
              nodeId,
              attemptKey: attempt.attemptKey,
              phase,
              fence: attempt.fence,
              currentFence: record.value.fence,
              code: failure?.code ?? null,
            },
          ),
        ];
        if (
          record.value.settledAt === null &&
          record.value.accountedAt == null
        ) {
          operations.unshift(
            store.putHead(
              {
                ...currentHead.value.value,
                budget: settleAttempt(
                  currentHead.value.value.budget,
                  attempt.reservation,
                  settlement,
                  metering,
                ),
                updatedAt: lateAt,
              },
              currentHead.value.version,
            ),
            store.putAttempt(
              { ...record.value, accountedAt: lateAt },
              record.version,
            ),
          );
        }
        return operations;
      }
      if (record.value.settledAt !== null)
        return [
          store.appendEvent(
            goalId,
            eventId(
              goalId,
              attempt.generationId,
              "late-settlement",
              attempt.attemptKey,
              phase,
              String(attempt.fence),
            ),
            "goal.late-settlement",
            {
              goalId,
              nodeId,
              attemptKey: attempt.attemptKey,
              phase,
              fence: attempt.fence,
              currentFence: record.value.fence,
              code: failure?.code ?? null,
            },
          ),
        ];
      const settledAt = clock.now();
      const settled: StoredGoalAttempt = {
        ...record.value,
        phase,
        workspaceId,
        settledAt,
        accountedAt: record.value.accountedAt ?? settledAt,
        certainty: failure ? failure.certainty : "started",
        // Usage contains measurements only. Reservations remain ledger
        // coordination and never become fabricated token or cost observations.
        usage:
          charge.tokensMetered || charge.costMetered
            ? {
                tokens: charge.tokens,
                authoritative: charge.tokensMetered,
                costMicros: charge.costMicros,
                costAuthoritative: charge.costMetered,
              }
            : null,
        error: failure
          ? { code: failure.code, message: failure.message }
          : null,
        artifact,
      };
      const operations: StateMutation[] = [
        store.putAttempt(settled, record.version),
      ];
      // A Goal that already settled, or a node another owner moved on, keeps its
      // state: the outcome is recorded as audit only.
      const stillOwned =
        !TERMINAL_GOAL_STATES.includes(currentHead.value.value.state) &&
        currentNode.value.value.currentAttempt === attempt.number &&
        nodeTransitionAllowed(currentNode.value.value.state, nodeState);
      operations.push(
        store.putHead(
          {
            ...currentHead.value.value,
            budget:
              record.value.accountedAt == null
                ? settleAttempt(
                    currentHead.value.value.budget,
                    attempt.reservation,
                    settlement,
                    metering,
                  )
                : currentHead.value.value.budget,
            blockedReason:
              stillOwned && decision === "block"
                ? "unknown-attempt"
                : currentHead.value.value.blockedReason,
            updatedAt: settledAt,
          },
          currentHead.value.version,
        ),
      );
      if (stillOwned) {
        let evidence = currentNode.value.value.evidence;
        for (const entry of produced)
          evidence = appendEvidence(evidence, entry);
        operations.push(
          store.putNode(
            {
              ...currentNode.value.value,
              state: nodeState,
              currentAttempt: decision === "retry" ? null : attempt.number,
              nextAttemptAt,
              evidence,
              blockedReason: decision === "block" ? "unknown-attempt" : null,
              lastError: failure
                ? { code: failure.code, message: failure.message }
                : null,
              updatedAt: settledAt,
            },
            currentNode.value.version,
          ),
        );
      }
      operations.push(
        {
          type: "release-lease",
          resource: store.leaseResource(goalId, nodeId),
          owner: ownerId,
          fence: attempt.fence,
        },
        store.appendEvent(
          goalId,
          eventId(
            goalId,
            attempt.generationId,
            "attempt-settled",
            attempt.attemptKey,
            phase,
            String(attempt.fence),
          ),
          "goal.attempt-settled",
          {
            goalId,
            nodeId,
            attemptKey: attempt.attemptKey,
            phase,
            nodeState: stillOwned ? nodeState : currentNode.value.value.state,
            code: failure?.code ?? null,
          },
        ),
      );
      return operations;
    });

    if (attempt.workspaceId && workspaces && !executorOwnsWorkspaces) {
      await workspaces.dispose({
        workspaceId: attempt.workspaceId,
        goalId,
        nodeId,
        attemptKey: attempt.attemptKey,
        outcome:
          decision === "done"
            ? "succeeded"
            : decision === "block"
              ? "unknown"
              : "failed",
        preserve: decision !== "done",
      });
    }
  }

  const SETTLED_ATTEMPT_PHASES: readonly StoredGoalAttempt["phase"][] = [
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
  ];

  /** An Attempt nobody is waiting on any more. */
  function settledAttempt(attempt: StoredGoalAttempt) {
    return (
      SETTLED_ATTEMPT_PHASES.includes(attempt.phase) &&
      attempt.settledAt !== null
    );
  }

  /**
   * Why the Goal is blocked, said as the cause rather than the symptom.
   *
   * A node blocked only because something it depends on is blocked repeats
   * information the user already has, so the root cause wins: the first node
   * in execution order whose block is its own. Ordering is explicit because a
   * storage listing is not an execution order.
   */
  function blockedReasonFor(
    nodes: readonly StoredGoalNode[],
    order: readonly string[],
    hasUnknown: boolean,
    criteriaSatisfied: boolean,
  ) {
    if (hasUnknown) return "unknown-attempt";
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const blocked = [
      ...order.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])),
      ...nodes.filter((node) => !order.includes(node.nodeId)),
    ].filter((node) => node.state === "blocked");
    const root =
      blocked.find(
        (node) => !(node.blockedReason ?? "").startsWith("dependency-"),
      ) ?? blocked[0];
    if (root) return root.blockedReason ?? "node-blocked";
    if (!criteriaSatisfied) return "goal-criteria-unmet";
    return "no-progress";
  }

  async function refreshGoal(goalId: string) {
    let settledState: {
      state: GoalState;
      generationId: string;
      runGeneration: number;
    } | null = null;
    await commitWithRetry("goal-state", async () => {
      settledState = null;
      const head = await store.loadHead(goalId);
      if (!head.ok || !head.value) return null;
      const stored = head.value.value;
      if (stored.state !== "ready" && stored.state !== "running") return null;
      const nodes = await store.loadNodes(goalId);
      if (!nodes.ok) return null;
      const values = nodes.value.map((entry) => entry.value);
      const hasUnknown = values.some(
        (node) => node.blockedReason === "unknown-attempt",
      );
      const criteria = evaluateCriteria(
        stored.criteria,
        stored.evidence,
        stored.definitionRevision,
      );
      const derived = deriveGoalState(stored.state, {
        nodes: values.map((node) => ({
          state: node.state,
          required: node.definition.required,
        })),
        hasUnknownAttempt: hasUnknown,
        criteriaSatisfied: criteria.satisfied,
      });
      const blockedReason =
        derived === "blocked"
          ? blockedReasonFor(
              values,
              stored.order,
              hasUnknown,
              criteria.satisfied,
            )
          : null;
      if (derived === stored.state && blockedReason === stored.blockedReason)
        return null;
      if (
        derived !== stored.state &&
        !goalTransitionAllowed(stored.state, derived)
      )
        return null;
      const now = clock.now();
      settledState = {
        state: derived,
        generationId: stored.generationId,
        runGeneration: stored.runGeneration,
      };
      return [
        store.putHead(
          { ...stored, state: derived, blockedReason, updatedAt: now },
          head.value.version,
        ),
        store.appendEvent(
          goalId,
          eventId(
            goalId,
            stored.generationId,
            "state",
            derived,
            blockedReason ?? "-",
            String(head.value.version),
          ),
          "goal.state-changed",
          { goalId, state: derived, reason: blockedReason },
        ),
      ];
    });
    const outcome = settledState as {
      state: GoalState;
      generationId: string;
      runGeneration: number;
    } | null;
    if (!outcome) return;
    if (
      outcome.state === "done" ||
      outcome.state === "failed" ||
      outcome.state === "blocked"
    )
      await deliverOutcome(
        goalId,
        outcome.generationId,
        outcome.state,
        outcome.runGeneration,
      );
  }

  function deliveryIdFor(
    goalId: string,
    generationId: string,
    goalState: GoalState,
    runGeneration: number,
  ) {
    return digestOfText(
      "goal-delivery-v1",
      binding.projectId,
      goalId,
      generationId,
      String(runGeneration),
      goalState,
    );
  }

  async function deliverOutcome(
    goalId: string,
    generationId: string,
    goalState: GoalState,
    runGeneration: number,
  ) {
    const deliveryId = deliveryIdFor(
      goalId,
      generationId,
      goalState,
      runGeneration,
    );
    const existing = await store.loadDelivery(goalId, deliveryId);
    if (!existing.ok) return;
    if (
      existing.value &&
      (existing.value.value.result === "delivered" ||
        existing.value.value.result === "offline")
    )
      return;
    let deliveryVersion = existing.value?.version;
    if (!existing.value) {
      const intent = await store.commit("deliver-intent", [
        store.putDelivery(
          deliveryId,
          {
            goalId,
            generationId,
            state: goalState,
            runGeneration,
            deliveredAt: 0,
            result: "pending",
          },
          null,
        ),
      ]);
      if (!intent.ok) return;
      deliveryVersion = intent.value.records.find(
        (record) => record.collection === store.collections.OUTBOX,
      )?.version;
    }
    if (deliveryVersion === undefined) return;
    const result = await delivery.deliver({
      deliveryId,
      goalId,
      state: goalState,
      summary: `Goal ${goalId} is ${goalState}.`,
      runGeneration,
    });
    const receipt = await store.commit("deliver-receipt", [
      store.putDelivery(
        deliveryId,
        {
          goalId,
          generationId,
          state: goalState,
          runGeneration,
          deliveredAt: clock.now(),
          result: result.ok ? result.value.state : "failed",
        },
        deliveryVersion,
      ),
    ]);
    if (!receipt.ok) return;
  }

  /**
   * Recover Attempts that were in flight when a previous incarnation stopped.
   *
   * A reservation or preparation is reclaimed because it provably never
   * dispatched. Anything past dispatch is decided by the executor, and silence
   * becomes an Unknown Attempt.
   */
  /**
   * Recover one Attempt found in flight, whatever left it that way.
   *
   * Returns `false` when the Attempt still belongs to somebody else, so a
   * caller waiting on reconciliation knows this node is not finished yet.
   */
  async function recoverAttempt(
    goalId: string,
    node: StoredGoalNode,
    current: { readonly value: StoredGoalAttempt; readonly version: number },
    reclaimState: GoalNodeState,
  ): Promise<boolean> {
    const attempt = current.value;
    if (attempt.owner === ownerId && aborts.has(`${goalId}:${node.nodeId}`))
      return false;
    // Take the node lease over before touching anything. A live incarnation
    // still holds it until expiry, and its work must not be disturbed.
    const takeover = await store.commit("takeover", [
      {
        type: "claim-lease",
        resource: store.leaseResource(goalId, node.nodeId),
        owner: ownerId,
        ttlMs: leaseTtlMs,
        metadata: { goalId, nodeId: node.nodeId, recovery: true },
      },
    ]);
    if (!takeover.ok) return false;
    const fence = takeover.value.leases.at(-1)?.fence ?? attempt.fence;
    const owned: StoredGoalAttempt = { ...attempt, fence, owner: ownerId };
    const rebound = await store.commit("rebind-fence", [
      store.putAttempt(owned, current.version),
      {
        type: "renew-lease",
        resource: store.leaseResource(goalId, node.nodeId),
        owner: ownerId,
        fence,
        ttlMs: leaseTtlMs,
      },
    ]);
    if (!rebound.ok) return false;
    const context: ClaimContext = {
      goalId,
      nodeId: node.nodeId,
      attempt: owned,
      attemptVersion: current.version + 1,
      definition: node.definition,
    };
    const needsInspection =
      attempt.phase !== "reserved" && attempt.phase !== "prepared";
    const inspection = needsInspection
      ? await executor.inspect(attempt.attemptKey).catch(() => null)
      : null;
    const decision = recoveryDecision(
      attempt.phase,
      inspection === null
        ? null
        : inspection.state === "settled"
          ? { state: "settled" }
          : inspection.state === "running"
            ? { state: "running" }
            : inspection.state === "not-started"
              ? { state: "not-started" }
              : { state: "unknown" },
    );
    if (decision === "reclaim") {
      await abandonAttempt(
        context,
        "reclaimed",
        "The Attempt never dispatched and was reclaimed.",
        reclaimState,
      );
      return true;
    }
    if (decision === "settle" && inspection?.state === "settled") {
      await settleAttemptOutcome(context, inspection.outcome);
      return true;
    }
    if (decision === "adopt") {
      await settleAttemptOutcome(context, {
        ok: false,
        error: {
          code: "execution_unknown",
          message:
            "The Attempt is still running under a previous incarnation and cannot be adopted here.",
          retryable: false,
          certainty: "unknown",
          ...(inspection?.state === "running" && inspection.workspaceId
            ? { workspaceId: inspection.workspaceId }
            : {}),
        },
      });
      return true;
    }
    await settleAttemptOutcome(context, {
      ok: false,
      error: {
        code: "execution_unknown",
        message: "The Attempt outcome cannot be proven after restart.",
        retryable: true,
        certainty: "unknown",
      },
    });
    return true;
  }

  /**
   * Finish what a cancellation started.
   *
   * The Goal is already terminal, so nothing here revives it. What is still
   * owed is the bookkeeping the user was promised: every Attempt that was in
   * flight settles or is sealed as unknown, its node lease and budget
   * reservation are released exactly once, its Guarded Workspace is preserved
   * for inspection, and the Goal records how certain the host is about what
   * those children actually did.
   */
  async function reconcileCancellation(head: StoredGoalHead) {
    const pending = head.cancellation;
    if (!pending || pending.reconciledAt !== null) return;
    let outstanding = false;
    let unknown = false;
    for (const nodeId of pending.unresolved) {
      const node = await store.loadNode(head.goalId, nodeId);
      if (!node.ok || !node.value) continue;
      const attempts = await store.loadAttempts(head.goalId, nodeId);
      if (!attempts.ok) {
        outstanding = true;
        continue;
      }
      const unsettled = attempts.value
        .filter((entry) => !settledAttempt(entry.value))
        .sort((left, right) => left.value.number - right.value.number)
        .at(-1);
      if (
        unsettled &&
        !(await recoverAttempt(
          head.goalId,
          node.value.value,
          unsettled,
          "cancelled",
        ))
      ) {
        outstanding = true;
        continue;
      }
      const settled = await store.loadAttempts(head.goalId, nodeId);
      if (!settled.ok) {
        outstanding = true;
        continue;
      }
      for (const entry of settled.value) {
        if (!settledAttempt(entry.value)) outstanding = true;
        else if (entry.value.certainty === "unknown") unknown = true;
      }
    }
    if (outstanding) return;
    await commitWithRetry("cancellation-reconciled", async () => {
      const current = await store.loadHead(head.goalId);
      if (!current.ok || !current.value) return null;
      const status = current.value.value.cancellation;
      if (!status || status.reconciledAt !== null) return null;
      const now = clock.now();
      const certainty = unknown ? "unknown" : "settled";
      return [
        store.putHead(
          {
            ...current.value.value,
            cancellation: { ...status, reconciledAt: now, certainty },
            updatedAt: now,
          },
          current.value.version,
        ),
        store.appendEvent(
          head.goalId,
          eventId(
            head.goalId,
            head.generationId,
            "cancellation-reconciled",
            String(status.requestedAt),
            certainty,
          ),
          "goal.cancellation-reconciled",
          {
            goalId: head.goalId,
            certainty,
            unresolved: status.unresolved.join(","),
          },
        ),
      ];
    });
  }

  async function recoverAll() {
    for (let page = 0; page < 8; page += 1) {
      const heads = await store.listHeads(GOAL_LIMITS.maxNodes, recoveryCursor);
      if (!heads.ok) return;
      for (const head of heads.value) {
        const goalId = head.value.goalId;
        if (TERMINAL_GOAL_STATES.includes(head.value.state)) {
          // A cancelled Goal keeps being visited until what it left in flight
          // is released; every other terminal Goal is finished.
          await reconcileCancellation(head.value);
          continue;
        }
        const nodes = await store.loadNodes(goalId);
        if (!nodes.ok) continue;
        for (const node of nodes.value) {
          if (
            node.value.state !== "running" ||
            node.value.currentAttempt === null
          )
            continue;
          const attempts = await store.loadAttempts(goalId, node.value.nodeId);
          if (!attempts.ok) continue;
          const current = attempts.value.find(
            (entry) => entry.value.number === node.value.currentAttempt,
          );
          if (!current) continue;
          if (settledAttempt(current.value)) continue;
          await recoverAttempt(goalId, node.value, current, "ready");
        }
        await refreshGoal(goalId);
        if (head.value.state === "ready" || head.value.state === "running")
          kick(goalId);
      }
      if (heads.value.length < GOAL_LIMITS.maxNodes) {
        recoveryCursor = undefined;
        break;
      }
      recoveryCursor = heads.value.at(-1)?.value.goalId;
    }
    const deliveries = await store.listDeliveries(
      GOAL_LIMITS.maxNodes,
      deliveryCursor,
    );
    if (!deliveries.ok) return;
    for (const entry of deliveries.value) {
      if (
        entry.value.result === "delivered" ||
        entry.value.result === "offline"
      )
        continue;
      await deliverOutcome(
        entry.value.goalId,
        entry.value.generationId,
        entry.value.state,
        entry.value.runGeneration,
      );
    }
    deliveryCursor =
      deliveries.value.length < GOAL_LIMITS.maxNodes
        ? undefined
        : deliveries.value.at(-1)?.key;
    await compactTerminalGoals(clock.now(), maxGoals);
  }

  function scheduleRecoverySweep() {
    if (closed) return;
    recoverySweepCancel?.();
    recoverySweepCancel = clock.arm(
      clock.now() + Math.max(1_000, Math.min(leaseTtlMs, 60_000)),
      () => {
        recoverySweepCancel = null;
        void track(
          recoverAll()
            .catch(() => {})
            .finally(() => scheduleRecoverySweep()),
        );
      },
    );
  }

  function ensureRecovered() {
    recovery ??= track(
      recoverAll()
        .catch(() => {})
        .finally(() => scheduleRecoverySweep()),
    );
    return recovery;
  }

  async function drain() {
    await ensureRecovered();
    while (activity > 0) {
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const controller of aborts.values()) controller.abort();
    for (const cancel of timers.values()) cancel();
    timers.clear();
    recoverySweepCancel?.();
    recoverySweepCancel = null;
    while (activity > 0) {
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    }
  }

  const engine: GoalEngine = { submit, resume, pause, cancel, observe };
  return { engine, metering, drain, close };
}
