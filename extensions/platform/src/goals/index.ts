/**
 * Goal Mode barrel: `src/composition.ts` and `src/wiring/goals.ts` import
 * through here (config decoding also comes straight from `config.ts`).
 *
 * Where to change what:
 * - types, states, `GOAL_LIMITS`: `model.ts`; legal moves: `transitions.ts`
 * - submission and graph checks: `validation.ts`; resume edits: `edits.ts`
 * - dispatch, retry, and crash-recovery choices: `scheduling.ts`
 * - reservation/settlement math: `budget.ts`; criterion gate: `evidence.ts`
 * - direct user authority: `authority.ts`; canonical hashing: `digest.ts`
 * - claim protocol, leases, commands, recovery: `engine.ts`
 * - State Record layout: `persistence.ts`; injected seams: `ports.ts`
 * - production port adapters: `host.ts`, `delivery.ts`; host caps: `config.ts`
 * Files listed before `engine.ts` do no I/O. Commands and tools that drive the
 * engine live in `src/wiring/goals.ts`.
 * See: docs/architecture/phase-8-goal-mode.md, docs/phase-8-configuration.md
 */

export {
  GOAL_DISPOSITIONS,
  GOAL_EVIDENCE_KINDS,
  GOAL_EVIDENCE_TRUST,
  GOAL_IDENTIFIER,
  GOAL_LIMITS,
} from "./model.ts";
export type {
  GoalActor,
  GoalArtifactReference,
  GoalAttemptPhase,
  GoalAttemptSnapshot,
  GoalBudget,
  GoalBudgetAmounts,
  GoalBudgetLimits,
  GoalBudgetLimitsInput,
  GoalCancelCommand,
  GoalCancellationStatus,
  GoalCommand,
  GoalCommandAuthority,
  GoalCriterion,
  GoalCriterionInput,
  GoalDefinition,
  GoalDisposition,
  GoalEdit,
  GoalEngine,
  GoalError,
  GoalErrorCode,
  GoalEvidence,
  GoalEvidenceKind,
  GoalEvidenceTrust,
  GoalHistoryEntry,
  GoalManualEvidenceInput,
  GoalMutationReceipt,
  GoalNodeDefinition,
  GoalNodeInput,
  GoalNodePolicy,
  GoalNodeSnapshot,
  GoalNodeState,
  GoalObservation,
  GoalObservationQuery,
  GoalOutcome,
  GoalPauseCommand,
  GoalProfilePin,
  GoalReservation,
  GoalResumeCommand,
  GoalSnapshot,
  GoalState,
  GoalSubmitCommand,
  GoalSummary,
} from "./model.ts";
export {
  goalInvalid,
  topologicalOrder,
  validateBudget,
  validateCriteria,
  validateGoalGraph,
  validateGoalSubmission,
} from "./validation.ts";
export { canonicalize, digestOf, digestOfText } from "./digest.ts";
export {
  GOAL_ATTEMPT_PHASES,
  GOAL_ATTEMPT_TRANSITIONS,
  GOAL_NODE_STATES,
  GOAL_NODE_TRANSITIONS,
  GOAL_STATES,
  GOAL_TRANSITIONS,
  attemptResolutionAllowed,
  attemptTransitionAllowed,
  deriveGoalState,
  dispositionNodeState,
  goalTransitionAllowed,
  nodeTransitionAllowed,
  resetNodeState,
} from "./transitions.ts";
export type { GoalStateInputs } from "./transitions.ts";
export {
  budgetRemaining,
  chargeForAttempt,
  initialBudget,
  reserveAttempt,
  settleAttempt,
  validateBudgetMetering,
} from "./budget.ts";
export type {
  GoalAttemptCharge,
  GoalAttemptSettlement,
  GoalMeteringCapabilities,
  GoalUsage,
} from "./budget.ts";
export {
  appendEvidence,
  createEvidence,
  evaluateCriteria,
  evidenceId,
  evidenceTrustRank,
} from "./evidence.ts";
export type {
  GoalCriteriaEvaluation,
  GoalCriterionGap,
  GoalEvidenceDraft,
} from "./evidence.ts";
export {
  planSchedule,
  recoveryDecision,
  retryDecision,
  retryDelayFor,
} from "./scheduling.ts";
export type {
  GoalExecutionCertainty,
  GoalRecoveryInspection,
  GoalRetryInputs,
  GoalSchedulableNode,
  GoalSchedulePlan,
  GoalScheduleOptions,
} from "./scheduling.ts";
export {
  GOAL_AUTHORITY_TOKEN_MAX_LENGTH,
  goalCommandDigest,
  verifyGoalAuthority,
} from "./authority.ts";
export type {
  GoalAuthorityContext,
  GoalAuthorityVerification,
  GoalAuthorityVerifier,
} from "./authority.ts";
export { createGoalRuntime } from "./engine.ts";
export type { GoalRuntime, GoalRuntimeOptions } from "./engine.ts";
export { createGoalPersistence, stateErrorToGoalError } from "./persistence.ts";
export type {
  GoalPersistence,
  StoredGoalAttempt,
  StoredGoalDelivery,
  StoredGoalHead,
  StoredGoalNode,
  StoredGoalRequest,
} from "./persistence.ts";
export type {
  GoalClock,
  GoalDeliveryPort,
  GoalDeliveryRequest,
  GoalExecutorArtifact,
  GoalExecutorCompletion,
  GoalExecutorFailure,
  GoalExecutorInspection,
  GoalExecutorOutcome,
  GoalExecutorPort,
  GoalExecutorRequest,
  GoalExecutorUsage,
  GoalHostBinding,
  GoalProfilePort,
  GoalProfileResolution,
  GoalReviewPort,
  GoalReviewRequest,
  GoalReviewVerdict,
  GoalWorkspaceBinding,
  GoalWorkspaceDisposal,
  GoalWorkspacePort,
  GoalWorkspaceRequest,
} from "./ports.ts";
export { applyGoalEdits, transitiveDependents } from "./edits.ts";
export type { GoalEditEvent, GoalEditInputs, GoalEditResult } from "./edits.ts";
export {
  decodeGoalConfiguration,
  defaultPlatformGoalConfiguration,
} from "./config.ts";
export type { PlatformGoalConfiguration } from "./config.ts";
export { createSessionBrokerGoalDelivery } from "./delivery.ts";
export {
  createGoalWorkerExecutorPort,
  createLocalReviewGoalReview,
  createProfileCatalogGoalProfiles,
  createSystemGoalClock,
} from "./host.ts";
export type { GoalProfilePortOptions, GoalReviewPortOptions } from "./host.ts";
