import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const STALE_RECLAMATION_GUARD_MS = 30_000;
const LOCK_OWNER_MAX_BYTES = 4_096;

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function applyMode(path: string, mode: number) {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["ENOSYS", "EPERM", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return;
    }
    throw error;
  }
}

export async function ensurePrivateDirectory(path: string) {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Private directory is not a real directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const created = await lstat(path);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Private directory is not a real directory: ${path}`);
  }
  await applyMode(path, 0o700);
}

export async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
) {
  // O_NOFOLLOW is unavailable on Windows. This preflight rejects an existing
  // junction/reparse point; ArtifactStore callers hold the cooperative store
  // lock across this check and use. A same-user malicious process can still
  // replace a path between Node filesystem calls.
  const entry = await lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Artifact path is not a real regular file: ${filePath}`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const file = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    if (!info.isFile())
      throw new Error(`Artifact path is not a regular file: ${filePath}`);
    if (info.size > maxBytes) {
      const error = new Error(
        `Artifact file exceeds ${maxBytes} byte limit: ${filePath}`,
      );
      (error as NodeJS.ErrnoException).code = "EFILETOOLARGE";
      throw error;
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function statLockEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isRealLockDirectory(entry: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}) {
  return !entry.isSymbolicLink() && entry.isDirectory();
}

async function readLockOwner(lockPath: string) {
  const lockEntry = await statLockEntry(lockPath);
  if (!lockEntry || !isRealLockDirectory(lockEntry)) return undefined;

  const ownerPath = join(lockPath, "owner.json");
  const ownerEntry = await statLockEntry(ownerPath);
  if (!ownerEntry || ownerEntry.isSymbolicLink() || !ownerEntry.isFile()) {
    return undefined;
  }

  let ownerText: string;
  try {
    ownerText = (
      await readBoundedRegularFile(ownerPath, LOCK_OWNER_MAX_BYTES)
    ).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    return JSON.parse(ownerText) as {
      pid?: unknown;
      token?: unknown;
    };
  } catch {
    return undefined;
  }
}

async function removeQuarantinedLock(quarantinePath: string) {
  const entry = await statLockEntry(quarantinePath);
  if (!entry) return;
  if (!isRealLockDirectory(entry)) return;
  try {
    await unlink(join(quarantinePath, "owner.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rmdir(quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function quarantinePath(lockPath: string) {
  return `${lockPath}.quarantine.${process.pid}.${randomBytes(16).toString("hex")}`;
}

async function moveToQuarantine(lockPath: string) {
  const destination = quarantinePath(lockPath);
  try {
    await rename(lockPath, destination);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function restoreQuarantinedLock(quarantine: string, lockPath: string) {
  try {
    await rename(quarantine, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reclaimStaleLock(lockPath: string) {
  const entry = await statLockEntry(lockPath);
  if (!entry) return;
  if (!isRealLockDirectory(entry)) return;
  if (Date.now() - entry.mtimeMs < STALE_LOCK_MS) return;

  const quarantine = await moveToQuarantine(lockPath);
  if (!quarantine) return;
  let restore = true;
  try {
    const quarantinedEntry = await statLockEntry(quarantine);
    if (!quarantinedEntry || !isRealLockDirectory(quarantinedEntry)) return;
    const owner = await readLockOwner(quarantine);
    if (typeof owner?.pid === "number" && processExists(owner.pid)) return;
    restore = false;
    await removeQuarantinedLock(quarantine);
  } finally {
    if (restore) await restoreQuarantinedLock(quarantine, lockPath);
  }
}

async function reclaimStaleReclamationGuard(guardPath: string) {
  const entry = await statLockEntry(guardPath);
  if (!entry) return false;
  if (!isRealLockDirectory(entry)) {
    throw new Error(
      `Artifact store reclamation guard is not a real directory: ${guardPath}`,
    );
  }
  if (Date.now() - entry.mtimeMs < STALE_RECLAMATION_GUARD_MS) return false;

  const quarantine = await moveToQuarantine(guardPath);
  if (!quarantine) return false;
  const quarantinedEntry = await statLockEntry(quarantine);
  if (!quarantinedEntry || !isRealLockDirectory(quarantinedEntry)) {
    throw new Error(
      `Quarantined artifact store reclamation guard is not a real directory: ${quarantine}`,
    );
  }
  await rmdir(quarantine);
  return true;
}

async function withReclamationGuard<T>(
  root: string,
  startedAt: number,
  operation: () => Promise<T>,
) {
  const guardPath = join(root, ".artifact-store.reclamation");
  for (;;) {
    try {
      await mkdir(guardPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimStaleReclamationGuard(guardPath)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        const lockError = new Error(
          "Timed out waiting for artifact store reclamation guard",
        );
        (lockError as NodeJS.ErrnoException).code = "ELOCKTIMEOUT";
        throw lockError;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      await rmdir(guardPath);
    } catch {
      // Guard cleanup failure must not hide a completed lock transition.
    }
  }
}

async function releaseOwnedLock(root: string, lockPath: string, token: string) {
  await withReclamationGuard(root, Date.now(), async () => {
    const owner = await readLockOwner(lockPath);
    if (owner?.token !== token) return;

    const quarantine = await moveToQuarantine(lockPath);
    if (!quarantine) return;
    let restore = true;
    try {
      const movedOwner = await readLockOwner(quarantine);
      if (movedOwner?.token !== token) return;
      restore = false;
      await removeQuarantinedLock(quarantine);
    } finally {
      if (restore) await restoreQuarantinedLock(quarantine, lockPath);
    }
  });
}

export async function withStoreLock<T>(
  root: string,
  operation: () => Promise<T>,
) {
  await ensurePrivateDirectory(root);
  const lockPath = join(root, ".artifact-store.lock");
  const token = randomBytes(16).toString("hex");
  const startedAt = Date.now();

  for (;;) {
    const acquired = await withReclamationGuard(root, startedAt, async () => {
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await reclaimStaleLock(lockPath);
        return false;
      }

      try {
        await writeFile(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        return true;
      } catch (error) {
        const quarantine = await moveToQuarantine(lockPath);
        if (quarantine) await removeQuarantinedLock(quarantine);
        throw error;
      }
    });
    if (acquired) break;
    if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
      const lockError = new Error("Timed out waiting for artifact store lock");
      (lockError as NodeJS.ErrnoException).code = "ELOCKTIMEOUT";
      throw lockError;
    }
    await sleep(LOCK_RETRY_MS);
  }

  try {
    return await operation();
  } finally {
    try {
      await releaseOwnedLock(root, lockPath, token);
    } catch {
      // A missing/replaced lock must not hide the operation result.
    }
  }
}

/** Same-directory, restrictive, bounded-by-caller creation without overwrite. */
export async function writeFileAtomicNew(
  filePath: string,
  content: string | Uint8Array,
) {
  await ensurePrivateDirectory(dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let created = false;
  let operationFailed = false;
  let temporaryCreated = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, filePath);
      created = true;
      await applyMode(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return created;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      if (temporaryCreated) await unlink(temporary);
    } catch (error) {
      if (
        !operationFailed &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
}
