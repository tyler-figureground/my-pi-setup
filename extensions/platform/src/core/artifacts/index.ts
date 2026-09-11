/**
 * Public barrel for ArtifactStore: the interface, limits, and both adapters.
 * Production composes `createFileSystemArtifactStore` per Project Identity;
 * `createInMemoryArtifactStore` backs tests and test fixtures behind the
 * same interface.
 *
 * See: docs/architecture/platform-foundation.md,
 * docs/architecture/phase-9-artifacts.md
 */

export { createFileSystemArtifactStore } from "./filesystem.ts";
export { createInMemoryArtifactStore } from "./memory.ts";
export { DEFAULT_ARTIFACT_LIMITS } from "./model.ts";
export type {
  ArtifactCollection,
  ArtifactLimits,
  ArtifactMetadata,
  ArtifactOutcome,
  ArtifactPage,
  ArtifactStore,
  ArtifactStoreError,
  ArtifactStoreErrorCode,
  ArtifactStoreOptions,
  ArtifactSensitivity,
  ArtifactType,
  CollectArtifactsInput,
  ExportArtifactInput,
  ExportedArtifact,
  FileSystemArtifactStoreOptions,
  ListArtifactsInput,
  PutArtifactInput,
  StoredArtifact,
} from "./model.ts";
