import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { failure, success, type ModuleError, type Outcome } from "../result.ts";
import { normalizeCanonicalPath } from "../../../../shared/child-session.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

interface GitProjectIdentityBase {
  readonly kind: "git";
  readonly projectId: string;
  /** Lexical caller path. Future cleanup must target this path, never canonicalCwd. */
  readonly requestedCwd: string;
  readonly canonicalCwd: string;
  readonly cwdWasAliased: boolean;
  readonly commonGitDir: string;
  readonly worktreeGitDir: string;
}

export interface WorkingTreeProjectIdentity extends GitProjectIdentityBase {
  readonly repositoryRoot: string;
  readonly mainWorktree: string | null;
  readonly currentWorktree: string;
  readonly bare: false;
}

export interface BareProjectIdentity extends GitProjectIdentityBase {
  readonly repositoryRoot: null;
  readonly mainWorktree: null;
  readonly currentWorktree: null;
  readonly bare: true;
}

export type GitProjectIdentity =
  WorkingTreeProjectIdentity | BareProjectIdentity;

export interface NonGitProjectIdentity {
  readonly kind: "non-git";
  readonly projectId: string;
  /** Lexical caller path. Future cleanup must target this path, never canonicalCwd. */
  readonly requestedCwd: string;
  readonly canonicalCwd: string;
  readonly cwdWasAliased: boolean;
}

export type ResolvedProjectIdentity =
  GitProjectIdentity | NonGitProjectIdentity;
export type ProjectIdentityError = ModuleError<"PROJECT_IDENTITY_UNAVAILABLE">;

export interface ProjectIdentity {
  resolve(
    cwd: string,
  ): Promise<Outcome<ResolvedProjectIdentity, ProjectIdentityError>>;
}

async function canonicalPath(filePath: string) {
  return normalizeCanonicalPath(await realpath(filePath));
}

async function gitOutput(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function gitPath(cwd: string, argument: string) {
  const output = await gitOutput(
    cwd,
    "rev-parse",
    "--path-format=absolute",
    argument,
  );
  return canonicalPath(output);
}

async function gitIsBare(cwd: string) {
  return (await gitOutput(cwd, "rev-parse", "--is-bare-repository")) === "true";
}

function parseGitWorktreeRecords(porcelain: string) {
  return porcelain
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      const worktree = fields.find((field) => field.startsWith("worktree "));
      if (!worktree)
        throw new Error("Git returned a malformed worktree record");
      return {
        path: worktree.slice("worktree ".length),
        bare: fields.includes("bare"),
      };
    });
}

async function gitMainWorktree(cwd: string) {
  const { stdout } = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain", "-z"],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    },
  );
  const main = parseGitWorktreeRecords(stdout)[0];
  if (!main) throw new Error("Git returned no main worktree record");
  return main.bare ? null : canonicalPath(main.path);
}

function identityHash(
  kind: ResolvedProjectIdentity["kind"],
  canonicalPath: string,
) {
  const digest = createHash("sha256").update(canonicalPath).digest("hex");
  return `${kind}:${digest}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNotGitRepository(error: unknown) {
  if (typeof error !== "object" || error === null || !("stderr" in error))
    return false;
  const stderr = String(error.stderr);
  return /not a git repository/i.test(stderr);
}

export function createProjectIdentity(): ProjectIdentity {
  return {
    async resolve(cwd) {
      const requestedCwd = normalizeCanonicalPath(path.resolve(cwd));
      let canonicalCwd: string;
      try {
        canonicalCwd = await canonicalPath(requestedCwd);
      } catch (error) {
        return failure({
          code: "PROJECT_IDENTITY_UNAVAILABLE",
          message: `Could not resolve project identity: ${errorMessage(error)}`,
          retryable: false,
          details: { cwd },
        });
      }

      try {
        const worktreeGitDir = await gitPath(canonicalCwd, "--git-dir");
        const commonGitDir = await gitPath(canonicalCwd, "--git-common-dir");
        const projectId = identityHash("git", commonGitDir);
        if (await gitIsBare(canonicalCwd)) {
          return success({
            kind: "git" as const,
            projectId,
            requestedCwd,
            canonicalCwd,
            cwdWasAliased: requestedCwd !== canonicalCwd,
            repositoryRoot: null,
            mainWorktree: null,
            commonGitDir,
            currentWorktree: null,
            worktreeGitDir,
            bare: true as const,
          });
        }

        const repositoryRoot = await gitPath(canonicalCwd, "--show-toplevel");
        const mainWorktree = await gitMainWorktree(canonicalCwd);
        return success({
          kind: "git" as const,
          projectId,
          requestedCwd,
          canonicalCwd,
          cwdWasAliased: requestedCwd !== canonicalCwd,
          repositoryRoot,
          mainWorktree,
          commonGitDir,
          currentWorktree: repositoryRoot,
          worktreeGitDir,
          bare: false as const,
        });
      } catch (error) {
        if (isNotGitRepository(error)) {
          return success({
            kind: "non-git" as const,
            projectId: identityHash("non-git", canonicalCwd),
            requestedCwd,
            canonicalCwd,
            cwdWasAliased: requestedCwd !== canonicalCwd,
          });
        }
        return failure({
          code: "PROJECT_IDENTITY_UNAVAILABLE",
          message: `Could not resolve project identity: ${errorMessage(error)}`,
          retryable: false,
          details: { cwd },
        });
      }
    },
  };
}
