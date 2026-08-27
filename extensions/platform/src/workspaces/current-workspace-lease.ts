import { canonicalPathKey } from "../../../shared/child-session.ts";
import type {
  ProjectIdentity,
  WorkingTreeProjectIdentity,
} from "../core/projects/index.ts";
import type { WorkspaceManager } from "./index.ts";

export interface CurrentWorkspaceLeaseProviderOptions {
  readonly manager: Pick<WorkspaceManager, "inspect" | "rebind">;
  readonly projectIdentity: ProjectIdentity;
  readonly project: WorkingTreeProjectIdentity;
  readonly sessionId: string;
  readonly now?: () => number;
}

function samePath(left: string, right: string) {
  return canonicalPathKey(left) === canonicalPathKey(right);
}

export function createCurrentWorkspaceLeaseProvider(
  options: CurrentWorkspaceLeaseProviderOptions,
) {
  const now = options.now ?? Date.now;

  return {
    async current() {
      const resolved = await options.projectIdentity.resolve(
        options.project.canonicalCwd,
      );
      if (!resolved.ok) return undefined;
      const currentProject = resolved.value;
      if (
        currentProject.kind !== "git" ||
        currentProject.bare ||
        currentProject.projectId !== options.project.projectId ||
        !samePath(currentProject.canonicalCwd, options.project.canonicalCwd) ||
        !samePath(
          currentProject.currentWorktree,
          options.project.currentWorktree,
        )
      ) {
        return undefined;
      }

      const inspected = await options.manager.inspect();
      if (!inspected.ok) return undefined;
      const candidates = inspected.value.filter(
        ({ snapshot }) =>
          snapshot.projectId === options.project.projectId &&
          snapshot.state === "leased" &&
          snapshot.lease !== undefined &&
          snapshot.lease.owner.sessionId === options.sessionId &&
          snapshot.lease.expiresAt > now() &&
          samePath(snapshot.path, currentProject.currentWorktree),
      );
      if (candidates.length !== 1) return undefined;

      const candidate = candidates[0]!.snapshot;
      const candidateLease = candidate.lease!;
      const rebound = await options.manager.rebind({
        workspaceId: candidate.workspaceId,
        owner: candidateLease.owner,
        fence: candidateLease.fence,
      });
      if (!rebound.ok) return undefined;
      const lease = rebound.value;
      if (
        lease.owner.sessionId !== options.sessionId ||
        lease.fence !== candidateLease.fence ||
        lease.expiresAt <= now() ||
        lease.snapshot.projectId !== options.project.projectId ||
        lease.snapshot.state !== "leased" ||
        !samePath(lease.snapshot.path, currentProject.currentWorktree)
      ) {
        return undefined;
      }
      return lease;
    },
  };
}
