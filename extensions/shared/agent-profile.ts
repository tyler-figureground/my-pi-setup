import type { ChildExecutionRole } from "./execution-role.ts";

export type ProfileScope = "managed" | "user" | "project";
export type ProfileBackend = "pi" | "claude" | "codex";
export type ProfileEffort =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkspacePolicy = "isolated" | "current";

export interface ResolvedProfileIdentity {
  readonly name: string;
  readonly contentDigest: string;
  readonly catalogGeneration: number;
  readonly source: {
    readonly scope: ProfileScope;
    readonly path: string;
  };
}

export interface ResolvedProfileSkill {
  readonly path: string;
  readonly content: string;
}

export interface ResolvedExecutionPolicy {
  readonly role: ChildExecutionRole;
  readonly instructions: readonly string[];
  readonly skills: readonly ResolvedProfileSkill[];
  readonly tools: {
    readonly allowed?: readonly string[];
    readonly denied: readonly string[];
  };
  readonly limits: {
    readonly maxTurns?: number;
    readonly timeoutMs?: number;
  };
  /** Host resource policy. Omitted preserves profile compatibility. */
  readonly resources?: {
    readonly project: boolean;
    readonly contextFiles?: boolean;
  };
  readonly workspace: WorkspacePolicy;
}

export interface ResolvedAgentProfile {
  readonly description: string;
  readonly identity: ResolvedProfileIdentity;
  readonly defaults: {
    readonly backend: ProfileBackend;
    readonly model?: string;
    readonly effort?: ProfileEffort;
  };
  readonly policy: ResolvedExecutionPolicy;
}
