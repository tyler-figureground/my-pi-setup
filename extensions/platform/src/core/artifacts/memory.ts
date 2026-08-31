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

  const store: ArtifactStore = {
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
        if (!artifactMetadataCompatible(existing.metadata, snapshot))
          return artifactError(
            "metadata_conflict",
            `Artifact metadata conflicts for body: ${snapshot.id}`,
          );
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
    async putBatch(inputs) {
      if (inputs.length < 1 || inputs.length > 1_000)
        return artifactError(
          "invalid_input",
          "Artifact batch must contain 1 through 1000 entries",
        );
      const snapshot = new Map(
        [...artifacts].map(([id, artifact]) => [
          id,
          {
            metadata: structuredClone(artifact.metadata),
            body: Buffer.from(artifact.body),
          },
        ]),
      );
      const results: ArtifactMetadata[] = [];
      for (const input of inputs) {
        const result = await store.put(input);
        if (!result.ok) {
          artifacts.clear();
          for (const [id, artifact] of snapshot) artifacts.set(id, artifact);
          return result;
        }
        results.push(result.value);
      }
      return success(results);
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
    async list(input = {}) {
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return artifactError(
          "invalid_input",
          "Artifact list limit must be an integer from 1 through 100",
        );
      }
      if (input.cursor !== undefined && !validateArtifactId(input.cursor)) {
        return artifactError(
          "invalid_artifact_id",
          `Invalid artifact cursor: ${input.cursor}`,
        );
      }
      const current = [...artifacts.values()]
        .filter(({ metadata }) => !isExpired(metadata, clock()))
        .map(({ metadata }) => structuredClone(metadata))
        .sort(
          (left, right) =>
            right.createdAt - left.createdAt || left.id.localeCompare(right.id),
        );
      const start =
        input.cursor === undefined
          ? 0
          : current.findIndex(({ id }) => id === input.cursor) + 1;
      if (input.cursor !== undefined && start === 0) {
        return artifactError(
          "invalid_input",
          "Artifact list cursor is not present in the current catalog",
        );
      }
      const page = current.slice(start, start + limit);
      return success({
        artifacts: page,
        ...(start + page.length < current.length
          ? { nextCursor: page.at(-1)!.id }
          : {}),
      });
    },
    async remove(id) {
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
      artifacts.delete(id);
      return success(structuredClone(artifact.metadata));
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
  return store;
}
