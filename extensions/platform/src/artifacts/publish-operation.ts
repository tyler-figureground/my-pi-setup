import { createHash } from "node:crypto";
import { scanArtifactSensitivity } from "./scanner.ts";
import { publisherFailure, validPublicationHandle } from "./errors.ts";
import type {
  ArtifactPublication,
  ArtifactPublicationAdapter,
  CreateArtifactPublisherOptions,
  PublicationApproval,
  PublicationTarget,
  PublishArtifactInput,
  StoredPublication,
} from "./model.ts";

export function approvalScope(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function publishArtifact(
  options: CreateArtifactPublisherOptions,
  adapters: ReadonlyMap<PublicationTarget, ArtifactPublicationAdapter>,
  clock: () => number,
  createHandle: () => string,
  input: PublishArtifactInput,
  signal?: AbortSignal,
) {
  const decide = () =>
    options.policy.decide(
      { kind: "operation", name: "publish" },
      options.actor,
      { kind: options.mode() },
    );
  const initialPolicy = decide();
  if (initialPolicy.kind === "deny")
    return publisherFailure("policy_denied", initialPolicy.reason);
  if (signal?.aborted)
    return publisherFailure("cancelled", "Artifact publication was cancelled.");
  const now = clock();
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)
    return publisherFailure(
      "invalid_expiry",
      "Artifact publication expiry must be in the future.",
    );
  const target = input.target ?? "local";
  const access = input.access ?? "private";
  const adapter = adapters.get(target);
  if (!adapter)
    return publisherFailure(
      "provider_unavailable",
      `Artifact publication target is unavailable: ${target}`,
    );
  const stored = await options.artifacts.get(input.artifactId);
  if (!stored.ok) {
    const code =
      stored.error.code === "artifact_not_found"
        ? "artifact_not_found"
        : stored.error.code === "artifact_expired"
          ? "artifact_expired"
          : stored.error.code === "corrupt_artifact"
            ? "corrupt_artifact"
            : "invalid_request";
    return publisherFailure(code, stored.error.message);
  }
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
  if (materialized.body.byteLength > adapter.maxBytes)
    return publisherFailure(
      "artifact_too_large",
      "Artifact exceeds publication provider limit.",
    );
  const materializedId = createHash("sha256")
    .update(materialized.body)
    .digest("hex");
  const outboundArtifactId = materializedId;
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
  if (
    target === "remote" &&
    sensitivity.findings.some(({ ruleId }) => ruleId === "local-path")
  ) {
    const findings = sensitivity.findings.map((finding) =>
      finding.ruleId === "local-path"
        ? { ...finding, severity: "block" as const }
        : finding,
    );
    sensitivity = {
      ...sensitivity,
      verdict: "blocked",
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
      "Artifact contains blocking sensitivity findings.",
      { sensitivity },
    );
  const exact = {
    operation: "publish" as const,
    artifactId: stored.value.metadata.id,
    outboundArtifactId,
    target,
    providerId: adapter.id,
    interactive: materialized.interactive,
    live: materialized.live,
    access,
    expiresAt: input.expiresAt,
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
      "Artifact publication requires direct user approval.",
      { approval, sensitivity },
    );
  if (decide().kind === "deny")
    return publisherFailure(
      "policy_denied",
      "Artifact publication policy changed before dispatch.",
    );
  if (materializedId !== stored.value.metadata.id) {
    const outbound = await options.artifacts.put({
      body: materialized.body,
      filename:
        materialized.mediaType === "text/html"
          ? "artifact.html"
          : "artifact.bin",
      mediaType: materialized.mediaType,
      kind: materialized.kind,
      sensitivity: stored.value.metadata.sensitivity ?? "unknown",
      metadata: {
        interactive: materialized.interactive,
        live: materialized.live,
        materializer: "phase-9-v1",
      },
    });
    if (!outbound.ok)
      return publisherFailure("persistence_error", outbound.error.message, {
        retryable: outbound.error.retryable,
      });
  }
  const handle = createHandle();
  if (!validPublicationHandle(handle))
    return publisherFailure(
      "persistence_error",
      "Artifact publication handle generator returned an invalid value.",
    );
  const pending: ArtifactPublication = {
    handle,
    sourceArtifactId: stored.value.metadata.id,
    outboundArtifactId,
    target,
    access,
    interactive: materialized.interactive,
    live: materialized.live,
    state: "pending",
    createdAt: now,
    expiresAt: input.expiresAt,
    observedAt: now,
    sensitivity,
  };
  const recoveryReference = adapter.recoveryReference?.(handle);
  const created = await options.publications.create({
    revision: 0,
    ownerId: options.ownerId ?? "artifact-publisher",
    publication: pending,
    adapterId: adapter.id,
    ...(recoveryReference ? { providerReference: recoveryReference } : {}),
  });
  if (!created.ok)
    return publisherFailure("persistence_error", created.error.message, {
      retryable: created.error.retryable,
    });
  let dispatched;
  try {
    dispatched = await adapter.publish(
      {
        handle,
        body: materialized.body,
        mediaType: materialized.mediaType,
        kind: materialized.kind,
        interactive: materialized.interactive,
        live: materialized.live,
        access,
        expiresAt: input.expiresAt,
      },
      signal,
    );
  } catch {
    await options.publications.update({
      ...created.value,
      publication: { ...pending, state: "unknown", observedAt: clock() },
    });
    return publisherFailure(
      "ambiguous_outcome",
      "Artifact provider outcome is unknown.",
    );
  }
  if (!dispatched.ok) {
    const recoveryReference = dispatched.error.details?.providerReference;
    await options.publications.update({
      ...created.value,
      ...(typeof recoveryReference === "string"
        ? { providerReference: recoveryReference }
        : {}),
      publication: {
        ...pending,
        state:
          dispatched.error.code === "ambiguous_outcome" ? "unknown" : "failed",
        observedAt: clock(),
      },
    });
    return publisherFailure(dispatched.error.code, dispatched.error.message, {
      retryable: dispatched.error.retryable,
    });
  }
  const dispatchedRecord: StoredPublication = {
    ...created.value,
    publication: { ...pending, state: "unknown", observedAt: clock() },
    adapterId: adapter.id,
    providerReference: dispatched.value.providerReference,
  };
  const dispatchedSaved = await options.publications.update(dispatchedRecord);
  if (!dispatchedSaved.ok)
    return publisherFailure(
      "ambiguous_outcome",
      "Artifact provider responded but reconciliation metadata could not be persisted.",
    );
  let url: URL;
  try {
    url = new URL(dispatched.value.shareUrl);
  } catch {
    return publisherFailure(
      "ambiguous_outcome",
      "Artifact provider returned an invalid share URL.",
    );
  }
  const unsafe =
    url.username ||
    url.password ||
    (target === "local"
      ? url.protocol !== "http:" || url.hostname !== "127.0.0.1"
      : url.protocol !== "https:");
  if (unsafe)
    return publisherFailure(
      "ambiguous_outcome",
      "Artifact provider returned an unsafe share URL.",
    );
  const active: StoredPublication = {
    ...dispatchedSaved.value,
    publication: { ...pending, state: "active", observedAt: clock() },
    adapterId: adapter.id,
    providerReference: dispatched.value.providerReference,
  };
  const updated = await options.publications.update(active);
  if (!updated.ok)
    return publisherFailure(
      "ambiguous_outcome",
      "Artifact publication succeeded but receipt persistence failed.",
    );
  return {
    ok: true as const,
    value: {
      publication: updated.value.publication,
      shareUrl: dispatched.value.shareUrl,
      revocationHandle: handle,
    },
  };
}
