/**
 * Public entry point for Phase 9 Artifact Publication: opening Artifacts in
 * the loopback viewer and sharing them through protected Vercel previews.
 *
 * Not the Artifact store. Immutable content-addressed bodies live in the
 * Phase 1 `ArtifactStore` (`src/core/artifacts/`); this module reads from it
 * and writes derived outbound bodies back to it, but owns only publication
 * records, approval, Sensitivity, and adapters. Composed by
 * `src/composition.ts`; driven by `/artifacts` in
 * `src/wiring/artifacts-command.ts`.
 *
 * See: docs/architecture/phase-9-artifacts.md,
 * docs/adr/0012-publish-artifacts-through-protected-vercel-previews.md
 */

export { exportArtifactBundle, importArtifactBundle } from "./bundle.ts";
export { createArtifactPublisher } from "./publisher.ts";
export { createInMemoryPublicationRepository } from "./repository.ts";
export { createLocalArtifactPublicationAdapter } from "./local-viewer.ts";
export { createStateStorePublicationRepository } from "./state-repository.ts";
export { createVaultPublicationSecretStore } from "./vault-secrets.ts";
export { createVercelRestTransport } from "./vercel-rest.ts";
export {
  createInMemoryPublicationSecretStore,
  createVercelArtifactPublicationAdapter,
} from "./vercel.ts";
export { scanArtifactSensitivity } from "./scanner.ts";
export type {
  ArtifactKind,
  ArtifactPublication,
  ArtifactPublicationAdapter,
  ArtifactPublisher,
  ArtifactPublisherError,
  ArtifactPublisherErrorCode,
  ArtifactPublisherOutcome,
  ArtifactUserAuthorityToken,
  CreateArtifactPublisherOptions,
  PublicationAccess,
  PublicationAdapterError,
  PublicationAdapterState,
  PublicationApproval,
  PublicationReceipt,
  PublicationRepository,
  PublicationState,
  PublicationTarget,
  PublishArtifactInput,
  RefreshPublicationInput,
  RevokePublicationInput,
  SensitivityFinding,
  SensitivityReport,
  StoredPublication,
} from "./model.ts";
export type {
  PublicationSecretStore,
  VercelArtifactPublicationOptions,
  VercelArtifactTransport,
  VercelFile,
} from "./vercel.ts";
