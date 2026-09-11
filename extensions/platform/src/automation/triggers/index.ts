/**
 * TriggerEngine barrel: the one Parent-owned automation bus that admits,
 * routes, and fences every Trigger Event (ADR-0009). `src/composition.ts`
 * builds the runtime; MonitorRegistry and the Hooks wiring
 * (`src/wiring/hooks.ts`) attach to it, but the Scheduler does not.
 *
 * Exports only the engine factory, the in-memory persistence port, and
 * types. The production StateStore port (`state-store-persistence.ts`) and
 * its record authenticator (`record-authentication.ts`) are imported
 * directly by `src/composition.ts`.
 * See: docs/adr/0009-unify-automation-through-trigger-engine.md,
 * docs/architecture/phase-7-automation.md (TriggerEngine)
 */

export { createTriggerEngine } from "./engine.ts";
export { createMemoryTriggerPersistence } from "./persistence.ts";
export type {
  TriggerDurableRecord,
  TriggerPersistenceError,
  TriggerPersistenceErrorCode,
  TriggerPersistenceOutcome,
  TriggerPersistencePort,
  TriggerPersistenceAttemptDisposition,
  TriggerPersistenceAttemptRequest,
  TriggerPersistenceClaim,
  TriggerPersistenceClaimPage,
  TriggerPersistenceClaimPageRequest,
  TriggerPersistenceClaimRequest,
  TriggerPersistenceCompleteRequest,
  TriggerPersistenceQuarantineRequest,
  TriggerPersistenceStoreRequest,
} from "./persistence.ts";
export type {
  TriggerBinding,
  TriggerBindingIdentity,
  TriggerClock,
  TriggerDelivery,
  TriggerDeliveryResult,
  TriggerDurability,
  TriggerEngine,
  TriggerEngineOptions,
  TriggerEngineRuntime,
  TriggerError,
  TriggerErrorCode,
  TriggerEvent,
  TriggerInspection,
  TriggerOutcome,
  TriggerOwnerReconciliation,
  TriggerPublishInput,
  TriggerPublishResult,
  TriggerReconcileResult,
  TriggerSource,
  TriggerSourceBinding,
  TriggerSourcePublisher,
  TriggerTrust,
} from "./model.ts";
