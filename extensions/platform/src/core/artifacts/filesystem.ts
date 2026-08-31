import { lstat, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { success } from "../result.ts";
import type {
  ArtifactMetadata,
  ArtifactOutcome,
  ArtifactStore,
  FileSystemArtifactStoreOptions,
  PutArtifactInput,
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
  validateArtifactMetadata,
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

  async function withValidatedStoreLock<T>(operation: () => Promise<T>) {
    return withStoreLock(root, async () => {
      await ensureLayout();
      return operation();
    });
  }

  function isInsideStore(candidate: string) {
    const relation = relative(root, resolve(candidate));
    return (
      relation === "" ||
      (!isAbsolute(relation) &&
        relation !== ".." &&
        !relation.startsWith(`..${sep}`))
    );
  }

  function ioError(error: unknown) {
    return artifactError(
      "io_error",
      error instanceof Error ? error.message : String(error),
      { retryable: true },
    );
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
      if (!validateArtifactId(entry.name)) continue;
      const bodyEntry = await lstat(join(bodies, entry.name));
      if (bodyEntry.isSymbolicLink() || !bodyEntry.isFile()) {
        throw new Error(
          `Artifact body is not a real regular file: ${entry.name}`,
        );
      }
      total += bodyEntry.size;
    }
    return total;
  }

  function prepare(input: PutArtifactInput):
    | { readonly ok: false; readonly outcome: ArtifactOutcome<never> }
    | {
        readonly ok: true;
        readonly body: Buffer;
        readonly serialized: string;
        readonly snapshot: ArtifactMetadata;
      } {
    const body = artifactBody(input.body);
    if (body.byteLength > limits.maxArtifactBytes)
      return {
        ok: false,
        outcome: artifactError(
          "artifact_too_large",
          "Artifact exceeds per-artifact limit",
        ),
      };
    const metadata = createMetadata(input, body, clock());
    if (!metadata.ok) return { ok: false, outcome: metadata };
    const serialized = serializeMetadata(
      metadata.value,
      limits.maxMetadataBytes,
    );
    if (!serialized.ok) return { ok: false, outcome: serialized };
    return {
      ok: true,
      body,
      serialized: serialized.value,
      snapshot: JSON.parse(serialized.value) as ArtifactMetadata,
    };
  }

  async function putUnlocked(prepared: {
    body: Buffer;
    serialized: string;
    snapshot: ArtifactMetadata;
  }) {
    const { body, serialized, snapshot } = prepared;
    const existing = await readStoredArtifact(snapshot.id);
    if (existing.ok)
      return {
        outcome: artifactMetadataCompatible(existing.value.metadata, snapshot)
          ? success(existing.value.metadata)
          : artifactError(
              "metadata_conflict",
              `Artifact metadata conflicts for body: ${snapshot.id}`,
            ),
        created: undefined,
      };
    if (existing.error.code !== "artifact_not_found")
      return { outcome: existing, created: undefined };
    const bodyPath = join(bodies, snapshot.id);
    let bodyExists = false;
    try {
      const persistedBody = await readBoundedRegularFile(
        bodyPath,
        limits.maxArtifactBytes,
      );
      bodyExists = true;
      if (sha256(persistedBody) !== snapshot.id)
        return {
          outcome: artifactError(
            "corrupt_artifact",
            `Artifact body hash collision: ${snapshot.id}`,
          ),
          created: undefined,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const additionalBytes = bodyExists ? 0 : body.byteLength;
    if ((await storedBytes()) + additionalBytes > limits.maxTotalBytes)
      return {
        outcome: artifactError(
          "quota_exceeded",
          "Artifact store quota exceeded",
        ),
        created: undefined,
      };
    const bodyCreated = bodyExists
      ? false
      : await writeFileAtomicNew(bodyPath, body);
    try {
      const metadataCreated = await writeFileAtomicNew(
        join(metadataDirectory, `${snapshot.id}.json`),
        serialized,
      );
      if (!metadataCreated) {
        if (bodyCreated) await unlink(bodyPath).catch(() => undefined);
        const raced = await readStoredArtifact(snapshot.id);
        return {
          outcome: raced.ok ? success(raced.value.metadata) : raced,
          created: undefined,
        };
      }
      return {
        outcome: success(snapshot),
        created: { id: snapshot.id, bodyCreated, metadataCreated: true },
      };
    } catch (error) {
      if (bodyCreated) await unlink(bodyPath).catch(() => undefined);
      throw error;
    }
  }

  const store: ArtifactStore = {
    async put(input) {
      try {
        const prepared = prepare(input);
        if (!prepared.ok) return prepared.outcome;
        return await withValidatedStoreLock(
          async () => (await putUnlocked(prepared)).outcome,
        );
      } catch (error) {
        return ioError(error);
      }
    },

    async putBatch(inputs) {
      if (inputs.length < 1 || inputs.length > 1_000)
        return artifactError(
          "invalid_input",
          "Artifact batch must contain 1 through 1000 entries",
        );
      try {
        const prepared = inputs.map(prepare);
        const invalid = prepared.find((entry) => !entry.ok);
        if (invalid && !invalid.ok) return invalid.outcome;
        return await withValidatedStoreLock(async () => {
          const created: Array<{
            id: string;
            bodyCreated: boolean;
            metadataCreated: boolean;
          }> = [];
          const results: ArtifactMetadata[] = [];
          for (const entry of prepared) {
            if (!entry.ok) return entry.outcome;
            const persisted = await putUnlocked(entry);
            if (!persisted.outcome.ok) {
              for (const item of created.reverse()) {
                if (item.metadataCreated)
                  await unlink(join(metadataDirectory, `${item.id}.json`));
                if (item.bodyCreated) await unlink(join(bodies, item.id));
              }
              return persisted.outcome;
            }
            if (persisted.created) created.push(persisted.created);
            results.push(persisted.outcome.value);
          }
          return success(results);
        });
      } catch (error) {
        return ioError(error);
      }
    },

    async get(id) {
      try {
        return await withValidatedStoreLock(async () => {
          const artifact = await readStoredArtifact(id);
          if (!artifact.ok) return artifact;
          if (isExpired(artifact.value.metadata, clock())) {
            return artifactError("artifact_expired", `Artifact expired: ${id}`);
          }
          return artifact;
        });
      } catch (error) {
        return ioError(error);
      }
    },

    async export(id, input) {
      try {
        if (isInsideStore(input.directory)) {
          return artifactError(
            "invalid_input",
            "Artifact export directory must be outside the private store",
          );
        }
        const artifact = await withValidatedStoreLock(async () => {
          const stored = await readStoredArtifact(id);
          if (!stored.ok) return stored;
          if (isExpired(stored.value.metadata, clock())) {
            return artifactError("artifact_expired", `Artifact expired: ${id}`);
          }
          return stored;
        });
        if (!artifact.ok) return artifact;
        return exportArtifact(
          artifact.value.metadata,
          artifact.value.body,
          input,
        );
      } catch (error) {
        return ioError(error);
      }
    },

    async list(input = {}) {
      try {
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
        return await withValidatedStoreLock(async () => {
          const current: ArtifactMetadata[] = [];
          const entries = await readdir(metadataDirectory, {
            withFileTypes: true,
          });
          for (const entry of entries) {
            if (!entry.name.endsWith(".json")) continue;
            const id = entry.name.slice(0, -".json".length);
            if (!validateArtifactId(id)) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(
                (
                  await readBoundedRegularFile(
                    join(metadataDirectory, entry.name),
                    limits.maxMetadataBytes,
                  )
                ).toString("utf8"),
              );
            } catch {
              continue;
            }
            const metadata = validateArtifactMetadata(id, parsed);
            if (!metadata.ok) continue;
            if (!isExpired(metadata.value, clock()))
              current.push(metadata.value);
          }
          current.sort(
            (left, right) =>
              right.createdAt - left.createdAt ||
              left.id.localeCompare(right.id),
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
        });
      } catch (error) {
        return ioError(error);
      }
    },

    async remove(id) {
      try {
        if (!validateArtifactId(id)) {
          return artifactError(
            "invalid_artifact_id",
            `Invalid artifact id: ${id}`,
          );
        }
        return await withValidatedStoreLock(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              (
                await readBoundedRegularFile(
                  join(metadataDirectory, `${id}.json`),
                  limits.maxMetadataBytes,
                )
              ).toString("utf8"),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return artifactError(
                "artifact_not_found",
                `Artifact not found: ${id}`,
              );
            return artifactError(
              "corrupt_artifact",
              `Artifact metadata is invalid: ${id}`,
            );
          }
          const metadata = validateArtifactMetadata(id, parsed);
          if (!metadata.ok) return metadata;
          await unlink(join(metadataDirectory, `${id}.json`));
          try {
            await unlink(join(bodies, id));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return success(metadata.value);
        });
      } catch (error) {
        return ioError(error);
      }
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
        return await withValidatedStoreLock(async () => {
          const retainedBodies = new Set<string>();
          const metadataToRemove: string[] = [];
          const metadataTemporariesToRemove: string[] = [];
          const bodiesToRemove = new Map<string, number>();

          const metadataEntries = (
            await readdir(metadataDirectory, { withFileTypes: true })
          ).sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of metadataEntries) {
            const metadataPath = join(metadataDirectory, entry.name);
            const isTemporary = entry.name.endsWith(".tmp");
            const isMetadata = entry.name.endsWith(".json");
            if (!isTemporary && !isMetadata) continue;

            const metadataEntry = await lstat(metadataPath);
            if (metadataEntry.isSymbolicLink() || !metadataEntry.isFile()) {
              throw new Error(
                `Artifact metadata is not a real regular file: ${entry.name}`,
              );
            }
            if (isTemporary) {
              metadataTemporariesToRemove.push(metadataPath);
              continue;
            }

            const id = entry.name.slice(0, -".json".length);
            if (!validateArtifactId(id)) continue;
            const stored = await readStoredArtifact(id);
            if (stored.ok) {
              if (isExpired(stored.value.metadata, now)) {
                metadataToRemove.push(metadataPath);
              } else {
                retainedBodies.add(id);
              }
            } else if (stored.error.code === "corrupt_artifact") {
              metadataToRemove.push(metadataPath);
            } else if (stored.error.code === "artifact_not_found") {
              continue;
            } else {
              return stored;
            }
          }

          const bodyEntries = (
            await readdir(bodies, { withFileTypes: true })
          ).sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of bodyEntries) {
            const bodyPath = join(bodies, entry.name);
            const isTemporary = entry.name.endsWith(".tmp");
            const isOrphan =
              validateArtifactId(entry.name) && !retainedBodies.has(entry.name);
            if (!isTemporary && !isOrphan) continue;

            const bodyEntry = await lstat(bodyPath);
            if (bodyEntry.isSymbolicLink() || !bodyEntry.isFile()) {
              throw new Error(
                `Artifact body is not a real regular file: ${entry.name}`,
              );
            }
            bodiesToRemove.set(bodyPath, bodyEntry.size);
          }

          for (const metadataPath of metadataTemporariesToRemove) {
            await unlink(metadataPath);
          }
          for (const metadataPath of metadataToRemove) {
            await unlink(metadataPath);
          }
          for (const bodyPath of bodiesToRemove.keys()) {
            await unlink(bodyPath);
          }

          const reclaimedBytes = [...bodiesToRemove.values()].reduce(
            (total, size) => total + size,
            0,
          );
          return success({
            removedArtifacts: metadataToRemove.length,
            reclaimedBytes,
          });
        });
      } catch (error) {
        return ioError(error);
      }
    },
  };
  return store;
}
