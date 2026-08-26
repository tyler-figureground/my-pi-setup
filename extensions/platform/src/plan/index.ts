import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ActorRole,
  CapabilityDecision,
  CapabilityPolicy,
} from "../core/policy/index.ts";

export const PLAN_MODE_ENTRY_TYPE = "platform-plan-mode";
export const PLAN_PROMPT_MAX_BYTES = 16 * 1024;
export const PLAN_BODY_MAX_BYTES = 128 * 1024;

export type PlanModeState =
  "off" | "planning" | "approval-pending" | "executing";

export interface PlanToolMetadata {
  readonly name: string;
  readonly sourceInfo: {
    readonly path: string;
    readonly source: string;
    readonly scope: "user" | "project" | "temporary";
    readonly origin: "package" | "top-level";
    readonly baseDir?: string;
  };
}

export interface PlanToolFingerprint {
  readonly name: string;
  readonly source: string;
  readonly path: string;
}

export interface PlanDestination {
  readonly scope: "user" | "project";
  readonly root: string;
  readonly path: string;
}

export interface PlanModeSnapshot {
  readonly version: 1;
  readonly state: PlanModeState;
  readonly activeTools: readonly string[];
  readonly prePlanActiveTools?: readonly string[];
  readonly prePlanTools?: readonly PlanToolFingerprint[];
  readonly planId?: string;
  readonly prompt?: string;
  readonly planHash?: string;
  readonly destination?: PlanDestination;
}

export interface PlanPersistenceAdapter {
  writeAtomic(write: {
    readonly destination: PlanDestination;
    readonly content: string;
    readonly signal?: AbortSignal;
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: string }
  >;
  readVerified?(read: {
    readonly destination: PlanDestination;
    readonly expectedHash: string;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly content: string }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface UserAuthorityToken {
  readonly kind: "user-authority";
  readonly value: string;
}

export interface UserAuthorityAdapter {
  verify(token: UserAuthorityToken): boolean;
}

export interface PlanModeOptions {
  readonly policy: CapabilityPolicy;
  readonly actor?: ActorRole;
  readonly authority: UserAuthorityAdapter;
  readonly persistence: PlanPersistenceAdapter;
  readonly destinations: {
    readonly defaultScope: "user" | "project";
    readonly user: {
      readonly root: string;
      readonly directory?: string;
    };
    readonly project?: {
      readonly root: string;
      readonly directory?: string;
      readonly trusted: boolean;
    };
  };
  readonly createPlanId: () => string;
}

export interface PlanToolAuthorization {
  readonly tool: string;
  readonly source: string;
  readonly decision: CapabilityDecision;
}

export interface PlanSessionEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly customType?: string;
  readonly data?: unknown;
}

export interface PlanModeResult {
  readonly ok: boolean;
  readonly snapshot: PlanModeSnapshot;
  readonly activeTools: readonly string[];
  readonly reason?: string;
}

export interface PlanMode {
  enter(input: {
    readonly prompt: string;
    readonly destination?: "user" | "project";
    readonly activeTools: readonly string[];
    readonly planningTools?: readonly string[];
    readonly tools: readonly PlanToolMetadata[];
  }): PlanModeResult;
  recordPlan(input: {
    readonly plan: string;
    readonly signal?: AbortSignal;
  }): Promise<PlanModeResult>;
  approve(
    authority: UserAuthorityToken,
    tools: readonly PlanToolMetadata[],
  ): PlanModeResult;
  revokeExecution(tools: readonly PlanToolMetadata[]): PlanModeResult;
  authorize(tool: PlanToolMetadata): PlanToolAuthorization;
  reconcileTools(input: {
    readonly activeTools: readonly string[];
    readonly tools: readonly PlanToolMetadata[];
  }): PlanModeResult;
  cancel(): PlanModeResult;
  restore(input: {
    readonly entries: readonly PlanSessionEntry[];
    readonly leafId: string | null;
    readonly activeTools: readonly string[];
    readonly tools: readonly PlanToolMetadata[];
    readonly preferRuntimeToolsWhenOff?: boolean;
  }): PlanModeResult;
  snapshot(): PlanModeSnapshot;
  status(): PlanModeSnapshot;
}

const cloneSnapshot = (snapshot: PlanModeSnapshot): PlanModeSnapshot => ({
  ...snapshot,
  activeTools: [...snapshot.activeTools],
  prePlanActiveTools: snapshot.prePlanActiveTools
    ? [...snapshot.prePlanActiveTools]
    : undefined,
  prePlanTools: snapshot.prePlanTools?.map((tool) => ({ ...tool })),
  destination: snapshot.destination ? { ...snapshot.destination } : undefined,
});

const policySource = (tool: PlanToolMetadata) => {
  if (tool.sourceInfo.source === "builtin") return "builtin";
  if (tool.sourceInfo.source === "sdk") return "sdk";
  return "custom";
};

export const authorizePlanTool = (
  policy: CapabilityPolicy,
  actor: ActorRole,
  tool: PlanToolMetadata,
): PlanToolAuthorization => ({
  tool: tool.name,
  source: tool.sourceInfo.source,
  decision: policy.decide(
    { kind: "tool", name: tool.name, source: policySource(tool) },
    actor,
    { kind: "plan" },
  ),
});

export const filterPlanTools = (
  policy: CapabilityPolicy,
  actor: ActorRole,
  activeTools: readonly string[],
  tools: readonly PlanToolMetadata[],
) => {
  const metadata = new Map(tools.map((tool) => [tool.name, tool]));
  return activeTools.filter((name) => {
    const tool = metadata.get(name);
    return tool
      ? authorizePlanTool(policy, actor, tool).decision.kind === "allow"
      : false;
  });
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function fingerprintTools(
  names: readonly string[],
  tools: readonly PlanToolMetadata[],
) {
  const metadata = new Map(tools.map((tool) => [tool.name, tool]));
  const fingerprints: PlanToolFingerprint[] = [];
  for (const name of names) {
    const tool = metadata.get(name);
    if (!tool) return undefined;
    fingerprints.push({
      name,
      source: tool.sourceInfo.source,
      path: tool.sourceInfo.path,
    });
  }
  return fingerprints;
}

function sameFingerprints(
  expected: readonly PlanToolFingerprint[],
  tools: readonly PlanToolMetadata[],
) {
  const current = fingerprintTools(
    expected.map(({ name }) => name),
    tools,
  );
  return (
    current !== undefined &&
    current.every(
      (tool, index) =>
        tool.name === expected[index]?.name &&
        tool.source === expected[index]?.source &&
        tool.path === expected[index]?.path,
    )
  );
}

const safePlanId = (value: string) => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Plan id must contain a safe filename character.");
  }
  return normalized;
};

export function createPlanMode(options: PlanModeOptions): PlanMode {
  const actor = options.actor ?? "parent";
  let current: PlanModeSnapshot = {
    version: 1,
    state: "off",
    activeTools: [],
  };
  let recording = false;

  const result = (ok: boolean, reason?: string): PlanModeResult => ({
    ok,
    snapshot: cloneSnapshot(current),
    activeTools: [...current.activeTools],
    reason,
  });

  const destinationFor = (scope: "user" | "project", planId: string) => {
    const configured =
      scope === "user"
        ? options.destinations.user
        : options.destinations.project;
    if (!configured || ("trusted" in configured && !configured.trusted)) {
      return undefined;
    }
    if (!isAbsolute(configured.root)) return undefined;
    const root = resolve(configured.root);
    const configuredDirectory = configured.directory ?? "plans";
    if (isAbsolute(configuredDirectory)) return undefined;
    const directory = resolve(root, configuredDirectory);
    const relativeDirectory = relative(root, directory);
    if (
      relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${sep}`) ||
      isAbsolute(relativeDirectory)
    ) {
      return undefined;
    }
    return { scope, root, path: join(directory, `${planId}.md`) } as const;
  };

  return {
    enter(input) {
      if (current.state !== "off") {
        return result(false, "Plan mode is already active.");
      }
      current = {
        version: 1,
        state: "off",
        activeTools: [...input.activeTools],
      };
      const prompt = input.prompt.trim();
      if (!prompt) return result(false, "Plan prompt cannot be empty.");
      if (Buffer.byteLength(prompt) > PLAN_PROMPT_MAX_BYTES) {
        return result(false, "Plan prompt exceeds the 16 KiB byte limit.");
      }

      let planId: string;
      try {
        planId = safePlanId(options.createPlanId());
      } catch (error) {
        return result(
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
      const scope = input.destination ?? options.destinations.defaultScope;
      const destination = destinationFor(scope, planId);
      if (!destination) {
        return result(
          false,
          "Requested plan destination is unavailable or untrusted.",
        );
      }
      const prePlanTools = fingerprintTools(input.activeTools, input.tools);
      if (!prePlanTools) {
        return result(false, "Active tool metadata is incomplete.");
      }
      current = {
        version: 1,
        state: "planning",
        activeTools: filterPlanTools(
          options.policy,
          actor,
          [...new Set([...input.activeTools, ...(input.planningTools ?? [])])],
          input.tools,
        ),
        prePlanActiveTools: [...input.activeTools],
        prePlanTools,
        planId,
        prompt,
        destination,
      };
      return result(true);
    },
    async recordPlan(input) {
      if (current.state !== "planning") {
        return result(false, "A plan can only be recorded while planning.");
      }
      if (recording)
        return result(false, "Plan persistence is already active.");
      const plan = input.plan.trim();
      if (!plan) return result(false, "Plan content cannot be empty.");
      if (Buffer.byteLength(plan) > PLAN_BODY_MAX_BYTES) {
        return result(false, "Plan content exceeds the 128 KiB byte limit.");
      }
      const destination = current.destination;
      if (!destination)
        return result(false, "Plan destination is unavailable.");
      if (input.signal?.aborted)
        return result(false, "Plan persistence was aborted.");

      recording = true;
      try {
        const persisted = await options.persistence.writeAtomic({
          destination,
          content: plan,
          signal: input.signal,
        });
        if (!persisted.ok) return result(false, persisted.reason);
        current = {
          ...current,
          state: "approval-pending",
          planHash: createHash("sha256").update(plan).digest("hex"),
        };
        return result(true);
      } catch (error) {
        return result(
          false,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        recording = false;
      }
    },
    approve(authority, tools) {
      if (current.state !== "approval-pending") {
        return result(false, "Only a recorded plan can be approved.");
      }
      let authorized = false;
      try {
        authorized = options.authority.verify(authority);
      } catch {
        authorized = false;
      }
      if (!authorized) {
        return result(false, "Approval requires direct user authority.");
      }
      if (
        !current.prePlanTools ||
        !sameFingerprints(current.prePlanTools, tools)
      ) {
        return result(
          false,
          "Tool provenance changed during planning; review and restart the plan.",
        );
      }
      current = {
        ...current,
        state: "executing",
        activeTools: [...(current.prePlanActiveTools ?? current.activeTools)],
      };
      return result(true);
    },
    revokeExecution(tools) {
      if (current.state !== "executing") {
        return result(false, "Only executing plans can be revoked.");
      }
      current = {
        ...current,
        state: "approval-pending",
        activeTools: filterPlanTools(
          options.policy,
          actor,
          current.prePlanActiveTools ?? current.activeTools,
          tools,
        ),
      };
      return result(true);
    },
    authorize(tool) {
      if (
        current.state === "planning" ||
        current.state === "approval-pending"
      ) {
        const expected = current.prePlanTools?.find(
          (candidate) => candidate.name === tool.name,
        );
        if (
          expected &&
          (expected.source !== tool.sourceInfo.source ||
            expected.path !== tool.sourceInfo.path)
        ) {
          return {
            tool: tool.name,
            source: tool.sourceInfo.source,
            decision: {
              kind: "deny",
              operation: "process",
              capabilities: ["process", "local-write"],
              sideEffecting: true,
              reason: "Tool provenance changed during planning.",
              provenance: {
                source: "plan-tool-fingerprint",
                reference: tool.name,
              },
            },
          };
        }
        return authorizePlanTool(options.policy, actor, tool);
      }
      return {
        tool: tool.name,
        source: tool.sourceInfo.source,
        decision: options.policy.decide(
          { kind: "tool", name: tool.name, source: policySource(tool) },
          actor,
          { kind: "normal" },
        ),
      };
    },
    reconcileTools(input) {
      current = {
        ...current,
        activeTools:
          current.state === "planning" || current.state === "approval-pending"
            ? filterPlanTools(
                options.policy,
                actor,
                input.activeTools,
                input.tools,
              )
            : [...input.activeTools],
      };
      return result(true);
    },
    cancel() {
      if (recording) {
        return result(
          false,
          "Plan persistence must settle before cancellation.",
        );
      }
      if (current.state === "off") return result(true);
      const restored = [...(current.prePlanActiveTools ?? current.activeTools)];
      current = { version: 1, state: "off", activeTools: restored };
      return result(true);
    },
    restore(input) {
      const activeBeforeRestore = current.prePlanActiveTools
        ? [...current.prePlanActiveTools]
        : [...input.activeTools];
      if (recording) {
        return result(
          false,
          "Plan persistence must settle before restoration.",
        );
      }
      const entries = new Map<string, PlanSessionEntry>();
      for (const entry of input.entries) {
        if (entries.has(entry.id)) {
          current = { version: 1, state: "planning", activeTools: [] };
          return result(false, `Duplicate session entry id: ${entry.id}`);
        }
        entries.set(entry.id, entry);
      }

      const branch: PlanSessionEntry[] = [];
      const visited = new Set<string>();
      let nextId = input.leafId;
      while (nextId !== null) {
        if (visited.has(nextId)) {
          current = { version: 1, state: "planning", activeTools: [] };
          return result(false, "Session entry tree contains a cycle.");
        }
        visited.add(nextId);
        const entry = entries.get(nextId);
        if (!entry) {
          current = { version: 1, state: "planning", activeTools: [] };
          return result(
            false,
            `Session branch references missing entry: ${nextId}`,
          );
        }
        branch.push(entry);
        nextId = entry.parentId;
      }

      const stateEntry = branch.find(
        (entry) =>
          entry.type === "custom" && entry.customType === PLAN_MODE_ENTRY_TYPE,
      );
      if (!stateEntry) {
        current = {
          version: 1,
          state: "off",
          activeTools: activeBeforeRestore,
        };
        return result(true);
      }
      const data = stateEntry.data;
      if (
        !isObject(data) ||
        data.version !== 1 ||
        !["off", "planning", "approval-pending", "executing"].includes(
          String(data.state),
        ) ||
        !isStringArray(data.activeTools)
      ) {
        current = { version: 1, state: "planning", activeTools: [] };
        return result(false, "Plan session entry is malformed.");
      }
      const state = data.state as PlanModeState;
      if (state === "off") {
        current = {
          version: 1,
          state,
          activeTools: [
            ...(input.preferRuntimeToolsWhenOff
              ? input.activeTools
              : data.activeTools),
          ],
        };
        return result(true);
      }
      if (
        !isStringArray(data.prePlanActiveTools) ||
        !Array.isArray(data.prePlanTools) ||
        !data.prePlanTools.every(
          (tool) =>
            isObject(tool) &&
            typeof tool.name === "string" &&
            typeof tool.source === "string" &&
            typeof tool.path === "string",
        ) ||
        typeof data.planId !== "string" ||
        typeof data.prompt !== "string" ||
        !isObject(data.destination) ||
        (data.destination.scope !== "user" &&
          data.destination.scope !== "project") ||
        (state !== "planning" &&
          (typeof data.planHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(data.planHash)))
      ) {
        current = { version: 1, state: "planning", activeTools: [] };
        return result(false, "Active plan session entry is malformed.");
      }

      let planId: string;
      try {
        planId = safePlanId(data.planId);
      } catch {
        current = { version: 1, state: "planning", activeTools: [] };
        return result(false, "Plan session entry contains an unsafe plan id.");
      }
      const destination = destinationFor(data.destination.scope, planId);
      if (!destination) {
        current = { version: 1, state: "planning", activeTools: [] };
        return result(
          false,
          "Restored plan destination is unavailable or untrusted.",
        );
      }
      const prePlanTools =
        data.prePlanTools as unknown as PlanToolFingerprint[];
      if (
        state === "executing" &&
        !sameFingerprints(prePlanTools, input.tools)
      ) {
        current = {
          version: 1,
          state: "approval-pending",
          activeTools: filterPlanTools(
            options.policy,
            actor,
            data.activeTools,
            input.tools,
          ),
          prePlanActiveTools: [...data.prePlanActiveTools],
          prePlanTools: prePlanTools.map((tool) => ({ ...tool })),
          planId,
          prompt: data.prompt,
          planHash:
            typeof data.planHash === "string" ? data.planHash : undefined,
          destination,
        };
        return result(
          false,
          "Tool provenance changed since approval; execution was returned to approval-pending.",
        );
      }
      const restoredActiveTools =
        state === "planning" || state === "approval-pending"
          ? filterPlanTools(
              options.policy,
              actor,
              data.activeTools,
              input.tools,
            )
          : [...data.activeTools];
      current = {
        version: 1,
        state,
        activeTools: restoredActiveTools,
        prePlanActiveTools: [...data.prePlanActiveTools],
        prePlanTools: prePlanTools.map((tool) => ({ ...tool })),
        planId,
        prompt: data.prompt,
        planHash: typeof data.planHash === "string" ? data.planHash : undefined,
        destination,
      };
      return result(true);
    },
    snapshot: () => cloneSnapshot(current),
    status: () => cloneSnapshot(current),
  };
}
