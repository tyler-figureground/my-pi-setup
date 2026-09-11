/**
 * TriggerEngine domain model: Trigger Event, Trigger Binding, source
 * binding, result and inspection shapes, and the engine interfaces. Types
 * only; `engine.ts` implements them.
 *
 * Callers never supply provenance. A publisher from
 * `TriggerEngineRuntime.bindSource` carries host-resolved Project Identity,
 * session, and trust; `TriggerPublishInput` is only type, payload, and
 * durability, and the engine stamps id, time, source, and causal ancestry.
 * Payloads are data, never authority. Unrelated to the Phase 2 hook-core
 * `TriggerEngine` interface in `src/automation/hooks/model.ts`.
 * See: docs/architecture/phase-7-automation.md (TriggerEngine)
 */

import type { JsonObject, ModuleError, Outcome } from "../../core/result.ts";

/**
 * `restart-only` events are stored through `TriggerPersistencePort` and
 * replayed to an owner's bindings on its first reconcile after a restart;
 * `ephemeral` events stay in memory and may be coalesced.
 */
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

/**
 * Capability handle returned by `bindSource`. Rebinding the same source kind
 * and id, or `revokeSource`, invalidates it.
 */
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
  /**
   * A returned plain JSON object (at most 64 KiB) becomes the delivery's
   * `output`; any other non-undefined value marks it `failed`. `signal`
   * aborts on deadline, generation retirement, and engine close.
   */
  readonly deliver: (
    delivery: TriggerDelivery,
  ) => JsonObject | void | Promise<JsonObject | void>;
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
  readonly output?: JsonObject;
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
  /**
   * Replaces every binding of `ownerId`. `generation` must strictly
   * increase; the prior generation's queued and running deliveries settle
   * as `fenced`. An empty `bindings` list detaches the owner.
   */
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
  readonly maxSources?: number;
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
  revokeSource(source: TriggerSourcePublisher): TriggerOutcome<void>;
  close(reason?: string): Promise<void>;
}
