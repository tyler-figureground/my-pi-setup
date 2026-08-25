import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createProjectIdentity } from "./src/core/projects/index.ts";

const execFileAsync = promisify(execFile);

function normalized(filePath: string) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  return /^[a-z]:/i.test(normalizedPath)
    ? `${normalizedPath[0]?.toUpperCase()}${normalizedPath.slice(1)}`
    : normalizedPath;
}

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-project-identity-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resolve returns canonical identity for a Git working tree", async () => {
  await withTempDirectory(async (directory) => {
    await git(directory, "init");
    const nested = path.join(directory, "src", "nested");
    await mkdir(nested, { recursive: true });

    const result = await createProjectIdentity().resolve(nested);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const root = normalized(await realpath(directory));
    assert.deepEqual(
      {
        ...result.value,
        projectId: result.value.projectId.replace(/[a-f0-9]{64}$/, "<hash>"),
      },
      {
        kind: "git",
        projectId: "git:<hash>",
        requestedCwd: normalized(path.resolve(nested)),
        canonicalCwd: normalized(await realpath(nested)),
        cwdWasAliased: false,
        repositoryRoot: root,
        mainWorktree: root,
        commonGitDir: `${root}/.git`,
        currentWorktree: root,
        worktreeGitDir: `${root}/.git`,
        bare: false,
      },
    );
  });
});

test("non-Git directories resolve to an explicit non-Git identity", async () => {
  await withTempDirectory(async (directory) => {
    const result = await createProjectIdentity().resolve(directory);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      {
        ...result.value,
        projectId: result.value.projectId.replace(/[a-f0-9]{64}$/, "<hash>"),
      },
      {
        kind: "non-git",
        projectId: "non-git:<hash>",
        requestedCwd: normalized(path.resolve(directory)),
        canonicalCwd: normalized(await realpath(directory)),
        cwdWasAliased: false,
      },
    );
  });
});

test("unavailable paths return the shared result error shape", async () => {
  await withTempDirectory(async (directory) => {
    const missing = path.join(directory, "missing");

    const result = await createProjectIdentity().resolve(missing);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "PROJECT_IDENTITY_UNAVAILABLE");
    assert.equal(result.error.retryable, false);
    assert.deepEqual(result.error.details, { cwd: missing });
  });
});

test("filesystem aliases resolve to the canonical project and cwd", async () => {
  await withTempDirectory(async (directory) => {
    const repository = path.join(directory, "repository");
    const alias = path.join(directory, "alias");
    await mkdir(repository);
    await git(repository, "init");
    await symlink(
      repository,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const resolver = createProjectIdentity();
    const [repositoryResult, aliasResult] = await Promise.all([
      resolver.resolve(repository),
      resolver.resolve(alias),
    ]);

    assert.equal(repositoryResult.ok, true);
    assert.equal(aliasResult.ok, true);
    if (!repositoryResult.ok || !aliasResult.ok) return;
    assert.equal(repositoryResult.value.kind, "git");
    assert.equal(aliasResult.value.kind, "git");
    assert.equal(aliasResult.value.projectId, repositoryResult.value.projectId);
    assert.equal(
      aliasResult.value.requestedCwd,
      normalized(path.resolve(alias)),
    );
    assert.equal(aliasResult.value.cwdWasAliased, true);
    assert.equal(
      aliasResult.value.canonicalCwd,
      normalized(await realpath(repository)),
    );
  });
});

test("bare repositories resolve without inventing a worktree", async () => {
  await withTempDirectory(async (directory) => {
    const bare = path.join(directory, "fixture.git");
    await git(directory, "init", "--bare", bare);

    const result = await createProjectIdentity().resolve(bare);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const canonicalBare = normalized(await realpath(bare));
    assert.deepEqual(
      {
        ...result.value,
        projectId: result.value.projectId.replace(/[a-f0-9]{64}$/, "<hash>"),
      },
      {
        kind: "git",
        projectId: "git:<hash>",
        requestedCwd: normalized(path.resolve(bare)),
        canonicalCwd: canonicalBare,
        cwdWasAliased: false,
        repositoryRoot: null,
        mainWorktree: null,
        commonGitDir: canonicalBare,
        currentWorktree: null,
        worktreeGitDir: canonicalBare,
        bare: true,
      },
    );
  });
});

test("linked worktrees share a project ID and retain distinct worktree identity", async () => {
  await withTempDirectory(async (directory) => {
    const main = path.join(directory, "main");
    const linked = path.join(directory, "linked");
    await mkdir(main);
    await git(main, "init");
    await git(main, "config", "user.email", "fixture@example.test");
    await git(main, "config", "user.name", "Fixture");
    await writeFile(path.join(main, "tracked.txt"), "fixture\n", "utf8");
    await git(main, "add", "tracked.txt");
    await git(main, "commit", "-m", "fixture");
    await git(main, "worktree", "add", "-b", "fixture-linked", linked);

    const resolver = createProjectIdentity();
    const [mainResult, linkedResult] = await Promise.all([
      resolver.resolve(main),
      resolver.resolve(linked),
    ]);

    assert.equal(mainResult.ok, true);
    assert.equal(linkedResult.ok, true);
    if (!mainResult.ok || !linkedResult.ok) return;
    assert.equal(mainResult.value.kind, "git");
    assert.equal(linkedResult.value.kind, "git");
    if (mainResult.value.kind !== "git" || linkedResult.value.kind !== "git")
      return;
    const canonicalMain = normalized(await realpath(main));
    const canonicalLinked = normalized(await realpath(linked));
    assert.equal(linkedResult.value.projectId, mainResult.value.projectId);
    assert.equal(linkedResult.value.repositoryRoot, canonicalLinked);
    assert.equal(linkedResult.value.mainWorktree, canonicalMain);
    assert.equal(linkedResult.value.currentWorktree, canonicalLinked);
    assert.equal(linkedResult.value.commonGitDir, `${canonicalMain}/.git`);
    assert.equal(
      linkedResult.value.worktreeGitDir,
      `${canonicalMain}/.git/worktrees/linked`,
    );
  });
});
