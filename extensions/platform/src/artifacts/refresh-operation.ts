import { createHash } from "node:crypto";
import { publisherFailure, validPublicationHandle } from "./errors.ts";
import { approvalScope } from "./publish-operation.ts";
import { scanArtifactSensitivity } from "./scanner.ts";
import type {
  ArtifactPublisher,
  CreateArtifactPublisherOptions,
  PublicationApproval,
} from "./model.ts";

export async function refreshArtifact(
  options: CreateArtifactPublisherOptions,
  clock: () => number,
  input: Parameters<ArtifactPublisher["refresh"]>[0],
  signal?: AbortSignal,
) {
  const policy = options.policy.decide(
    { kind: "operation", name: "publish" },
    options.actor,
    { kind: options.mode() },
  );
  if (policy.kind === "deny")
    return publisherFailure("policy_denied", policy.reason);
  if (signal?.aborted)
    return publisherFailure("cancelled", "Artifact refresh was cancelled.");
  if (!validPublicationHandle(input.handle))
    return publisherFailure(
      "invalid_request",
      "Artifact publication handle is invalid.",
    );
  const current = await options.publications.get(input.handle);
  if (!current.ok)
    return publisherFailure(
      current.error.code === "publication_not_found"
        ? "publication_not_found"
        : "persistence_error",
      current.error.message,
      { retryable: current.error.retryable },
    );
  const publication = current.value.publication;
  if (
    current.value.ownerId !== (options.ownerId ?? "artifact-publisher") ||
    publication.target !== "local" ||
    !publication.live ||
    publication.state !== "active" ||
    !current.value.providerReference ||
    !options.refreshLocal
  )
    return publisherFailure(
      "invalid_request",
      "Artifact publication is not an active local live publication.",
    );
  const stored = await options.artifacts.get(input.artifactId);
  if (!stored.ok)
    return publisherFailure("artifact_not_found", stored.error.message);
  let materialized;
  try {
    const { materializeArtifact } = await import("./materializer.ts");
    materialized = materializeArtifact(
      stored.value.metadata,
      stored.value.body,
    );
  } catch (error) {
    return publisherFailure(
      "unsupported_artifact",
      error instanceof Error ? error.message : String(error),
    );
  }
  let canaries: readonly string[] = [];
  try {
    canaries = (await options.sensitivityCanaries?.()) ?? [];
  } catch {
    return publisherFailure(
      "provider_unavailable",
      "Artifact sensitivity canaries are unavailable.",
    );
  }
  let sensitivity = scanArtifactSensitivity(materialized.body, canaries);
  if (
    sensitivity.verdict === "clear" &&
    stored.value.metadata.sensitivity !== "public"
  ) {
    const findings = [
      ...sensitivity.findings,
      {
        ruleId: "artifact-classification",
        severity: "review" as const,
        count: 1,
      },
    ];
    sensitivity = {
      ...sensitivity,
      verdict: "review",
      findings,
      digest: createHash("sha256")
        .update(sensitivity.scannerVersion)
        .update("\0")
        .update(JSON.stringify(findings))
        .digest("hex"),
    };
  }
  if (sensitivity.verdict === "blocked")
    return publisherFailure(
      "sensitivity_blocked",
      "Artifact refresh contains blocking sensitivity findings.",
      { sensitivity },
    );
  const outboundArtifactId = createHash("sha256")
    .update(materialized.body)
    .digest("hex");
  const exact = {
    operation: "refresh" as const,
    artifactId: stored.value.metadata.id,
    outboundArtifactId,
    target: publication.target,
    providerId: current.value.adapterId,
    interactive: materialized.interactive,
    live: true,
    publicationState: publication.state,
    access: publication.access,
    expiresAt: publication.expiresAt,
    sensitivity,
  };
  const approval: PublicationApproval = {
    ...exact,
    scope: approvalScope(exact),
  };
  if (
    !input.authority ||
    !options.authority.verify(input.authority, approval.scope)
  )
    return publisherFailure(
      "approval_required",
      "Artifact refresh requires direct user approval.",
      { approval, sensitivity },
    );
  if (options.mode() === "plan" || publication.expiresAt <= clock())
    return publisherFailure(
      "policy_denied",
      "Artifact refresh policy or expiry changed before update.",
    );
  if (outboundArtifactId !== stored.value.metadata.id) {
    const outbound = await options.artifacts.put({
      body: materialized.body,
      filename: "artifact.html",
      mediaType: materialized.mediaType,
      kind: materialized.kind,
      sensitivity: stored.value.metadata.sensitivity ?? "unknown",
      metadata: {
        interactive: materialized.interactive,
        live: true,
        materializer: "phase-9-v1",
      },
    });
    if (!outbound.ok)
      return publisherFailure("persistence_error", outbound.error.message);
  }
  const refreshing = await options.publications.update({
    ...current.value,
    publication: {
      ...publication,
      sourceArtifactId: stored.value.metadata.id,
      outboundArtifactId,
      interactive: materialized.interactive,
      sensitivity,
      state: "refreshing",
      observedAt: clock(),
    },
  });
  if (!refreshing.ok)
    return publisherFailure("persistence_error", refreshing.error.message);
  const refreshed = await options.refreshLocal(
    current.value.providerReference,
    {
      body: materialized.body,
      mediaType: materialized.mediaType,
      interactive: materialized.interactive,
    },
  );
  if (!refreshed) {
    const rolledBack = await options.publications.update({
      ...refreshing.value,
      publication: { ...publication, observedAt: clock() },
    });
    return rolledBack.ok
      ? publisherFailure(
          "provider_unavailable",
          "Local live Artifact refresh failed.",
        )
      : publisherFailure(
          "ambiguous_outcome",
          "Local live Artifact refresh failed and rollback could not be persisted.",
        );
  }
  const active = await options.publications.update({
    ...refreshing.value,
    publication: {
      ...refreshing.value.publication,
      state: "active",
      observedAt: clock(),
    },
  });
  return active.ok
    ? { ok: true as const, value: active.value.publication }
    : publisherFailure(
        "ambiguous_outcome",
        "Live Artifact refreshed but final state persistence failed.",
      );
}
