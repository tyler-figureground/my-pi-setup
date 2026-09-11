/**
 * Reads one local file for `/artifacts create` (16 MiB default cap). The
 * caller shows the result for direct user confirmation before storing it in
 * the core `ArtifactStore`.
 *
 * Rejects symlinks and non-regular files, then compares dev/inode identity
 * and canonical path before, during, and after the read, so a file swapped
 * mid-read fails instead of importing different bytes. Returns the body and
 * the canonical basename only.
 */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename } from "node:path";

export async function readArtifactImportFile(
  path: string,
  maxBytes = 16 * 1024 * 1024,
) {
  if (!path || Buffer.byteLength(path) > 4_096 || path.includes("\0"))
    throw new Error("Artifact import path is invalid.");
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes)
    throw new Error(
      "Artifact import must be a bounded regular file, not a link.",
    );
  const canonical = await realpath(path);
  const file = await open(
    canonical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("Artifact import file identity changed before read.");
    const body = await file.readFile();
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (await realpath(path)) !== canonical
    )
      throw new Error("Artifact import file identity changed during read.");
    return { body, filename: basename(canonical) };
  } finally {
    await file.close();
  }
}
