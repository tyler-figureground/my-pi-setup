import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type {
  PlatformHookEvent,
  PlatformHookEventProducer,
} from "./src/automation/platform-hook-event-sink.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import { createProjectIdentity } from "./src/core/projects/index.ts";
import { createWorkspaceManager } from "./src/workspaces/index.ts";

const execFileAsync = promisify(execFile);

function collectingHookEvents() {
  const events: Array<{
    event: PlatformHookEvent;
    payload: Readonly<Record<string, unknown>>;
  }> = [];
  const producer: PlatformHookEventProducer = {
    publish: (event, payload) => events.push({ event, payload }),
  };
  return { events, producer };
}

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-workspaces-"));
  const repository = path.join(root, "repository");
  const workspaceRoot = path.join(root, "managed");
  await git(root, "init", repository);
  await git(repository, "config", "user.email", "tests@example.invalid");
  await git(repository, "config", "user.name", "Pi Tests");
  await writeFile(path.join(repository, "tracked.txt"), "parent\n", "utf8");
  await git(repository, "add", "tracked.txt");
  await git(repository, "commit", "-m", "base");
  const resolved = await createProjectIdentity().resolve(repository);
  assert.equal(resolved.ok, true);
  if (!resolved.ok || resolved.value.kind !== "git" || resolved.value.bare) {
    throw new Error("Fixture did not resolve as a working Git repository.");
  }
  return {
    root,
    repository,
    workspaceRoot,
    project: resolved.value,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("failed cleanup preserves shared junction target and leaves workspace blocked", async () => {
  const f = await repositoryFixture();
  try {
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "blocked-cleanup",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shared = path.join(f.root, "shared-blocked");
    const sentinel = path.join(shared, "sentinel.txt");
    await mkdir(shared);
    await writeFile(sentinel, "preserve", "utf8");
    await symlink(
      shared,
      path.join(created.value.path, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await git(f.repository, "worktree", "lock", created.value.path);
    const claimed = await manager.lease({
      workspaceId: "blocked-cleanup",
      owner: { sessionId: "session-a", agentId: "agent-a" },
      ttlMs: 60_000,
      role: "subagent",
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const abandoned = await manager.disposition(claimed.value, {
      kind: "abandon",
      acknowledgeDataLoss: true,
    });
    assert.equal(abandoned.ok, false);
    if (!abandoned.ok) assert.equal(abandoned.error.code, "GIT_FAILED");
    assert.equal(await readFile(sentinel, "utf8"), "preserve");
    await access(created.value.path);
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager rejects commits added after review evidence", async () => {
  const f = await repositoryFixture();
  try {
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "review-binding",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const targetBranch = await git(f.repository, "branch", "--show-current");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await writeFile(
      path.join(created.value.path, "tracked.txt"),
      "reviewed\n",
      "utf8",
    );
    await git(created.value.path, "add", "tracked.txt");
    await git(created.value.path, "commit", "-m", "reviewed change");
    const claimed = await manager.lease({
      workspaceId: "review-binding",
      owner: { sessionId: "session", agentId: "agent" },
      ttlMs: 60_000,
      role: "review",
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const reviewed = await manager.disposition(claimed.value, {
      kind: "mark-reviewed",
      evidence: "Reviewed commit A",
    });
    assert.equal(reviewed.ok, true);
    await writeFile(
      path.join(created.value.path, "tracked.txt"),
      "unreviewed\n",
      "utf8",
    );
    await git(created.value.path, "add", "tracked.txt");
    await git(created.value.path, "commit", "-m", "unreviewed change");
    const integrated = await manager.integrate(claimed.value, {
      targetBranch,
      expectedTargetCommit: head,
    });
    assert.equal(integrated.ok, false);
    if (!integrated.ok)
      assert.match(integrated.error.message, /changed after review/i);
    assert.equal(
      await readFile(path.join(f.repository, "tracked.txt"), "utf8"),
      "parent\n",
    );
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager integrates only reviewed work by expected fast-forward target", async () => {
  const f = await repositoryFixture();
  try {
    const hookEvents = collectingHookEvents();
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "integrate-state",
      hookEvents: hookEvents.producer,
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const targetBranch = await git(f.repository, "branch", "--show-current");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await writeFile(
      path.join(created.value.path, "tracked.txt"),
      "integrated\n",
      "utf8",
    );
    await git(created.value.path, "add", "tracked.txt");
    await git(created.value.path, "commit", "-m", "agent change");
    const claimed = await manager.lease({
      workspaceId: "integrate-state",
      owner: { sessionId: "session-a", agentId: "agent-a" },
      ttlMs: 60_000,
      role: "review",
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const reviewed = await manager.disposition(claimed.value, {
      kind: "mark-reviewed",
      evidence: "Tests and review passed.",
    });
    assert.equal(reviewed.ok, true);

    const integrated = await manager.integrate(claimed.value, {
      targetBranch,
      expectedTargetCommit: head,
    });
    assert.equal(
      integrated.ok,
      true,
      integrated.ok
        ? "integration succeeded"
        : JSON.stringify(integrated.error),
    );
    if (integrated.ok) assert.equal(integrated.value.state, "integrated");
    assert.deepEqual(
      hookEvents.events.map(({ event }) => event),
      ["worktree.created", "worktree.claimed", "worktree.integrated"],
    );
    assert.equal(
      await readFile(path.join(f.repository, "tracked.txt"), "utf8"),
      "integrated\n",
    );
    await assert.rejects(access(created.value.path));
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager refuses implicit dirty cleanup and detaches a junction before explicit abandon", async () => {
  const f = await repositoryFixture();
  try {
    const hookEvents = collectingHookEvents();
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "abandon-state",
      hookEvents: hookEvents.producer,
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const shared = path.join(f.root, "shared-node-modules");
    const sentinel = path.join(shared, "sentinel.txt");
    await mkdir(shared);
    await writeFile(sentinel, "preserve", "utf8");
    await symlink(
      shared,
      path.join(created.value.path, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(
      path.join(created.value.path, "untracked.txt"),
      "dirty",
      "utf8",
    );
    const claimed = await manager.lease({
      workspaceId: "abandon-state",
      owner: { sessionId: "session-a", agentId: "agent-a" },
      ttlMs: 60_000,
      role: "subagent",
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const refused = await manager.disposition(claimed.value, {
      kind: "abandon",
      acknowledgeDataLoss: false,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, "INVALID_STATE");
    await access(created.value.path);

    const abandoned = await manager.disposition(claimed.value, {
      kind: "abandon",
      acknowledgeDataLoss: true,
    });
    assert.equal(
      abandoned.ok,
      true,
      abandoned.ok ? "abandon succeeded" : JSON.stringify(abandoned.error),
    );
    if (abandoned.ok) assert.equal(abandoned.value.state, "abandoned");
    await assert.rejects(access(created.value.path));
    assert.equal(await readFile(sentinel, "utf8"), "preserve");
    assert.deepEqual(
      hookEvents.events.map(({ event }) => event),
      ["worktree.created", "worktree.claimed", "worktree.released"],
    );
    assert.equal(hookEvents.events[2]?.payload.disposition, "abandoned");
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager inspection classifies staged, tracked, untracked, ignored, detached, and unpushed state", async () => {
  const f = await repositoryFixture();
  try {
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "inspect-state",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await writeFile(
      path.join(created.value.path, ".gitignore"),
      "ignored.txt\n",
      "utf8",
    );
    await writeFile(
      path.join(created.value.path, "tracked.txt"),
      "changed\n",
      "utf8",
    );
    await git(created.value.path, "add", "tracked.txt");
    await writeFile(
      path.join(created.value.path, "untracked.txt"),
      "new\n",
      "utf8",
    );
    await writeFile(
      path.join(created.value.path, "ignored.txt"),
      "ignored\n",
      "utf8",
    );

    const inspected = await manager.inspect({ workspaceId: "inspect-state" });
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    assert.equal(inspected.value.length, 1);
    const inventory = inspected.value[0]?.inventory;
    assert.equal(inventory?.staged, true);
    assert.equal(inventory?.tracked, true);
    assert.equal(inventory?.untracked, true);
    assert.equal(inventory?.ignored, true);
    assert.equal(inventory?.detached, false);
    assert.equal(inventory?.unpushed, false);
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager copies bounded .worktreeinclude files with secret warnings", async () => {
  const f = await repositoryFixture();
  try {
    await writeFile(
      path.join(f.repository, ".env"),
      "TOKEN=test-only\n",
      "utf8",
    );
    await writeFile(
      path.join(f.repository, ".worktreeinclude"),
      ".env\n",
      "utf8",
    );
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "included-state",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(
      await readFile(path.join(created.value.path, ".env"), "utf8"),
      "TOKEN=test-only\n",
    );
    assert.match(created.value.warnings?.[0] ?? "", /Potential secret/);
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager recovers an expired lease with a higher fence after process death", async () => {
  const f = await repositoryFixture();
  try {
    let now = 1_000;
    const hookEvents = collectingHookEvents();
    const stateStore = createMemoryStateStore({ now: () => now });
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore,
      now: () => now,
      id: () => "recover-state",
      hookEvents: hookEvents.producer,
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    await manager.create({ base: { kind: "commit", commit: head } });
    const original = await manager.lease({
      workspaceId: "recover-state",
      owner: { sessionId: "dead-session", agentId: "dead-agent" },
      ttlMs: 1_000,
      role: "subagent",
    });
    assert.equal(original.ok, true);
    now = 2_001;

    const recovery = await manager.recover();
    assert.equal(recovery.ok, true);
    if (recovery.ok)
      assert.deepEqual(recovery.value.recovered, ["recover-state"]);
    const next = await manager.lease({
      workspaceId: "recover-state",
      owner: { sessionId: "new-session", agentId: "new-agent" },
      ttlMs: 1_000,
      role: "subagent",
    });
    assert.equal(next.ok, true);
    if (next.ok) assert.equal(next.value.fence, 3);
    assert.deepEqual(
      hookEvents.events.map(({ event }) => event),
      [
        "worktree.created",
        "worktree.claimed",
        "worktree.released",
        "worktree.claimed",
      ],
    );
    assert.equal(hookEvents.events[2]?.payload.disposition, "recovered");
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager publishes preserve release once and rejected dispositions never publish", async () => {
  const f = await repositoryFixture();
  try {
    const hookEvents = collectingHookEvents();
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "event-state",
      hookEvents: hookEvents.producer,
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    const claimed = await manager.lease({
      workspaceId: "event-state",
      owner: { sessionId: "session", agentId: "agent" },
      ttlMs: 60_000,
      role: "subagent",
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const rejected = await manager.disposition(claimed.value, {
      kind: "mark-reviewed",
      evidence: "not dirty",
    });
    assert.equal(rejected.ok, false);
    const preserved = await manager.disposition(claimed.value, {
      kind: "preserve",
    });
    assert.equal(preserved.ok, true);
    const second = await manager.disposition(claimed.value, {
      kind: "preserve",
    });
    assert.equal(second.ok, false);

    assert.deepEqual(
      hookEvents.events.map(({ event }) => event),
      ["worktree.created", "worktree.claimed", "worktree.released"],
    );
    assert.equal(hookEvents.events[2]?.payload.disposition, "preserved");
  } finally {
    await f.cleanup();
  }
});

test("parallel guarded workspace creation gives children distinct non-colliding paths", async () => {
  const f = await repositoryFixture();
  try {
    const ids = ["parallel-a", "parallel-b"];
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => ids.shift()!,
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const results = await Promise.all([
      manager.create({ base: { kind: "commit", commit: head } }),
      manager.create({ base: { kind: "commit", commit: head } }),
    ]);
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    const paths = results.flatMap((result) =>
      result.ok ? [result.value.path] : [],
    );
    assert.equal(new Set(paths).size, 2);
    await writeFile(path.join(paths[0]!, "child.txt"), "a", "utf8");
    await writeFile(path.join(paths[1]!, "child.txt"), "b", "utf8");
    assert.equal(
      await readFile(path.join(paths[0]!, "child.txt"), "utf8"),
      "a",
    );
    assert.equal(
      await readFile(path.join(paths[1]!, "child.txt"), "utf8"),
      "b",
    );
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager fetches and resolves an explicit fresh remote default branch", async () => {
  const f = await repositoryFixture();
  try {
    const remote = path.join(f.root, "remote.git");
    await git(f.root, "init", "--bare", remote);
    await git(f.repository, "remote", "add", "origin", remote);
    const branch = await git(f.repository, "branch", "--show-current");
    await git(f.repository, "push", "-u", "origin", branch);
    await git(f.repository, "remote", "set-head", "origin", "-a");
    const remoteHead = await git(f.repository, "rev-parse", `origin/${branch}`);
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "fresh-remote",
    });
    const created = await manager.create({
      base: { kind: "fresh-remote", remote: "origin" },
    });
    assert.equal(
      created.ok,
      true,
      created.ok ? "fresh remote created" : JSON.stringify(created.error),
    );
    if (created.ok) assert.equal(created.value.baseCommit, remoteHead);
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager resolves current-HEAD base to an exact commit", async () => {
  const f = await repositoryFixture();
  try {
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "current-head",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({ base: { kind: "current-head" } });
    assert.equal(created.ok, true);
    if (created.ok) assert.equal(created.value.baseCommit, head);
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager rebinds only a valid owner, fence, and worktree identity", async () => {
  const f = await repositoryFixture();
  try {
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "resume-target",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    await manager.create({ base: { kind: "commit", commit: head } });
    const claimed = await manager.lease({
      workspaceId: "resume-target",
      owner: { sessionId: "session-a", agentId: "agent-a" },
      ttlMs: 60_000,
      role: "subagent",
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const valid = await manager.rebind({
      workspaceId: "resume-target",
      owner: claimed.value.owner,
      fence: claimed.value.fence,
    });
    assert.equal(valid.ok, true);
    const stale = await manager.rebind({
      workspaceId: "resume-target",
      owner: claimed.value.owner,
      fence: claimed.value.fence + 1,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "LEASE_LOST");
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager grants one atomic fenced lease and rejects a parallel collision", async () => {
  const f = await repositoryFixture();
  try {
    const stateStore = createMemoryStateStore();
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore,
      id: () => "lease-target",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);

    const claims = await Promise.all([
      manager.lease({
        workspaceId: "lease-target",
        owner: { sessionId: "session-a", agentId: "agent-a" },
        ttlMs: 60_000,
        role: "review",
        profile: "security-reviewer",
      }),
      manager.lease({
        workspaceId: "lease-target",
        owner: { sessionId: "session-b", agentId: "agent-b" },
        ttlMs: 60_000,
        role: "review",
        profile: "security-reviewer",
      }),
    ]);

    assert.equal(claims.filter((claim) => claim.ok).length, 1);
    assert.equal(
      claims.filter((claim) => !claim.ok)[0]?.error.code,
      "LEASE_HELD",
    );
    const granted = claims.find((claim) => claim.ok);
    assert.ok(granted?.ok);
    if (granted?.ok) {
      assert.equal(granted.value.fence, 1);
      assert.equal(granted.value.snapshot.state, "leased");
      assert.equal(granted.value.snapshot.workspaceId, "lease-target");
    }
  } finally {
    await f.cleanup();
  }
});

test("guarded creation leaves a dirty parent worktree byte-for-byte unchanged", async () => {
  const f = await repositoryFixture();
  try {
    await writeFile(
      path.join(f.repository, "tracked.txt"),
      "dirty parent\n",
      "utf8",
    );
    await git(f.repository, "add", "tracked.txt");
    await writeFile(
      path.join(f.repository, "untracked.txt"),
      "untracked\n",
      "utf8",
    );
    await writeFile(
      path.join(f.repository, ".gitignore"),
      "ignored.txt\n",
      "utf8",
    );
    await writeFile(
      path.join(f.repository, "ignored.txt"),
      "ignored\n",
      "utf8",
    );
    const beforeStatus = await git(
      f.repository,
      "status",
      "--porcelain=v1",
      "--ignored",
    );
    const before = await Promise.all(
      ["tracked.txt", "untracked.txt", ".gitignore", "ignored.txt"].map(
        async (file) =>
          [
            file,
            await readFile(path.join(f.repository, file), "utf8"),
          ] as const,
      ),
    );
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "dirty-parent",
    });
    const head = await git(f.repository, "rev-parse", "HEAD");
    const created = await manager.create({
      base: { kind: "commit", commit: head },
    });
    assert.equal(created.ok, true);
    assert.equal(
      await git(f.repository, "status", "--porcelain=v1", "--ignored"),
      beforeStatus,
    );
    for (const [file, body] of before) {
      assert.equal(await readFile(path.join(f.repository, file), "utf8"), body);
    }
  } finally {
    await f.cleanup();
  }
});

test("WorkspaceManager creates a ready guarded worktree from an explicit commit without changing parent", async () => {
  const f = await repositoryFixture();
  try {
    const beforeHead = await git(f.repository, "rev-parse", "HEAD");
    const beforeStatus = await git(f.repository, "status", "--porcelain=v1");
    const beforeBody = await readFile(
      path.join(f.repository, "tracked.txt"),
      "utf8",
    );
    const manager = createWorkspaceManager({
      project: f.project,
      projectTrusted: true,
      workspaceRoot: f.workspaceRoot,
      stateStore: createMemoryStateStore(),
      id: () => "workspace-one",
    });

    const created = await manager.create({
      base: { kind: "commit", commit: beforeHead },
    });

    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.state, "ready");
    assert.equal(created.value.workspaceId, "workspace-one");
    assert.equal(created.value.baseCommit, beforeHead);
    assert.equal(created.value.currentCommit, beforeHead);
    assert.equal(
      created.value.path,
      path.join(f.workspaceRoot, "workspace-one"),
    );
    assert.equal(
      await git(created.value.path, "rev-parse", "HEAD"),
      beforeHead,
    );
    assert.equal(await git(f.repository, "rev-parse", "HEAD"), beforeHead);
    assert.equal(
      await git(f.repository, "status", "--porcelain=v1"),
      beforeStatus,
    );
    assert.equal(
      await readFile(path.join(f.repository, "tracked.txt"), "utf8"),
      beforeBody,
    );
    assert.deepEqual(
      (await manager.inspect({ workspaceId: "workspace-one" })).ok,
      true,
    );
  } finally {
    await f.cleanup();
  }
});
