import type { JsonObject, ModuleError, Outcome } from "../result.ts";

export const DEFAULT_ARTIFACT_LIMITS = Object.freeze({
  maxArtifactBytes: 16 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
});

export interface ArtifactLimits {
  readonly maxArtifactBytes: number;
  readonly maxTotalBytes: number;
  readonly maxMetadataBytes: number;
}

export interface PutArtifactInput {
  readonly body: string | Uint8Array;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly metadata?: JsonObject;
  readonly expiresAt?: number;
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly sha256: string;
  readonly size: number;
  readonly createdAt: number;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly metadata?: JsonObject;
  readonly expiresAt?: number;
}

export interface StoredArtifact {
  readonly metadata: ArtifactMetadata;
  readonly body: Uint8Array;
}

export interface ExportArtifactInput {
  readonly directory: string;
  readonly filename?: string;
}

export interface ExportedArtifact {
  readonly artifact: ArtifactMetadata;
  readonly path: string;
}

export interface CollectArtifactsInput {
  readonly now?: number;
}

export interface ArtifactCollection {
  readonly removedArtifacts: number;
  readonly reclaimedBytes: number;
}

export type ArtifactStoreErrorCode =
  | "invalid_input"
  | "invalid_artifact_id"
  | "invalid_filename"
  | "artifact_too_large"
  | "metadata_too_large"
  | "metadata_conflict"
  | "quota_exceeded"
  | "artifact_not_found"
  | "artifact_expired"
  | "destination_exists"
  | "corrupt_artifact"
  | "io_error";

export type ArtifactStoreError = ModuleError<ArtifactStoreErrorCode>;
export type ArtifactOutcome<T> = Outcome<T, ArtifactStoreError>;

/**
 * Immutable artifact seam. IDs are lowercase SHA-256 body digests. Limits are
 * inclusive; total quota counts each physically stored body once.
 */
export interface ArtifactStore {
  /** Persist a body and bounded metadata, or return existing metadata by hash. */
  put(input: PutArtifactInput): Promise<ArtifactOutcome<ArtifactMetadata>>;
  /** Explicitly load a body. Artifact bodies are absent from put results. */
  get(id: string): Promise<ArtifactOutcome<StoredArtifact>>;
  /** Export one safe basename using create-new semantics; never overwrite. */
  export(
    id: string,
    input: ExportArtifactInput,
  ): Promise<ArtifactOutcome<ExportedArtifact>>;
  /** Remove artifacts whose expiresAt is less than or equal to now. */
  collect(
    input?: CollectArtifactsInput,
  ): Promise<ArtifactOutcome<ArtifactCollection>>;
}

export interface ArtifactStoreOptions {
  readonly limits?: Partial<ArtifactLimits>;
  readonly clock?: () => number;
}

export interface FileSystemArtifactStoreOptions extends ArtifactStoreOptions {
  readonly root: string;
}
