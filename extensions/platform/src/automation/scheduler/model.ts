export interface OneShotScheduleInput {
  readonly kind: "one-shot";
  readonly at: string;
}

export interface OneShotSchedule {
  readonly kind: "one-shot";
  readonly at: string;
}

export interface IntervalScheduleInput {
  readonly kind: "interval";
  readonly anchor: string;
  readonly everyMs: number;
}

export interface IntervalSchedule {
  readonly kind: "interval";
  readonly anchor: string;
  readonly everyMs: number;
}

export interface CronScheduleInput {
  readonly kind: "cron";
  readonly expression: string;
  readonly timeZone: string;
}

export interface CronSchedule {
  readonly kind: "cron";
  readonly expression: string;
  readonly timeZone: string;
}

export type ScheduleInput =
  OneShotScheduleInput | IntervalScheduleInput | CronScheduleInput;
export type Schedule = OneShotSchedule | IntervalSchedule | CronSchedule;

export interface CalendarSearchOptions {
  readonly horizonMs?: number;
  readonly candidateLimit?: number;
}

export type MissedRunPolicy = "skip" | "run-once";

import type { ArtifactStore } from "../../core/artifacts/model.ts";
import type { StateStore } from "../../core/persistence/state-store.ts";
import type { ResolvedProjectIdentity } from "../../core/projects/index.ts";
import type { ModuleError, Outcome } from "../../core/result.ts";
import type { PlatformSchedulerConfiguration } from "./config.ts";
import type {
  ProfileCatalog,
  ResolvedAgentProfile,
} from "../../profiles/index.ts";
import type { ProjectIdentity } from "../../core/projects/index.ts";
import type { ScheduledAgentExecutor } from "../../../../shared/scheduled-agent.ts";
import type { PlatformHookEventProducer } from "../platform-hook-event-sink.ts";

export type ScheduleScope = "session" | "durable";
export type ScheduleState = "active" | "paused" | "blocked" | "deleted";
export type ScheduleOccurrenceState =
  "claimed" | "running" | "retry-wait" | "completed" | "failed" | "unknown";

export interface ScheduleResultRoute {
  readonly kind: "session";
  readonly sessionId: string;
}

export interface ScheduleHostBinding {
  readonly project: ResolvedProjectIdentity;
  readonly cwd: string;
  readonly creatorSessionId: string;
  readonly resultRoute: ScheduleResultRoute;
}

export interface StoredScheduleBinding {
  readonly projectId: string;
  readonly cwd: string;
  readonly creatorSessionId: string;
  readonly resultRoute: ScheduleResultRoute;
  readonly executionRole: "scheduled";
}

export interface PinnedScheduleProfile {
  readonly name: string;
  readonly contentDigest: string;
  readonly source: ResolvedAgentProfile["identity"]["source"];
}

export interface SchedulePromptArtifact {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType?: string;
}

export interface SchedulePolicy {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxOutputBytes: number;
}

export interface ScheduleOccurrenceSnapshot {
  readonly id: string;
  readonly kind: "regular" | "run-now";
  readonly dueAt: string;
  readonly state: ScheduleOccurrenceState;
  readonly attempt: number;
  readonly claimedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly resultArtifact?: SchedulePromptArtifact;
  readonly delivered?: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ScheduleSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly scope: ScheduleScope;
  readonly state: ScheduleState;
  readonly schedule: Schedule;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly nextAt: string | null;
  readonly binding: StoredScheduleBinding;
  readonly profile: PinnedScheduleProfile;
  readonly promptArtifact: SchedulePromptArtifact;
  readonly policy: SchedulePolicy;
  readonly credentialReferenceCount: number;
  readonly currentOccurrence: ScheduleOccurrenceSnapshot | null;
  readonly recentOccurrences: readonly ScheduleOccurrenceSnapshot[];
  readonly blockedReason?: string;
}

export interface ScheduleDefinitionInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly scope: ScheduleScope;
  readonly schedule: ScheduleInput;
  readonly missedRunPolicy: MissedRunPolicy;
  readonly profileName: string;
  readonly prompt: string;
  readonly credentialReferences?: readonly string[];
  readonly policy?: Partial<SchedulePolicy>;
}

export type ScheduleCommand =
  | ({
      readonly type: "create";
      readonly requestId: string;
    } & ScheduleDefinitionInput)
  | ({
      readonly type: "replace";
      readonly requestId: string;
    } & ScheduleDefinitionInput)
  | {
      readonly type: "pause" | "resume" | "run-now" | "delete";
      readonly requestId: string;
      readonly id: string;
      readonly expectedRevision: number;
    };

export interface ScheduleQuery {
  readonly id?: string;
  readonly state?: ScheduleState;
  readonly includeHistory?: boolean;
  readonly afterId?: string;
  readonly limit?: number;
}

export interface ScheduleInspection {
  readonly schedules: readonly ScheduleSnapshot[];
  readonly nextCursor?: string;
  readonly closed: boolean;
}

export interface ScheduleChangeReceipt {
  readonly schedule: ScheduleSnapshot;
  readonly replayed: boolean;
  readonly cancellation?: {
    readonly state: "acknowledged" | "unknown";
  };
}

export type ScheduleErrorCode =
  | "invalid_request"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "capacity_exceeded"
  | "authority_denied"
  | "profile_changed"
  | "artifact_failed"
  | "storage_failed"
  | "lease_lost"
  | "closed";

export interface ScheduleError extends ModuleError<ScheduleErrorCode> {}
export type ScheduleOutcome<T> = Outcome<T, ScheduleError>;

export interface HostAuthorityError extends ModuleError<
  "project_denied" | "trust_denied" | "profile_denied" | "credential_denied"
> {}

export interface HostAuthorityRequest {
  readonly projectId: string;
  readonly cwd: string;
  readonly profileName: string;
  readonly expectedProfile?: PinnedScheduleProfile;
  readonly credentialReferences: readonly string[];
}

export interface HostAuthority {
  authorize(
    request: HostAuthorityRequest,
    signal?: AbortSignal,
  ): Promise<
    Outcome<
      {
        readonly project: ResolvedProjectIdentity;
        readonly projectTrusted: boolean;
        readonly profile: ResolvedAgentProfile;
      },
      HostAuthorityError
    >
  >;
}

export interface ResultDeliveryRequest {
  readonly deliveryId: string;
  readonly generation: number;
  readonly route: ScheduleResultRoute;
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly artifact: SchedulePromptArtifact;
}

export interface ResultDeliveryError extends ModuleError<"delivery_failed"> {}
export interface ResultDelivery {
  deliver(
    request: ResultDeliveryRequest,
    signal: AbortSignal,
  ): Promise<
    Outcome<{ readonly state: "delivered" | "offline" }, ResultDeliveryError>
  >;
}

export interface SchedulerClock {
  now(): number;
  arm(at: number, wake: () => void): () => void;
}

export interface Scheduler {
  change(
    command: ScheduleCommand,
  ): Promise<ScheduleOutcome<ScheduleChangeReceipt>>;
  inspect(query?: ScheduleQuery): Promise<ScheduleOutcome<ScheduleInspection>>;
}

export interface SchedulerRuntime {
  readonly scheduler: Scheduler;
  close(): Promise<void>;
}

export interface SchedulerOptions {
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly clock: SchedulerClock;
  readonly authority: HostAuthority;
  readonly executor: ScheduledAgentExecutor;
  readonly delivery: ResultDelivery;
  readonly hookEvents?: PlatformHookEventProducer;
  readonly ownerId: string;
  readonly binding: ScheduleHostBinding;
  readonly configuration?: Partial<PlatformSchedulerConfiguration>;
  readonly retention?: {
    readonly maxOccurrences?: number;
    readonly maxInspection?: number;
    readonly maxRequestReceipts?: number;
  };
}

export interface SchedulerHostAuthorityOptions {
  readonly projects: ProjectIdentity;
  readonly profiles: ProfileCatalog;
  readonly projectTrusted: (
    project: ResolvedProjectIdentity,
  ) => boolean | Promise<boolean>;
  readonly credentialsAvailable: (
    references: readonly string[],
  ) => boolean | Promise<boolean>;
}
