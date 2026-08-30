import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  GOAL_LIMITS,
  validateGoalSubmission,
  type GoalNodeInput,
  type GoalSubmitCommand,
} from "./src/goals/index.ts";

function node(
  id: string,
  overrides: Partial<GoalNodeInput> = {},
): GoalNodeInput {
  return {
    id,
    title: `Node ${id}`,
    prompt: `Do ${id}`,
    dependsOn: [],
    profileName: "goal-worker",
    ...overrides,
  };
}

function command(
  overrides: Partial<GoalSubmitCommand> = {},
): GoalSubmitCommand {
  return {
    type: "submit",
    requestId: "request-1",
    goalId: "ship-feature",
    objective: "Ship the feature",
    nodes: [node("plan"), node("build", { dependsOn: ["plan"] })],
    budget: {
      maxConcurrency: 2,
      maxAgentCalls: 8,
      maxRuntimeMs: 600_000,
    },
    ...overrides,
  };
}

function expectInvalid(input: GoalSubmitCommand, reason: string) {
  const result = validateGoalSubmission(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid_request");
  assert.equal(result.error.details?.reason, reason);
  assert.equal(result.error.retryable, false);
}

test("valid submission returns pinned definition, defaults, and topological order", () => {
  const result = validateGoalSubmission(command());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const definition = result.value;
  assert.deepEqual(definition.order, ["plan", "build"]);
  assert.equal(definition.nodes.length, 2);
  const plan = definition.nodes[0]!;
  assert.equal(plan.required, true);
  assert.equal(plan.policy.maxAttempts, 1);
  assert.equal(plan.policy.timeoutMs, GOAL_LIMITS.defaultTimeoutMs);
  assert.equal(plan.reservation.runtimeMs, plan.policy.timeoutMs);
  assert.equal(plan.reservation.tokens, 0);
  assert.equal(plan.reservation.costMicros, 0);
  assert.match(definition.revisionDigest, /^[a-f0-9]{64}$/);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
});

test("definition digest is deterministic and objective-sensitive", () => {
  const first = validateGoalSubmission(command());
  const second = validateGoalSubmission(command());
  const changed = validateGoalSubmission(
    command({ objective: "Ship it later" }),
  );
  assert.equal(first.ok && second.ok && changed.ok, true);
  if (!first.ok || !second.ok || !changed.ok) return;
  assert.equal(first.value.revisionDigest, second.value.revisionDigest);
  assert.notEqual(first.value.revisionDigest, changed.value.revisionDigest);
  assert.equal(first.value.nodes[0]!.digest, changed.value.nodes[0]!.digest);
});

test("topological order is deterministic for independent nodes", () => {
  const result = validateGoalSubmission(
    command({
      nodes: [
        node("beta", { dependsOn: ["alpha"] }),
        node("alpha"),
        node("gamma", { dependsOn: ["beta", "alpha"] }),
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.order, ["alpha", "beta", "gamma"]);
});

test("duplicate node identifiers are rejected", () => {
  expectInvalid(
    command({ nodes: [node("plan"), node("plan")] }),
    "duplicate_node",
  );
});

test("self dependencies are rejected", () => {
  expectInvalid(
    command({ nodes: [node("plan", { dependsOn: ["plan"] })] }),
    "self_dependency",
  );
});

test("missing dependencies are rejected", () => {
  expectInvalid(
    command({ nodes: [node("build", { dependsOn: ["plan"] })] }),
    "missing_dependency",
  );
});

test("duplicate dependency entries are rejected", () => {
  expectInvalid(
    command({
      nodes: [node("plan"), node("build", { dependsOn: ["plan", "plan"] })],
    }),
    "duplicate_dependency",
  );
});

test("two node cycles are rejected", () => {
  expectInvalid(
    command({
      nodes: [
        node("plan", { dependsOn: ["build"] }),
        node("build", { dependsOn: ["plan"] }),
      ],
    }),
    "dependency_cycle",
  );
});

test("longer cycles are rejected", () => {
  expectInvalid(
    command({
      nodes: [
        node("a", { dependsOn: ["c"] }),
        node("b", { dependsOn: ["a"] }),
        node("c", { dependsOn: ["b"] }),
        node("d"),
      ],
    }),
    "dependency_cycle",
  );
});

test("identifier formats are enforced", () => {
  expectInvalid(command({ goalId: "Ship Feature" }), "invalid_goal_id");
  expectInvalid(command({ nodes: [node("Plan")] }), "invalid_node_id");
  expectInvalid(command({ requestId: "" }), "invalid_request_id");
  expectInvalid(
    command({ nodes: [node("plan", { profileName: "Bad Name" })] }),
    "invalid_profile_name",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "Not Valid",
              description: "check",
              acceptedEvidenceKinds: ["worker-output"],
              minimumEvidenceCount: 1,
              minimumTrust: "worker-reported",
            },
          ],
        }),
      ],
    }),
    "invalid_criterion_id",
  );
});

test("graph size bounds are enforced", () => {
  const nodes = Array.from({ length: GOAL_LIMITS.maxNodes + 1 }, (_, index) =>
    node(`n-${index}`),
  );
  expectInvalid(command({ nodes }), "too_many_nodes");
  expectInvalid(command({ nodes: [] }), "empty_graph");

  const wide = [
    ...Array.from(
      { length: GOAL_LIMITS.maxDependenciesPerNode + 1 },
      (_, index) => node(`dep-${index}`),
    ),
  ];
  wide.push(node("sink", { dependsOn: wide.map((entry) => entry.id) }));
  expectInvalid(command({ nodes: wide }), "too_many_dependencies");
});

test("attempt, concurrency, and retry bounds are enforced", () => {
  expectInvalid(
    command({ nodes: [node("plan", { policy: { maxAttempts: 0 } })] }),
    "invalid_max_attempts",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          policy: { maxAttempts: GOAL_LIMITS.maxAttemptsPerNode + 1 },
        }),
      ],
    }),
    "invalid_max_attempts",
  );
  expectInvalid(
    command({
      budget: { maxConcurrency: 0, maxAgentCalls: 4, maxRuntimeMs: 1_000 },
    }),
    "invalid_concurrency",
  );
  expectInvalid(
    command({
      budget: {
        maxConcurrency: GOAL_LIMITS.maxConcurrentNodes + 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 1_000,
      },
    }),
    "invalid_concurrency",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          policy: { retryDelayMs: GOAL_LIMITS.maxRetryDelayMs + 1 },
        }),
      ],
    }),
    "invalid_retry_delay",
  );
  expectInvalid(
    command({ nodes: [node("plan", { policy: { retryDelayMs: 10.5 } })] }),
    "invalid_retry_delay",
  );
});

test("bounded text is enforced", () => {
  expectInvalid(
    command({ objective: "x".repeat(GOAL_LIMITS.maxObjectiveLength + 1) }),
    "invalid_objective",
  );
  expectInvalid(command({ objective: "" }), "invalid_objective");
  expectInvalid(
    command({
      nodes: [
        node("plan", { prompt: "x".repeat(GOAL_LIMITS.maxPromptLength + 1) }),
      ],
    }),
    "invalid_prompt",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", { title: "x".repeat(GOAL_LIMITS.maxTitleLength + 1) }),
      ],
    }),
    "invalid_title",
  );
});

test("currency and token reservations must be integers within bounds", () => {
  expectInvalid(
    command({ nodes: [node("plan", { reservation: { costMicros: 12.5 } })] }),
    "invalid_cost_micros",
  );
  expectInvalid(
    command({ nodes: [node("plan", { reservation: { costMicros: -1 } })] }),
    "invalid_cost_micros",
  );
  expectInvalid(
    command({ nodes: [node("plan", { reservation: { tokens: 1.5 } })] }),
    "invalid_tokens",
  );
  expectInvalid(
    command({
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 1_000,
        maxCostMicros: 10.5,
      },
    }),
    "invalid_cost_micros",
  );
});

test("token and cost limits require per node worst case reservations", () => {
  expectInvalid(
    command({
      nodes: [node("plan")],
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 1_000,
        maxTokens: 5_000,
      },
    }),
    "missing_token_reservation",
  );
  expectInvalid(
    command({
      nodes: [node("plan", { reservation: { tokens: 100 } })],
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 1_000,
        maxCostMicros: 5_000,
      },
    }),
    "missing_cost_reservation",
  );
  const metered = validateGoalSubmission(
    command({
      nodes: [node("plan", { reservation: { tokens: 100, costMicros: 25 } })],
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 1_000,
        maxTokens: 5_000,
        maxCostMicros: 5_000,
      },
    }),
  );
  assert.equal(metered.ok, true);
});

test("criteria shape and counts are bounded", () => {
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "checked",
              description: "check",
              acceptedEvidenceKinds: [],
              minimumEvidenceCount: 1,
              minimumTrust: "worker-reported",
            },
          ],
        }),
      ],
    }),
    "invalid_evidence_kinds",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "checked",
              description: "check",
              acceptedEvidenceKinds: ["worker-output", "worker-output"],
              minimumEvidenceCount: 1,
              minimumTrust: "worker-reported",
            },
          ],
        }),
      ],
    }),
    "invalid_evidence_kinds",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "checked",
              description: "check",
              acceptedEvidenceKinds: ["invented-kind" as "worker-output"],
              minimumEvidenceCount: 1,
              minimumTrust: "worker-reported",
            },
          ],
        }),
      ],
    }),
    "invalid_evidence_kinds",
  );
  expectInvalid(
    command({
      nodes: [
        node("plan", {
          criteria: [
            {
              id: "checked",
              description: "check",
              acceptedEvidenceKinds: ["worker-output"],
              minimumEvidenceCount: 0,
              minimumTrust: "worker-reported",
            },
          ],
        }),
      ],
    }),
    "invalid_evidence_count",
  );
  expectInvalid(
    command({
      criteria: Array.from(
        { length: GOAL_LIMITS.maxCriteria + 1 },
        (_, index) => ({
          id: `criterion-${index}`,
          description: "check",
          acceptedEvidenceKinds: ["worker-output" as const],
          minimumEvidenceCount: 1,
          minimumTrust: "worker-reported" as const,
        }),
      ),
    }),
    "too_many_criteria",
  );
  expectInvalid(
    command({
      criteria: [
        {
          id: "same",
          description: "check",
          acceptedEvidenceKinds: ["worker-output"],
          minimumEvidenceCount: 1,
          minimumTrust: "worker-reported",
        },
        {
          id: "same",
          description: "check again",
          acceptedEvidenceKinds: ["worker-output"],
          minimumEvidenceCount: 1,
          minimumTrust: "worker-reported",
        },
      ],
    }),
    "duplicate_criterion",
  );
});

test("unknown fields are rejected rather than silently ignored", () => {
  expectInvalid(
    {
      ...command(),
      autonomous: true,
    } as unknown as GoalSubmitCommand,
    "unexpected_field",
  );
  expectInvalid(
    command({
      nodes: [{ ...node("plan"), script: "run()" } as unknown as GoalNodeInput],
    }),
    "unexpected_field",
  );
  expectInvalid(
    command({
      nodes: [node("plan", { policy: { onFailure: "continue" } as never })],
    }),
    "unexpected_field",
  );
});

test("submission carries no executable orchestration surface", () => {
  const result = validateGoalSubmission(command());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const encoded = JSON.stringify(result.value);
  assert.doesNotMatch(encoded, /function|=>|eval|script/i);
  for (const value of Object.values(result.value.nodes[0]!)) {
    assert.notEqual(typeof value, "function");
  }
});

test("Goal Mode ships no evaluator and no Workflow JavaScript dependency", async () => {
  const directory = new URL("./src/goals/", import.meta.url);
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".ts"),
  );
  assert.ok(files.length >= 8);
  for (const file of files) {
    const source = await readFile(new URL(file, directory), "utf8");
    // Goal definitions are data. Nothing in this module may compile, evaluate,
    // or import executable orchestration.
    assert.doesNotMatch(source, /\beval\s*\(/, file);
    assert.doesNotMatch(source, /new\s+Function\s*\(/, file);
    assert.doesNotMatch(source, /require\s*\(\s*["']node:vm["']\s*\)/, file);
    assert.doesNotMatch(source, /from\s+["'](node:vm|acorn)["']/, file);
    assert.doesNotMatch(source, /from\s+["'][^"']*workflow[^"']*["']/i, file);
  }
});
