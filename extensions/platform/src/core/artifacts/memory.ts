import {
  artifactBody,
  artifactError,
  artifactMetadataCompatible,
  createMetadata,
  isExpired,
  resolveOptions,
  serializeMetadata,
  validateArtifactId,
  validateLimits,
} from "./shared.ts";
import { success } from "../result.ts";
import { exportArtifact } from "./exporter.ts";
import type {
  ArtifactMetadata,
  ArtifactStore,
  ArtifactStoreOptions,
} from "./model.ts";

export function createInMemoryArtifactStore(
  options: ArtifactStoreOptions = {},
): ArtifactStore {
  const { limits, clock } = resolveOptions(options);
  validateLimits(limits);
  const artifacts = new Map<
    string,
    { metadata: ArtifactMetadata; body: Buffer }
  >();

  return {
    async put(input) {
      const body = artifactBody(input.body);
      if (body.byteLength > limits.maxArtifactBytes) {
        return artifactError(
          "artifact_too_large",
          "Artifact exceeds per-artifact limit",
        );
      }
      const metadata = createMetadata(input, body, clock());
      if (!metadata.ok) return metadata;
      const serialized = serializeMetadata(
        metadata.value,
        limits.maxMetadataBytes,
      );
      if (!serialized.ok) return serialized;
      const snapshot = JSON.parse(serialized.value) as ArtifactMetadata;
      const existing = artifacts.get(snapshot.id);
      if (existing) {
        if (!artifactMetadataCompatible(existing.metadata, snapshot)) {
          return artifactError(
            "metadata_conflict",
            `Artifact metadata conflicts for body: ${snapshot.id}`,
          );
        }
        return success(structuredClone(existing.metadata));
      }
      const used = [...artifacts.values()].reduce(
        (total, artifact) => total + artifact.body.byteLength,
        0,
      );
      if (used + body.byteLength > limits.maxTotalBytes) {
        return artifactError("quota_exceeded", "Artifact store quota exceeded");
      }
      artifacts.set(snapshot.id, {
        metadata: snapshot,
        body: Buffer.from(body),
      });
      return success(structuredClone(snapshot));
    },
    async get(id) {
      if (!validateArtifactId(id)) {
        return artifactError(
          "invalid_artifact_id",
          `Invalid artifact id: ${id}`,
        );
      }
      const artifact = artifacts.get(id);
      if (!artifact) {
        return artifactError("artifact_not_found", `Artifact not found: ${id}`);
      }
      if (isExpired(artifact.metadata, clock())) {
        return artifactError("artifact_expired", `Artifact expired: ${id}`);
      }
      return success({
        metadata: structuredClone(artifact.metadata),
        body: Buffer.from(artifact.body),
      });
    },
    async export(id, input) {
      if (!validateArtifactId(id)) {
        return artifactError(
          "invalid_artifact_id",
          `Invalid artifact id: ${id}`,
        );
      }
      const artifact = artifacts.get(id);
      if (!artifact) {
        return artifactError("artifact_not_found", `Artifact not found: ${id}`);
      }
      if (isExpired(artifact.metadata, clock())) {
        return artifactError("artifact_expired", `Artifact expired: ${id}`);
      }
      return exportArtifact(
        structuredClone(artifact.metadata),
        artifact.body,
        input,
      );
    },
    async collect(input = {}) {
      const now = input.now ?? clock();
      if (!Number.isSafeInteger(now)) {
        return artifactError(
          "invalid_input",
          "Artifact collection time must be a safe integer",
        );
      }
      let removedArtifacts = 0;
      let reclaimedBytes = 0;
      for (const [id, artifact] of artifacts) {
        if (!isExpired(artifact.metadata, now)) continue;
        artifacts.delete(id);
        removedArtifacts++;
        reclaimedBytes += artifact.body.byteLength;
      }
      return success({ removedArtifacts, reclaimedBytes });
    },
  };
}
