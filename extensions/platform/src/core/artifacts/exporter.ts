import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { success } from "../result.ts";
import type {
  ArtifactMetadata,
  ArtifactOutcome,
  ExportArtifactInput,
  ExportedArtifact,
} from "./model.ts";
import { artifactError, validateFilename } from "./shared.ts";

export async function exportArtifact(
  artifact: ArtifactMetadata,
  body: Uint8Array,
  input: ExportArtifactInput,
): Promise<ArtifactOutcome<ExportedArtifact>> {
  const filename = input.filename ?? artifact.filename ?? artifact.id;
  if (!validateFilename(filename)) {
    return artifactError(
      "invalid_filename",
      `Unsafe export filename: ${filename}`,
    );
  }

  const destination = join(input.directory, filename);
  let created = false;
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const file = await open(destination, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    return success({ artifact, path: destination });
  } catch (error) {
    if (created) {
      try {
        await unlink(destination);
      } catch {
        // Preserve the original export failure.
      }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return artifactError(
        "destination_exists",
        `Export destination already exists: ${destination}`,
      );
    }
    return artifactError(
      "io_error",
      error instanceof Error ? error.message : String(error),
      { retryable: true },
    );
  }
}
