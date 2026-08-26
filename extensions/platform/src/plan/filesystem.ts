import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { PlanPersistenceAdapter } from "./index.ts";

export interface FilesystemPlanPersistence extends PlanPersistenceAdapter {
  readVerified: NonNullable<PlanPersistenceAdapter["readVerified"]>;
}

const failure = (reason: string) => ({ ok: false as const, reason });

const abortReason = () => failure("Plan persistence was aborted.");

function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isContained(root: string, candidate: string) {
  const nested = relative(root, candidate);
  return (
    nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)
  );
}

async function ensureContainedDirectory(
  root: string,
  directory: string,
  create: boolean,
) {
  const canonicalRoot = await realpath(root);
  const nested = relative(resolve(root), resolve(directory));
  if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error("Plan directory escapes its configured root.");
  }
  let current = resolve(root);
  for (const segment of nested.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissing(error) || !create) throw error;
      await mkdir(current, { mode: 0o700 });
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        "Plan directory cannot contain links or non-directories.",
      );
    }
    const canonicalCurrent = await realpath(current);
    if (!isContained(canonicalRoot, canonicalCurrent)) {
      throw new Error("Plan directory resolves outside its configured root.");
    }
  }
  const canonicalDirectory = await realpath(current);
  const identity = await lstat(canonicalDirectory);
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error("Plan directory identity is unsafe.");
  }
  return {
    canonicalRoot,
    canonicalDirectory,
    directoryDevice: identity.dev,
    directoryInode: identity.ino,
  };
}

export function createFilesystemPlanPersistence(): FilesystemPlanPersistence {
  return {
    async writeAtomic({ destination, content, signal }) {
      if (signal?.aborted) return abortReason();
      if (!isAbsolute(destination.root) || !isAbsolute(destination.path)) {
        return failure("Plan root and destination must be absolute.");
      }
      const lexicalPath = relative(destination.root, destination.path);
      if (
        lexicalPath === ".." ||
        lexicalPath.startsWith(`..${sep}`) ||
        isAbsolute(lexicalPath)
      ) {
        return failure("Plan destination escapes its configured root.");
      }

      const directory = dirname(destination.path);
      let canonicalRoot: string;
      let canonicalDirectory: string;
      let directoryDevice: number;
      let directoryInode: number;
      try {
        ({
          canonicalRoot,
          canonicalDirectory,
          directoryDevice,
          directoryInode,
        } = await ensureContainedDirectory(destination.root, directory, true));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      if (!isContained(canonicalRoot, canonicalDirectory)) {
        return failure("Plan directory resolves outside its configured root.");
      }

      const filename = basename(destination.path);
      const publishedPath = join(canonicalDirectory, filename);
      const temporaryPath = join(
        canonicalDirectory,
        `.${filename}.${randomUUID()}.pending`,
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const beforeWrite = await lstat(canonicalDirectory);
        if (
          beforeWrite.isSymbolicLink() ||
          beforeWrite.dev !== directoryDevice ||
          beforeWrite.ino !== directoryInode
        ) {
          return failure("Plan directory identity changed before write.");
        }
        handle = await open(temporaryPath, "wx", 0o600);
        if (signal?.aborted) return abortReason();
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (signal?.aborted) return abortReason();

        const beforePublish = await lstat(canonicalDirectory);
        if (
          beforePublish.isSymbolicLink() ||
          beforePublish.dev !== directoryDevice ||
          beforePublish.ino !== directoryInode
        ) {
          return failure("Plan directory identity changed before publish.");
        }
        await link(temporaryPath, publishedPath);
        const afterPublish = await lstat(canonicalDirectory);
        if (
          afterPublish.isSymbolicLink() ||
          afterPublish.dev !== directoryDevice ||
          afterPublish.ino !== directoryInode
        ) {
          await unlink(publishedPath).catch(() => undefined);
          return failure("Plan directory identity changed during publish.");
        }
        return { ok: true };
      } catch (error) {
        if (signal?.aborted) return abortReason();
        return failure(error instanceof Error ? error.message : String(error));
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
    },
    async readVerified({ destination, expectedHash, maxBytes, signal }) {
      if (signal?.aborted) return abortReason();
      if (
        !/^[a-f0-9]{64}$/.test(expectedHash) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1
      ) {
        return failure("Plan read verification parameters are invalid.");
      }
      if (!isAbsolute(destination.root) || !isAbsolute(destination.path)) {
        return failure("Plan root and destination must be absolute.");
      }
      const lexicalPath = relative(destination.root, destination.path);
      if (
        lexicalPath === ".." ||
        lexicalPath.startsWith(`..${sep}`) ||
        isAbsolute(lexicalPath)
      ) {
        return failure("Plan destination escapes its configured root.");
      }
      let canonicalDirectory: string;
      let directoryDevice: number;
      let directoryInode: number;
      try {
        ({ canonicalDirectory, directoryDevice, directoryInode } =
          await ensureContainedDirectory(
            destination.root,
            dirname(destination.path),
            false,
          ));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
      const publishedPath = join(
        canonicalDirectory,
        basename(destination.path),
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const directoryBefore = await lstat(canonicalDirectory);
        if (
          directoryBefore.isSymbolicLink() ||
          directoryBefore.dev !== directoryDevice ||
          directoryBefore.ino !== directoryInode
        ) {
          return failure("Plan directory identity changed before read.");
        }
        const metadata = await lstat(publishedPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          return failure("Plan path must be a regular file, not a link.");
        }
        handle = await open(
          publishedPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== metadata.dev ||
          opened.ino !== metadata.ino
        ) {
          return failure("Plan file identity changed before open.");
        }
        if (opened.size > maxBytes) {
          return failure(`Plan exceeds the ${maxBytes} byte read limit.`);
        }
        const bytes = await handle.readFile();
        const [directoryAfter, fileAfter] = await Promise.all([
          lstat(canonicalDirectory),
          lstat(publishedPath),
        ]);
        if (
          directoryAfter.isSymbolicLink() ||
          directoryAfter.dev !== directoryDevice ||
          directoryAfter.ino !== directoryInode ||
          fileAfter.isSymbolicLink() ||
          fileAfter.dev !== opened.dev ||
          fileAfter.ino !== opened.ino
        ) {
          return failure("Plan path identity changed during read.");
        }
        if (signal?.aborted) return abortReason();
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (hash !== expectedHash) {
          return failure("Plan content hash does not match persisted state.");
        }
        return {
          ok: true,
          content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}
