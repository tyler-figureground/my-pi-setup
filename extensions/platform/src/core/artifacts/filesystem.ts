import { readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { success } from "../result.ts";
import type {
  ArtifactMetadata,
  ArtifactStore,
  FileSystemArtifactStoreOptions,
} from "./model.ts";
import { exportArtifact } from "./exporter.ts";
import {
  ensurePrivateDirectory,
  readBoundedRegularFile,
  withStoreLock,
  writeFileAtomicNew,
} from "./persistence.ts";
import {
  artifactBody,
  artifactError,
  artifactMetadataCompatible,
  createMetadata,
  isExpired,
  resolveOptions,
  serializeMetadata,
  sha256,
  validateArtifactId,
  validateLimits,
  validateStoredArtifact,
} from "./shared.ts";

export function createFileSystemArtifactStore(
  options: FileSystemArtifactStoreOptions,
): ArtifactStore {
  const { limits, clock } = resolveOptions(options);
  validateLimits(limits);
  if (options.root.length === 0) {
    throw new TypeError("Artifact store root must not be empty");
  }
  const root = resolve(options.root);
  const bodies = join(root, "bodies");
  const metadataDirectory = join(root, "metadata");

  async function ensureLayout() {
    await ensurePrivateDirectory(root);
    await Promise.all([
      ensurePrivateDirectory(bodies),
      ensurePrivateDirectory(metadataDirectory),
    ]);
  }

  async function readStoredArtifact(id: string) {
    if (!validateArtifactId(id)) {
      return artifactError("invalid_artifact_id", `Invalid artifact id: ${id}`);
    }

    let metadataText: string;
    try {
      metadataText = (
        await readBoundedRegularFile(
          join(metadataDirectory, `${id}.json`),
          limits.maxMetadataBytes,
        )
      ).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return artifactError("artifact_not_found", `Artifact not found: ${id}`);
      }
      return artifactError(
        "io_error",
        error instanceof Error ? error.message : String(error),
        { retryable: true },
      );
    }

    let metadataValue: unknown;
    try {
      metadataValue = JSON.parse(metadataText);
    } catch {
      return artifactError(
        "corrupt_artifact",
        `Invalid metadata for artifact: ${id}`,
      );
    }

    try {
      const body = await readBoundedRegularFile(
        join(bodies, id),
        limits.maxArtifactBytes,
      );
      return validateStoredArtifact(id, metadataValue, body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return artifactError(
          "corrupt_artifact",
          `Artifact body is missing: ${id}`,
        );
      }
      return artifactError(
        "io_error",
        error instanceof Error ? error.message : String(error),
        { retryable: true },
      );
    }
  }

  async function storedBytes() {
    const entries = await readdir(bodies, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !validateArtifactId(entry.name)) continue;
      total += (await stat(join(bodies, entry.name))).size;
    }
    return total;
  }

  return {
    async put(input) {
      try {
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

        await ensureLayout();
        return await withStoreLock(root, async () => {
          const existing = await readStoredArtifact(snapshot.id);
          if (existing.ok) {
            if (
              !artifactMetadataCompatible(existing.value.metadata, snapshot)
            ) {
              return artifactError(
                "metadata_conflict",
                `Artifact metadata conflicts for body: ${snapshot.id}`,
              );
            }
            return success(existing.value.metadata);
          }
          if (existing.error.code !== "artifact_not_found") return existing;

          const bodyPath = join(bodies, snapshot.id);
          let bodyExists = false;
          try {
            const persistedBody = await readBoundedRegularFile(
              bodyPath,
              limits.maxArtifactBytes,
            );
            bodyExists = true;
            if (sha256(persistedBody) !== snapshot.id) {
              return artifactError(
                "corrupt_artifact",
                `Artifact body hash collision: ${snapshot.id}`,
              );
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }

          const additionalBytes = bodyExists ? 0 : body.byteLength;
          if ((await storedBytes()) + additionalBytes > limits.maxTotalBytes) {
            return artifactError(
              "quota_exceeded",
              "Artifact store quota exceeded",
            );
          }

          const bodyCreated = bodyExists
            ? false
            : await writeFileAtomicNew(bodyPath, body);
          try {
            const metadataCreated = await writeFileAtomicNew(
              join(metadataDirectory, `${snapshot.id}.json`),
              serialized.value,
            );
            if (!metadataCreated) {
              const raced = await readStoredArtifact(snapshot.id);
              if (raced.ok) return success(raced.value.metadata);
              return raced;
            }
          } catch (error) {
            if (bodyCreated) {
              try {
                await unlink(bodyPath);
              } catch {
                // Preserve metadata persistence failure.
              }
            }
            throw error;
          }
          return success(snapshot);
        });
      } catch (error) {
        return artifactError(
          "io_error",
          error instanceof Error ? error.message : String(error),
          { retryable: true },
        );
      }
    },

    async get(id) {
      const artifact = await readStoredArtifact(id);
      if (!artifact.ok) return artifact;
      if (isExpired(artifact.value.metadata, clock())) {
        return artifactError("artifact_expired", `Artifact expired: ${id}`);
      }
      return artifact;
    },

    async export(id, input) {
      const artifact = await readStoredArtifact(id);
      if (!artifact.ok) return artifact;
      if (isExpired(artifact.value.metadata, clock())) {
        return artifactError("artifact_expired", `Artifact expired: ${id}`);
      }
      return exportArtifact(
        artifact.value.metadata,
        artifact.value.body,
        input,
      );
    },

    async collect(input = {}) {
      try {
        const now = input.now ?? clock();
        if (!Number.isSafeInteger(now)) {
          return artifactError(
            "invalid_input",
            "Artifact collection time must be a safe integer",
          );
        }
        await ensureLayout();
        return await withStoreLock(root, async () => {
          const retainedBodies = new Set<string>();
          let removedArtifacts = 0;
          let reclaimedBytes = 0;

          const metadataEntries = await readdir(metadataDirectory, {
            withFileTypes: true,
          });
          for (const entry of metadataEntries) {
            if (!entry.isFile()) continue;
            const metadataPath = join(metadataDirectory, entry.name);
            if (entry.name.endsWith(".tmp")) {
              await unlink(metadataPath);
              continue;
            }
            if (!entry.name.endsWith(".json")) continue;
            const id = entry.name.slice(0, -".json".length);
            if (!validateArtifactId(id)) continue;
            const stored = await readStoredArtifact(id);
            const remove = !stored.ok || isExpired(stored.value.metadata, now);
            if (!remove) {
              retainedBodies.add(id);
              continue;
            }

            const bodyPath = join(bodies, id);
            try {
              reclaimedBytes += (await stat(bodyPath)).size;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            await unlink(metadataPath);
            try {
              await unlink(bodyPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            removedArtifacts++;
          }

          const bodyEntries = await readdir(bodies, { withFileTypes: true });
          for (const entry of bodyEntries) {
            if (!entry.isFile()) continue;
            const bodyPath = join(bodies, entry.name);
            const isTemporary = entry.name.endsWith(".tmp");
            const isOrphan =
              validateArtifactId(entry.name) && !retainedBodies.has(entry.name);
            if (!isTemporary && !isOrphan) continue;
            reclaimedBytes += (await stat(bodyPath)).size;
            await unlink(bodyPath);
          }

          return success({ removedArtifacts, reclaimedBytes });
        });
      } catch (error) {
        return artifactError(
          "io_error",
          error instanceof Error ? error.message : String(error),
          { retryable: true },
        );
      }
    },
  };
}
