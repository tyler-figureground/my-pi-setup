/**
 * Types for Phase 9 Artifact Publication: the `ArtifactPublisher` seam, the
 * transport-only `ArtifactPublicationAdapter` seam, persisted publication
 * records, and the exact `PublicationApproval` a user confirms.
 *
 * Not the Artifact store: `src/core/artifacts/model.ts` types the immutable
 * content-addressed `ArtifactStore`. Publication records reference Artifacts
 * by ID and never hold a body. The Capability Token-bearing `shareUrl` exists
 * only in adapter results and `PublicationReceipt`; `StoredPublication` has
 * no field for it.
 *
 * See: docs/architecture/phase-9-artifacts.md
 */

import type { ActorRole, CapabilityPolicy } from "../core/policy/index.ts";
import type { ArtifactStore } from "../core/artifacts/index.ts";
import type { ModuleError, Outcome } from "../core/result.ts";

export type ArtifactKind = "markdown" | "html" | "json" | "image" | "bundle";
export type PublicationTarget = "local" | "remote";
export type PublicationAccess = "private" | "link";
export type PublicationState =
  | "pending"
  | "active"
  | "revoking"
  | "refreshing"
  | "revoked"
  | "expired"
  | "failed"
  | "unknown";

export interface SensitivityFinding {
  readonly ruleId: string;
  readonly severity: "review" | "block";
  readonly count: number;
}

export interface SensitivityReport {
  readonly verdict: "clear" | "review" | "blocked";
  readonly scannerVersion: string;
  readonly digest: string;
  readonly findings: readonly SensitivityFinding[];
}

export interface ArtifactPublication {
  readonly handle: string;
  readonly sourceArtifactId: string;
  readonly outboundArtifactId: string;
  readonly target: PublicationTarget;
  readonly access: PublicationAccess;
  readonly interactive: boolean;
  readonly live: boolean;
  readonly state: PublicationState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly observedAt: number;
  readonly sensitivity: SensitivityReport;
}

export interface PublicationReceipt {
  readonly publication: ArtifactPublication;
  /**
   * Contains the Capability Token. Show it once in trusted direct-user UI;
   * never log, persist, or return it to a model.
   */
  readonly shareUrl: string;
  readonly revocationHandle: string;
}

export interface ArtifactUserAuthorityToken {
  readonly kind: "artifact-user-authority";
  readonly value: string;
  readonly scope: string;
}

export interface PublishArtifactInput {
  readonly artifactId: string;
  readonly target?: PublicationTarget;
  readonly access?: PublicationAccess;
  readonly expiresAt: number;
  readonly authority?: ArtifactUserAuthorityToken;
}

export interface RefreshPublicationInput {
  readonly handle: string;
  readonly artifactId: string;
  readonly authority?: ArtifactUserAuthorityToken;
}

export interface RevokePublicationInput {
  readonly handle: string;
  readonly authority?: ArtifactUserAuthorityToken;
}

export interface PublicationApproval {
  readonly operation: "publish" | "refresh" | "revoke";
  readonly scope: string;
  readonly artifactId?: string;
  readonly outboundArtifactId?: string;
  readonly target: PublicationTarget;
  readonly providerId: string;
  readonly interactive: boolean;
  readonly live: boolean;
  readonly publicationState?: PublicationState;
  readonly access: PublicationAccess;
  readonly expiresAt: number;
  readonly sensitivity: SensitivityReport;
}

export type ArtifactPublisherErrorCode =
  | "invalid_request"
  | "invalid_expiry"
  | "artifact_not_found"
  | "artifact_expired"
  | "corrupt_artifact"
  | "unsupported_artifact"
  | "artifact_too_large"
  | "sensitivity_blocked"
  | "approval_required"
  | "policy_denied"
  | "publication_not_found"
  | "publication_conflict"
  | "provider_unavailable"
  | "provider_rejected"
  | "ambiguous_outcome"
  | "persistence_error"
  | "cancelled";

export interface ArtifactPublisherError extends ModuleError<ArtifactPublisherErrorCode> {
  readonly approval?: PublicationApproval;
  readonly sensitivity?: SensitivityReport;
}

export type ArtifactPublisherOutcome<T> = Outcome<T, ArtifactPublisherError>;

export interface ArtifactPublisher {
  close(): Promise<void>;
  publish(
    input: PublishArtifactInput,
    signal?: AbortSignal,
  ): Promise<ArtifactPublisherOutcome<PublicationReceipt>>;
  status(
    handle: string,
    signal?: AbortSignal,
  ): Promise<ArtifactPublisherOutcome<ArtifactPublication>>;
  refresh(
    input: RefreshPublicationInput,
    signal?: AbortSignal,
  ): Promise<ArtifactPublisherOutcome<ArtifactPublication>>;
  revoke(
    input: RevokePublicationInput,
    signal?: AbortSignal,
  ): Promise<ArtifactPublisherOutcome<ArtifactPublication>>;
}

export interface PublicationAdapterError extends ModuleError<
  | "provider_unavailable"
  | "provider_rejected"
  | "ambiguous_outcome"
  | "cancelled"
> {}

export interface PublicationAdapterState {
  readonly state: "active" | "revoked" | "expired" | "unknown";
}

export interface ArtifactPublicationAdapter {
  readonly id: string;
  readonly target: PublicationTarget;
  readonly maxBytes: number;
  /**
   * Provider reference persisted with the `pending` record before dispatch,
   * so an ambiguous publish can still be reconciled by `status`/`revoke`.
   */
  recoveryReference?(handle: string): string | undefined;
  publish(
    input: {
      readonly handle: string;
      readonly body: Uint8Array;
      readonly mediaType: string;
      readonly kind: ArtifactKind;
      readonly interactive: boolean;
      readonly live: boolean;
      readonly access: PublicationAccess;
      readonly expiresAt: number;
    },
    signal?: AbortSignal,
  ): Promise<
    Outcome<
      { readonly providerReference: string; readonly shareUrl: string },
      PublicationAdapterError
    >
  >;
  status(
    providerReference: string,
    signal?: AbortSignal,
  ): Promise<Outcome<PublicationAdapterState, PublicationAdapterError>>;
  revoke(
    providerReference: string,
    signal?: AbortSignal,
  ): Promise<Outcome<PublicationAdapterState, PublicationAdapterError>>;
}

export interface StoredPublication {
  readonly revision: number;
  readonly ownerId: string;
  readonly publication: ArtifactPublication;
  readonly adapterId: string;
  readonly providerReference?: string;
}

export interface PublicationRepository {
  list(): Promise<
    Outcome<readonly StoredPublication[], ModuleError<"persistence_error">>
  >;
  create(
    record: StoredPublication,
  ): Promise<
    Outcome<
      StoredPublication,
      ModuleError<"publication_conflict" | "persistence_error">
    >
  >;
  get(
    handle: string,
  ): Promise<
    Outcome<
      StoredPublication,
      ModuleError<"publication_not_found" | "persistence_error">
    >
  >;
  update(
    record: StoredPublication,
  ): Promise<
    Outcome<
      StoredPublication,
      ModuleError<"publication_not_found" | "persistence_error">
    >
  >;
}

export interface CreateArtifactPublisherOptions {
  readonly artifacts: ArtifactStore;
  readonly adapters: readonly ArtifactPublicationAdapter[];
  readonly publications: PublicationRepository;
  readonly policy: CapabilityPolicy;
  readonly actor: ActorRole;
  readonly mode: () => "normal" | "plan";
  readonly authority: {
    verify(token: ArtifactUserAuthorityToken, scope: string): boolean;
  };
  /** Exact secret values (e.g. the resolved Vercel token) that block publish. */
  readonly sensitivityCanaries?: () => Promise<readonly string[]>;
  readonly refreshLocal?: (
    handle: string,
    input: {
      readonly body: Uint8Array;
      readonly mediaType: string;
      readonly interactive: boolean;
    },
  ) => Promise<boolean>;
  readonly clock?: () => number;
  readonly createHandle?: () => string;
  /** Stamped on created records; `refresh` only touches records it owns. */
  readonly ownerId?: string;
}
