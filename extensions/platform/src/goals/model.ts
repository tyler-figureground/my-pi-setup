import type { ModuleError, Outcome } from "../core/result.ts";

/**
 * Goal Mode domain data.
 *
 * Every value here is plain, bounded, serializable data. A Goal definition
 * never carries executable orchestration: no callbacks, no expressions, and no
 * evaluator. That separation is what keeps Goal Mode distinct from Workflow
 * JavaScript, so any addition to these types must stay declarative.
 */

export const GOAL_LIMITS = Object.freeze({
  maxNodes: 128,
  maxDependenciesPerNode: 32,
  maxAttemptsPerNode: 6,
  maxConcurrentNodes: 4,
  maxCriteria: 16,
  maxEvidencePerNode: 32,
  maxHistoryEntries: 64,
  maxObservationPageSize: 50,
  defaultObservationPageSize: 20,
  maxObjectiveLength: 4_096,
  maxTitleLength: 200,
  maxPromptLength: 16_384,
  maxDescriptionLength: 512,
  maxReasonLength: 1_000,
  maxIdentifierLength: 64,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 3_600_000,
  defaultTimeoutMs: 300_000,
  maxRetryDelayMs: 3_600_000,
  defaultRetryDelayMs: 30_000,
  maxOutputBytes: 4 * 1024 * 1024,
  defaultOutputBytes: 256 * 1024,
  maxAgentCalls: 768,
  maxRuntimeMs: 30 * 24 * 3_600_000,
  maxTokens: 1_000_000_000,
  maxCostMicros: 1_000_000_000_000,
  maxEvidenceCountPerCriterion: 8,
  maxGoals: 1_000,
  defaultMaxGoals: 100,
  defaultTerminalRetentionMs: 7 * 24 * 3_600_000,
} as const);

export const GOAL_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
export const GOAL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Public Goal states. `blocked` always requires a direct user decision. */
export type GoalState =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "blocked"
  | "failed"
  | "done"
  | "cancelled";

/**
 * Node states. An ordinary unmet dependency is `waiting`; `blocked` is reserved
 * for situations no automatic transition can clear.
 */
export type GoalNodeState =
  | "waiting"
  | "ready"
  | "running"
  | "retry-wait"
  | "blocked"
  | "failed"
  | "done"
  | "cancelled";

/** `unknown` means execution may have happened but cannot be proven. */
export type GoalAttemptPhase =
  | "reserved"
  | "prepared"
  | "dispatching"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type GoalEvidenceKind =
  | "worker-output"
  | "review-report"
  | "test-report"
  | "file-digest"
  | "user-attestation";

export type GoalEvidenceTrust =
  "worker-reported" | "host-verified" | "user-accepted";

export const GOAL_EVIDENCE_KINDS: readonly GoalEvidenceKind[] = Object.freeze([
  "worker-output",
  "review-report",
  "test-report",
  "file-digest",
  "user-attestation",
]);

export const GOAL_EVIDENCE_TRUST: readonly GoalEvidenceTrust[] = Object.freeze([
  "worker-reported",
  "host-verified",
  "user-accepted",
]);

export type GoalErrorCode =
  | "invalid_request"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "state_conflict"
  | "authority_denied"
  | "profile_denied"
  | "profile_changed"
  | "budget_exceeded"
  | "capacity_exceeded"
  | "metering_unavailable"
  | "workspace_failed"
  | "artifact_failed"
  | "storage_failed"
  | "lease_lost"
  | "closed";

export interface GoalError extends ModuleError<GoalErrorCode> {}
export type GoalOutcome<T> = Outcome<T, GoalError>;

export interface GoalCriterionInput {
  readonly id: string;
  readonly description: string;
  readonly acceptedEvidenceKinds: readonly GoalEvidenceKind[];
  readonly minimumEvidenceCount: number;
  readonly minimumTrust: GoalEvidenceTrust;
}

export interface GoalCriterion extends GoalCriterionInput {
  readonly acceptedEvidenceKinds: readonly GoalEvidenceKind[];
}

export interface GoalNodePolicy {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly maxOutputBytes: number;
}

/** Worst-case amounts reserved before an Attempt is dispatched. */
export interface GoalReservation {
  readonly runtimeMs: number;
  readonly tokens: number;
  readonly costMicros: number;
}

export interface GoalNodeInput {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
  readonly profileName: string;
  readonly required?: boolean;
  readonly policy?: Partial<GoalNodePolicy>;
  readonly reservation?: Partial<GoalReservation>;
  readonly criteria?: readonly GoalCriterionInput[];
}

export interface GoalNodeDefinition {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
  readonly profileName: string;
  readonly required: boolean;
  readonly policy: GoalNodePolicy;
  readonly reservation: GoalReservation;
  readonly criteria: readonly GoalCriterion[];
  readonly digest: string;
}

export interface GoalBudgetLimitsInput {
  readonly maxConcurrency: number;
  readonly maxAgentCalls: number;
  readonly maxRuntimeMs: number;
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
}

export interface GoalBudgetLimits {
  readonly maxConcurrency: number;
  readonly maxAgentCalls: number;
  readonly maxRuntimeMs: number;
  readonly maxTokens: number | null;
  readonly maxCostMicros: number | null;
}

export interface GoalBudgetAmounts {
  readonly calls: number;
  readonly runtimeMs: number;
  readonly tokens: number;
  readonly costMicros: number;
}

export interface GoalBudget {
  readonly limits: GoalBudgetLimits;
  readonly reserved: GoalBudgetAmounts;
  readonly consumed: GoalBudgetAmounts;
}

export interface GoalDefinition {
  readonly goalId: string;
  readonly objective: string;
  readonly criteria: readonly GoalCriterion[];
  readonly nodes: readonly GoalNodeDefinition[];
  readonly budget: GoalBudgetLimits;
  /** Deterministic dependency-respecting execution order. */
  readonly order: readonly string[];
  readonly revisionDigest: string;
}

export interface GoalSubmitCommand {
  readonly type: "submit";
  readonly requestId: string;
  readonly goalId: string;
  readonly objective: string;
  readonly nodes: readonly GoalNodeInput[];
  readonly budget: GoalBudgetLimitsInput;
  readonly criteria?: readonly GoalCriterionInput[];
  /** Persist as `draft` when false. Defaults to activating the graph. */
  readonly activate?: boolean;
}

/**
 * What a person decides about one node, named as the decision rather than as
 * the state it lands in.
 *
 * `skip` and `done` both finish a node, but they are not the same claim:
 * `done` asserts the work was carried out and needs attestation, while `skip`
 * asserts the work will not be carried out and waives what would have judged
 * it. `block` is the only disposition that leaves the node unfinished, and it
 * always carries the reason a person must clear.
 */
export type GoalDisposition =
  "done" | "skip" | "block" | "cancelled" | "failed";

export const GOAL_DISPOSITIONS: readonly GoalDisposition[] = Object.freeze([
  "done",
  "skip",
  "block",
  "cancelled",
  "failed",
]);

export type GoalEdit =
  | { readonly kind: "objective"; readonly objective: string }
  | {
      readonly kind: "criteria";
      readonly criteria: readonly GoalCriterionInput[];
    }
  | {
      readonly kind: "node-criteria";
      readonly nodeId: string;
      readonly criteria: readonly GoalCriterionInput[];
    }
  | {
      readonly kind: "node-task";
      readonly nodeId: string;
      readonly title?: string;
      readonly prompt?: string;
    }
  | {
      readonly kind: "node-dependencies";
      readonly nodeId: string;
      readonly dependsOn: readonly string[];
    }
  | { readonly kind: "budget"; readonly limits: GoalBudgetLimitsInput }
  | {
      readonly kind: "disposition";
      readonly nodeId: string;
      readonly disposition: GoalDisposition;
      readonly reason: string;
      readonly evidence?: GoalManualEvidenceInput;
    }
  | {
      readonly kind: "resolve-unknown";
      readonly nodeId: string;
      readonly attemptNumber: number;
      readonly resolution: "succeeded" | "failed" | "cancelled";
      readonly reason: string;
      readonly evidence?: GoalManualEvidenceInput;
    }
  | {
      readonly kind: "waive-criterion";
      readonly scope: "goal" | "node";
      readonly nodeId?: string;
      readonly criterionId: string;
      readonly reason: string;
    };

export interface GoalManualEvidenceInput {
  readonly kind: GoalEvidenceKind;
  readonly criterionId: string;
  readonly summary: string;
  readonly artifactId?: string;
}

export interface GoalResumeCommand {
  readonly type: "resume";
  readonly requestId: string;
  readonly goalId: string;
  readonly expectedRevision: number;
  readonly edits?: readonly GoalEdit[];
  /** Reset this node and its transitive dependents before activating. */
  readonly invalidateNode?: string;
  readonly reason?: string;
}

export interface GoalPauseCommand {
  readonly type: "pause";
  readonly requestId: string;
  readonly goalId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export interface GoalCancelCommand {
  readonly type: "cancel";
  readonly requestId: string;
  readonly goalId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}

export type GoalCommand =
  GoalSubmitCommand | GoalResumeCommand | GoalPauseCommand | GoalCancelCommand;

export type GoalActor = "direct-user" | "agent";

/**
 * Direct user authority is opaque, digest-bound, project/session-bound and
 * expiring. Model-authored input cannot manufacture it because the digest must
 * match the exact command the host approved.
 */
export interface GoalCommandAuthority {
  readonly actor: GoalActor;
  readonly actorId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly commandDigest: string;
  readonly token?: string;
  readonly expiresAt?: number;
}

export interface GoalEvidence {
  readonly id: string;
  readonly kind: GoalEvidenceKind;
  readonly trust: GoalEvidenceTrust;
  readonly criterionId: string;
  readonly scope: "goal" | "node";
  readonly nodeId: string | null;
  readonly attemptNumber: number | null;
  readonly definitionRevision: number;
  readonly summary: string;
  readonly artifact: GoalArtifactReference | null;
  readonly recordedAt: number;
}

export interface GoalArtifactReference {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType?: string;
}

export type GoalProfileScope = "managed" | "user" | "project";

export interface GoalProfilePin {
  readonly name: string;
  readonly contentDigest: string;
  readonly catalogGeneration: number;
  readonly source: {
    readonly scope: GoalProfileScope;
    readonly path: string;
  };
}

export interface GoalAttemptSnapshot {
  readonly number: number;
  readonly attemptKey: string;
  readonly phase: GoalAttemptPhase;
  readonly fence: number;
  readonly reservation: GoalReservation;
  readonly startedAt: number;
  readonly settledAt: number | null;
  readonly workspaceId: string | null;
  readonly certainty: "not-started" | "started" | "unknown" | null;
  /** What the budget was charged, and which figures were measured. */
  readonly usage: {
    readonly tokens: number;
    readonly authoritative: boolean;
    readonly costMicros?: number;
    readonly costAuthoritative?: boolean;
  } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface GoalNodeSnapshot {
  readonly id: string;
  readonly title: string;
  readonly state: GoalNodeState;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  readonly definitionDigest: string;
  readonly profile: GoalProfilePin | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number | null;
  readonly currentAttempt: GoalAttemptSnapshot | null;
  readonly attempts: readonly GoalAttemptSnapshot[];
  readonly evidence: readonly GoalEvidence[];
  readonly blockedReason: string | null;
  readonly lastError: {
    readonly code: string;
    readonly message: string;
  } | null;
}

export interface GoalHistoryEntry {
  readonly position: number;
  readonly type: string;
  readonly actor: GoalActor;
  readonly actorId: string;
  readonly at: number;
  readonly reason: string | null;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * What a cancellation still owes.
 *
 * Cancelling a Goal is a terminal decision the user gets immediately, but an
 * Attempt already in flight cannot be undone by a state write. The intent is
 * therefore retained with the Goal: which nodes were mid-flight, whether their
 * Attempts have been settled since, and how certain the host is about what
 * those children actually did.
 */
export interface GoalCancellationStatus {
  readonly requestedAt: number;
  /** Null until every in-flight Attempt has settled or been sealed unknown. */
  readonly reconciledAt: number | null;
  readonly unresolved: readonly string[];
  readonly certainty: "pending" | "settled" | "unknown";
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly state: GoalState;
  readonly definitionRevision: number;
  readonly runGeneration: number;
  readonly objective: string;
  readonly criteria: readonly GoalCriterion[];
  readonly budget: GoalBudget;
  readonly nodes: readonly GoalNodeSnapshot[];
  readonly evidence: readonly GoalEvidence[];
  readonly history: readonly GoalHistoryEntry[];
  readonly blockedReason: string | null;
  readonly cancellation: GoalCancellationStatus | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GoalSummary {
  readonly goalId: string;
  readonly state: GoalState;
  readonly definitionRevision: number;
  readonly runGeneration: number;
  readonly objective: string;
  readonly counts: Readonly<Record<GoalNodeState, number>>;
  readonly budget: GoalBudget;
  readonly blockedReason: string | null;
  readonly updatedAt: number;
}

export interface GoalMutationReceipt {
  readonly goal: GoalSnapshot;
  readonly replayed: boolean;
  readonly eventPosition: number;
}

export interface GoalObservationQuery {
  readonly goalId?: string;
  readonly state?: GoalState;
  readonly afterGoalId?: string;
  readonly limit?: number;
  readonly includeHistory?: boolean;
}

export interface GoalObservation {
  readonly goals: readonly GoalSummary[];
  readonly detail: GoalSnapshot | null;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

/**
 * The confirmed external seam. Claims, leases, retries, reservations, attempt
 * settlement, evidence validation, workspace disposition, and delivery are
 * implementation details behind these five methods.
 */
export interface GoalEngine {
  submit(
    command: GoalSubmitCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>>;
  resume(
    command: GoalResumeCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>>;
  pause(
    command: GoalPauseCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>>;
  cancel(
    command: GoalCancelCommand,
    authority: GoalCommandAuthority,
  ): Promise<GoalOutcome<GoalMutationReceipt>>;
  observe(query?: GoalObservationQuery): Promise<GoalOutcome<GoalObservation>>;
}
