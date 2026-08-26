import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createRuleCatalog,
  type RuleCatalogOptions,
  type RuleCatalogStorage,
} from "./index.ts";

const MAX_SCAN_ENTRIES = 4_096;
const MAX_SCAN_DIRECTORIES = 1_024;
const MAX_SCAN_DEPTH = 32;

function normalizePath(filePath: string) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function compareText(left: { name: string }, right: { name: string }) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function canonicalizeNearestExisting(candidate: string) {
  const absolute = path.resolve(candidate);
  const remainder: string[] = [];
  let current = absolute;
  while (true) {
    try {
      const canonical = await realpath(current);
      return normalizePath(path.join(canonical, ...remainder.reverse()));
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      remainder.push(path.basename(current));
      current = parent;
    }
  }
}

async function assertRegularFile(filePath: string) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Rule path must be a regular file, not a link");
  }
  return metadata;
}

async function readPrefix(filePath: string, limit: number) {
  const before = await assertRegularFile(filePath);
  const canonicalBefore = normalizePath(await realpath(filePath));
  if (canonicalBefore !== normalizePath(filePath)) {
    throw new Error("Rule path changed from its discovered canonical path");
  }
  const handle = await open(
    canonicalBefore,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Rule path is not a regular file");
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
      throw new Error("Rule file identity changed before open");
    }
    const buffer = Buffer.alloc(Math.min(limit + 1, metadata.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const [canonicalAfter, after] = await Promise.all([
      realpath(filePath).then(normalizePath),
      lstat(filePath),
    ]);
    if (
      canonicalAfter !== canonicalBefore ||
      after.isSymbolicLink() ||
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino
    ) {
      throw new Error("Rule path changed during read");
    }
    return {
      bytes: buffer.subarray(0, bytesRead),
      size: metadata.size,
    };
  } finally {
    await handle.close();
  }
}

export function createFileSystemRuleStorage(): RuleCatalogStorage {
  return {
    async listMarkdownFiles(root, limit) {
      const files: string[] = [];
      const pending = [{ directory: normalizePath(root), depth: 0 }];
      let scannedEntries = 0;
      let scannedDirectories = 0;
      while (pending.length > 0 && files.length < limit) {
        const { directory, depth } = pending.pop()!;
        scannedDirectories += 1;
        if (scannedDirectories > MAX_SCAN_DIRECTORIES) {
          throw new Error(
            `Rule scan exceeds ${MAX_SCAN_DIRECTORIES} directory limit`,
          );
        }
        let handle;
        try {
          handle = await opendir(directory);
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        const entries = [];
        for await (const entry of handle) {
          scannedEntries += 1;
          if (scannedEntries > MAX_SCAN_ENTRIES) {
            throw new Error(
              `Rule scan exceeds ${MAX_SCAN_ENTRIES} entry limit`,
            );
          }
          entries.push(entry);
        }
        entries.sort(compareText);
        for (const entry of entries) {
          const candidate = normalizePath(path.join(directory, entry.name));
          if (entry.isDirectory()) {
            if (depth >= MAX_SCAN_DEPTH) {
              throw new Error(
                `Rule scan exceeds directory depth limit of ${MAX_SCAN_DEPTH}`,
              );
            }
            pending.push({ directory: candidate, depth: depth + 1 });
          }
          if (
            entry.name.toLowerCase().endsWith(".md") &&
            (entry.isFile() || entry.isSymbolicLink())
          ) {
            files.push(candidate);
            if (files.length >= limit) break;
          }
        }
      }
      return files;
    },
    canonicalize: canonicalizeNearestExisting,
    async readFrontmatter(filePath, limit) {
      const read = await readPrefix(filePath, limit);
      return { prefix: read.bytes.toString("utf8"), size: read.size };
    },
    async readContent(filePath, limit) {
      const read = await readPrefix(filePath, limit);
      return new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    },
  };
}

export function createFileSystemRuleCatalog(
  options: Omit<RuleCatalogOptions, "storage">,
) {
  return createRuleCatalog({
    ...options,
    storage: createFileSystemRuleStorage(),
  });
}
