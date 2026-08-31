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

const artifactTypes = new Set([
  "markdown",
  "html",
  "json",
  "image",
  "bundle",
  "other",
]);
const artifactSensitivities = new Set([
  "unknown",
  "public",
  "internal",
  "confidential",
  "restricted",
]);

function boundedText(value: unknown, maximum: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0")
  );
}

export function validateArtifactMetadata(
  id: string,
  metadataValue: unknown,
): ArtifactOutcome<ArtifactMetadata> {
  if (
    typeof metadataValue !== "object" ||
    metadataValue === null ||
    Array.isArray(metadataValue)
  )
    return artifactError(
      "corrupt_artifact",
      `Invalid metadata for artifact: ${id}`,
    );
  const candidate = metadataValue as Record<string, unknown>;
  const filename = candidate.filename;
  const mediaType = candidate.mediaType;
  const title = candidate.title;
  const creator = candidate.creator;
  const projectId = candidate.projectId;
  const kind = candidate.kind;
  const sensitivity = candidate.sensitivity;
  const customMetadata = candidate.metadata;
  const expiresAt = candidate.expiresAt;
  if (
    candidate.id !== id ||
    candidate.sha256 !== id ||
    !Number.isSafeInteger(candidate.size) ||
    Number(candidate.size) < 0 ||
    !Number.isSafeInteger(candidate.createdAt) ||
    (filename !== undefined &&
      (typeof filename !== "string" || !validateFilename(filename))) ||
    (mediaType !== undefined &&
      (typeof mediaType !== "string" ||
        !boundedText(mediaType, 512) ||
        /[\r\n]/u.test(mediaType))) ||
    (title !== undefined && !boundedText(title, 512)) ||
    (creator !== undefined && !boundedText(creator, 256)) ||
    (projectId !== undefined && !boundedText(projectId, 512)) ||
    (kind !== undefined && !artifactTypes.has(String(kind))) ||
    (sensitivity !== undefined &&
      !artifactSensitivities.has(String(sensitivity))) ||
    (customMetadata !== undefined &&
      (typeof customMetadata !== "object" ||
        customMetadata === null ||
        Array.isArray(customMetadata))) ||
    (expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) || Number(expiresAt) < 0))
  )
    return artifactError(
      "corrupt_artifact",
      `Artifact metadata failed validation: ${id}`,
    );
  return success({
    id,
    sha256: id,
    size: Number(candidate.size),
    createdAt: Number(candidate.createdAt),
    ...(filename === undefined ? {} : { filename: String(filename) }),
    ...(mediaType === undefined ? {} : { mediaType: String(mediaType) }),
    ...(title === undefined ? {} : { title: String(title) }),
    ...(creator === undefined ? {} : { creator: String(creator) }),
    ...(projectId === undefined ? {} : { projectId: String(projectId) }),
    ...(kind === undefined
      ? {}
      : { kind: String(kind) as ArtifactMetadata["kind"] }),
    ...(sensitivity === undefined
      ? {}
      : {
          sensitivity: String(sensitivity) as ArtifactMetadata["sensitivity"],
        }),
    ...(customMetadata === undefined
      ? {}
      : { metadata: customMetadata as JsonObject }),
    ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }),
  });
}

export function validateStoredArtifact(
  id: string,
  metadataValue: unknown,
  body: Uint8Array,
): ArtifactOutcome<StoredArtifact> {
  const metadata = validateArtifactMetadata(id, metadataValue);
  const actualSha256 = sha256(body);
  if (
    !metadata.ok ||
    metadata.value.size !== body.byteLength ||
    actualSha256 !== id
  )
    return artifactError(
      "corrupt_artifact",
      `Artifact integrity check failed: ${id}`,
      { details: { expectedSha256: id, actualSha256 } },
    );
  return success({ metadata: metadata.value, body: Buffer.from(body) });
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
      title: existing.title,
      creator: existing.creator,
      projectId: existing.projectId,
      kind: existing.kind,
      sensitivity: existing.sensitivity,
      metadata: existing.metadata,
      expiresAt: existing.expiresAt,
    },
    {
      filename: requested.filename,
      mediaType: requested.mediaType,
      title: requested.title,
      creator: requested.creator,
      projectId: requested.projectId,
      kind: requested.kind,
      sensitivity: requested.sensitivity,
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
  for (const [name, value, maximum] of [
    ["title", input.title, 512],
    ["creator", input.creator, 256],
    ["projectId", input.projectId, 512],
  ] as const) {
    if (value !== undefined && !boundedText(value, maximum))
      return artifactError(
        "invalid_input",
        `Artifact ${name} must be bounded non-empty text`,
      );
  }
  if (
    input.mediaType !== undefined &&
    (!boundedText(input.mediaType, 512) || /[\r\n]/u.test(input.mediaType))
  )
    return artifactError("invalid_input", "Artifact mediaType is invalid");
  if (input.kind !== undefined && !artifactTypes.has(input.kind))
    return artifactError("invalid_input", "Artifact kind is invalid");
  if (
    input.sensitivity !== undefined &&
    !artifactSensitivities.has(input.sensitivity)
  )
    return artifactError("invalid_input", "Artifact sensitivity is invalid");
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
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.creator === undefined ? {} : { creator: input.creator }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.sensitivity === undefined
      ? {}
      : { sensitivity: input.sensitivity }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
}
