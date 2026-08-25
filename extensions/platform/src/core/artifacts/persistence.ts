import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

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

async function removeLockDirectory(lockPath: string) {
  try {
    await unlink(join(lockPath, "owner.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeStaleLock(lockPath: string) {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs < STALE_LOCK_MS) return;

  try {
    const owner = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    if (typeof owner.pid === "number" && processExists(owner.pid)) return;
  } catch {
    // An old unreadable owner record cannot prove the lock is live.
  }
  await removeLockDirectory(lockPath);
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
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(lockPath);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        const lockError = new Error(
          "Timed out waiting for artifact store lock",
        );
        (lockError as NodeJS.ErrnoException).code = "ELOCKTIMEOUT";
        throw lockError;
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }

    try {
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      break;
    } catch (error) {
      await removeLockDirectory(lockPath);
      throw error;
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(
        await readFile(join(lockPath, "owner.json"), "utf8"),
      ) as { token?: unknown };
      if (owner.token === token) {
        await removeLockDirectory(lockPath);
      }
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
