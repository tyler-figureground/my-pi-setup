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
