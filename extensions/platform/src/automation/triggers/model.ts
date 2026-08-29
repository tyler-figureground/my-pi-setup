import type { JsonObject, ModuleError, Outcome } from "../../core/result.ts";

export type TriggerDurability = "ephemeral" | "restart-only";

export interface TriggerSource {
  readonly kind: string;
  readonly id: string;
  readonly generation: number;
  readonly metadata?: JsonObject;
}

export type TriggerTrust = "managed" | "user" | "trusted-project" | "untrusted";

export interface TriggerSourceBinding {
  readonly kind: string;
  readonly id: string;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly trust: TriggerTrust;
  readonly metadata?: JsonObject;
}

export interface TriggerEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: number;
  readonly provenance: {
    readonly hostId: string;
    readonly projectId: string;
    readonly sessionId?: string;
    readonly trust: TriggerTrust;
    readonly source: TriggerSource;
  };
  readonly cause: {
    readonly rootEventId: string;
    readonly parentEventId?: string;
    readonly ancestry: readonly string[];
  };
  readonly payload: JsonObject;
  readonly durability: TriggerDurability;
}

export interface TriggerBindingIdentity {
  readonly ownerId: string;
  readonly generation: number;
  readonly bindingId: string;
}

export interface TriggerPublishInput {
  readonly type: string;
  readonly payload: JsonObject;
  readonly durability?: TriggerDurability;
}

export interface TriggerSourcePublisher {
  publish(
    input: TriggerPublishInput,
  ): Promise<TriggerOutcome<TriggerPublishResult>>;
}

export interface TriggerDelivery {
  readonly binding: TriggerBindingIdentity;
  readonly events: readonly TriggerEvent[];
  readonly signal: AbortSignal;
  publish(
    input: TriggerPublishInput,
  ): Promise<TriggerOutcome<TriggerPublishResult>>;
}

export interface TriggerBinding {
  readonly id: string;
  readonly eventTypes: readonly string[];
  readonly priority?: number;
  readonly concurrency?: number;
  readonly debounceMs?: number;
  readonly batch?: {
    readonly maxCount: number;
    readonly maxWaitMs: number;
  };
  readonly coalesceBy?: string;
  readonly deadlineMs?: number;
  readonly deliver: (delivery: TriggerDelivery) => void | Promise<void>;
}

export interface TriggerOwnerReconciliation {
  readonly ownerId: string;
  readonly generation: number;
  readonly bindings: readonly TriggerBinding[];
}

export type TriggerErrorCode =
  | "CLOSED"
  | "INVALID_ARGUMENT"
  | "SOURCE_TOO_LARGE"
  | "ENVELOPE_TOO_LARGE"
  | "PAYLOAD_TOO_LARGE"
  | "PERSISTENCE_FAILED"
  | "CAPACITY_EXCEEDED"
  | "QUEUE_FULL"
  | "RECURSION_LIMIT"
  | "STALE_GENERATION";

export interface TriggerError extends ModuleError<TriggerErrorCode> {}
export type TriggerOutcome<T> = Outcome<T, TriggerError>;

export interface TriggerReconcileResult {
  readonly ownerId: string;
  readonly generation: number;
  readonly bindingCount: number;
  readonly replay: {
    readonly claimed: number;
    readonly delivered: number;
    readonly ambiguous: number;
    readonly quarantined: number;
    readonly state: "healthy" | "degraded";
  };
}

export interface TriggerDeliveryResult {
  readonly ownerId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly status:
    | "delivered"
    | "failed"
    | "timed-out"
    | "fenced"
    | "closed"
    | "superseded"
    | "acknowledged"
    | "ambiguous";
  readonly replacementEventId?: string;
}

export interface TriggerPublishResult {
  readonly event: TriggerEvent;
  readonly deliveries: readonly TriggerDeliveryResult[];
  readonly disposition: "routed" | "unrouted" | "coalesced" | "superseded";
}

export interface TriggerInspection {
  readonly state: "open" | "closed";
  readonly bindings: readonly TriggerBindingIdentity[];
  readonly queue: {
    readonly count: number;
    readonly bytes: number;
    readonly running: number;
    readonly admitting: number;
  };
  readonly counters: {
    readonly coalesced: number;
    readonly superseded: number;
    readonly dropped: number;
    readonly quarantined: number;
    readonly ambiguous: number;
    readonly unresolvedCallbacks: number;
    readonly unresolvedOperations: number;
  };
  readonly history: readonly {
    readonly sequence: number;
    readonly eventId: string;
    readonly type: string;
    readonly source: { readonly kind: string; readonly id: string };
    readonly durability: TriggerDurability;
    readonly routed: number;
    readonly outcomes: readonly TriggerDeliveryResult["status"][];
  }[];
}

export interface TriggerEngine {
  reconcile(
    input: TriggerOwnerReconciliation,
  ): Promise<TriggerOutcome<TriggerReconcileResult>>;
  publish(
    source: TriggerSourcePublisher,
    input: TriggerPublishInput,
  ): Promise<TriggerOutcome<TriggerPublishResult>>;
  inspect(): TriggerInspection;
}

export interface TriggerClock {
  now(): number;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export interface TriggerEngineOptions {
  readonly hostId: string;
  readonly clock?: TriggerClock;
  readonly createEventId?: () => string;
  readonly maxPayloadBytes?: number;
  readonly maxSourceBytes?: number;
  readonly maxEnvelopeBytes?: number;
  readonly maxDataNodes?: number;
  readonly maxQueueCount?: number;
  readonly maxQueueBytes?: number;
  readonly maxActiveConsumers?: number;
  readonly maxBindings?: number;
  readonly maxPendingPerBinding?: number;
  readonly maxRootFanout?: number;
  readonly maxRootFirings?: number;
  readonly persistence?: import("./persistence.ts").TriggerPersistencePort;
  readonly maxInspectionEntries?: number;
  readonly maxInspectionBytes?: number;
  readonly maxCausalDepth?: number;
  readonly closeDrainMs?: number;
  readonly maxPersistencePages?: number;
}

export interface TriggerEngineRuntime {
  readonly engine: TriggerEngine;
  bindSource(
    input: TriggerSourceBinding,
  ): TriggerOutcome<TriggerSourcePublisher>;
  close(reason?: string): Promise<void>;
}
