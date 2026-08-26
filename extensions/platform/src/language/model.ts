import type {
  Position,
  Range,
  ServerCapabilities,
} from "vscode-languageserver-protocol";
import type { LifecycleSupervisor } from "../core/lifecycle/supervisor.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import type { ModuleError, Outcome } from "../core/result.ts";
import type { ArtifactStore } from "../core/artifacts/index.ts";

export type LanguageQueryKind =
  | "diagnostics"
  | "documentSymbols"
  | "workspaceSymbols"
  | "definition"
  | "references"
  | "implementations"
  | "hover"
  | "callHierarchy";

export interface LanguageServerCommand {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface LanguageSelector {
  readonly languageId: string;
  readonly extensions: readonly string[];
}

export interface LanguageServerDefinition {
  readonly id: string;
  readonly command: LanguageServerCommand;
  readonly selectors: readonly LanguageSelector[];
  readonly queries: readonly LanguageQueryKind[];
  readonly initializationOptions?: unknown;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface LanguageServerConnection {
  readonly capabilities: ServerCapabilities;
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(
    handler: (method: string, params: unknown) => void,
  ): () => void;
  onClose(handler: () => void): () => void;
  close(signal?: AbortSignal): Promise<void>;
}

export interface LanguageServerAdapter {
  connect(
    request: {
      readonly definition: LanguageServerDefinition;
      readonly rootPath: string;
      readonly stderrLimitBytes: number;
    },
    signal: AbortSignal,
  ): Promise<LanguageServerConnection>;
}

export interface LanguageIntelligenceOptions {
  readonly lifecycle: LifecycleSupervisor;
  readonly project: ResolvedProjectIdentity;
  readonly servers: readonly LanguageServerDefinition[];
  readonly adapter: LanguageServerAdapter;
  readonly artifacts?: ArtifactStore;
  readonly limits?: Partial<LanguageLimits>;
}

export interface LanguageLimits {
  readonly maxServers: number;
  readonly maxServersPerQuery: number;
  readonly maxDiagnosticFiles: number;
  readonly maxOpenDocumentsPerServer: number;
  readonly maxFileBytes: number;
  readonly maxResultItems: number;
  readonly maxResponseBytes: number;
  readonly maxStderrBytes: number;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxCrashesPerWindow: number;
  readonly crashWindowMs: number;
}

export interface LanguageDiscovery {
  readonly advisory: true;
  readonly authority: "repository-native-checks";
  readonly servers: readonly {
    readonly id: string;
    readonly languages: readonly string[];
    readonly extensions: readonly string[];
    readonly queries: readonly LanguageQueryKind[];
  }[];
}

export interface LanguageIntelligence {
  discover(): Promise<{ readonly ok: true; readonly value: LanguageDiscovery }>;
  synchronize(
    updates: readonly LanguageDocumentUpdate[],
    signal?: AbortSignal,
  ): Promise<LanguageOutcome<LanguageSynchronization>>;
  query(
    request: LanguageQuery,
    signal?: AbortSignal,
  ): Promise<LanguageOutcome<LanguageQueryResult>>;
}

export interface FixtureLanguageServerDefinition {
  readonly capabilities: ServerCapabilities;
  readonly startupDelayMs?: number;
  readonly onNotification?: (context: {
    readonly method: string;
    readonly params: unknown;
    publish(method: string, params?: unknown): void;
    close(): void;
  }) => void | Promise<void>;
  readonly onRequest?: (context: {
    readonly method: string;
    readonly params: unknown;
    readonly signal?: AbortSignal;
    publish(method: string, params?: unknown): void;
    close(): void;
  }) => unknown | Promise<unknown>;
}

export interface FixtureLanguageServerAdapter extends LanguageServerAdapter {
  inspect(): {
    readonly starts: number;
    readonly closes: number;
    readonly notifications: readonly {
      readonly serverId: string;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }[];
    readonly requests: readonly {
      readonly serverId: string;
      readonly method: string;
      readonly params: unknown;
    }[];
  };
}

export type LanguageDocumentUpdate =
  | {
      readonly kind: "open";
      readonly path: string;
      readonly text: string;
      readonly languageId?: string;
    }
  | { readonly kind: "change"; readonly path: string; readonly text: string }
  | { readonly kind: "close"; readonly path: string };

export interface LanguageSynchronization {
  readonly advisory: true;
  readonly authority: "repository-native-checks";
  readonly documents: readonly {
    readonly path: string;
    readonly state: "open" | "closed";
    readonly version: number;
  }[];
}

export type LanguageQuery =
  | { readonly kind: "diagnostics"; readonly path?: string }
  | { readonly kind: "documentSymbols"; readonly path: string }
  | { readonly kind: "workspaceSymbols"; readonly query: string }
  | {
      readonly kind: "definition" | "references" | "implementations" | "hover";
      readonly path: string;
      readonly position: Position;
    }
  | {
      readonly kind: "callHierarchy";
      readonly path: string;
      readonly position: Position;
      readonly direction: "incoming" | "outgoing";
    };

export interface MappedLanguagePath {
  readonly kind: "project" | "external";
  readonly path: string;
  readonly uri?: string;
}

export interface NormalizedDiagnostic {
  readonly type: "diagnostic";
  readonly path: MappedLanguagePath;
  readonly range: Range;
  readonly severity: "error" | "warning" | "information" | "hint" | "unknown";
  readonly code?: string;
  readonly source?: string;
  readonly message: string;
}

export interface NormalizedLocation {
  readonly type: "location";
  readonly path: MappedLanguagePath;
  readonly range: Range;
  readonly targetSelectionRange?: Range;
}

export interface NormalizedSymbol {
  readonly type: "symbol";
  readonly name: string;
  readonly kind: string;
  readonly path: MappedLanguagePath;
  readonly range?: Range;
  readonly selectionRange?: Range;
  readonly containerName?: string;
}

export interface NormalizedHover {
  readonly type: "hover";
  readonly contents: string;
  readonly range?: Range;
}

export interface NormalizedCall {
  readonly type: "call";
  readonly direction: "incoming" | "outgoing";
  readonly name: string;
  readonly kind: string;
  readonly path: MappedLanguagePath;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly callRanges: readonly Range[];
}

export type NormalizedLanguageItem =
  | NormalizedDiagnostic
  | NormalizedLocation
  | NormalizedSymbol
  | NormalizedHover
  | NormalizedCall;

export interface LanguageQueryResult {
  readonly advisory: true;
  readonly authority: "repository-native-checks";
  readonly kind: LanguageQueryKind;
  readonly serverIds: readonly string[];
  readonly items: readonly NormalizedLanguageItem[];
  readonly truncated: boolean;
  readonly artifact?: {
    readonly id: string;
    readonly size: number;
    readonly mediaType: "application/json";
  };
}

export type LanguageErrorCode =
  | "invalid_input"
  | "unsupported_capability"
  | "server_unavailable"
  | "startup_timeout"
  | "request_timeout"
  | "cancelled"
  | "artifact_unavailable"
  | "response_too_large";

export type LanguageError = ModuleError<LanguageErrorCode>;
export type LanguageOutcome<T> = Outcome<T, LanguageError>;

export interface StdioLanguageServerAdapterOptions {
  readonly spawn?: typeof import("node:child_process").spawn;
  readonly onSpawn?: (pid: number, serverId: string) => void;
}
