import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  ArtifactMetadata,
  ArtifactStore,
} from "../core/artifacts/index.ts";
import type { ModuleError, Outcome } from "../core/result.ts";

const MAX_FILES = 1_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 36 * 1024 * 1024;

export type ArtifactBundleError = ModuleError<
  | "invalid_bundle"
  | "integrity_failed"
  | "artifact_failed"
  | "destination_exists"
  | "io_error"
>;

function failure(
  code: ArtifactBundleError["code"],
  message: string,
  retryable = false,
): Outcome<never, ArtifactBundleError> {
  return { ok: false, error: { code, message, retryable } };
}

async function verifyRealParent(filePath: string) {
  let current = dirname(resolve(filePath));
  for (;;) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error("Artifact bundle parent must be a real directory.");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validMetadata(value: unknown): value is ArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    /^[a-f0-9]{64}$/u.test(item.id) &&
    item.sha256 === item.id &&
    Number.isSafeInteger(item.size) &&
    Number(item.size) >= 0 &&
    Number.isSafeInteger(item.createdAt) &&
    (item.filename === undefined || typeof item.filename === "string") &&
    (item.mediaType === undefined || typeof item.mediaType === "string") &&
    (item.metadata === undefined ||
      (!!item.metadata &&
        typeof item.metadata === "object" &&
        !Array.isArray(item.metadata))) &&
    (item.expiresAt === undefined || Number.isSafeInteger(item.expiresAt))
  );
}

async function readBundle(path: string) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES)
      throw new Error("Artifact bundle must be a bounded regular file.");
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function exportArtifactBundle(
  artifacts: ArtifactStore,
  artifactIds: readonly string[],
  path: string,
  options: { readonly clock?: () => number } = {},
) {
  if (
    artifactIds.length < 1 ||
    artifactIds.length > MAX_FILES ||
    new Set(artifactIds).size !== artifactIds.length
  )
    return failure(
      "invalid_bundle",
      "Artifact bundle IDs must be unique and bounded.",
    );
  const entries: Array<{ metadata: ArtifactMetadata; body: string }> = [];
  let totalBytes = 0;
  for (const id of artifactIds) {
    const stored = await artifacts.get(id);
    if (!stored.ok) return failure("artifact_failed", stored.error.message);
    if (stored.value.body.byteLength > MAX_FILE_BYTES)
      return failure(
        "invalid_bundle",
        "Artifact exceeds bundle per-file limit.",
      );
    totalBytes += stored.value.body.byteLength;
    if (totalBytes > MAX_BODY_BYTES)
      return failure(
        "invalid_bundle",
        "Artifact bundle exceeds aggregate body limit.",
      );
    entries.push({
      metadata: stored.value.metadata,
      body: Buffer.from(stored.value.body).toString("base64"),
    });
  }
  const manifest = {
    format: "pi-artifact-bundle" as const,
    version: 1,
    createdAt: (options.clock ?? Date.now)(),
    entries,
  };
  const encoded = JSON.stringify({
    manifest,
    manifestSha256: digest(manifest),
  });
  const encodedBytes = Buffer.byteLength(encoded);
  if (encodedBytes > MAX_BUNDLE_BYTES)
    return failure(
      "invalid_bundle",
      "Encoded Artifact bundle exceeds its byte limit.",
    );
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  let temporaryCreated = false;
  try {
    await verifyRealParent(path);
    handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(encoded, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    return {
      ok: true as const,
      value: {
        path,
        artifactIds: [...artifactIds],
        size: encodedBytes,
      },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST"
      ? failure("destination_exists", "Artifact bundle destination exists.")
      : failure("io_error", "Artifact bundle export failed.", true);
  } finally {
    await handle?.close();
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
  }
}

export async function importArtifactBundle(
  artifacts: ArtifactStore,
  path: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBundle(path));
  } catch {
    return failure(
      "invalid_bundle",
      "Artifact bundle is not bounded valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return failure("invalid_bundle", "Artifact bundle envelope is invalid.");
  const envelope = parsed as Record<string, unknown>;
  const manifest = envelope.manifest;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    envelope.manifestSha256 !== digest(manifest)
  )
    return failure(
      "integrity_failed",
      "Artifact bundle manifest digest failed.",
    );
  const value = manifest as Record<string, unknown>;
  if (
    value.format !== "pi-artifact-bundle" ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.createdAt) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > MAX_FILES
  )
    return failure("invalid_bundle", "Artifact bundle manifest is invalid.");
  const validated: Array<{ metadata: ArtifactMetadata; body: Buffer }> = [];
  let totalBytes = 0;
  for (const raw of value.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return failure("invalid_bundle", "Artifact bundle entry is invalid.");
    const entry = raw as Record<string, unknown>;
    if (!validMetadata(entry.metadata) || typeof entry.body !== "string")
      return failure(
        "invalid_bundle",
        "Artifact bundle entry metadata is invalid.",
      );
    const body = Buffer.from(entry.body, "base64");
    if (
      body.toString("base64") !== entry.body ||
      body.byteLength !== entry.metadata.size ||
      body.byteLength > MAX_FILE_BYTES ||
      createHash("sha256").update(body).digest("hex") !== entry.metadata.id
    )
      return failure("integrity_failed", "Artifact bundle body digest failed.");
    totalBytes += body.byteLength;
    if (totalBytes > MAX_BODY_BYTES)
      return failure(
        "invalid_bundle",
        "Artifact bundle exceeds aggregate body limit.",
      );
    validated.push({ metadata: entry.metadata, body });
  }
  if (
    new Set(validated.map(({ metadata }) => metadata.id)).size !==
    validated.length
  )
    return failure("invalid_bundle", "Artifact bundle contains duplicate IDs.");
  const stored = await artifacts.putBatch(
    validated.map((entry) => ({
      body: entry.body,
      ...(entry.metadata.filename ? { filename: entry.metadata.filename } : {}),
      ...(entry.metadata.mediaType
        ? { mediaType: entry.metadata.mediaType }
        : {}),
      ...(entry.metadata.title ? { title: entry.metadata.title } : {}),
      ...(entry.metadata.creator ? { creator: entry.metadata.creator } : {}),
      ...(entry.metadata.projectId
        ? { projectId: entry.metadata.projectId }
        : {}),
      ...(entry.metadata.kind ? { kind: entry.metadata.kind } : {}),
      ...(entry.metadata.sensitivity
        ? { sensitivity: entry.metadata.sensitivity }
        : {}),
      ...(entry.metadata.metadata ? { metadata: entry.metadata.metadata } : {}),
      ...(entry.metadata.expiresAt === undefined
        ? {}
        : { expiresAt: entry.metadata.expiresAt }),
    })),
  );
  if (!stored.ok) return failure("artifact_failed", stored.error.message);
  return {
    ok: true as const,
    value: { artifactIds: stored.value.map(({ id }) => id) },
  };
}
