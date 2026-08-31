import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { success } from "../result.ts";
import type {
  ArtifactMetadata,
  ArtifactOutcome,
  ExportArtifactInput,
  ExportedArtifact,
} from "./model.ts";
import { artifactError, validateFilename } from "./shared.ts";

async function verifyRealDirectory(directory: string) {
  let current = resolve(directory);
  for (;;) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(`Export parent is not a real directory: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

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
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let temporaryCreated = false;
  let file;
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    await verifyRealDirectory(input.directory);
    file = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    await file.writeFile(body);
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporary, destination);
    return success({ artifact, path: destination });
  } catch (error) {
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
  } finally {
    await file?.close();
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
  }
}
