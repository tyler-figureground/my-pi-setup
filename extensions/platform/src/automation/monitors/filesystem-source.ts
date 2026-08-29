import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MonitorSourceFactory } from "./model.ts";

interface ParcelSubscription {
  unsubscribe(): Promise<void>;
}

interface ParcelEvent {
  readonly type: "create" | "update" | "delete";
  readonly path: string;
}

interface ParcelWatcher {
  subscribe(
    directory: string,
    callback: (error: Error | null, events: readonly ParcelEvent[]) => void,
    options?: { readonly ignore?: readonly string[] },
  ): Promise<ParcelSubscription>;
}

type LoadedParcelWatcher = ParcelWatcher | { readonly default: ParcelWatcher };

export interface FileSystemMonitorSourceOptions {
  readonly reconcileIntervalMs?: number;
  readonly maxEntries?: number;
  readonly loadWatcher?: () => Promise<LoadedParcelWatcher>;
  readonly ignores?: readonly string[];
}

interface SnapshotEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly signature: string;
}

const DEFAULT_IGNORES = new Set([".git", "state", "artifact", "artifacts"]);

function normalizedRelative(root: string, path: string) {
  const candidate = relative(root, path);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  )
    return undefined;
  return candidate.split(sep).join("/");
}

function rootKey(value: string) {
  return process.platform === "win32"
    ? value.toLocaleLowerCase("en-US")
    : value;
}

export function createFileSystemMonitorSourceFactory(
  options: FileSystemMonitorSourceOptions = {},
): MonitorSourceFactory {
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const ignoredNames = new Set([
    ...DEFAULT_IGNORES,
    ...(options.ignores ?? []).map((value) => value.toLocaleLowerCase("en-US")),
  ]);
  if (
    !Number.isSafeInteger(reconcileIntervalMs) ||
    reconcileIntervalMs < 25 ||
    reconcileIntervalMs > 60 * 60_000 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 100_000
  )
    throw new TypeError("Filesystem monitor limits are outside safety bounds.");

  return {
    async open(definition, emit, signal) {
      if (definition.source.kind !== "file") {
        throw new Error(
          "Filesystem source factory received another source kind.",
        );
      }
      const source = definition.source;
      const requestedRoot = resolve(source.root);
      const requestedMetadata = await lstat(requestedRoot);
      if (
        !requestedMetadata.isDirectory() ||
        requestedMetadata.isSymbolicLink()
      ) {
        throw new Error(
          "Filesystem monitor root must be a real directory, not a junction or link.",
        );
      }
      const canonicalRoot = await realpath(requestedRoot);
      const canonicalMetadata = await lstat(canonicalRoot);
      const identity = `${canonicalMetadata.dev}:${canonicalMetadata.ino}`;
      const canonicalKey = rootKey(canonicalRoot);
      let closed = false;
      let rootRefused = false;
      let snapshot = new Map<string, SnapshotEntry>();
      let serial = Promise.resolve();
      let closePromise: Promise<void> | undefined;
      let subscription: ParcelSubscription | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;

      const ignored = (relativePath: string) =>
        relativePath
          .split("/")
          .some((part) => ignoredNames.has(part.toLocaleLowerCase("en-US")));

      const validateRoot = async () => {
        try {
          const metadata = await lstat(canonicalRoot);
          if (!metadata.isDirectory() || metadata.isSymbolicLink())
            return false;
          if (`${metadata.dev}:${metadata.ino}` !== identity) return false;
          return rootKey(await realpath(canonicalRoot)) === canonicalKey;
        } catch {
          return false;
        }
      };

      const scan = async () => {
        const found = new Map<string, SnapshotEntry>();
        const pending = [canonicalRoot];
        while (pending.length > 0) {
          const directory = pending.pop()!;
          for (const dirent of await readdir(directory, {
            withFileTypes: true,
          })) {
            const path = resolve(directory, dirent.name);
            const relativePath = normalizedRelative(canonicalRoot, path);
            if (!relativePath || ignored(relativePath)) continue;
            const metadata = await lstat(path).catch(() => undefined);
            if (!metadata || metadata.isSymbolicLink()) continue;
            const kind = metadata.isDirectory()
              ? ("directory" as const)
              : metadata.isFile()
                ? ("file" as const)
                : undefined;
            if (!kind) continue;
            if (found.size >= maxEntries) {
              throw new Error(
                "Filesystem monitor snapshot exceeded its entry limit.",
              );
            }
            found.set(relativePath, {
              path: relativePath,
              kind,
              signature: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`,
            });
            if (kind === "directory" && source.recursive !== false)
              pending.push(path);
          }
        }
        return found;
      };

      const reconcile = async (hint: "parcel" | "snapshot") => {
        if (closed || signal.aborted || rootRefused) return;
        if (!(await validateRoot())) {
          rootRefused = true;
          emit({
            type: "filesystem.error",
            payload: {
              code: "root_replaced",
              message: "Filesystem monitor root identity changed.",
            },
          });
          void beginClose();
          return;
        }
        let next: Map<string, SnapshotEntry>;
        try {
          next = await scan();
        } catch {
          emit({
            type: "filesystem.error",
            payload: {
              code: "snapshot_failed",
              message: "Filesystem snapshot reconciliation failed.",
            },
          });
          return;
        }
        for (const [path, current] of next) {
          const prior = snapshot.get(path);
          if (!prior || prior.signature !== current.signature) {
            emit({
              type: "filesystem.change",
              payload: {
                kind: prior ? "update" : "create",
                path,
                entryType: current.kind,
                hint,
              },
            });
          }
        }
        for (const [path, prior] of snapshot) {
          if (!next.has(path)) {
            emit({
              type: "filesystem.change",
              payload: { kind: "delete", path, entryType: prior.kind, hint },
            });
          }
        }
        snapshot = next;
      };

      const schedule = (hint: "parcel" | "snapshot") => {
        serial = serial.then(() => reconcile(hint)).catch(() => undefined);
      };

      const beginClose = () => {
        if (closePromise) return closePromise;
        closed = true;
        if (timer) clearInterval(timer);
        timer = undefined;
        closePromise = serial
          .catch(() => undefined)
          .then(() => subscription?.unsubscribe())
          .then(() => undefined);
        return closePromise;
      };

      snapshot = await scan();
      if (!(await validateRoot()))
        throw new Error("Filesystem monitor root changed during startup.");
      const loaded = await (options.loadWatcher?.() ??
        import("@parcel/watcher"));
      const watcher = "default" in loaded ? loaded.default : loaded;
      subscription = await watcher.subscribe(
        canonicalRoot,
        (error) => {
          if (closed) return;
          if (error) {
            emit({
              type: "filesystem.error",
              payload: {
                code: "watch_failed",
                message: "Filesystem event backend failed.",
              },
            });
          }
          schedule("parcel");
        },
        { ignore: [".git", "state", "artifact", "artifacts"] },
      );
      timer = setInterval(() => schedule("snapshot"), reconcileIntervalMs);
      timer.unref?.();
      const abort = () => {
        void beginClose();
      };
      signal.addEventListener("abort", abort, { once: true });
      return {
        async close() {
          signal.removeEventListener("abort", abort);
          await beginClose();
          snapshot.clear();
        },
      };
    },
  };
}
