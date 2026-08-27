import assert from "node:assert/strict";
import test from "node:test";
import type { WorkingTreeProjectIdentity } from "./src/core/projects/index.ts";
import { createCurrentWorkspaceLeaseProvider } from "./src/workspaces/current-workspace-lease.ts";
import type {
  WorkspaceLease,
  WorkspaceManager,
} from "./src/workspaces/index.ts";

const project: WorkingTreeProjectIdentity = {
  kind: "git",
  projectId: "git:stable-project",
  requestedCwd: "C:/managed/workspace-one",
  canonicalCwd: "C:/managed/workspace-one",
  cwdWasAliased: false,
  commonGitDir: "C:/repo/.git",
  worktreeGitDir: "C:/repo/.git/worktrees/workspace-one",
  repositoryRoot: "C:/managed/workspace-one",
  mainWorktree: "C:/repo",
  currentWorktree: "C:/managed/workspace-one",
  bare: false,
};

function lease(overrides: Partial<WorkspaceLease> = {}) {
  const owner = overrides.owner ?? {
    sessionId: "session-current",
    agentId: "agent-one",
  };
  const fence = overrides.fence ?? 7;
  const expiresAt = overrides.expiresAt ?? 2_000;
  return {
    workspaceId: "workspace-one",
    owner,
    fence,
    expiresAt,
    snapshot: {
      workspaceId: "workspace-one",
      projectId: project.projectId,
      projectRoot: "C:/repo",
      path: project.currentWorktree,
      branch: "pi-agent/workspace-one",
      baseCommit: "a".repeat(40),
      currentCommit: "b".repeat(40),
      state: "leased",
      createdAt: 1,
      updatedAt: 2,
      lease: {
        owner,
        fence,
        expiresAt,
        role: "subagent",
        projectTrusted: true,
      },
    },
    ...overrides,
  } satisfies WorkspaceLease;
}

test("current workspace lease provider rejects owner and fence rollover", async () => {
  let currentLease = lease();
  const manager: Pick<WorkspaceManager, "inspect" | "rebind"> = {
    async inspect() {
      return {
        ok: true,
        value: [{ snapshot: currentLease.snapshot }],
      };
    },
    async rebind(request) {
      if (
        request.workspaceId !== currentLease.workspaceId ||
        request.owner.sessionId !== currentLease.owner.sessionId ||
        request.owner.agentId !== currentLease.owner.agentId ||
        request.fence !== currentLease.fence
      ) {
        return {
          ok: false,
          error: {
            code: "LEASE_LOST",
            message: "lease rolled over",
            retryable: false,
          },
        };
      }
      return { ok: true, value: currentLease };
    },
  };
  const provider = createCurrentWorkspaceLeaseProvider({
    manager,
    project,
    projectIdentity: {
      resolve: async () => ({ ok: true, value: project }),
    },
    sessionId: "session-current",
    now: () => 1_000,
  });

  const issued = await provider.current();
  assert.equal(issued?.fence, 7);

  currentLease = lease({
    owner: { sessionId: "session-other", agentId: "agent-two" },
    fence: 8,
  });
  assert.equal(await provider.current(), undefined);
});
