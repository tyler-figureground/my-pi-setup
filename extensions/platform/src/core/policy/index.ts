import {
  EXECUTION_ROLES,
  type ExecutionRole,
} from "../../../../shared/execution-role.ts";

export const operationKinds = [
  "read",
  "local-write",
  "process",
  "network-read",
  "remote-write",
  "credential-use",
  "orchestration",
  "publish",
] as const;

export type OperationKind = (typeof operationKinds)[number];
export type ToolSource = "builtin" | "custom" | "sdk";

export const actorRoles = EXECUTION_ROLES;
export type ActorRole = ExecutionRole;

export type CapabilityOperation =
  | { readonly kind: "operation"; readonly name: OperationKind }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly source: ToolSource;
    };

export interface PolicyMode {
  readonly kind: "normal" | "plan";
}

export interface DecisionProvenance {
  readonly source: string;
  readonly reference: string;
}

export interface CapabilityDecision {
  readonly kind: "allow" | "deny" | "require-user-confirmation";
  readonly operation: OperationKind;
  readonly capabilities: readonly OperationKind[];
  readonly sideEffecting: boolean;
  readonly reason: string;
  readonly provenance: DecisionProvenance;
}

export interface CapabilityPolicy {
  decide(
    operation: CapabilityOperation,
    actor: ActorRole,
    mode: PolicyMode,
  ): CapabilityDecision;
}

export interface CapabilityRule {
  readonly id: string;
  readonly match: {
    readonly operations?: readonly OperationKind[];
    readonly actors?: readonly ActorRole[];
    readonly modes?: readonly PolicyMode["kind"][];
    readonly tools?: readonly {
      readonly name: string;
      readonly source: ToolSource;
    }[];
  };
  readonly decision: CapabilityDecision["kind"];
  readonly reason: string;
  readonly provenance: DecisionProvenance;
}

export interface PolicyRuleAdapter {
  list(): readonly CapabilityRule[];
}

export interface InMemoryRuleAdapter extends PolicyRuleAdapter {
  replace(rules: readonly CapabilityRule[]): void;
}

export interface CapabilityPolicyOptions {
  readonly rules?: PolicyRuleAdapter;
}

export function createInMemoryRuleAdapter(
  initialRules: readonly CapabilityRule[] = [],
): InMemoryRuleAdapter {
  let rules = [...initialRules];
  return {
    list: () => [...rules],
    replace(nextRules) {
      rules = [...nextRules];
    },
  };
}

const arbitraryProcessCapabilities = [
  "process",
  "local-write",
  "network-read",
  "remote-write",
  "credential-use",
  "publish",
] as const;

const toolOperations = {
  builtin: {
    read: ["read"],
    grep: ["read"],
    find: ["read"],
    ls: ["read"],
    edit: ["local-write"],
    write: ["local-write"],
    bash: arbitraryProcessCapabilities,
    powershell: arbitraryProcessCapabilities,
  },
  custom: {
    fd: ["read"],
    rg: ["read"],
    bg_status: ["read"],
    bg_list: ["read"],
    search: ["network-read", "credential-use"],
    crawl: ["network-read", "credential-use"],
    scrape: ["network-read", "credential-use"],
    bg_start: arbitraryProcessCapabilities,
    bg_kill: ["process"],
    ask_user: ["read"],
    subagent_spawn: ["orchestration"],
    subagent_wait: ["read"],
    subagent_cancel: ["orchestration"],
    subagent_check: ["read"],
    subagent_list: ["read"],
    workspace_list: ["read"],
    workflow: ["orchestration"],
    git_status: ["read"],
    git_diff: ["read"],
    git_log: ["read"],
    git_show: ["read"],
    git_list_files: ["read"],
  },
  sdk: {},
} as const satisfies Record<
  ToolSource,
  Readonly<Record<string, readonly OperationKind[]>>
>;

const nonSideEffectingOperations = new Set<OperationKind>([
  "read",
  "network-read",
]);

const confirmationOperations = new Set<OperationKind>([
  "remote-write",
  "credential-use",
  "publish",
]);

function matchesRule(
  rule: CapabilityRule,
  operation: CapabilityOperation,
  capabilities: readonly OperationKind[],
  actor: ActorRole,
  mode: PolicyMode,
) {
  const { match } = rule;
  if (
    match.operations &&
    !match.operations.some((operation) => capabilities.includes(operation))
  )
    return false;
  if (match.actors && !match.actors.includes(actor)) return false;
  if (match.modes && !match.modes.includes(mode.kind)) return false;
  if (
    match.tools &&
    (operation.kind !== "tool" ||
      !match.tools.some(
        (tool) =>
          tool.name === operation.name && tool.source === operation.source,
      ))
  ) {
    return false;
  }
  return true;
}

function confirmationDecision(
  operation: OperationKind,
  capabilities: readonly OperationKind[],
  sideEffecting: boolean,
  reason: string,
  provenance: DecisionProvenance,
): CapabilityDecision {
  return {
    kind: "require-user-confirmation",
    operation,
    capabilities,
    sideEffecting,
    reason,
    provenance,
  };
}

export function createCapabilityPolicy(
  options: CapabilityPolicyOptions = {},
): CapabilityPolicy {
  const rules = options.rules ?? createInMemoryRuleAdapter();

  return {
    decide(operation, actor, mode) {
      const reference =
        operation.kind === "tool"
          ? `${operation.source}:${operation.name}`
          : operation.name;
      const classifiedCapabilities =
        operation.kind === "tool"
          ? (
              toolOperations[operation.source] as Readonly<
                Record<string, readonly OperationKind[]>
              >
            )[operation.name]
          : [operation.name];
      const unknown = classifiedCapabilities === undefined;
      const capabilities = unknown
        ? arbitraryProcessCapabilities
        : classifiedCapabilities;
      const operationKind = capabilities[0] ?? "process";
      const sideEffecting = capabilities.some(
        (capability) => !nonSideEffectingOperations.has(capability),
      );

      if (mode.kind === "plan" && sideEffecting) {
        return {
          kind: "deny",
          operation: operationKind,
          capabilities,
          sideEffecting,
          reason: unknown
            ? "Unknown tool is side-effecting and unavailable in plan mode."
            : "Side-effecting operation is unavailable in plan mode.",
          provenance: unknown
            ? { source: "unknown-tool-default", reference }
            : {
                source: "default-policy",
                reference: "plan-mode-side-effect",
              },
        };
      }

      const decisionPriority = {
        deny: 0,
        "require-user-confirmation": 1,
        allow: 2,
      } as const;
      const rule = rules
        .list()
        .filter((candidate) =>
          matchesRule(candidate, operation, capabilities, actor, mode),
        )
        .sort(
          (left, right) =>
            decisionPriority[left.decision] -
              decisionPriority[right.decision] ||
            left.id.localeCompare(right.id),
        )[0];
      if (rule) {
        if (rule.decision === "require-user-confirmation") {
          return confirmationDecision(
            operationKind,
            capabilities,
            sideEffecting,
            rule.reason,
            rule.provenance,
          );
        }
        return {
          kind: rule.decision,
          operation: operationKind,
          capabilities,
          sideEffecting,
          reason: rule.reason,
          provenance: rule.provenance,
        };
      }

      if (capabilities.includes("orchestration") && actor !== "parent") {
        return {
          kind: "deny",
          operation: operationKind,
          capabilities,
          sideEffecting,
          reason: "Child role cannot perform orchestration by default.",
          provenance: {
            source: "default-policy",
            reference: "child-orchestration",
          },
        };
      }

      if (unknown) {
        return confirmationDecision(
          operationKind,
          capabilities,
          sideEffecting,
          "Unknown tool requires user confirmation.",
          { source: "unknown-tool-default", reference },
        );
      }

      const sensitive = capabilities.find((capability) =>
        confirmationOperations.has(capability),
      );
      if (sensitive) {
        return confirmationDecision(
          operationKind,
          capabilities,
          sideEffecting,
          "Sensitive operation requires user confirmation.",
          {
            source: "default-policy",
            reference: `confirm:${sensitive}`,
          },
        );
      }

      return {
        kind: "allow",
        operation: operationKind,
        capabilities,
        sideEffecting,
        reason: "Operation allowed by default policy.",
        provenance:
          operation.kind === "tool"
            ? { source: "tool-classification", reference }
            : { source: "default-policy", reference: `allow:${reference}` },
      };
    },
  };
}
