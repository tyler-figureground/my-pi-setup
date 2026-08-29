import type {
  ArtifactMetadata,
  ArtifactStore,
} from "../../core/artifacts/model.ts";
import type { ReleasableLifecycleSupervisor } from "../../core/lifecycle/supervisor.ts";
import type { JsonObject, ModuleError, Outcome } from "../../core/result.ts";
import type { TriggerEngineRuntime } from "../triggers/model.ts";
import type { PlatformMonitorConfiguration } from "./config.ts";
import type { StateStore } from "../../core/persistence/state-store.ts";

export type MonitorScope = "session" | "durable";
export type MonitorState =
  "active" | "paused" | "stopped" | "blocked" | "deleted";

export interface TerminalMonitorSource {
  readonly kind: "terminal";
  readonly terminalId: string;
  readonly framing?: "line" | "chunk";
}

export interface FileMonitorSource {
  readonly kind: "file";
  readonly root: string;
  readonly recursive?: boolean;
}

export interface PollMonitorSource {
  readonly kind: "poll";
  readonly adapter: string;
  readonly intervalMs: number;
  readonly input?: JsonObject;
  readonly credentialReference?: string;
}

export interface WebSocketMonitorSource {
  readonly kind: "websocket";
  readonly url: string;
  readonly credentialReference?: string;
}

export type MonitorSource =
  | TerminalMonitorSource
  | FileMonitorSource
  | PollMonitorSource
  | WebSocketMonitorSource;

export type MonitorMatcher =
  | {
      readonly kind: "literal";
      readonly value: string;
      readonly field?: string;
    }
  | {
      readonly kind: "field";
      readonly field: string;
      readonly equals: string | number | boolean | null;
    };

export interface MonitorResultRoute {
  readonly kind: "session";
  readonly sessionId: string;
}

export interface MonitorDefinition {
  readonly id: string;
  readonly revision: number;
  readonly scope: MonitorScope;
  readonly state: MonitorState;
  readonly source: MonitorSource;
  readonly matcher?: MonitorMatcher;
  readonly delivery: MonitorResultRoute;
  readonly blockedReason?: string;
}

export interface MonitorSnapshot extends MonitorDefinition {
  readonly deliveries: number;
  readonly dropped: number;
  readonly unresolved: number;
  readonly lastEventAt?: number;
  readonly lastError?: string;
}

export interface MonitorSourceEvent {
  readonly type: string;
  readonly payload: JsonObject;
  readonly occurredAt?: number;
  readonly causedByMonitorId?: string;
}

export interface MonitorSourceLease {
  close(): void | Promise<void>;
}

export interface MonitorSourceFactory {
  open(
    definition: MonitorDefinition,
    emit: (event: MonitorSourceEvent) => void,
    signal: AbortSignal,
  ): Promise<MonitorSourceLease>;
}

export interface MonitorDeliveryRequest {
  readonly deliveryId: string;
  readonly route: MonitorResultRoute;
  readonly monitorId: string;
  readonly revision: number;
  readonly summary: string;
  readonly evidence: ArtifactMetadata;
  readonly trust: "untrusted";
  readonly authority: "none";
}

export interface MonitorDelivery {
  deliver(
    request: MonitorDeliveryRequest,
    signal?: AbortSignal,
  ): Promise<
    Outcome<
      { readonly state: "delivered" | "offline" },
      ModuleError<"delivery_failed">
    >
  >;
}

export interface MonitorAuthority {
  authorize(request: {
    readonly definition: MonitorDefinition;
    readonly phase: "create" | "replace" | "resume" | "restore";
    readonly projectId: string;
    readonly cwd: string;
  }): Promise<
    Outcome<{ readonly allowed: true }, ModuleError<"authority_denied">>
  >;
}

interface MonitorDefinitionInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly scope: MonitorScope;
  readonly source: MonitorSource;
  readonly matcher?: MonitorMatcher;
  readonly delivery: MonitorResultRoute;
}

export type MonitorCommand =
  | ({
      readonly type: "create" | "replace";
      readonly requestId: string;
    } & MonitorDefinitionInput)
  | {
      readonly type: "pause" | "resume" | "stop" | "delete";
      readonly requestId: string;
      readonly id: string;
      readonly expectedRevision: number;
    };

export interface MonitorChangeReceipt {
  readonly monitor: MonitorSnapshot;
  readonly replayed: boolean;
}

export interface MonitorQuery {
  readonly id?: string;
  readonly state?: MonitorState;
  readonly afterId?: string;
  readonly limit?: number;
}

export interface MonitorInspection {
  readonly monitors: readonly MonitorSnapshot[];
  readonly closed: boolean;
  readonly nextCursor?: string;
}

export type MonitorErrorCode =
  | "invalid_request"
  | "not_found"
  | "already_exists"
  | "revision_conflict"
  | "capacity_exceeded"
  | "authority_denied"
  | "source_failed"
  | "storage_failed"
  | "closed";

export interface MonitorError extends ModuleError<MonitorErrorCode> {}
export type MonitorOutcome<T> = Outcome<T, MonitorError>;

export interface MonitorRegistry {
  change(
    command: MonitorCommand,
  ): Promise<MonitorOutcome<MonitorChangeReceipt>>;
  inspect(query?: MonitorQuery): Promise<MonitorOutcome<MonitorInspection>>;
}

export interface MonitorRegistryOptions {
  readonly ownerId: string;
  readonly binding: {
    readonly projectId: string;
    readonly cwd: string;
    readonly sessionId: string;
  };
  readonly triggers: TriggerEngineRuntime;
  readonly lifecycle: ReleasableLifecycleSupervisor;
  readonly artifacts: ArtifactStore;
  readonly sources: MonitorSourceFactory;
  readonly delivery: MonitorDelivery;
  readonly authority: MonitorAuthority;
  readonly state?: StateStore;
  readonly configuration?: PlatformMonitorConfiguration;
  readonly limits?: {
    readonly maxActive?: number;
    readonly maxInspection?: number;
    readonly batchWindowMs?: number;
    readonly maxBatchCount?: number;
    readonly maxEvidenceBytes?: number;
    readonly pollMinimumMs?: number;
    readonly maxReceipts?: number;
    readonly callbackDrainMs?: number;
    readonly closeDrainMs?: number;
  };
}

export interface MonitorCloseReport {
  readonly dropped: number;
  readonly unresolvedCallbacks: number;
  readonly unresolvedSources: number;
}

export interface MonitorRegistryRuntime {
  readonly registry: MonitorRegistry;
  close(): Promise<MonitorCloseReport>;
}

export type MonitorOpenOutcome = Outcome<
  MonitorRegistryRuntime,
  ModuleError<"invalid_options" | "trigger_failed" | "storage_failed">
>;
