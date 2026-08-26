export const hookEvents = [
  "resources_discover",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_before_tree",
  "session_tree",
  "session_shutdown",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  "context",
  "before_provider_request",
  "after_provider_response",
  "model_select",
  "thinking_level_select",
  "tool_execution_start",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "user_bash",
  "input",
] as const;

export type HookEvent = (typeof hookEvents)[number];
export type HookMode = "normal" | "plan";
export type FailurePolicy = "open" | "closed";
export type HookScope = "global" | "project" | "runtime";
export type PlainScalar = string | number | boolean | null;
export type PlainData =
  PlainScalar | readonly PlainData[] | { readonly [key: string]: PlainData };

export interface HookProvenance {
  readonly scope: HookScope;
  readonly source: string;
  readonly trusted: boolean;
  readonly documentIndex?: number;
  readonly hookIndex?: number;
}

export type MatcherValue =
  | PlainScalar
  | {
      readonly equals?: PlainScalar;
      readonly contains?: string;
      readonly startsWith?: string;
      readonly endsWith?: string;
      readonly exists?: boolean;
    };

export interface CommandAction {
  readonly type: "command";
  readonly executable: string;
  readonly args: readonly string[];
}

export interface NotifyAction {
  readonly type: "notify";
  readonly message: string;
  readonly level: "info" | "warning" | "error";
}

export interface StatusAction {
  readonly type: "status";
  readonly key: string;
  readonly text: string | null;
}

export interface ContextAction {
  readonly type: "context";
  readonly content: string;
}

export interface PolicyAction {
  readonly type: "policy";
  readonly decision: "allow" | "deny" | "require-user-confirmation";
  readonly reason: string;
}

export type HookAction =
  CommandAction | NotifyAction | StatusAction | ContextAction | PolicyAction;

export interface HookDefinition {
  readonly id: string;
  readonly event: HookEvent;
  readonly priority: number;
  readonly match: Readonly<Record<string, MatcherValue>>;
  readonly action: HookAction;
  readonly timeoutMs: number;
  readonly outputCapBytes: number;
  readonly failurePolicy: FailurePolicy;
}

export interface HookRegistration {
  readonly hook: HookDefinition;
  readonly provenance: HookProvenance;
}

export type HookConfigSource =
  | {
      readonly scope: "global";
      readonly path: string;
      readonly root?: string;
      readonly trusted?: true;
      readonly optional?: boolean;
    }
  | {
      readonly scope: "project";
      readonly path: string;
      readonly root?: string;
      readonly trusted: boolean;
      readonly optional?: boolean;
    };

export interface HookDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly source: string;
  readonly hookId?: string;
  readonly message: string;
}

export interface RegistrationResult {
  readonly accepted: boolean;
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookEventEnvelope {
  readonly event: HookEvent;
  readonly mode: HookMode;
  readonly payload: Readonly<Record<string, PlainData>>;
  readonly trace?: readonly string[];
}

interface EffectBase {
  readonly effectId: string;
  readonly hookId: string;
  readonly event: HookEvent;
  readonly timeoutMs: number;
  readonly outputCapBytes: number;
  readonly failurePolicy: FailurePolicy;
  readonly provenance: HookProvenance;
  readonly trace: readonly string[];
}

export type HookEffect = EffectBase & HookAction;

export interface DispatchResult {
  readonly dispatchId: string;
  readonly status:
    | "completed"
    | "not-running"
    | "recursion-blocked"
    | "bounded"
    | "invalid-event";
  readonly effects: readonly HookEffect[];
  readonly matchedHookIds: readonly string[];
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookLogEntry {
  readonly sequence: number;
  readonly dispatchId: string;
  readonly event: HookEvent;
  readonly hookId?: string;
  readonly outcome:
    | "emitted"
    | "plan-denied"
    | "recursion-blocked"
    | "bounded"
    | "invalid"
    | "not-running";
  readonly message: string;
}

export interface HookInspection {
  readonly instanceId: string;
  readonly state: "created" | "running" | "stopped";
  readonly hooks: readonly {
    readonly id: string;
    readonly event: HookEvent;
    readonly priority: number;
    readonly source: string;
    readonly scope: HookScope;
    readonly action: HookAction["type"];
    readonly failurePolicy: FailurePolicy;
  }[];
  readonly logs: readonly HookLogEntry[];
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly hooks: readonly HookRegistration[];
  readonly diagnostics: readonly HookDiagnostic[];
  readonly sources: readonly {
    readonly scope: HookConfigSource["scope"];
    readonly path: string;
    readonly status: "valid" | "invalid" | "missing" | "untrusted-skipped";
    readonly hookCount: number;
  }[];
}

export interface ReloadResult extends ValidationResult {
  readonly applied: boolean;
}

export interface TriggerEngineOptions {
  readonly instanceId?: string;
  readonly maxHooks?: number;
  readonly maxHooksPerDispatch?: number;
  readonly maxEffectsPerDispatch?: number;
  readonly dispatchTimeoutMs?: number;
  readonly maxConfigBytes?: number;
  readonly maxConfigDepth?: number;
  readonly maxConfigNodes?: number;
  readonly maxMatchersPerHook?: number;
  readonly maxHookTimeoutMs?: number;
  readonly maxHookOutputBytes?: number;
  readonly maxLogEntries?: number;
  readonly maxLogBytes?: number;
}

export interface TriggerEngine {
  readonly instanceId: string;
  register(registration: HookRegistration): RegistrationResult;
  dispatch(event: HookEventEnvelope): Promise<DispatchResult>;
  validate(sources?: readonly HookConfigSource[]): Promise<ValidationResult>;
  reload(sources?: readonly HookConfigSource[]): Promise<ReloadResult>;
  start(sources?: readonly HookConfigSource[]): Promise<ReloadResult>;
  stop(
    reason?: string,
  ): Promise<{ readonly status: "stopped"; readonly reason: string }>;
  inspect(): HookInspection;
}
