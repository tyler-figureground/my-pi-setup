import type {
  ArtifactMetadata,
  ArtifactStore,
} from "../core/artifacts/index.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import type { JsonObject, ModuleError, Outcome } from "../core/result.ts";
import type { WorkspaceLease } from "../workspaces/index.ts";
import type { ExecutionRole } from "../../../shared/execution-role.ts";
import type { MemoryPersistenceAdapter } from "./memory-persistence.ts";

export const coreMemoryKinds = {
  preference: { id: "pi/preference", version: 1 },
  projectFact: { id: "pi/project-fact", version: 1 },
  decision: { id: "pi/decision", version: 1 },
  procedure: { id: "pi/procedure", version: 1 },
  ephemeralNote: { id: "pi/ephemeral-note", version: 1 },
} as const;

export interface MemoryKindRef {
  readonly id: string;
  readonly version: number;
}

export type MemoryScopeSelector = "user" | "project" | "workspace";

export interface MemoryCitationInput {
  readonly kind: "session-entry" | "artifact" | "external" | string;
  readonly locator: JsonObject;
  readonly excerpt?: string;
}

export interface MemoryCitation {
  readonly id: string;
  readonly kind: string;
  readonly locator: JsonObject;
  readonly excerpt?: string;
  readonly recordedAt: number;
  readonly trust: "untrusted";
}

export interface MemoryRelationship {
  readonly kind: "pi/contradicts" | "pi/supersedes" | string;
  readonly targetId: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly revision: number;
  readonly kind: MemoryKindRef;
  readonly scope:
    | { readonly kind: "user" }
    | { readonly kind: "project"; readonly projectId: string }
    | {
        readonly kind: "workspace";
        readonly projectId: string;
        readonly workspaceId: string;
      };
  readonly content: string;
  readonly citations: readonly MemoryCitation[];
  readonly provenance: {
    readonly ingress:
      "direct-user" | "model-proposal" | "automatic-proposal" | "import";
    readonly sessionId?: string;
    readonly executionRole: ExecutionRole;
    readonly importedFrom?: string;
  };
  readonly confidence: number;
  readonly status: "active" | "review";
  readonly relationships: readonly MemoryRelationship[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly trust: "untrusted";
  readonly authority: "none";
}

export interface HostMemoryBinding {
  readonly executionRole: ExecutionRole;
  readonly project?: ResolvedProjectIdentity;
  readonly workspace?: WorkspaceLease;
  readonly ingress:
    "direct-user" | "model-proposal" | "automatic-proposal" | "import";
  readonly sessionId?: string;
  readonly sourceEntryId?: string;
}

export interface RememberRequest {
  readonly requestId: string;
  readonly kind: MemoryKindRef;
  readonly scope: MemoryScopeSelector;
  readonly content: string;
  readonly citations?: readonly MemoryCitationInput[];
  readonly expiresAt?: number;
  readonly attributes?: JsonObject;
}

export interface RememberReceipt {
  readonly state: "created" | "duplicate" | "review-required";
  readonly memory: MemoryRecord;
  readonly duplicateOf?: string;
  readonly contradictionIds: readonly string[];
  readonly redactions: readonly {
    readonly kind: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly replayed: boolean;
}

export interface MemorySearchRequest {
  readonly text: string;
  readonly ranking?: "relevant" | "recent" | "exact";
  readonly within?: readonly MemoryScopeSelector[];
  readonly kinds?: readonly MemoryKindRef[];
  readonly limit?: number;
  readonly asOf?: number;
}

export interface MemoryHit {
  readonly memory: MemoryRecord;
  readonly rank: number;
  readonly excerpt: string;
  readonly reasons: readonly ("exact" | "lexical" | "recent" | string)[];
}

export type MemoryInspectRequest =
  | { readonly id: string; readonly includeRevisions?: boolean }
  | {
      readonly scope?: MemoryScopeSelector;
      readonly status?: "active" | "review";
      readonly kind?: MemoryKindRef;
      readonly cursor?: string;
      readonly limit?: number;
    };

export interface MemoryInspection {
  readonly memories: readonly MemoryRecord[];
  readonly nextCursor?: string;
}

export type MemoryChange =
  | {
      readonly type: "replace";
      readonly requestId: string;
      readonly id: string;
      readonly expectedRevision: number;
      readonly content: string;
      readonly citations?: readonly MemoryCitationInput[];
      readonly expiresAt?: number | null;
    }
  | {
      readonly type: "forget";
      readonly requestId: string;
      readonly id: string;
      readonly expectedRevision?: number;
    }
  | {
      readonly type: "promote";
      readonly requestId: string;
      readonly id: string;
      readonly expectedRevision: number;
    };

export type MemoryChangeResult =
  | {
      readonly type: "replace" | "promote";
      readonly memory: MemoryRecord;
      readonly replayed: boolean;
    }
  | {
      readonly type: "forget";
      readonly id: string;
      readonly forgottenAt: number;
      readonly replayed: boolean;
    };

export type MemoryTransferRequest =
  | {
      readonly type: "export";
      readonly requestId: string;
      readonly format: { readonly id: string; readonly version: number };
      readonly scopes?: readonly MemoryScopeSelector[];
      readonly kinds?: readonly MemoryKindRef[];
    }
  | {
      readonly type: "preview-import";
      readonly requestId: string;
      readonly artifactId: string;
      readonly format?: { readonly id: string; readonly version: number };
      readonly targetScope: MemoryScopeSelector;
    }
  | {
      readonly type: "commit-import";
      readonly requestId: string;
      readonly previewId: string;
      readonly expectedManifestSha256: string;
      readonly collisions: "skip" | "review";
    };

export type MemoryTransferResult =
  | {
      readonly type: "export";
      readonly artifact: ArtifactMetadata;
      readonly count: number;
      readonly replayed: boolean;
    }
  | {
      readonly type: "preview-import";
      readonly previewId: string;
      readonly manifestSha256: string;
      readonly accepted: number;
      readonly duplicates: number;
      readonly contradictions: number;
      readonly unsupportedKinds: number;
      readonly expiresAt: number;
      readonly replayed: boolean;
    }
  | {
      readonly type: "commit-import";
      readonly imported: number;
      readonly reviewRequired: number;
      readonly skipped: number;
      readonly replayed: boolean;
    };

export type MemoryStoreErrorCode =
  | "invalid_request"
  | "scope_unavailable"
  | "project_mismatch"
  | "workspace_lease_lost"
  | "unsupported_kind"
  | "unsupported_format"
  | "memory_not_found"
  | "revision_conflict"
  | "content_too_large"
  | "content_empty_after_redaction"
  | "secret_redaction_failed"
  | "index_unavailable"
  | "import_invalid"
  | "import_too_large"
  | "import_preview_expired"
  | "import_manifest_changed"
  | "import_requires_direct_user"
  | "artifact_failed"
  | "storage_failed"
  | "cancelled"
  | "shutting_down";

export type MemoryStoreError = ModuleError<MemoryStoreErrorCode>;
export type MemoryStoreResult<T> = Outcome<T, MemoryStoreError>;

export interface MemoryStore {
  remember(
    request: RememberRequest,
    signal?: AbortSignal,
  ): Promise<MemoryStoreResult<RememberReceipt>>;
  search(
    request: MemorySearchRequest,
    signal?: AbortSignal,
  ): Promise<MemoryStoreResult<readonly MemoryHit[]>>;
  inspect(
    request: MemoryInspectRequest,
  ): Promise<MemoryStoreResult<MemoryInspection>>;
  change(
    request: MemoryChange,
    signal?: AbortSignal,
  ): Promise<MemoryStoreResult<MemoryChangeResult>>;
  transfer(
    request: MemoryTransferRequest,
    signal?: AbortSignal,
  ): Promise<MemoryStoreResult<MemoryTransferResult>>;
}

export interface MemoryStoreModule {
  bind(binding: HostMemoryBinding): MemoryStore;
}

export interface MemoryStoreLimits {
  readonly maxContentBytes: number;
  readonly maxCitations: number;
  readonly maxCitationBytes: number;
  readonly maxQueryBytes: number;
  readonly maxSearchLimit: number;
  readonly maxInspectLimit: number;
  readonly maxExcerptBytes: number;
  readonly maxContextBytes: number;
  readonly maxTransferBytes: number;
  readonly maxTransferEntries: number;
  readonly maxCandidateIds: number;
}

export interface MemoryStoreModuleOptions {
  readonly persistence: MemoryPersistenceAdapter;
  readonly artifacts: ArtifactStore;
  readonly clock?: () => number;
  readonly id?: () => string;
  readonly limits?: Partial<MemoryStoreLimits>;
}
