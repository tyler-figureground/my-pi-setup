/**
 * Declarative Hooks barrel, imported by `src/composition.ts` and
 * `src/wiring/hooks.ts`. The production runtime is `createHooks`
 * (`phase7.ts`); `createTriggerEngine` here is the legacy Phase 2 hook core
 * (`engine.ts`), not the Phase 7 bus in `src/automation/triggers/`.
 *
 * Where to look: event names and shapes in `model.ts`; YAML loading in
 * `config.ts`; load-time rules and redaction in `validation.ts`; host-named
 * integrations in `configuration.ts` and `adapters.ts`; the no-shell
 * command runner in `process.ts`.
 * See: docs/migrations/phase-7-declarative-hooks.md,
 * docs/adr/0003-build-declarative-hook-core.md
 */

export { createTriggerEngine } from "./engine.ts";
export {
  decodeHookActionConfiguration,
  defaultPlatformHookActionConfiguration,
} from "./configuration.ts";
export type { PlatformHookActionConfiguration } from "./configuration.ts";
export {
  createNamedHookAgentAdapter,
  createNamedHookHttpAdapter,
  createNamedHookMcpAdapter,
} from "./adapters.ts";
export type {
  NamedHookAgentAdapterOptions,
  NamedHookHttpAdapterOptions,
  NamedHookHttpDefinition,
  NamedHookMcpAdapterOptions,
  NamedHookMcpDefinition,
  NamedProfileExecutionPort,
} from "./adapters.ts";
export { createHooks } from "./phase7.ts";
export {
  declarativeHookEvents,
  hookEvents,
  nativeHookEvents,
  platformHookEvents,
} from "./model.ts";
export { createHookProcessRunner } from "./process.ts";
export type {
  HookProcessRequest,
  HookProcessResult,
  HookProcessRunner,
} from "./process.ts";
export type {
  AgentAction,
  CommandAction,
  ContextAction,
  DeclarativeHookAction,
  DispatchResult,
  FailurePolicy,
  HookAction,
  HookConfigSource,
  HookDefinition,
  HookDiagnostic,
  HookEffect,
  HookEvent,
  HookEventEnvelope,
  HookInspection,
  HookLogEntry,
  HookMode,
  HookProvenance,
  HookRegistration,
  HookScope,
  HttpAction,
  MatcherValue,
  McpAction,
  NotifyAction,
  PlainData,
  PolicyAction,
  RegistrationResult,
  ReloadResult,
  StatusAction,
  TriggerEngine,
  TriggerEngineOptions,
  ValidationResult,
} from "./model.ts";
export type {
  HookAdapterResult,
  HookAgentAdapter,
  HookConfigurationCommand,
  HookConfigurationResult,
  HookError,
  HookHistoryEntry,
  HookHttpAdapter,
  HookHttpAdapterRequest,
  HookHttpAuthorityRequest,
  HookInvocation,
  HookMcpAdapter,
  HookNamedAdapterRequest,
  HookOutcome,
  HookQuery,
  HookResponse,
  Hooks,
  HooksOptions,
  HookTrustAdapter,
  HookUiAdapter,
} from "./phase7.ts";
