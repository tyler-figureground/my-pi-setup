import type { GoalMeteringCapabilities } from "./budget.ts";
import type {
  GoalArtifactReference,
  GoalEvidenceKind,
  GoalOutcome,
  GoalProfilePin,
  GoalProfileScope,
  GoalState,
} from "./model.ts";
import type { GoalExecutionCertainty } from "./scheduling.ts";

/**
 * Injected seams.
 *
 * Every port is plain data in and plain data out: no shared mutable objects, no
 * host handles, and no model-facing authority. That keeps the engine testable
 * with fakes and keeps privileged subsystems (Agent Supervisor, workspaces,
 * review, delivery) outside the Goal domain.
 */

export interface GoalClock {
  now(): number;
  /** Schedule one wake-up. The returned function cancels it. */
  arm(at: number, wake: () => void): () => void;
}

export interface GoalExecutorRequest {
  /** Durable idempotency key owned by the Goal Attempt. */
  readonly attemptKey: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly projectId: string;
  /** Immutable pin. The executor resolves its own profile material. */
  readonly profile: GoalProfilePin;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxTokens?: number;
  readonly maxCostMicros?: number;
}

export interface GoalExecutorArtifact {
  readonly body: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly metadata: {
    readonly kind: string;
    readonly attemptKey: string;
    readonly trust: string;
  };
}

export interface GoalExecutorUsage {
  readonly tokens: number;
  readonly costMicros?: number;
  readonly authoritative: boolean;
  readonly source?: string;
}

export interface GoalExecutorCompletion {
  readonly status: "completed";
  readonly artifact: GoalExecutorArtifact;
  readonly execution: {
    readonly attemptKey: string;
    readonly childId: string;
    readonly certainty: "started";
  };
  readonly usage?: GoalExecutorUsage;
  readonly sessionId?: string;
  readonly workspaceId?: string;
}

export interface GoalExecutorFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly certainty: GoalExecutionCertainty;
  readonly childId?: string;
  readonly workspaceId?: string;
  readonly usage?: GoalExecutorUsage;
}

export type GoalExecutorOutcome =
  | { readonly ok: true; readonly value: GoalExecutorCompletion }
  | { readonly ok: false; readonly error: GoalExecutorFailure };

export type GoalExecutorInspection =
  | {
      readonly attemptKey: string;
      readonly state: "not-started";
      readonly certainty: "not-started";
    }
  | {
      readonly attemptKey: string;
      readonly state: "running";
      readonly certainty: "started";
      readonly childId?: string;
      readonly workspaceId?: string;
    }
  | {
      readonly attemptKey: string;
      readonly state: "settled";
      readonly certainty: GoalExecutionCertainty;
      readonly outcome: GoalExecutorOutcome;
    }
  | {
      readonly attemptKey: string;
      readonly state: "unknown";
      readonly certainty: "unknown";
    };

/**
 * Host-only execution seam for one fully bound Goal Attempt.
 *
 * `inspect` exists so recovery can ask what happened instead of guessing. An
 * executor that cannot answer leaves the Attempt ambiguous, and the engine
 * blocks rather than dispatching a second child.
 */
export interface GoalExecutorPort {
  /** Declared metering. Absent metering refuses token and cost limits. */
  readonly metering?: GoalMeteringCapabilities;
  /**
   * Who creates and disposes a Guarded Workspace for an isolated Agent
   * Profile. Exactly one owner exists per deployment: the default `host` uses
   * `GoalWorkspacePort`, while `executor` means the execution seam already
   * holds the workspace lease for the Attempt and reports its identifier back.
   */
  readonly workspaceOwnership?: "host" | "executor";
  run(
    request: GoalExecutorRequest,
    signal?: AbortSignal,
  ): Promise<GoalExecutorOutcome>;
  inspect(attemptKey: string): Promise<GoalExecutorInspection>;
}

export interface GoalProfileResolution {
  readonly name: string;
  readonly contentDigest: string;
  readonly catalogGeneration: number;
  readonly source: { readonly scope: GoalProfileScope; readonly path: string };
  /** Execution Role. Goal Attempts require `goal-worker`. */
  readonly role: string;
  readonly workspacePolicy: "inherit" | "isolated";
}

export interface GoalProfilePort {
  resolve(name: string): Promise<GoalOutcome<GoalProfileResolution>>;
}

export interface GoalWorkspaceRequest {
  readonly goalId: string;
  readonly nodeId: string;
  readonly attemptKey: string;
  readonly projectId: string;
  readonly fence: number;
}

export interface GoalWorkspaceBinding {
  readonly workspaceId: string;
  readonly cwd: string;
}

export type GoalWorkspaceOutcomeKind =
  "succeeded" | "failed" | "cancelled" | "unknown";

export interface GoalWorkspaceDisposal {
  readonly workspaceId: string;
  readonly goalId: string;
  readonly nodeId: string;
  readonly attemptKey: string;
  readonly outcome: GoalWorkspaceOutcomeKind;
  /** Ambiguity and failure preserve the workspace for inspection. */
  readonly preserve: boolean;
}

export interface GoalWorkspacePort {
  prepare(
    request: GoalWorkspaceRequest,
  ): Promise<GoalOutcome<GoalWorkspaceBinding>>;
  dispose(
    request: GoalWorkspaceDisposal,
  ): Promise<GoalOutcome<{ readonly disposition: string }>>;
}

export interface GoalReviewRequest {
  readonly goalId: string;
  readonly nodeId: string;
  readonly attemptKey: string;
  readonly criterionId: string;
  readonly acceptedEvidenceKinds: readonly GoalEvidenceKind[];
  readonly artifact: GoalArtifactReference | null;
  readonly cwd: string;
  /** Guarded Workspace the Attempt ran in, whoever owns its lifecycle. */
  readonly workspaceId: string | null;
}

export interface GoalReviewVerdict {
  readonly satisfied: boolean;
  readonly kind: GoalEvidenceKind;
  readonly summary: string;
  readonly artifact?: GoalArtifactReference | null;
}

/** Host-verified evidence. The worker cannot produce this trust level itself. */
export interface GoalReviewPort {
  verify(request: GoalReviewRequest): Promise<GoalOutcome<GoalReviewVerdict>>;
}

export interface GoalDeliveryRequest {
  readonly deliveryId: string;
  readonly goalId: string;
  readonly state: GoalState;
  readonly summary: string;
  readonly runGeneration: number;
}

export interface GoalDeliveryPort {
  deliver(
    request: GoalDeliveryRequest,
  ): Promise<GoalOutcome<{ readonly state: "delivered" | "offline" }>>;
}

export interface GoalHostBinding {
  readonly projectId: string;
  readonly cwd: string;
  readonly sessionId: string;
}
