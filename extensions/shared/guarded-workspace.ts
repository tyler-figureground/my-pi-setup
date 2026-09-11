/**
 * Guarded Workspace lease shapes shared by the platform `WorkspaceManager`
 * and the subagents extension.
 *
 * Type-only contract. `WorkspaceLeaseIdentity` (owner, fence, expiry) is the
 * base of the platform's `WorkspaceLease` (`platform/src/workspaces/index.ts`)
 * and is what every workspace mutation must present. `GuardedWorkspaceBinding`
 * is the lease a subagent spawn carries (`subagents/src/domain.ts`); its
 * literal `state: "leased"` and `projectTrusted: true` fields mean a binding
 * exists only for a live lease in a trusted project.
 * See docs/architecture/phase-3-profiles-workspaces.md.
 */

import type { ResolvedProfileIdentity } from "./agent-profile.ts";
import type { ChildExecutionRole } from "./execution-role.ts";

export interface WorkspaceLeaseOwner {
  readonly sessionId: string;
  readonly agentId: string;
}

export interface WorkspaceLeaseIdentity {
  readonly workspaceId: string;
  readonly owner: WorkspaceLeaseOwner;
  readonly fence: number;
  readonly expiresAt: number;
}

export interface GuardedWorkspaceBinding extends WorkspaceLeaseIdentity {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly path: string;
  readonly state: "leased";
  readonly role: ChildExecutionRole;
  readonly profile?: ResolvedProfileIdentity;
  readonly projectTrusted: true;
}
