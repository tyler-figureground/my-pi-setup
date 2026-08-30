import { digestOf } from "./digest.ts";
import {
  GOAL_EVIDENCE_KINDS,
  GOAL_EVIDENCE_TRUST,
  GOAL_IDENTIFIER,
  GOAL_LIMITS,
  GOAL_REQUEST_ID,
  type GoalBudgetLimits,
  type GoalBudgetLimitsInput,
  type GoalCriterion,
  type GoalCriterionInput,
  type GoalDefinition,
  type GoalNodeDefinition,
  type GoalNodeInput,
  type GoalOutcome,
  type GoalSubmitCommand,
} from "./model.ts";

/**
 * Declarative validation for Goal submissions and edits.
 *
 * Structure is rejected before persistence: unknown fields, bad identifiers,
 * unbounded text, out-of-range numbers, duplicate identifiers, self
 * dependencies, missing dependencies, and cycles. Callers receive one stable
 * machine-readable `reason` so hosts can explain a rejection without parsing
 * prose.
 */

export function goalInvalid(reason: string, path?: string): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code: "invalid_request",
      message: `Goal submission is invalid: ${reason}.`,
      retryable: false,
      details: path === undefined ? { reason } : { reason, path },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unexpectedKey(
  value: unknown,
  allowed: readonly string[],
): string | null {
  if (!isRecord(value)) return null;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function isText(value: unknown, maximum: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum
  );
}

function isInteger(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

const COMMAND_FIELDS = [
  "type",
  "requestId",
  "goalId",
  "objective",
  "nodes",
  "budget",
  "criteria",
  "activate",
];
const NODE_FIELDS = [
  "id",
  "title",
  "prompt",
  "dependsOn",
  "profileName",
  "required",
  "policy",
  "reservation",
  "criteria",
];
const POLICY_FIELDS = [
  "timeoutMs",
  "maxAttempts",
  "retryDelayMs",
  "maxOutputBytes",
];
const RESERVATION_FIELDS = ["runtimeMs", "tokens", "costMicros"];
const CRITERION_FIELDS = [
  "id",
  "description",
  "acceptedEvidenceKinds",
  "minimumEvidenceCount",
  "minimumTrust",
];
const BUDGET_FIELDS = [
  "maxConcurrency",
  "maxAgentCalls",
  "maxRuntimeMs",
  "maxTokens",
  "maxCostMicros",
];

export function validateCriteria(
  value: unknown,
  path: string,
): GoalOutcome<readonly GoalCriterion[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return goalInvalid("invalid_criteria", path);
  if (value.length > GOAL_LIMITS.maxCriteria)
    return goalInvalid("too_many_criteria", path);
  const seen = new Set<string>();
  const criteria: GoalCriterion[] = [];
  for (const [index, entry] of value.entries()) {
    const where = `${path}[${index}]`;
    if (!isRecord(entry)) return goalInvalid("invalid_criterion", where);
    const unexpected = unexpectedKey(entry, CRITERION_FIELDS);
    if (unexpected)
      return goalInvalid("unexpected_field", `${where}.${unexpected}`);
    const input = entry as unknown as GoalCriterionInput;
    if (typeof input.id !== "string" || !GOAL_IDENTIFIER.test(input.id))
      return goalInvalid("invalid_criterion_id", where);
    if (seen.has(input.id)) return goalInvalid("duplicate_criterion", where);
    seen.add(input.id);
    if (!isText(input.description, GOAL_LIMITS.maxDescriptionLength))
      return goalInvalid("invalid_criterion_description", where);
    const kinds = input.acceptedEvidenceKinds;
    if (
      !Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.length > GOAL_EVIDENCE_KINDS.length ||
      new Set(kinds).size !== kinds.length ||
      kinds.some((kind) => !GOAL_EVIDENCE_KINDS.includes(kind))
    )
      return goalInvalid("invalid_evidence_kinds", where);
    const minimumEvidenceCount = input.minimumEvidenceCount ?? 1;
    if (
      !isInteger(
        minimumEvidenceCount,
        1,
        GOAL_LIMITS.maxEvidenceCountPerCriterion,
      )
    )
      return goalInvalid("invalid_evidence_count", where);
    const minimumTrust = input.minimumTrust ?? "worker-reported";
    if (!GOAL_EVIDENCE_TRUST.includes(minimumTrust))
      return goalInvalid("invalid_evidence_trust", where);
    criteria.push({
      id: input.id,
      description: input.description,
      acceptedEvidenceKinds: [...kinds],
      minimumEvidenceCount,
      minimumTrust,
    });
  }
  return { ok: true, value: criteria };
}

export function validateBudget(
  value: unknown,
  path = "budget",
): GoalOutcome<GoalBudgetLimits> {
  if (!isRecord(value)) return goalInvalid("invalid_budget", path);
  const unexpected = unexpectedKey(value, BUDGET_FIELDS);
  if (unexpected)
    return goalInvalid("unexpected_field", `${path}.${unexpected}`);
  const input = value as unknown as GoalBudgetLimitsInput;
  if (!isInteger(input.maxConcurrency, 1, GOAL_LIMITS.maxConcurrentNodes))
    return goalInvalid("invalid_concurrency", path);
  if (!isInteger(input.maxAgentCalls, 1, GOAL_LIMITS.maxAgentCalls))
    return goalInvalid("invalid_agent_calls", path);
  if (!isInteger(input.maxRuntimeMs, 1, GOAL_LIMITS.maxRuntimeMs))
    return goalInvalid("invalid_runtime", path);
  if (
    input.maxTokens !== undefined &&
    !isInteger(input.maxTokens, 1, GOAL_LIMITS.maxTokens)
  )
    return goalInvalid("invalid_tokens", path);
  if (
    input.maxCostMicros !== undefined &&
    !isInteger(input.maxCostMicros, 1, GOAL_LIMITS.maxCostMicros)
  )
    return goalInvalid("invalid_cost_micros", path);
  return {
    ok: true,
    value: {
      maxConcurrency: input.maxConcurrency,
      maxAgentCalls: input.maxAgentCalls,
      maxRuntimeMs: input.maxRuntimeMs,
      maxTokens: input.maxTokens ?? null,
      maxCostMicros: input.maxCostMicros ?? null,
    },
  };
}

function validateNode(
  value: unknown,
  index: number,
): GoalOutcome<GoalNodeDefinition> {
  const where = `nodes[${index}]`;
  if (!isRecord(value)) return goalInvalid("invalid_node", where);
  const unexpected = unexpectedKey(value, NODE_FIELDS);
  if (unexpected)
    return goalInvalid("unexpected_field", `${where}.${unexpected}`);
  const input = value as unknown as GoalNodeInput;
  if (typeof input.id !== "string" || !GOAL_IDENTIFIER.test(input.id))
    return goalInvalid("invalid_node_id", where);
  if (!isText(input.title, GOAL_LIMITS.maxTitleLength))
    return goalInvalid("invalid_title", where);
  if (!isText(input.prompt, GOAL_LIMITS.maxPromptLength))
    return goalInvalid("invalid_prompt", where);
  if (
    typeof input.profileName !== "string" ||
    !GOAL_IDENTIFIER.test(input.profileName)
  )
    return goalInvalid("invalid_profile_name", where);
  if (input.required !== undefined && typeof input.required !== "boolean")
    return goalInvalid("invalid_required", where);

  const dependsOn = input.dependsOn ?? [];
  if (!Array.isArray(dependsOn))
    return goalInvalid("invalid_dependencies", where);
  if (dependsOn.length > GOAL_LIMITS.maxDependenciesPerNode)
    return goalInvalid("too_many_dependencies", where);
  const dependencies = new Set<string>();
  for (const dependency of dependsOn) {
    if (typeof dependency !== "string" || !GOAL_IDENTIFIER.test(dependency))
      return goalInvalid("invalid_dependency_id", where);
    if (dependency === input.id) return goalInvalid("self_dependency", where);
    if (dependencies.has(dependency))
      return goalInvalid("duplicate_dependency", where);
    dependencies.add(dependency);
  }

  if (input.policy !== undefined && !isRecord(input.policy))
    return goalInvalid("invalid_policy", where);
  const policyUnexpected = unexpectedKey(input.policy, POLICY_FIELDS);
  if (policyUnexpected)
    return goalInvalid(
      "unexpected_field",
      `${where}.policy.${policyUnexpected}`,
    );
  const policyInput = input.policy ?? {};
  const timeoutMs = policyInput.timeoutMs ?? GOAL_LIMITS.defaultTimeoutMs;
  if (!isInteger(timeoutMs, GOAL_LIMITS.minTimeoutMs, GOAL_LIMITS.maxTimeoutMs))
    return goalInvalid("invalid_timeout", where);
  const maxAttempts = policyInput.maxAttempts ?? 1;
  if (!isInteger(maxAttempts, 1, GOAL_LIMITS.maxAttemptsPerNode))
    return goalInvalid("invalid_max_attempts", where);
  const retryDelayMs =
    policyInput.retryDelayMs ?? GOAL_LIMITS.defaultRetryDelayMs;
  if (!isInteger(retryDelayMs, 0, GOAL_LIMITS.maxRetryDelayMs))
    return goalInvalid("invalid_retry_delay", where);
  const maxOutputBytes =
    policyInput.maxOutputBytes ?? GOAL_LIMITS.defaultOutputBytes;
  if (!isInteger(maxOutputBytes, 1, GOAL_LIMITS.maxOutputBytes))
    return goalInvalid("invalid_output_bytes", where);

  if (input.reservation !== undefined && !isRecord(input.reservation))
    return goalInvalid("invalid_reservation", where);
  const reservationUnexpected = unexpectedKey(
    input.reservation,
    RESERVATION_FIELDS,
  );
  if (reservationUnexpected)
    return goalInvalid(
      "unexpected_field",
      `${where}.reservation.${reservationUnexpected}`,
    );
  const reservationInput = input.reservation ?? {};
  const runtimeMs = reservationInput.runtimeMs ?? timeoutMs;
  if (!isInteger(runtimeMs, 1, GOAL_LIMITS.maxRuntimeMs))
    return goalInvalid("invalid_runtime", where);
  const tokens = reservationInput.tokens ?? 0;
  if (!isInteger(tokens, 0, GOAL_LIMITS.maxTokens))
    return goalInvalid("invalid_tokens", where);
  const costMicros = reservationInput.costMicros ?? 0;
  if (!isInteger(costMicros, 0, GOAL_LIMITS.maxCostMicros))
    return goalInvalid("invalid_cost_micros", where);

  const criteria = validateCriteria(input.criteria, `${where}.criteria`);
  if (!criteria.ok) return criteria;

  const definition = {
    id: input.id,
    title: input.title,
    prompt: input.prompt,
    dependsOn: [...dependencies],
    profileName: input.profileName,
    required: input.required ?? true,
    policy: { timeoutMs, maxAttempts, retryDelayMs, maxOutputBytes },
    reservation: { runtimeMs, tokens, costMicros },
    criteria: criteria.value,
  };
  return {
    ok: true,
    value: { ...definition, digest: goalNodeDigest(definition) },
  };
}

/** Content digest of one node definition. Excludes the digest field itself. */
export function goalNodeDigest(
  definition: Omit<GoalNodeDefinition, "digest">,
): string {
  return digestOf("goal-node-v1", {
    id: definition.id,
    title: definition.title,
    prompt: definition.prompt,
    dependsOn: definition.dependsOn,
    profileName: definition.profileName,
    required: definition.required,
    policy: definition.policy,
    reservation: definition.reservation,
    criteria: definition.criteria,
  });
}

/** Deterministic dependency-respecting order, or a cycle rejection. */
export function topologicalOrder(
  nodes: readonly GoalNodeDefinition[],
): GoalOutcome<readonly string[]> {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, node.dependsOn.length);
    for (const dependency of node.dependsOn) {
      dependents.set(dependency, [
        ...(dependents.get(dependency) ?? []),
        node.id,
      ]);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== nodes.length) return goalInvalid("dependency_cycle");
  return { ok: true, value: order };
}

export function validateGoalGraph(
  goalId: string,
  objective: string,
  criteria: readonly GoalCriterion[],
  nodes: readonly GoalNodeDefinition[],
  budget: GoalBudgetLimits,
): GoalOutcome<GoalDefinition> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return goalInvalid("duplicate_node", node.id);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency))
        return goalInvalid("missing_dependency", `${node.id}.${dependency}`);
    }
  }
  if (
    budget.maxTokens !== null &&
    nodes.some((node) => node.reservation.tokens < 1)
  )
    return goalInvalid("missing_token_reservation");
  if (
    budget.maxCostMicros !== null &&
    nodes.some((node) => node.reservation.costMicros < 1)
  )
    return goalInvalid("missing_cost_reservation");
  const order = topologicalOrder(nodes);
  if (!order.ok) return order;
  const definition = { goalId, objective, criteria, nodes, budget };
  return {
    ok: true,
    value: {
      ...definition,
      order: order.value,
      revisionDigest: digestOf("goal-definition-v1", definition),
    },
  };
}

export function validateGoalSubmission(
  command: GoalSubmitCommand,
): GoalOutcome<GoalDefinition> {
  if (!isRecord(command)) return goalInvalid("invalid_command");
  const unexpected = unexpectedKey(command, COMMAND_FIELDS);
  if (unexpected) return goalInvalid("unexpected_field", unexpected);
  if (command.type !== "submit") return goalInvalid("invalid_command_type");
  if (
    typeof command.requestId !== "string" ||
    !GOAL_REQUEST_ID.test(command.requestId)
  )
    return goalInvalid("invalid_request_id");
  if (
    typeof command.goalId !== "string" ||
    !GOAL_IDENTIFIER.test(command.goalId)
  )
    return goalInvalid("invalid_goal_id");
  if (!isText(command.objective, GOAL_LIMITS.maxObjectiveLength))
    return goalInvalid("invalid_objective");
  if (command.activate !== undefined && typeof command.activate !== "boolean")
    return goalInvalid("invalid_activate");

  const criteria = validateCriteria(command.criteria, "criteria");
  if (!criteria.ok) return criteria;
  const budget = validateBudget(command.budget);
  if (!budget.ok) return budget;

  if (!Array.isArray(command.nodes)) return goalInvalid("invalid_nodes");
  if (command.nodes.length === 0) return goalInvalid("empty_graph");
  if (command.nodes.length > GOAL_LIMITS.maxNodes)
    return goalInvalid("too_many_nodes");
  const nodes: GoalNodeDefinition[] = [];
  for (const [index, entry] of command.nodes.entries()) {
    const node = validateNode(entry, index);
    if (!node.ok) return node;
    nodes.push(node.value);
  }
  return validateGoalGraph(
    command.goalId,
    command.objective,
    criteria.value,
    nodes,
    budget.value,
  );
}
