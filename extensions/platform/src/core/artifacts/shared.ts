import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject } from "../result.ts";
import { failure, success } from "../result.ts";
import {
  DEFAULT_ARTIFACT_LIMITS,
  type ArtifactLimits,
  type ArtifactMetadata,
  type ArtifactOutcome,
  type ArtifactStoreErrorCode,
  type ArtifactStoreOptions,
  type PutArtifactInput,
  type StoredArtifact,
} from "./model.ts";

export function resolveOptions(options: ArtifactStoreOptions = {}) {
  return {
    limits: { ...DEFAULT_ARTIFACT_LIMITS, ...options.limits },
    clock: options.clock ?? Date.now,
  };
}

export function artifactBody(body: PutArtifactInput["body"]) {
  return typeof body === "string"
    ? Buffer.from(body, "utf8")
    : Buffer.from(body);
}

export function sha256(body: Uint8Array) {
  return createHash("sha256").update(body).digest("hex");
}

export function artifactError(
  code: ArtifactStoreErrorCode,
  message: string,
  options: { retryable?: boolean; details?: JsonObject } = {},
) {
  return failure({
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.details ? { details: options.details } : {}),
  });
}

export function validateLimits(limits: ArtifactLimits) {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
}

export function validateArtifactId(id: string) {
  return /^[a-f0-9]{64}$/u.test(id);
}

export function validateFilename(filename: string) {
  if (
    filename.length === 0 ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename === "." ||
    filename === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(filename) ||
    /[ .]$/u.test(filename)
  ) {
    return false;
  }
  const basename = (filename.split(".", 1)[0] ?? filename).replace(
    /[ .]+$/u,
    "",
  );
  return !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(
    basename,
  );
}

export function validateStoredArtifact(
  id: string,
  metadataValue: unknown,
  body: Uint8Array,
): ArtifactOutcome<StoredArtifact> {
  if (
    typeof metadataValue !== "object" ||
    metadataValue === null ||
    Array.isArray(metadataValue)
  ) {
    return artifactError(
      "corrupt_artifact",
      `Invalid metadata for artifact: ${id}`,
    );
  }
  const candidate = metadataValue as Record<string, unknown>;
  const actualSha256 = sha256(body);
  const filename = candidate.filename;
  const mediaType = candidate.mediaType;
  const customMetadata = candidate.metadata;
  const expiresAt = candidate.expiresAt;
  if (
    candidate.id !== id ||
    candidate.sha256 !== id ||
    candidate.size !== body.byteLength ||
    actualSha256 !== id ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (filename !== undefined &&
      (typeof filename !== "string" || !validateFilename(filename))) ||
    (mediaType !== undefined && typeof mediaType !== "string") ||
    (customMetadata !== undefined &&
      (typeof customMetadata !== "object" ||
        customMetadata === null ||
        Array.isArray(customMetadata))) ||
    (expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || Number(expiresAt) < 0))
  ) {
    return artifactError(
      "corrupt_artifact",
      `Artifact integrity check failed: ${id}`,
      { details: { expectedSha256: id, actualSha256 } },
    );
  }
  const metadata: ArtifactMetadata = {
    id,
    sha256: id,
    size: body.byteLength,
    createdAt: Number(candidate.createdAt),
    ...(filename === undefined ? {} : { filename: String(filename) }),
    ...(mediaType === undefined ? {} : { mediaType: String(mediaType) }),
    ...(customMetadata === undefined
      ? {}
      : { metadata: customMetadata as JsonObject }),
    ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }),
  };
  return success({ metadata, body: Buffer.from(body) });
}

export function serializeMetadata(
  metadata: ArtifactMetadata,
  maxBytes: number,
): ArtifactOutcome<string> {
  try {
    const text = JSON.stringify(metadata);
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return artifactError(
        "metadata_too_large",
        "Artifact metadata exceeds metadata limit",
        { details: { maxBytes } },
      );
    }
    return success(text);
  } catch (error) {
    return artifactError(
      "invalid_input",
      `Artifact metadata is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function artifactMetadataCompatible(
  existing: ArtifactMetadata,
  requested: ArtifactMetadata,
) {
  return isDeepStrictEqual(
    {
      filename: existing.filename,
      mediaType: existing.mediaType,
      metadata: existing.metadata,
      expiresAt: existing.expiresAt,
    },
    {
      filename: requested.filename,
      mediaType: requested.mediaType,
      metadata: requested.metadata,
      expiresAt: requested.expiresAt,
    },
  );
}

export function isExpired(metadata: ArtifactMetadata, now: number) {
  return metadata.expiresAt !== undefined && metadata.expiresAt <= now;
}

export function createMetadata(
  input: PutArtifactInput,
  body: Uint8Array,
  createdAt: number,
): ArtifactOutcome<ArtifactMetadata> {
  if (!Number.isSafeInteger(createdAt)) {
    return artifactError(
      "invalid_input",
      "Artifact clock returned an invalid time",
    );
  }
  if (
    input.expiresAt !== undefined &&
    (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)
  ) {
    return artifactError(
      "invalid_input",
      "Artifact expiresAt must be a non-negative safe integer",
    );
  }
  if (input.filename !== undefined && !validateFilename(input.filename)) {
    return artifactError(
      "invalid_filename",
      `Unsafe artifact filename: ${input.filename}`,
    );
  }
  const id = sha256(body);
  return success({
    id,
    sha256: id,
    size: body.byteLength,
    createdAt,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
}
