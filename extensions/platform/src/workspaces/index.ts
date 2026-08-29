import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { JsonObject } from "../core/result.ts";
import {
  failure,
  success,
  type ModuleError,
  type Outcome,
} from "../core/result.ts";
import type { StateStore } from "../core/persistence/index.ts";
import type { WorkingTreeProjectIdentity } from "../core/projects/index.ts";
import {
  canonicalPathKey,
  normalizeCanonicalPath,
} from "../../../shared/child-session.ts";
import type { WorkspaceLeaseIdentity } from "../../../shared/guarded-workspace.ts";
import type { PlatformHookEventProducer } from "../automation/platform-hook-event-sink.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const WORKSPACE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const COLLECTION = "platform-workspaces";

export type WorkspaceState =
  | "creating"
  | "ready"
  | "leased"
  | "dirty"
  | "reviewed"
  | "integrated"
  | "abandoned";

export interface WorkspaceSnapshot {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly currentCommit: string;
  readonly reviewedCommit?: string;
  readonly state: WorkspaceState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly warnings?: readonly string[];
  readonly lease?: {
    readonly owner: { readonly sessionId: string; readonly agentId: string };
    readonly fence: number;
    readonly expiresAt: number;
    readonly role: string;
    readonly profile?: string;
    readonly profileDigest?: string;
    readonly profileGeneration?: number;
    readonly profileScope?: string;
    readonly profilePath?: string;
    readonly projectTrusted: true;
    readonly priorState?: "ready" | "dirty" | "reviewed";
  };
}

export interface WorkspaceInventory {
  readonly tracked: boolean;
  readonly staged: boolean;
  readonly untracked: boolean;
  readonly ignored: boolean;
  readonly submodule: boolean;
  readonly detached: boolean;
  readonly unpushed: boolean;
  readonly indexFlags: boolean;
  readonly entries: readonly string[];
}

export interface WorkspaceInspection {
  readonly snapshot: WorkspaceSnapshot;
  readonly inventory?: WorkspaceInventory;
}

export interface WorkspaceLease extends WorkspaceLeaseIdentity {
  readonly snapshot: WorkspaceSnapshot;
}

export interface WorkspaceError extends ModuleError<
  | "UNTRUSTED_PROJECT"
  | "INVALID_REQUEST"
  | "WORKSPACE_EXISTS"
  | "WORKSPACE_NOT_FOUND"
  | "IDENTITY_MISMATCH"
  | "INVALID_STATE"
  | "LEASE_HELD"
  | "LEASE_LOST"
  | "GIT_FAILED"
  | "STORAGE_FAILED"
> {}

export type WorkspaceResult<T> = Outcome<T, WorkspaceError>;

export interface WorkspaceRecoveryReport {
  readonly recovered: readonly string[];
  readonly blocked: readonly {
    readonly workspaceId: string;
    readonly reason: string;
  }[];
}

export interface WorkspaceManager {
  recover(): Promise<WorkspaceResult<WorkspaceRecoveryReport>>;
  create(request: {
    readonly base:
      | { readonly kind: "commit"; readonly commit: string }
      | { readonly kind: "current-head" }
      | { readonly kind: "fresh-remote"; readonly remote?: string };
  }): Promise<WorkspaceResult<WorkspaceSnapshot>>;
  lease(request: {
    readonly workspaceId: string;
    readonly owner: { readonly sessionId: string; readonly agentId: string };
    readonly ttlMs: number;
    readonly role: string;
    readonly profile?: string;
    readonly profileDigest?: string;
    readonly profileGeneration?: number;
    readonly profileScope?: string;
    readonly profilePath?: string;
  }): Promise<WorkspaceResult<WorkspaceLease>>;
  integrate(
    lease: WorkspaceLease,
    request: {
      readonly targetBranch: string;
      readonly expectedTargetCommit: string;
    },
  ): Promise<WorkspaceResult<WorkspaceSnapshot>>;
  disposition(
    lease: WorkspaceLease,
    action:
      | { readonly kind: "preserve" }
      | {
          readonly kind: "mark-reviewed";
          readonly evidence: string;
        }
      | {
          readonly kind: "abandon";
          readonly acknowledgeDataLoss: boolean;
        },
  ): Promise<WorkspaceResult<WorkspaceSnapshot>>;
  renew(
    lease: WorkspaceLease,
    ttlMs: number,
  ): Promise<WorkspaceResult<WorkspaceLease>>;
  rebind(request: {
    readonly workspaceId: string;
    readonly owner: { readonly sessionId: string; readonly agentId: string };
    readonly fence: number;
  }): Promise<WorkspaceResult<WorkspaceLease>>;
  inspect(query?: {
    readonly workspaceId?: string;
  }): Promise<WorkspaceResult<readonly WorkspaceInspection[]>>;
}

export interface WorkspaceManagerOptions {
  readonly project: WorkingTreeProjectIdentity;
  readonly projectTrusted: boolean;
  readonly workspaceRoot: string;
  readonly stateStore: StateStore;
  readonly id?: () => string;
  readonly now?: () => number;
  readonly hookEvents?: PlatformHookEventProducer;
}

function workspaceFailure(
  code: WorkspaceError["code"],
  message: string,
  retryable = false,
  details?: JsonObject,
): WorkspaceResult<never> {
  return failure({ code, message, retryable, details });
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

async function gitOutput(cwd: string, args: readonly string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "GIT_CONFIG_COUNT" &&
        name !== "GIT_CONFIG_GLOBAL" &&
        !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name),
    ),
  );
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      `core.hooksPath=${nullDevice}`,
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  return stdout.trim();
}

async function pathIsAbsent(candidate: string) {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function gitOptional(cwd: string, args: readonly string[]) {
  try {
    return await gitOutput(cwd, args);
  } catch {
    return undefined;
  }
}

async function inspectWorkspace(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceInventory> {
  const status = await gitOutput(snapshot.path, [
    "status",
    "--porcelain=v2",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
  ]);
  const entries = status.split("\0").filter(Boolean);
  if (entries.length > 10_000) {
    throw new Error("Workspace inventory exceeds 10000 entries.");
  }
  let tracked = false;
  let staged = false;
  let untracked = false;
  let ignored = false;
  let submodule = false;
  for (const entry of entries) {
    if (entry.startsWith("? ")) untracked = true;
    else if (entry.startsWith("! ")) ignored = true;
    else if (/^[12u] /.test(entry)) {
      tracked = true;
      const xy = entry.slice(2, 4);
      if (xy[0] !== "." && xy[0] !== " ") staged = true;
      if (/^[12] .. S/.test(entry) || entry.startsWith("u ")) submodule = true;
    }
  }
  const branch = await gitOptional(snapshot.path, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const upstream = await gitOptional(snapshot.path, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const ahead = upstream
    ? await gitOptional(snapshot.path, [
        "rev-list",
        "--count",
        `${upstream}..HEAD`,
      ])
    : undefined;
  const head = await gitOutput(snapshot.path, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const index = await gitOutput(snapshot.path, ["ls-files", "-v", "-z"]);
  const indexFlags = index
    .split("\0")
    .filter(Boolean)
    .some((entry) => /^[a-z]/.test(entry));
  return Object.freeze({
    tracked,
    staged,
    untracked,
    ignored,
    submodule,
    detached: branch === undefined,
    unpushed:
      upstream === undefined
        ? head !== snapshot.baseCommit
        : Number(ahead ?? "0") > 0,
    indexFlags,
    entries: Object.freeze(entries.slice(0, 10_000)),
  });
}

async function applyWorktreeInclude(
  repositoryRoot: string,
  workspacePath: string,
) {
  const includePath = path.join(repositoryRoot, ".worktreeinclude");
  if (!existsSync(includePath)) return [] as string[];
  const includeMetadata = await lstat(includePath);
  if (
    !includeMetadata.isFile() ||
    includeMetadata.isSymbolicLink() ||
    includeMetadata.size > 64 * 1024
  ) {
    throw new Error(
      ".worktreeinclude must be a bounded regular file, not a link.",
    );
  }
  const entries = (await readFile(includePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (entries.length > 64) {
    throw new Error(".worktreeinclude exceeds 64 entries.");
  }
  const canonicalRoot = await realpath(repositoryRoot);
  const warnings: string[] = [];
  let copiedEntries = 0;
  let copiedBytes = 0;
  const copyOne = async (source: string, destination: string) => {
    const pending = [{ source, destination }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (++copiedEntries > 10_000) {
        throw new Error(".worktreeinclude exceeds 10000 copied entries.");
      }
      const sourceMetadata = await lstat(current.source);
      if (sourceMetadata.isSymbolicLink()) {
        throw new Error(".worktreeinclude never copies links or junctions.");
      }
      const canonicalSource = await realpath(current.source);
      const nested = path.relative(canonicalRoot, canonicalSource);
      if (
        nested === ".." ||
        nested.startsWith(`..${path.sep}`) ||
        path.isAbsolute(nested)
      ) {
        throw new Error(".worktreeinclude source escapes repository root.");
      }
      if (sourceMetadata.isDirectory()) {
        await mkdir(current.destination, { mode: 0o700 });
        for (const child of await readdir(current.source, {
          withFileTypes: true,
        })) {
          pending.push({
            source: path.join(current.source, child.name),
            destination: path.join(current.destination, child.name),
          });
        }
      } else if (sourceMetadata.isFile()) {
        copiedBytes += sourceMetadata.size;
        if (copiedBytes > 64 * 1024 * 1024) {
          throw new Error(".worktreeinclude exceeds 64MB copied content.");
        }
        await mkdir(path.dirname(current.destination), {
          recursive: true,
          mode: 0o700,
        });
        await copyFile(
          current.source,
          current.destination,
          constants.COPYFILE_EXCL,
        );
      } else {
        throw new Error(
          ".worktreeinclude supports only regular files and directories.",
        );
      }
    }
  };
  for (const entry of entries) {
    if (
      entry.includes("\0") ||
      entry.length > 4096 ||
      path.isAbsolute(entry) ||
      entry.split(/[\\/]/).includes("..")
    ) {
      throw new Error(
        ".worktreeinclude entries must be bounded relative paths.",
      );
    }
    if (
      /(^|[\\/])(\.env|.*(?:secret|credential|private[-_.]?key).*)$/i.test(
        entry,
      )
    ) {
      warnings.push(`Potential secret copied by .worktreeinclude: ${entry}`);
    }
    await copyOne(
      path.resolve(repositoryRoot, entry),
      path.resolve(workspacePath, entry),
    );
  }
  return warnings;
}

function inventoryDirty(inventory: WorkspaceInventory) {
  return (
    inventory.tracked ||
    inventory.staged ||
    inventory.untracked ||
    inventory.ignored ||
    inventory.submodule ||
    inventory.detached ||
    inventory.unpushed ||
    inventory.indexFlags
  );
}

async function detachWorkspaceLinks(root: string) {
  const pending = [root];
  const links: string[] = [];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 100_000) {
        throw new Error("Workspace traversal exceeds 100000 entries.");
      }
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) links.push(candidate);
      else if (metadata.isDirectory()) pending.push(candidate);
    }
  }
  links.sort((a, b) => b.length - a.length);
  for (const link of links) {
    const target = await realpath(link);
    const before = await stat(target);
    if (process.platform === "win32") {
      await execFileAsync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `rmdir "${link}"`],
        {
          encoding: "utf8",
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: GIT_TIMEOUT_MS,
        },
      );
    } else {
      await unlink(link);
    }
    try {
      await lstat(link);
      throw new Error(`Workspace link was not detached: ${link}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const after = await stat(target);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`Workspace link target identity changed: ${target}`);
    }
  }
  return links;
}

function metadata(snapshot: WorkspaceSnapshot): JsonObject {
  const { lease, ...base } = snapshot;
  return lease
    ? {
        ...base,
        lease: {
          owner: { ...lease.owner },
          fence: lease.fence,
          expiresAt: lease.expiresAt,
          role: lease.role,
          ...(lease.profile ? { profile: lease.profile } : {}),
          ...(lease.profileDigest
            ? { profileDigest: lease.profileDigest }
            : {}),
          ...(lease.profileGeneration !== undefined
            ? { profileGeneration: lease.profileGeneration }
            : {}),
          ...(lease.profileScope ? { profileScope: lease.profileScope } : {}),
          ...(lease.profilePath ? { profilePath: lease.profilePath } : {}),
          projectTrusted: true,
          ...(lease.priorState ? { priorState: lease.priorState } : {}),
        },
      }
    : base;
}

function decodeSnapshot(value: JsonObject): WorkspaceSnapshot | undefined {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.projectRoot !== "string" ||
    typeof value.path !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.baseCommit !== "string" ||
    typeof value.currentCommit !== "string" ||
    (value.reviewedCommit !== undefined &&
      (typeof value.reviewedCommit !== "string" ||
        !/^[a-f0-9]{40,64}$/i.test(value.reviewedCommit))) ||
    typeof value.state !== "string" ||
    ![
      "creating",
      "ready",
      "leased",
      "dirty",
      "reviewed",
      "integrated",
      "abandoned",
    ].includes(value.state) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return undefined;
  }
  if (
    value.warnings !== undefined &&
    (!Array.isArray(value.warnings) ||
      value.warnings.some((warning) => typeof warning !== "string"))
  ) {
    return undefined;
  }
  if (value.lease !== undefined) {
    if (
      !value.lease ||
      typeof value.lease !== "object" ||
      Array.isArray(value.lease)
    ) {
      return undefined;
    }
    const lease = value.lease as JsonObject;
    if (
      !lease.owner ||
      typeof lease.owner !== "object" ||
      Array.isArray(lease.owner) ||
      typeof (lease.owner as JsonObject).sessionId !== "string" ||
      typeof (lease.owner as JsonObject).agentId !== "string" ||
      typeof lease.fence !== "number" ||
      typeof lease.expiresAt !== "number" ||
      typeof lease.role !== "string" ||
      (lease.profile !== undefined && typeof lease.profile !== "string") ||
      (lease.profileDigest !== undefined &&
        (typeof lease.profileDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(lease.profileDigest))) ||
      (lease.profileGeneration !== undefined &&
        (!Number.isSafeInteger(lease.profileGeneration) ||
          (lease.profileGeneration as number) < 1)) ||
      (lease.profileScope !== undefined &&
        typeof lease.profileScope !== "string") ||
      (lease.profilePath !== undefined &&
        typeof lease.profilePath !== "string") ||
      lease.projectTrusted !== true ||
      (lease.priorState !== undefined &&
        lease.priorState !== "ready" &&
        lease.priorState !== "dirty" &&
        lease.priorState !== "reviewed")
    ) {
      return undefined;
    }
  }
  return value as unknown as WorkspaceSnapshot;
}

export function createWorkspaceManager(
  options: WorkspaceManagerOptions,
): WorkspaceManager {
  const now = options.now ?? Date.now;
  const makeId = options.id ?? (() => randomUUID());
  const requestedRoot = path.resolve(options.workspaceRoot);
  const operationOwner = JSON.stringify({
    pid: process.pid,
    instance: randomUUID(),
  });
  const operationResource = (id: string) =>
    `workspace-operation:${options.project.projectId}:${id}`;
  const projectOperationResource = `workspace-project-operation:${options.project.projectId}`;
  const recordKey = (id: string) => `${options.project.projectId}:${id}`;
  const publishHookEvent: PlatformHookEventProducer["publish"] = (
    event,
    payload,
  ) => {
    try {
      options.hookEvents?.publish(event, payload);
    } catch {
      // Observe-only publication cannot invalidate a durable transition.
    }
  };
  const managedSnapshot = (
    snapshot: WorkspaceSnapshot | undefined,
  ): snapshot is WorkspaceSnapshot =>
    snapshot !== undefined &&
    WORKSPACE_ID.test(snapshot.workspaceId) &&
    snapshot.projectId === options.project.projectId &&
    canonicalPathKey(snapshot.projectRoot) ===
      canonicalPathKey(options.project.repositoryRoot) &&
    canonicalPathKey(snapshot.path) ===
      canonicalPathKey(path.join(requestedRoot, snapshot.workspaceId)) &&
    snapshot.branch === `pi-agent/${snapshot.workspaceId}` &&
    /^[a-f0-9]{40,64}$/i.test(snapshot.baseCommit) &&
    /^[a-f0-9]{40,64}$/i.test(snapshot.currentCommit);
  const verifyLiveIdentity = async (snapshot: WorkspaceSnapshot) => {
    const canonical = await realpath(snapshot.path);
    const [common, registrations] = await Promise.all([
      gitOutput(snapshot.path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
      gitOutput(options.project.repositoryRoot, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    ]);
    const registered = registrations
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => canonicalPathKey(field.slice(9)));
    if (
      canonicalPathKey(canonical) !== canonicalPathKey(snapshot.path) ||
      canonicalPathKey(common) !==
        canonicalPathKey(options.project.commonGitDir) ||
      !registered.includes(canonicalPathKey(snapshot.path))
    ) {
      throw new Error(
        "Workspace canonical path, Git project, or registration changed.",
      );
    }
  };

  return {
    async recover() {
      if (!options.projectTrusted) {
        return workspaceFailure(
          "UNTRUSTED_PROJECT",
          "Workspace recovery requires a trusted project decision.",
        );
      }
      const queried = await options.stateStore.query({
        type: "records",
        collection: COLLECTION,
        keyPrefix: `${options.project.projectId}:`,
        limit: 1_000,
      });
      if (!queried.ok || queried.value.type !== "records") {
        return workspaceFailure(
          "STORAGE_FAILED",
          queried.ok
            ? "Workspace recovery query returned the wrong shape."
            : queried.error.message,
          queried.ok ? false : queried.error.retryable,
        );
      }
      const recovered: string[] = [];
      const blocked: Array<{ workspaceId: string; reason: string }> = [];
      for (const record of queried.value.records) {
        const snapshot = decodeSnapshot(record.metadata);
        if (!managedSnapshot(snapshot)) {
          blocked.push({
            workspaceId: record.key,
            reason: "Malformed workspace record.",
          });
          continue;
        }
        if (snapshot.state === "creating") {
          blocked.push({
            workspaceId: snapshot.workspaceId,
            reason:
              "Creation intent is incomplete; inspect the preserved path and Git registration before disposition.",
          });
          continue;
        }
        if (snapshot.state !== "leased" && snapshot.state !== "reviewed") {
          continue;
        }
        const existing = await options.stateStore.query({
          type: "lease",
          resource: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
        });
        if (
          !existing.ok ||
          existing.value.type !== "lease" ||
          !existing.value.lease
        ) {
          blocked.push({
            workspaceId: snapshot.workspaceId,
            reason: "Lease record is missing or unreadable.",
          });
          continue;
        }
        if (existing.value.lease.expiresAt > now()) continue;
        const [workspaceOperation, projectOperation] = await Promise.all([
          options.stateStore.query({
            type: "lease",
            resource: operationResource(snapshot.workspaceId),
          }),
          options.stateStore.query({
            type: "lease",
            resource: projectOperationResource,
          }),
        ]);
        const activeOperation = [workspaceOperation, projectOperation].some(
          (result) =>
            result.ok &&
            result.value.type === "lease" &&
            result.value.lease?.owner !== null &&
            (result.value.lease?.expiresAt ?? 0) > now(),
        );
        if (activeOperation) {
          blocked.push({
            workspaceId: snapshot.workspaceId,
            reason:
              "Expired agent lease still has an active Git-operation guard.",
          });
          continue;
        }
        const recoveryOwner = JSON.stringify({
          sessionId: `recovery-${process.pid}`,
          agentId: snapshot.workspaceId,
        });
        const claim = await options.stateStore.transact({
          transactionId: `workspace:${snapshot.workspaceId}:recovery-claim:${randomUUID()}`,
          operations: [
            {
              type: "claim-lease",
              resource: existing.value.lease.resource,
              owner: recoveryOwner,
              ttlMs: 5_000,
              metadata: {
                workspaceId: snapshot.workspaceId,
                projectId: options.project.projectId,
                recovery: true,
              },
            },
          ],
        });
        if (!claim.ok || !claim.value.leases[0]) {
          blocked.push({
            workspaceId: snapshot.workspaceId,
            reason: claim.ok
              ? "Recovery claim returned no lease."
              : claim.error.message,
          });
          continue;
        }
        const recoveryLease = claim.value.leases[0];
        try {
          const canonical = normalizeCanonicalPath(
            await realpath(snapshot.path),
          );
          const common = normalizeCanonicalPath(
            await gitOutput(snapshot.path, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]),
          );
          if (
            canonicalPathKey(canonical) !== canonicalPathKey(snapshot.path) ||
            canonicalPathKey(common) !==
              canonicalPathKey(options.project.commonGitDir)
          ) {
            throw new Error("Workspace path or Git identity changed.");
          }
          const inventory = await inspectWorkspace(snapshot);
          const next: WorkspaceSnapshot = {
            ...snapshot,
            state:
              snapshot.state === "reviewed"
                ? "reviewed"
                : inventoryDirty(inventory)
                  ? "dirty"
                  : "ready",
            currentCommit: await gitOutput(snapshot.path, [
              "rev-parse",
              "--verify",
              "HEAD^{commit}",
            ]),
            updatedAt: now(),
            lease: undefined,
          };
          const saved = await options.stateStore.transact({
            transactionId: `workspace:${snapshot.workspaceId}:recovered:${randomUUID()}`,
            operations: [
              {
                type: "release-lease",
                resource: recoveryLease.resource,
                owner: recoveryOwner,
                fence: recoveryLease.fence,
              },
              {
                type: "put-record",
                collection: COLLECTION,
                key: record.key,
                metadata: metadata(next),
                expectedVersion: record.version,
              },
              {
                type: "append-event",
                stream: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
                eventId: `recovered:${recoveryLease.fence}:${randomUUID()}`,
                eventType: "workspace-recovered",
                metadata: { fence: recoveryLease.fence, state: next.state },
              },
            ],
          });
          if (!saved.ok) throw new Error(saved.error.message);
          recovered.push(snapshot.workspaceId);
          publishHookEvent("worktree.released", {
            workspaceId: snapshot.workspaceId,
            projectId: snapshot.projectId,
            state: next.state,
            disposition: "recovered",
          });
        } catch (error) {
          blocked.push({
            workspaceId: snapshot.workspaceId,
            reason: errorText(error),
          });
        }
      }
      return success({ recovered, blocked });
    },

    async create(request) {
      if (!options.projectTrusted) {
        return workspaceFailure(
          "UNTRUSTED_PROJECT",
          "Guarded workspaces require a trusted project decision.",
        );
      }
      const workspaceId = makeId();
      if (!WORKSPACE_ID.test(workspaceId)) {
        return workspaceFailure(
          "INVALID_REQUEST",
          "Workspace id must use lowercase letters, digits, and hyphens.",
        );
      }
      if (
        request.base.kind === "commit" &&
        (typeof request.base.commit !== "string" ||
          request.base.commit.length === 0 ||
          request.base.commit.length > 256 ||
          request.base.commit.includes("\0"))
      ) {
        return workspaceFailure(
          "INVALID_REQUEST",
          "Base commit must be a bounded Git revision.",
        );
      }
      if (
        request.base.kind === "fresh-remote" &&
        request.base.remote !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.base.remote)
      ) {
        return workspaceFailure(
          "INVALID_REQUEST",
          "Remote name contains unsupported characters.",
        );
      }
      const workspacePath = path.join(requestedRoot, workspaceId);
      if (existsSync(workspacePath)) {
        return workspaceFailure(
          "WORKSPACE_EXISTS",
          `Managed workspace path already exists: ${workspacePath}`,
        );
      }

      let baseCommit: string;
      try {
        let revision: string;
        if (request.base.kind === "current-head") {
          revision = "HEAD";
        } else if (request.base.kind === "fresh-remote") {
          const remote = request.base.remote ?? "origin";
          await gitOutput(options.project.repositoryRoot, [
            "fetch",
            "--prune",
            "--",
            remote,
          ]);
          revision = await gitOutput(options.project.repositoryRoot, [
            "symbolic-ref",
            "--quiet",
            "--short",
            `refs/remotes/${remote}/HEAD`,
          ]);
        } else {
          revision = request.base.commit;
        }
        baseCommit = await gitOutput(options.project.repositoryRoot, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${revision}^{commit}`,
        ]);
        if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) {
          throw new Error("Git did not return a full object id.");
        }
      } catch (error) {
        return workspaceFailure(
          "GIT_FAILED",
          `Could not resolve workspace base: ${errorText(error)}`,
        );
      }

      const timestamp = now();
      const branch = `pi-agent/${workspaceId}`;
      const creating: WorkspaceSnapshot = {
        workspaceId,
        projectId: options.project.projectId,
        projectRoot: options.project.repositoryRoot,
        path: workspacePath,
        branch,
        baseCommit,
        currentCommit: baseCommit,
        state: "creating",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const started = await options.stateStore.transact({
        transactionId: `workspace:${workspaceId}:creating:${randomUUID()}`,
        operations: [
          {
            type: "put-record",
            collection: COLLECTION,
            key: recordKey(workspaceId),
            metadata: metadata(creating),
            expectedVersion: null,
          },
          {
            type: "claim-lease",
            resource: operationResource(workspaceId),
            owner: operationOwner,
            ttlMs: 300_000,
            metadata: {
              workspaceId,
              projectId: options.project.projectId,
              operation: "create",
            },
          },
        ],
      });
      if (!started.ok) {
        return workspaceFailure(
          started.error.code === "VERSION_CONFLICT"
            ? "WORKSPACE_EXISTS"
            : "STORAGE_FAILED",
          started.error.message,
          started.error.retryable,
        );
      }
      const creatingRecord = started.value.records[0];
      const creatingOperation = started.value.leases[0];
      if (!creatingRecord || !creatingOperation) {
        return workspaceFailure(
          "STORAGE_FAILED",
          "Workspace creation intent or operation guard was not persisted.",
        );
      }

      let includeWarnings: string[] = [];
      try {
        await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
        const canonicalRoot = normalizeCanonicalPath(
          await realpath(requestedRoot),
        );
        if (
          canonicalPathKey(canonicalRoot) !== canonicalPathKey(requestedRoot)
        ) {
          throw new Error(
            "Managed workspace root must not resolve through an alias.",
          );
        }
        await gitOutput(options.project.repositoryRoot, [
          "worktree",
          "add",
          "-b",
          branch,
          workspacePath,
          baseCommit,
        ]);
        const verifiedCommit = await gitOutput(workspacePath, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
        const commonGitDir = normalizeCanonicalPath(
          await gitOutput(workspacePath, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
        );
        if (
          verifiedCommit !== baseCommit ||
          canonicalPathKey(commonGitDir) !==
            canonicalPathKey(options.project.commonGitDir)
        ) {
          throw new Error(
            "Created worktree identity did not match its project and base.",
          );
        }
        includeWarnings = await applyWorktreeInclude(
          options.project.repositoryRoot,
          workspacePath,
        );
      } catch (error) {
        return workspaceFailure(
          "GIT_FAILED",
          `Workspace creation remains preserved for recovery: ${errorText(error)}`,
          false,
          { workspaceId, path: workspacePath },
        );
      }

      const ready: WorkspaceSnapshot = {
        ...creating,
        state: "ready",
        updatedAt: now(),
        ...(includeWarnings.length > 0
          ? { warnings: Object.freeze(includeWarnings) }
          : {}),
      };
      const committed = await options.stateStore.transact({
        transactionId: `workspace:${workspaceId}:ready:${randomUUID()}`,
        operations: [
          {
            type: "release-lease",
            resource: creatingOperation.resource,
            owner: operationOwner,
            fence: creatingOperation.fence,
          },
          {
            type: "put-record",
            collection: COLLECTION,
            key: recordKey(workspaceId),
            metadata: metadata(ready),
            expectedVersion: creatingRecord.version,
          },
          {
            type: "append-event",
            stream: `workspace:${options.project.projectId}:${workspaceId}`,
            eventId: `ready:${randomUUID()}`,
            eventType: "workspace-ready",
            metadata: { baseCommit, path: workspacePath },
          },
        ],
      });
      if (!committed.ok) {
        return workspaceFailure(
          "STORAGE_FAILED",
          `Worktree exists but ready state could not be persisted: ${committed.error.message}`,
          committed.error.retryable,
          { workspaceId, path: workspacePath },
        );
      }
      publishHookEvent("worktree.created", {
        workspaceId,
        projectId: ready.projectId,
        state: ready.state,
        branch: ready.branch,
        baseCommit: ready.baseCommit,
      });
      return success(ready);
    },

    async lease(request) {
      if (!options.projectTrusted) {
        return workspaceFailure(
          "UNTRUSTED_PROJECT",
          "Workspace leases require a trusted project decision.",
        );
      }
      const boundedIdentity = (value: string) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 256 &&
        !value.includes("\0");
      if (
        !WORKSPACE_ID.test(request.workspaceId) ||
        !boundedIdentity(request.owner.sessionId) ||
        !boundedIdentity(request.owner.agentId) ||
        !boundedIdentity(request.role) ||
        (request.profile !== undefined && !boundedIdentity(request.profile)) ||
        (request.profileDigest !== undefined &&
          !/^[a-f0-9]{64}$/.test(request.profileDigest)) ||
        (request.profileGeneration !== undefined &&
          (!Number.isSafeInteger(request.profileGeneration) ||
            request.profileGeneration < 1)) ||
        (request.profileScope !== undefined &&
          !boundedIdentity(request.profileScope)) ||
        (request.profilePath !== undefined &&
          (typeof request.profilePath !== "string" ||
            request.profilePath.length === 0 ||
            request.profilePath.length > 32_768 ||
            request.profilePath.includes("\0"))) ||
        !Number.isSafeInteger(request.ttlMs) ||
        request.ttlMs < 1_000 ||
        request.ttlMs > 86_400_000
      ) {
        return workspaceFailure(
          "INVALID_REQUEST",
          "Workspace lease requires bounded owner, role, profile, and TTL fields.",
        );
      }
      const current = await options.stateStore.query({
        type: "record",
        collection: COLLECTION,
        key: recordKey(request.workspaceId),
      });
      if (!current.ok) {
        return workspaceFailure(
          "STORAGE_FAILED",
          current.error.message,
          current.error.retryable,
        );
      }
      if (current.value.type !== "record" || !current.value.record) {
        return workspaceFailure(
          "WORKSPACE_NOT_FOUND",
          `Workspace ${JSON.stringify(request.workspaceId)} was not found.`,
        );
      }
      const snapshot = decodeSnapshot(current.value.record.metadata);
      if (!managedSnapshot(snapshot)) {
        return workspaceFailure(
          "IDENTITY_MISMATCH",
          "Workspace record is malformed or belongs to another project.",
        );
      }
      try {
        await verifyLiveIdentity(snapshot);
      } catch (error) {
        return workspaceFailure(
          "IDENTITY_MISMATCH",
          `Workspace lease identity is unsafe: ${errorText(error)}`,
        );
      }
      if (
        snapshot.state !== "ready" &&
        snapshot.state !== "dirty" &&
        snapshot.state !== "reviewed"
      ) {
        return workspaceFailure(
          "INVALID_STATE",
          `Workspace ${JSON.stringify(request.workspaceId)} is ${snapshot.state}, not leaseable.`,
        );
      }
      const owner = JSON.stringify(request.owner);
      const claimed = await options.stateStore.transact({
        transactionId: `workspace:${request.workspaceId}:claim:${randomUUID()}`,
        operations: [
          {
            type: "claim-lease",
            resource: `workspace:${options.project.projectId}:${request.workspaceId}`,
            owner,
            ttlMs: request.ttlMs,
            metadata: {
              workspaceId: request.workspaceId,
              projectId: options.project.projectId,
              sessionId: request.owner.sessionId,
              agentId: request.owner.agentId,
              role: request.role,
              ...(request.profile ? { profile: request.profile } : {}),
              ...(request.profileDigest
                ? { profileDigest: request.profileDigest }
                : {}),
              ...(request.profileGeneration !== undefined
                ? { profileGeneration: request.profileGeneration }
                : {}),
              ...(request.profileScope
                ? { profileScope: request.profileScope }
                : {}),
              ...(request.profilePath
                ? { profilePath: request.profilePath }
                : {}),
              projectTrusted: true,
            },
          },
        ],
      });
      if (!claimed.ok) {
        return workspaceFailure(
          claimed.error.code === "LEASE_HELD" ? "LEASE_HELD" : "STORAGE_FAILED",
          claimed.error.message,
          claimed.error.retryable,
        );
      }
      const lease = claimed.value.leases[0];
      if (!lease) {
        return workspaceFailure(
          "STORAGE_FAILED",
          "State store committed no workspace lease.",
        );
      }
      try {
        await verifyLiveIdentity(snapshot);
      } catch (error) {
        return workspaceFailure(
          "IDENTITY_MISMATCH",
          `Workspace identity changed after lease claim: ${errorText(error)}`,
        );
      }
      const leased: WorkspaceSnapshot = {
        ...snapshot,
        state: "leased",
        updatedAt: now(),
        lease: {
          owner: request.owner,
          fence: lease.fence,
          expiresAt: lease.expiresAt,
          role: request.role,
          ...(request.profile ? { profile: request.profile } : {}),
          ...(request.profileDigest
            ? { profileDigest: request.profileDigest }
            : {}),
          ...(request.profileGeneration !== undefined
            ? { profileGeneration: request.profileGeneration }
            : {}),
          ...(request.profileScope
            ? { profileScope: request.profileScope }
            : {}),
          ...(request.profilePath ? { profilePath: request.profilePath } : {}),
          projectTrusted: true,
          priorState: snapshot.state,
        },
      };
      const recorded = await options.stateStore.transact({
        transactionId: `workspace:${request.workspaceId}:leased:${randomUUID()}`,
        operations: [
          {
            type: "put-record",
            collection: COLLECTION,
            key: recordKey(request.workspaceId),
            metadata: metadata(leased),
            expectedVersion: current.value.record.version,
          },
          {
            type: "append-event",
            stream: `workspace:${options.project.projectId}:${request.workspaceId}`,
            eventId: `leased:${lease.fence}:${randomUUID()}`,
            eventType: "workspace-leased",
            metadata: {
              owner,
              fence: lease.fence,
              expiresAt: lease.expiresAt,
              role: request.role,
              ...(request.profile ? { profile: request.profile } : {}),
              projectTrusted: true,
            },
          },
        ],
      });
      if (!recorded.ok) {
        await options.stateStore.transact({
          transactionId: `workspace:${request.workspaceId}:release-failed-claim:${randomUUID()}`,
          operations: [
            {
              type: "release-lease",
              resource: lease.resource,
              owner,
              fence: lease.fence,
            },
          ],
        });
        return workspaceFailure(
          recorded.error.code === "VERSION_CONFLICT"
            ? "LEASE_HELD"
            : "STORAGE_FAILED",
          recorded.error.message,
          recorded.error.retryable,
        );
      }
      publishHookEvent("worktree.claimed", {
        workspaceId: request.workspaceId,
        projectId: leased.projectId,
        state: leased.state,
        fence: lease.fence,
        role: request.role,
        ...(request.profile ? { profile: request.profile } : {}),
      });
      return success({
        workspaceId: request.workspaceId,
        owner: request.owner,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
        snapshot: leased,
      });
    },

    async integrate(leaseToken, request) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/.test(request.targetBranch) ||
        !/^[a-f0-9]{40,64}$/i.test(request.expectedTargetCommit)
      ) {
        return workspaceFailure(
          "INVALID_REQUEST",
          "Integration requires a bounded target branch and full expected commit id.",
        );
      }
      const renewedAuthority = await this.renew(leaseToken, 300_000);
      if (!renewedAuthority.ok) return renewedAuthority;
      const snapshot = renewedAuthority.value.snapshot;
      if (
        snapshot.state !== "reviewed" &&
        snapshot.lease?.priorState !== "reviewed"
      ) {
        return workspaceFailure(
          "INVALID_STATE",
          `Workspace must be reviewed before integration; current state is ${snapshot.state}.`,
        );
      }
      let workspaceCommit: string;
      try {
        const [parentStatus, currentBranch, parentHead, inventory] =
          await Promise.all([
            gitOutput(options.project.repositoryRoot, [
              "status",
              "--porcelain=v2",
              "-z",
              "--untracked-files=all",
            ]),
            gitOutput(options.project.repositoryRoot, [
              "branch",
              "--show-current",
            ]),
            gitOutput(options.project.repositoryRoot, [
              "rev-parse",
              "--verify",
              "HEAD^{commit}",
            ]),
            inspectWorkspace(snapshot),
          ]);
        if (parentStatus !== "") {
          throw new Error("Protected target checkout is dirty.");
        }
        if (currentBranch !== request.targetBranch) {
          throw new Error(
            `Protected checkout is on ${JSON.stringify(currentBranch)}, not ${JSON.stringify(request.targetBranch)}.`,
          );
        }
        if (parentHead !== request.expectedTargetCommit) {
          throw new Error(
            "Protected target commit changed before integration.",
          );
        }
        if (
          inventory.tracked ||
          inventory.staged ||
          inventory.untracked ||
          inventory.ignored ||
          inventory.submodule ||
          inventory.detached ||
          inventory.indexFlags
        ) {
          throw new Error(
            "Reviewed workspace has uncommitted or unsafe filesystem state.",
          );
        }
        workspaceCommit = await gitOutput(snapshot.path, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
        if (
          !snapshot.reviewedCommit ||
          workspaceCommit !== snapshot.reviewedCommit
        ) {
          throw new Error(
            "Workspace HEAD changed after review evidence was recorded.",
          );
        }
      } catch (error) {
        return workspaceFailure(
          "INVALID_STATE",
          `Integration preflight failed: ${errorText(error)}`,
        );
      }
      const current = await options.stateStore.query({
        type: "record",
        collection: COLLECTION,
        key: recordKey(snapshot.workspaceId),
      });
      if (
        !current.ok ||
        current.value.type !== "record" ||
        !current.value.record
      ) {
        return workspaceFailure(
          "STORAGE_FAILED",
          current.ok
            ? "Workspace record disappeared during integration."
            : current.error.message,
        );
      }
      const intent = await options.stateStore.transact({
        transactionId: `workspace:${snapshot.workspaceId}:integrating:${randomUUID()}`,
        operations: [
          {
            type: "claim-lease",
            resource: projectOperationResource,
            owner: operationOwner,
            ttlMs: 300_000,
            metadata: {
              workspaceId: snapshot.workspaceId,
              projectId: options.project.projectId,
              operation: "integrate",
              fence: leaseToken.fence,
            },
          },
          {
            type: "append-event",
            stream: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
            eventId: `integrating:${leaseToken.fence}:${randomUUID()}`,
            eventType: "workspace-integration-started",
            metadata: {
              fence: leaseToken.fence,
              targetBranch: request.targetBranch,
              expectedTargetCommit: request.expectedTargetCommit,
              workspaceCommit,
            },
          },
        ],
      });
      if (!intent.ok || !intent.value.leases[0]) {
        return workspaceFailure(
          !intent.ok && intent.error.code === "LEASE_HELD"
            ? "LEASE_HELD"
            : "STORAGE_FAILED",
          intent.ok
            ? "Integration operation guard was not persisted."
            : intent.error.message,
          intent.ok ? false : intent.error.retryable,
        );
      }
      const integrationOperation = intent.value.leases[0];
      try {
        const [lockedStatus, lockedBranch, lockedHead] = await Promise.all([
          gitOutput(options.project.repositoryRoot, [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
          ]),
          gitOutput(options.project.repositoryRoot, [
            "branch",
            "--show-current",
          ]),
          gitOutput(options.project.repositoryRoot, [
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
          ]),
        ]);
        if (
          lockedStatus !== "" ||
          lockedBranch !== request.targetBranch ||
          lockedHead !== request.expectedTargetCommit
        ) {
          throw new Error(
            "Protected target changed after integration intent was fenced.",
          );
        }
        await gitOutput(options.project.repositoryRoot, [
          "merge",
          "--ff-only",
          "--no-edit",
          "--",
          workspaceCommit,
        ]);
        const integratedHead = await gitOutput(options.project.repositoryRoot, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
        if (integratedHead !== workspaceCommit) {
          throw new Error("Target did not reach reviewed workspace commit.");
        }
        await verifyLiveIdentity(snapshot);
        await detachWorkspaceLinks(snapshot.path);
        await gitOutput(options.project.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          "--",
          snapshot.path,
        ]);
        const registrations = await gitOutput(options.project.repositoryRoot, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        const stillRegistered = registrations
          .split("\0")
          .filter((field) => field.startsWith("worktree "))
          .map((field) => canonicalPathKey(field.slice(9)))
          .includes(canonicalPathKey(snapshot.path));
        if (!(await pathIsAbsent(snapshot.path)) || stillRegistered) {
          throw new Error(
            "Integrated workspace removal failed path or registration postconditions.",
          );
        }
      } catch (error) {
        return workspaceFailure(
          "GIT_FAILED",
          `Integration requires recovery inspection: ${errorText(error)}`,
          false,
          {
            workspaceId: snapshot.workspaceId,
            targetBranch: request.targetBranch,
            workspaceCommit,
          },
        );
      }
      const integrated: WorkspaceSnapshot = {
        ...snapshot,
        state: "integrated",
        currentCommit: workspaceCommit,
        updatedAt: now(),
        lease: undefined,
      };
      const saved = await options.stateStore.transact({
        transactionId: `workspace:${snapshot.workspaceId}:integrated:${randomUUID()}`,
        operations: [
          {
            type: "release-lease",
            resource: integrationOperation.resource,
            owner: operationOwner,
            fence: integrationOperation.fence,
          },
          {
            type: "release-lease",
            resource: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
            owner: JSON.stringify(leaseToken.owner),
            fence: leaseToken.fence,
          },
          {
            type: "put-record",
            collection: COLLECTION,
            key: recordKey(snapshot.workspaceId),
            metadata: metadata(integrated),
            expectedVersion: current.value.record.version,
          },
          {
            type: "append-event",
            stream: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
            eventId: `integrated:${leaseToken.fence}:${randomUUID()}`,
            eventType: "workspace-integrated",
            metadata: {
              fence: leaseToken.fence,
              targetBranch: request.targetBranch,
              targetCommit: workspaceCommit,
            },
          },
        ],
      });
      if (!saved.ok) {
        return workspaceFailure(
          "STORAGE_FAILED",
          `Target integrated but state persistence failed: ${saved.error.message}`,
          saved.error.retryable,
          {
            workspaceId: snapshot.workspaceId,
            targetBranch: request.targetBranch,
            targetCommit: workspaceCommit,
          },
        );
      }
      publishHookEvent("worktree.integrated", {
        workspaceId: snapshot.workspaceId,
        projectId: snapshot.projectId,
        state: integrated.state,
        targetBranch: request.targetBranch,
        targetCommit: workspaceCommit,
      });
      return success(integrated);
    },

    async disposition(leaseToken, action) {
      const renewedAuthority = await this.renew(leaseToken, 300_000);
      if (!renewedAuthority.ok) return renewedAuthority;
      const snapshot = renewedAuthority.value.snapshot;
      let inventory: WorkspaceInventory;
      try {
        inventory = await inspectWorkspace(snapshot);
      } catch (error) {
        return workspaceFailure(
          "IDENTITY_MISMATCH",
          `Workspace disposition inspection failed: ${errorText(error)}`,
        );
      }
      const dirty = inventoryDirty(inventory);
      if (
        action.kind === "abandon" &&
        dirty &&
        action.acknowledgeDataLoss !== true
      ) {
        return workspaceFailure(
          "INVALID_STATE",
          "Dirty workspace cleanup requires explicit data-loss acknowledgement.",
          false,
          { workspaceId: snapshot.workspaceId },
        );
      }
      const current = await options.stateStore.query({
        type: "record",
        collection: COLLECTION,
        key: recordKey(snapshot.workspaceId),
      });
      if (
        !current.ok ||
        current.value.type !== "record" ||
        !current.value.record
      ) {
        return workspaceFailure(
          "STORAGE_FAILED",
          current.ok
            ? "Workspace record disappeared during disposition."
            : current.error.message,
        );
      }
      if (action.kind === "mark-reviewed") {
        if (!dirty) {
          return workspaceFailure(
            "INVALID_STATE",
            "Only a dirty workspace can be marked reviewed.",
          );
        }
        if (
          typeof action.evidence !== "string" ||
          action.evidence.length === 0 ||
          action.evidence.length > 4096
        ) {
          return workspaceFailure(
            "INVALID_REQUEST",
            "Review evidence must be a non-empty bounded string.",
          );
        }
        const reviewedCommit = await gitOutput(snapshot.path, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]);
        const reviewed: WorkspaceSnapshot = {
          ...snapshot,
          state: "reviewed",
          currentCommit: reviewedCommit,
          reviewedCommit,
          updatedAt: now(),
        };
        const saved = await options.stateStore.transact({
          transactionId: `workspace:${snapshot.workspaceId}:reviewed:${randomUUID()}`,
          operations: [
            {
              type: "put-record",
              collection: COLLECTION,
              key: recordKey(snapshot.workspaceId),
              metadata: metadata(reviewed),
              expectedVersion: current.value.record.version,
            },
            {
              type: "append-event",
              stream: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
              eventId: `reviewed:${leaseToken.fence}:${randomUUID()}`,
              eventType: "workspace-reviewed",
              metadata: { evidence: action.evidence, fence: leaseToken.fence },
            },
          ],
        });
        return saved.ok
          ? success(reviewed)
          : workspaceFailure(
              "STORAGE_FAILED",
              saved.error.message,
              saved.error.retryable,
            );
      }
      if (action.kind === "preserve") {
        const preserved: WorkspaceSnapshot = {
          ...snapshot,
          state:
            snapshot.state === "reviewed" ||
            snapshot.lease?.priorState === "reviewed"
              ? "reviewed"
              : dirty
                ? "dirty"
                : "ready",
          currentCommit: await gitOutput(snapshot.path, [
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
          ]),
          updatedAt: now(),
          lease: undefined,
        };
        const released = await options.stateStore.transact({
          transactionId: `workspace:${snapshot.workspaceId}:preserved:${randomUUID()}`,
          operations: [
            {
              type: "release-lease",
              resource: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
              owner: JSON.stringify(leaseToken.owner),
              fence: leaseToken.fence,
            },
            {
              type: "put-record",
              collection: COLLECTION,
              key: recordKey(snapshot.workspaceId),
              metadata: metadata(preserved),
              expectedVersion: current.value.record.version,
            },
          ],
        });
        if (!released.ok) {
          return workspaceFailure(
            released.error.code === "LEASE_LOST"
              ? "LEASE_LOST"
              : "STORAGE_FAILED",
            released.error.message,
            released.error.retryable,
          );
        }
        publishHookEvent("worktree.released", {
          workspaceId: snapshot.workspaceId,
          projectId: snapshot.projectId,
          state: preserved.state,
          disposition: "preserved",
        });
        return success(preserved);
      }

      const abandonIntent = await options.stateStore.transact({
        transactionId: `workspace:${snapshot.workspaceId}:abandoning:${randomUUID()}`,
        operations: [
          {
            type: "claim-lease",
            resource: operationResource(snapshot.workspaceId),
            owner: operationOwner,
            ttlMs: 300_000,
            metadata: {
              workspaceId: snapshot.workspaceId,
              projectId: options.project.projectId,
              operation: "abandon",
              fence: leaseToken.fence,
            },
          },
        ],
      });
      if (!abandonIntent.ok || !abandonIntent.value.leases[0]) {
        return workspaceFailure(
          !abandonIntent.ok && abandonIntent.error.code === "LEASE_HELD"
            ? "LEASE_HELD"
            : "STORAGE_FAILED",
          abandonIntent.ok
            ? "Abandon operation guard was not persisted."
            : abandonIntent.error.message,
          abandonIntent.ok ? false : abandonIntent.error.retryable,
        );
      }
      const abandonOperation = abandonIntent.value.leases[0];
      try {
        await verifyLiveIdentity(snapshot);
        await detachWorkspaceLinks(snapshot.path);
        await gitOutput(options.project.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          "--",
          snapshot.path,
        ]);
        const registrations = await gitOutput(options.project.repositoryRoot, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        const registeredPaths = registrations
          .split("\0")
          .filter((field) => field.startsWith("worktree "))
          .map((field) => canonicalPathKey(field.slice(9)));
        if (
          registeredPaths.includes(canonicalPathKey(snapshot.path)) ||
          !(await pathIsAbsent(snapshot.path))
        ) {
          throw new Error(
            "Git removal did not satisfy registration and path postconditions.",
          );
        }
      } catch (error) {
        return workspaceFailure(
          "GIT_FAILED",
          `Workspace remains blocked for recovery: ${errorText(error)}`,
          false,
          { workspaceId: snapshot.workspaceId, path: snapshot.path },
        );
      }
      const abandoned: WorkspaceSnapshot = {
        ...snapshot,
        state: "abandoned",
        updatedAt: now(),
        lease: undefined,
      };
      const released = await options.stateStore.transact({
        transactionId: `workspace:${snapshot.workspaceId}:abandoned:${randomUUID()}`,
        operations: [
          {
            type: "release-lease",
            resource: abandonOperation.resource,
            owner: operationOwner,
            fence: abandonOperation.fence,
          },
          {
            type: "release-lease",
            resource: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
            owner: JSON.stringify(leaseToken.owner),
            fence: leaseToken.fence,
          },
          {
            type: "put-record",
            collection: COLLECTION,
            key: recordKey(snapshot.workspaceId),
            metadata: metadata(abandoned),
            expectedVersion: current.value.record.version,
          },
          {
            type: "append-event",
            stream: `workspace:${options.project.projectId}:${snapshot.workspaceId}`,
            eventId: `abandoned:${leaseToken.fence}:${randomUUID()}`,
            eventType: "workspace-abandoned",
            metadata: { dirty, fence: leaseToken.fence },
          },
        ],
      });
      if (!released.ok) {
        return workspaceFailure(
          released.error.code === "LEASE_LOST"
            ? "LEASE_LOST"
            : "STORAGE_FAILED",
          released.error.message,
          released.error.retryable,
        );
      }
      publishHookEvent("worktree.released", {
        workspaceId: snapshot.workspaceId,
        projectId: snapshot.projectId,
        state: abandoned.state,
        disposition: "abandoned",
      });
      return success(abandoned);
    },

    async renew(leaseToken, ttlMs) {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
        return workspaceFailure("INVALID_REQUEST", "Renewal TTL is invalid.");
      }
      const rebound = await this.rebind({
        workspaceId: leaseToken.workspaceId,
        owner: leaseToken.owner,
        fence: leaseToken.fence,
      });
      if (!rebound.ok) return rebound;
      const current = await options.stateStore.query({
        type: "record",
        collection: COLLECTION,
        key: recordKey(leaseToken.workspaceId),
      });
      if (
        !current.ok ||
        current.value.type !== "record" ||
        !current.value.record
      ) {
        return workspaceFailure(
          "STORAGE_FAILED",
          current.ok
            ? "Workspace record disappeared during renewal."
            : current.error.message,
        );
      }
      const renewed = await options.stateStore.transact({
        transactionId: `workspace:${leaseToken.workspaceId}:renew:${randomUUID()}`,
        operations: [
          {
            type: "renew-lease",
            resource: `workspace:${options.project.projectId}:${leaseToken.workspaceId}`,
            owner: JSON.stringify(leaseToken.owner),
            fence: leaseToken.fence,
            ttlMs,
            metadata: {
              workspaceId: leaseToken.workspaceId,
              projectId: options.project.projectId,
              sessionId: leaseToken.owner.sessionId,
              agentId: leaseToken.owner.agentId,
              role: rebound.value.snapshot.lease?.role ?? "subagent",
              ...(rebound.value.snapshot.lease?.profile
                ? { profile: rebound.value.snapshot.lease.profile }
                : {}),
              ...(rebound.value.snapshot.lease?.profileDigest
                ? {
                    profileDigest: rebound.value.snapshot.lease.profileDigest,
                  }
                : {}),
              ...(rebound.value.snapshot.lease?.profileGeneration !== undefined
                ? {
                    profileGeneration:
                      rebound.value.snapshot.lease.profileGeneration,
                  }
                : {}),
              ...(rebound.value.snapshot.lease?.profileScope
                ? { profileScope: rebound.value.snapshot.lease.profileScope }
                : {}),
              ...(rebound.value.snapshot.lease?.profilePath
                ? { profilePath: rebound.value.snapshot.lease.profilePath }
                : {}),
              projectTrusted: true,
            },
          },
        ],
      });
      if (!renewed.ok || !renewed.value.leases[0]) {
        return workspaceFailure(
          !renewed.ok && renewed.error.code === "LEASE_LOST"
            ? "LEASE_LOST"
            : "STORAGE_FAILED",
          renewed.ok ? "Renewal returned no lease." : renewed.error.message,
          renewed.ok ? false : renewed.error.retryable,
        );
      }
      const stateLease = renewed.value.leases[0];
      const snapshot: WorkspaceSnapshot = {
        ...rebound.value.snapshot,
        updatedAt: now(),
        lease: {
          ...rebound.value.snapshot.lease!,
          expiresAt: stateLease.expiresAt,
        },
      };
      const saved = await options.stateStore.transact({
        transactionId: `workspace:${leaseToken.workspaceId}:renewed-record:${randomUUID()}`,
        operations: [
          {
            type: "put-record",
            collection: COLLECTION,
            key: recordKey(leaseToken.workspaceId),
            metadata: metadata(snapshot),
            expectedVersion: current.value.record.version,
          },
        ],
      });
      if (!saved.ok) {
        return workspaceFailure(
          "STORAGE_FAILED",
          saved.error.message,
          saved.error.retryable,
        );
      }
      return success({
        workspaceId: leaseToken.workspaceId,
        owner: leaseToken.owner,
        fence: leaseToken.fence,
        expiresAt: stateLease.expiresAt,
        snapshot,
      });
    },

    async rebind(request) {
      if (!options.projectTrusted) {
        return workspaceFailure(
          "UNTRUSTED_PROJECT",
          "Workspace rebind requires a trusted project decision.",
        );
      }
      const [recordResult, leaseResult] = await Promise.all([
        options.stateStore.query({
          type: "record",
          collection: COLLECTION,
          key: recordKey(request.workspaceId),
        }),
        options.stateStore.query({
          type: "lease",
          resource: `workspace:${options.project.projectId}:${request.workspaceId}`,
        }),
      ]);
      if (!recordResult.ok || !leaseResult.ok) {
        const storeError = !recordResult.ok
          ? recordResult.error
          : !leaseResult.ok
            ? leaseResult.error
            : undefined;
        return workspaceFailure(
          "STORAGE_FAILED",
          storeError?.message ?? "Could not read workspace lease state.",
          storeError?.retryable ?? false,
        );
      }
      const record =
        recordResult.value.type === "record" ? recordResult.value.record : null;
      const lease =
        leaseResult.value.type === "lease" ? leaseResult.value.lease : null;
      let snapshot = record ? decodeSnapshot(record.metadata) : undefined;
      const expectedOwner = JSON.stringify(request.owner);
      if (
        !managedSnapshot(snapshot) ||
        (snapshot.state !== "leased" && snapshot.state !== "reviewed") ||
        !snapshot.lease ||
        !lease ||
        lease.owner !== expectedOwner ||
        lease.fence !== request.fence ||
        lease.expiresAt <= now() ||
        snapshot.lease.fence !== request.fence ||
        snapshot.lease.owner.sessionId !== request.owner.sessionId ||
        snapshot.lease.owner.agentId !== request.owner.agentId
      ) {
        return workspaceFailure(
          "LEASE_LOST",
          "Workspace lease owner, fence, expiry, or persisted binding no longer matches.",
        );
      }
      try {
        const canonicalPath = normalizeCanonicalPath(
          await realpath(snapshot.path),
        );
        if (
          canonicalPathKey(canonicalPath) !== canonicalPathKey(snapshot.path)
        ) {
          throw new Error("Workspace path resolves through an alias.");
        }
        const [commonGitDir, currentCommit] = await Promise.all([
          gitOutput(snapshot.path, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]),
          gitOutput(snapshot.path, ["rev-parse", "--verify", "HEAD^{commit}"]),
        ]);
        if (
          canonicalPathKey(commonGitDir) !==
          canonicalPathKey(options.project.commonGitDir)
        ) {
          throw new Error("Workspace Git identity changed.");
        }
        if (currentCommit !== snapshot.currentCommit) {
          snapshot = { ...snapshot, currentCommit };
        }
      } catch (error) {
        return workspaceFailure(
          "IDENTITY_MISMATCH",
          `Workspace resume identity is unsafe: ${errorText(error)}`,
        );
      }
      return success({
        workspaceId: snapshot.workspaceId,
        owner: request.owner,
        fence: request.fence,
        expiresAt: lease.expiresAt,
        snapshot,
      });
    },

    async inspect(query = {}) {
      if (!options.projectTrusted) {
        return workspaceFailure(
          "UNTRUSTED_PROJECT",
          "Workspace inspection requires a trusted project decision.",
        );
      }
      const result = query.workspaceId
        ? await options.stateStore.query({
            type: "record",
            collection: COLLECTION,
            key: recordKey(query.workspaceId),
          })
        : await options.stateStore.query({
            type: "records",
            collection: COLLECTION,
            keyPrefix: `${options.project.projectId}:`,
            limit: 1_000,
          });
      if (!result.ok) {
        return workspaceFailure(
          "STORAGE_FAILED",
          result.error.message,
          result.error.retryable,
        );
      }
      const records =
        result.value.type === "record"
          ? result.value.record
            ? [result.value.record]
            : []
          : result.value.type === "records"
            ? result.value.records
            : [];
      if (query.workspaceId && records.length === 0) {
        return workspaceFailure(
          "WORKSPACE_NOT_FOUND",
          `Workspace ${JSON.stringify(query.workspaceId)} was not found.`,
        );
      }
      const inspections: WorkspaceInspection[] = [];
      for (const record of records) {
        const snapshot = decodeSnapshot(record.metadata);
        if (!managedSnapshot(snapshot)) {
          return workspaceFailure(
            "IDENTITY_MISMATCH",
            `Workspace record ${JSON.stringify(record.key)} is malformed or belongs to another project.`,
          );
        }
        try {
          inspections.push(
            snapshot.state === "integrated" || snapshot.state === "abandoned"
              ? { snapshot }
              : {
                  snapshot,
                  inventory: await inspectWorkspace(snapshot),
                },
          );
        } catch (error) {
          return workspaceFailure(
            "IDENTITY_MISMATCH",
            `Workspace inspection failed: ${errorText(error)}`,
          );
        }
      }
      return success(inspections);
    },
  };
}
