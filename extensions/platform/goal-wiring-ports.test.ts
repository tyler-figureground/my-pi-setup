import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import {
  createGoalRuntime,
  goalCommandDigest,
  type GoalAuthorityVerifier,
  type GoalCommand,
  type GoalCommandAuthority,
  type GoalExecutorPort,
  type GoalProfileResolution,
  type GoalSubmitCommand,
} from "./src/goals/index.ts";
import {
  createGoalWorkerExecutorPort,
  createLocalReviewGoalReview,
  createProfileCatalogGoalProfiles,
  createSystemGoalClock,
} from "./src/goals/host.ts";
import { createSessionBrokerGoalDelivery } from "./src/goals/delivery.ts";
import {
  decodeGoalConfiguration,
  defaultPlatformGoalConfiguration,
} from "./src/goals/config.ts";
import type {
  GoalWorkerExecutor,
  GoalWorkerInspection,
  GoalWorkerOutcome,
  GoalWorkerRequest,
} from "../shared/goal-worker.ts";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { LocalReview } from "./src/review/index.ts";

const ATTEMPT_KEY = "b".repeat(64);
const PROFILE_DIGEST = "a".repeat(64);

function fakeClock(start = 1_000) {
  let current = start;
  const timers = new Set<{ at: number; wake: () => void }>();
  return {
    now: () => current,
    arm(at: number, wake: () => void) {
      const timer = { at, wake };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advance(ms: number) {
      current += ms;
      for (const timer of [...timers]) {
        if (timer.at <= current) {
          timers.delete(timer);
          timer.wake();
        }
      }
    },
  };
}

function authority(command: GoalCommand): GoalCommandAuthority {
  return {
    actor: "direct-user",
    actorId: "pi-session:session-1",
    projectId: "project-1",
    sessionId: "session-1",
    commandDigest: goalCommandDigest(command),
    token: "approval",
    expiresAt: 10_000_000,
  };
}

function submitCommand(): GoalSubmitCommand {
  return {
    type: "submit",
    requestId: "request-1",
    goalId: "ship-feature",
    objective: "Ship the feature",
    nodes: [
      {
        id: "plan",
        title: "Plan",
        prompt: "Plan the work",
        dependsOn: [],
        profileName: "goal-worker",
      },
    ],
    budget: {
      maxConcurrency: 1,
      maxAgentCalls: 2,
      maxRuntimeMs: 3_600_000,
    },
  };
}

/**
 * Stand-in host approval issuer: only the exact token the fixture minted, bound
 * to the digest the engine recomputed, verifies.
 */
const issuedAuthority: GoalAuthorityVerifier = {
  verify: (request) =>
    request.authority.token === "approval" &&
    request.authority.commandDigest === request.commandDigest &&
    request.authority.projectId === request.projectId &&
    request.authority.sessionId === request.sessionId,
};

function goalRuntime(input: {
  readonly executor: GoalExecutorPort;
  readonly workspacePolicy?: GoalProfileResolution["workspacePolicy"];
  readonly workspaces?: Parameters<typeof createGoalRuntime>[0]["workspaces"];
}) {
  const clock = fakeClock();
  const state = createMemoryStateStore({ now: () => clock.now() });
  return {
    clock,
    runtime: createGoalRuntime({
      state,
      artifacts: createInMemoryArtifactStore({ clock: () => clock.now() }),
      clock,
      executor: input.executor,
      profiles: {
        async resolve(name) {
          return {
            ok: true,
            value: {
              name,
              contentDigest: PROFILE_DIGEST,
              catalogGeneration: 1,
              source: { scope: "user", path: "/profiles/goal-worker.yaml" },
              role: "goal-worker",
              workspacePolicy: input.workspacePolicy ?? "isolated",
            },
          };
        },
      },
      ...(input.workspaces ? { workspaces: input.workspaces } : {}),
      review: {
        async verify() {
          return {
            ok: false,
            error: {
              code: "invalid_request",
              message: "no host review",
              retryable: false,
            },
          };
        },
      },
      delivery: {
        async deliver() {
          return { ok: true, value: { state: "delivered" } };
        },
      },
      binding: {
        projectId: "project-1",
        cwd: "/repo",
        sessionId: "session-1",
      },
      ownerId: "owner-1",
      authority: issuedAuthority,
    }),
  };
}

function workerCompletion(
  overrides: Partial<Extract<GoalWorkerOutcome, { ok: true }>["value"]> = {},
): GoalWorkerOutcome {
  return {
    ok: true,
    value: {
      status: "completed",
      artifact: {
        body: "done",
        filename: "goal-worker-output.txt",
        mediaType: "text/plain; charset=utf-8",
        size: 4,
        sha256:
          "a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211",
        metadata: {
          kind: "goal-worker-output",
          attemptKey: ATTEMPT_KEY,
          trust: "worker-reported",
        },
      },
      execution: {
        attemptKey: ATTEMPT_KEY,
        childId: "child-1",
        certainty: "started",
      },
      workspaceId: "workspace-9",
      ...overrides,
    },
  };
}

test("the Goal Worker executor port owns workspaces and declares only the metering it proves", () => {
  const worker = {
    async run() {
      return workerCompletion();
    },
    async inspect(attemptKey: string) {
      return { attemptKey, state: "unknown", certainty: "unknown" } as const;
    },
  };
  const port = createGoalWorkerExecutorPort(worker);
  assert.equal(port.workspaceOwnership, "executor");
  // Agent Supervisor meters whole-attempt tokens and prices nothing.
  assert.deepEqual(port.metering, { tokens: true, cost: false });
});

test("production Goal Worker wiring admits a token budget and still refuses a cost budget", async (t) => {
  const requests: GoalWorkerRequest[] = [];
  const worker: GoalWorkerExecutor = {
    async run(request) {
      requests.push(request);
      return workerCompletion({
        usage: { tokens: 640, authoritative: true, source: "agent-supervisor" },
      });
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "not-started", certainty: "not-started" };
    },
  };
  const harness = goalRuntime({
    executor: createGoalWorkerExecutorPort(worker),
    workspacePolicy: "inherit",
  });
  t.after(() => harness.runtime.close());
  const submitFor = (budget: {
    maxTokens?: number;
    maxCostMicros?: number;
  }) => {
    const command: GoalSubmitCommand = {
      ...submitCommand(),
      budget: {
        maxConcurrency: 1,
        maxAgentCalls: 4,
        maxRuntimeMs: 3_600_000,
        ...budget,
      },
      nodes: [
        {
          id: "plan",
          title: "Plan",
          prompt: "Plan the work",
          dependsOn: [],
          profileName: "goal-worker",
          reservation: {
            tokens: budget.maxTokens === undefined ? 0 : 750,
            costMicros: budget.maxCostMicros === undefined ? 0 : 400,
          },
        },
      ],
    };
    return harness.runtime.engine.submit(command, authority(command));
  };

  const priced = await submitFor({ maxCostMicros: 2_000 });
  assert.equal(priced.ok, false);
  if (!priced.ok) assert.equal(priced.error.code, "metering_unavailable");
  assert.equal(requests.length, 0);

  const metered = await submitFor({ maxTokens: 5_000 });
  assert.equal(metered.ok, true);
  await harness.runtime.drain();
  assert.equal(requests.length, 1);
  // The node's worst case reaches the executor as its cap, so the Supervisor
  // can stop the child rather than only refusing a burned completion.
  assert.equal(requests[0]!.maxTokens, 750);
});

test("the executor port forwards exactly the bound Attempt request", async () => {
  const requests: GoalWorkerRequest[] = [];
  const port = createGoalWorkerExecutorPort({
    async run(request) {
      requests.push(request);
      return workerCompletion();
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "not-started", certainty: "not-started" };
    },
  });
  const outcome = await port.run({
    attemptKey: ATTEMPT_KEY,
    prompt: "Plan the work",
    cwd: "/repo",
    projectId: "project-1",
    profile: {
      name: "goal-worker",
      contentDigest: PROFILE_DIGEST,
      catalogGeneration: 1,
      source: { scope: "user", path: "/profiles/goal-worker.yaml" },
    },
    timeoutMs: 900_000,
    maxOutputBytes: 262_144,
  });

  assert.equal(requests.length, 1);
  // An absent cap is an absent key, never an undefined one: the Goal Worker
  // validates its request as an exact field set.
  assert.deepEqual(Object.keys(requests[0]!), [
    "attemptKey",
    "prompt",
    "cwd",
    "projectId",
    "profile",
    "timeoutMs",
    "maxOutputBytes",
  ]);
  assert.deepEqual(Object.keys(requests[0]!.profile), [
    "name",
    "contentDigest",
    "catalogGeneration",
    "source",
  ]);
  assert.equal(Object.getPrototypeOf(requests[0]!), Object.prototype);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.value.workspaceId, "workspace-9");

  const metered = await port.run({
    attemptKey: ATTEMPT_KEY,
    prompt: "Plan the work",
    cwd: "/repo",
    projectId: "project-1",
    profile: {
      name: "goal-worker",
      contentDigest: PROFILE_DIGEST,
      catalogGeneration: 1,
      source: { scope: "user", path: "/profiles/goal-worker.yaml" },
    },
    timeoutMs: 900_000,
    maxOutputBytes: 262_144,
    maxTokens: 1_000,
  });
  assert.equal(metered.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.maxTokens, 1_000);

  const priced = await port.run({
    attemptKey: ATTEMPT_KEY,
    prompt: "Plan the work",
    cwd: "/repo",
    projectId: "project-1",
    profile: {
      name: "goal-worker",
      contentDigest: PROFILE_DIGEST,
      catalogGeneration: 1,
      source: { scope: "user", path: "/profiles/goal-worker.yaml" },
    },
    timeoutMs: 900_000,
    maxOutputBytes: 262_144,
    maxCostMicros: 5_000,
  });
  // Tokens are proven; a price is not, and an unproven dimension is refused
  // before dispatch rather than silently dropped from the request.
  assert.equal(priced.ok, false);
  if (!priced.ok) {
    assert.equal(priced.error.code, "metering_unavailable");
    assert.equal(priced.error.certainty, "not-started");
  }
  assert.equal(requests.length, 2);

  const inspected = await port.inspect(ATTEMPT_KEY);
  assert.deepEqual(inspected, {
    attemptKey: ATTEMPT_KEY,
    state: "not-started",
    certainty: "not-started",
  });
});

test("an executor owned workspace is recorded on the Attempt and prepared only once", async (t) => {
  const workspaceCalls: string[] = [];
  const executor = createGoalWorkerExecutorPort({
    async run(request) {
      return workerCompletion({
        execution: {
          attemptKey: request.attemptKey,
          childId: "child-1",
          certainty: "started",
        },
        artifact: {
          body: "done",
          filename: "goal-worker-output.txt",
          mediaType: "text/plain; charset=utf-8",
          size: 4,
          sha256:
            "a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211",
          metadata: {
            kind: "goal-worker-output",
            attemptKey: request.attemptKey,
            trust: "worker-reported",
          },
        },
      });
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "unknown", certainty: "unknown" };
    },
  });
  const harness = goalRuntime({
    executor,
    workspaces: {
      async prepare(request) {
        workspaceCalls.push(`prepare:${request.nodeId}`);
        return {
          ok: true,
          value: { workspaceId: "host-workspace", cwd: "/repo/.worktrees/x" },
        };
      },
      async dispose(request) {
        workspaceCalls.push(`dispose:${request.workspaceId}`);
        return { ok: true, value: { disposition: "preserved" } };
      },
    },
  });
  t.after(() => harness.runtime.close());
  const command = submitCommand();
  const submitted = await harness.runtime.engine.submit(
    command,
    authority(command),
  );
  assert.equal(submitted.ok, true);
  await harness.runtime.drain();

  const observed = await harness.runtime.engine.observe({
    goalId: "ship-feature",
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  const node = observed.value.detail?.nodes[0];
  assert.equal(node?.state, "done");
  assert.deepEqual(workspaceCalls, []);
  assert.equal(node?.attempts[0]?.workspaceId, "workspace-9");
});

test("an isolated profile without any workspace owner blocks the node", async (t) => {
  const hostOwned: GoalExecutorPort = {
    async run() {
      throw new Error("must not dispatch without a workspace owner");
    },
    async inspect(attemptKey) {
      return { attemptKey, state: "not-started", certainty: "not-started" };
    },
  };
  const harness = goalRuntime({ executor: hostOwned });
  t.after(() => harness.runtime.close());
  const command = submitCommand();
  await harness.runtime.engine.submit(command, authority(command));
  await harness.runtime.drain();

  const observed = await harness.runtime.engine.observe({
    goalId: "ship-feature",
  });
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(observed.value.detail?.nodes[0]?.state, "blocked");
  assert.equal(
    observed.value.detail?.nodes[0]?.blockedReason,
    "workspace_failed",
  );
});

function profileFixture(
  overrides: Partial<ResolvedAgentProfile["policy"]> = {},
): ResolvedAgentProfile {
  return {
    description: "Goal worker",
    identity: {
      name: "goal-worker",
      contentDigest: PROFILE_DIGEST,
      catalogGeneration: 4,
      source: { scope: "user", path: "/profiles/goal-worker.yaml" },
    },
    defaults: { backend: "pi" },
    policy: {
      role: "goal-worker",
      instructions: [],
      skills: [],
      tools: { denied: [] },
      limits: {},
      workspace: "current",
      ...overrides,
    },
  };
}

test("the Goal profile port revalidates the catalog and fails closed", async () => {
  const revalidated: string[] = [];
  let trusted = true;
  let workspaces = true;
  const profiles = createProfileCatalogGoalProfiles({
    catalog: {
      resolve() {
        return {
          ok: false,
          error: {
            code: "PROFILE_NOT_FOUND",
            message: "stale cache must not be used",
            retryable: false,
          },
        };
      },
      async revalidate(name) {
        revalidated.push(name);
        return { ok: true, value: profileFixture() };
      },
    },
    projectRoot: "/repo",
    projectTrusted: () => trusted,
    workspacesAvailable: () => workspaces,
  });

  const resolved = await profiles.resolve("goal-worker");
  assert.deepEqual(revalidated, ["goal-worker"]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.deepEqual(resolved.value, {
      name: "goal-worker",
      contentDigest: PROFILE_DIGEST,
      catalogGeneration: 4,
      source: { scope: "user", path: "/profiles/goal-worker.yaml" },
      role: "goal-worker",
      workspacePolicy: "inherit",
    });
  }

  trusted = false;
  const untrusted = await profiles.resolve("goal-worker");
  assert.equal(untrusted.ok, false);
  if (!untrusted.ok) assert.equal(untrusted.error.code, "profile_denied");
  trusted = true;

  const isolated = createProfileCatalogGoalProfiles({
    catalog: {
      resolve() {
        return { ok: true, value: profileFixture({ workspace: "isolated" }) };
      },
    },
    projectRoot: "/repo",
    projectTrusted: () => true,
    workspacesAvailable: () => workspaces,
  });
  const withWorkspaces = await isolated.resolve("goal-worker");
  assert.equal(withWorkspaces.ok, true);
  if (withWorkspaces.ok)
    assert.equal(withWorkspaces.value.workspacePolicy, "isolated");
  workspaces = false;
  const withoutWorkspaces = await isolated.resolve("goal-worker");
  assert.equal(withoutWorkspaces.ok, false);
  if (!withoutWorkspaces.ok)
    assert.equal(withoutWorkspaces.error.code, "profile_denied");
});

test("the Goal profile port never rewrites a non goal worker Execution Role", async () => {
  const profiles = createProfileCatalogGoalProfiles({
    catalog: {
      resolve() {
        return {
          ok: true,
          value: profileFixture({ role: "subagent" }),
        };
      },
    },
    projectRoot: "/repo",
    projectTrusted: () => true,
    workspacesAvailable: () => true,
  });
  const resolved = await profiles.resolve("goal-worker");
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.value.role, "subagent");
});

test("host review evidence is only produced for the project tree it can actually inspect", async () => {
  const runs: unknown[] = [];
  const review: LocalReview = {
    async run(target, options) {
      runs.push({ target, includeTests: options.includeTests });
      return {
        ok: true,
        value: {
          status: "completed",
          conclusion: "no-findings",
          target: { kind: "uncommitted", targetId: "uncommitted" },
          freshness: { kind: "fresh" as const, ahead: 0, behind: 0 },
          findings: [],
          rejectedFindingCount: 0,
          artifact: {
            id: "artifact-1",
            sha256: "c".repeat(64),
            size: 12,
            createdAt: 1,
            mediaType: "application/json",
          },
        },
      };
    },
  };
  const port = createLocalReviewGoalReview({ review: () => review });

  const verified = await port.verify({
    goalId: "ship-feature",
    nodeId: "plan",
    attemptKey: ATTEMPT_KEY,
    criterionId: "reviewed",
    acceptedEvidenceKinds: ["review-report"],
    artifact: null,
    cwd: "/repo",
    workspaceId: null,
  });
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.value.satisfied, true);
    assert.equal(verified.value.kind, "review-report");
    assert.deepEqual(verified.value.artifact, {
      id: "artifact-1",
      sha256: "c".repeat(64),
      size: 12,
      mediaType: "application/json",
    });
  }
  assert.deepEqual(runs, [
    { target: { kind: "uncommitted" }, includeTests: true },
  ]);

  const workspaceBound = await port.verify({
    goalId: "ship-feature",
    nodeId: "plan",
    attemptKey: ATTEMPT_KEY,
    criterionId: "reviewed",
    acceptedEvidenceKinds: ["review-report"],
    artifact: null,
    cwd: "/repo",
    workspaceId: "workspace-9",
  });
  assert.equal(workspaceBound.ok, true);
  if (workspaceBound.ok) assert.equal(workspaceBound.value.satisfied, false);

  const otherKind = await port.verify({
    goalId: "ship-feature",
    nodeId: "plan",
    attemptKey: ATTEMPT_KEY,
    criterionId: "output",
    acceptedEvidenceKinds: ["worker-output"],
    artifact: null,
    cwd: "/repo",
    workspaceId: null,
  });
  assert.equal(otherKind.ok, true);
  if (otherKind.ok) assert.equal(otherKind.value.satisfied, false);
  assert.equal(runs.length, 1);

  const absent = createLocalReviewGoalReview({ review: () => undefined });
  const unavailable = await absent.verify({
    goalId: "ship-feature",
    nodeId: "plan",
    attemptKey: ATTEMPT_KEY,
    criterionId: "reviewed",
    acceptedEvidenceKinds: ["review-report"],
    artifact: null,
    cwd: "/repo",
    workspaceId: null,
  });
  assert.equal(unavailable.ok, true);
  if (unavailable.ok) assert.equal(unavailable.value.satisfied, false);
});

test("findings block host verified review evidence", async () => {
  const port = createLocalReviewGoalReview({
    review: () => ({
      async run() {
        return {
          ok: true,
          value: {
            status: "completed",
            conclusion: "findings",
            target: { kind: "uncommitted", targetId: "uncommitted" },
            freshness: { kind: "fresh" as const, ahead: 0, behind: 0 },
            findings: [],
            rejectedFindingCount: 0,
            artifact: {
              id: "artifact-2",
              sha256: "d".repeat(64),
              size: 20,
              createdAt: 1,
            },
          },
        };
      },
    }),
  });
  const verified = await port.verify({
    goalId: "ship-feature",
    nodeId: "plan",
    attemptKey: ATTEMPT_KEY,
    criterionId: "reviewed",
    acceptedEvidenceKinds: ["review-report"],
    artifact: null,
    cwd: "/repo",
    workspaceId: null,
  });
  assert.equal(verified.ok, true);
  if (verified.ok) assert.equal(verified.value.satisfied, false);
});

test("Goal delivery is idempotent, session bound, and reports offline queues", async () => {
  const sends: Array<{
    readonly request: Record<string, unknown>;
    readonly automation: unknown;
  }> = [];
  let queued = false;
  const delivery = createSessionBrokerGoalDelivery(
    {
      async send(request, _signal, automation) {
        sends.push({
          request: request as unknown as Record<string, unknown>,
          automation,
        });
        return {
          ok: true,
          value: {
            requestId: "receipt",
            body: { id: "body", sha256: "0".repeat(64), size: 0, createdAt: 0 },
            deliveries: queued
              ? [{ recipient: "session-1", state: "queued" as const }]
              : [{ recipient: "session-1", state: "delivered" as const }],
            replayed: false,
          },
        } as never;
      },
    },
    { sessionId: "session-1" },
  );

  const delivered = await delivery.deliver({
    deliveryId: "e".repeat(64),
    goalId: "ship-feature",
    state: "done",
    summary: "Goal ship-feature is done.",
    runGeneration: 1,
  });
  assert.equal(delivered.ok, true);
  if (delivered.ok) assert.equal(delivered.value.state, "delivered");
  assert.deepEqual(sends[0]?.automation, {
    producerId: "goals",
    idempotencyKey: "e".repeat(64),
  });
  assert.deepEqual(sends[0]?.request.recipients, [
    { piSessionId: "session-1" },
  ]);
  const body = sends[0]?.request.body as { readonly text: string };
  assert.match(body.text, /Trust: untrusted\. Authority: none\./);
  assert.match(body.text, /Goal: ship-feature/);

  queued = true;
  const offline = await delivery.deliver({
    deliveryId: "f".repeat(64),
    goalId: "ship-feature",
    state: "blocked",
    summary: "Goal ship-feature is blocked.",
    runGeneration: 1,
  });
  assert.equal(offline.ok, true);
  if (offline.ok) assert.equal(offline.value.state, "offline");
});

test("Goal delivery failure is reported as a retryable storage failure", async () => {
  const delivery = createSessionBrokerGoalDelivery(
    {
      async send() {
        return {
          ok: false,
          error: {
            code: "storage_failed",
            message: "broker unavailable",
            retryable: true,
          },
        } as never;
      },
    },
    { sessionId: "session-1" },
  );
  const result = await delivery.deliver({
    deliveryId: "a".repeat(64),
    goalId: "ship-feature",
    state: "failed",
    summary: "Goal ship-feature is failed.",
    runGeneration: 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "storage_failed");
    assert.equal(result.error.retryable, true);
  }
});

test("the system Goal clock arms bounded timers", () => {
  const clock = createSystemGoalClock();
  assert.equal(typeof clock.now(), "number");
  const cancel = clock.arm(clock.now() + 10_000, () => {
    throw new Error("timer must not fire");
  });
  cancel();
  const farCancel = clock.arm(clock.now() + 30 * 24 * 3_600_000, () => {
    throw new Error("timer must not fire");
  });
  farCancel();
});

test("goal settings decode inside host safety bounds", () => {
  assert.deepEqual(decodeGoalConfiguration(undefined), {
    goals: defaultPlatformGoalConfiguration,
    diagnostics: [],
  });

  const unknown = decodeGoalConfiguration({ nope: 1 });
  assert.equal(unknown.diagnostics.length, 1);
  assert.match(unknown.diagnostics[0]!.message, /Unknown goal setting/);

  const tooLarge = decodeGoalConfiguration({ maxAgentCalls: 100_000 });
  assert.equal(tooLarge.goals.maxAgentCalls, 256);
  assert.match(tooLarge.diagnostics[0]!.message, /host safety bounds/);

  const narrowed = decodeGoalConfiguration(
    { maxAgentCalls: 16, maxConcurrentNodes: 1 },
    defaultPlatformGoalConfiguration,
    "project",
  );
  assert.equal(narrowed.goals.maxAgentCalls, 16);
  assert.equal(narrowed.goals.maxConcurrentNodes, 1);
  assert.equal(narrowed.goals.defaultConcurrency, 1);

  const widened = decodeGoalConfiguration(
    { maxNodesPerGoal: 128 },
    defaultPlatformGoalConfiguration,
    "project",
  );
  assert.equal(
    widened.goals.maxNodesPerGoal,
    defaultPlatformGoalConfiguration.maxNodesPerGoal,
  );
  assert.match(widened.diagnostics[0]!.message, /host safety bounds/);
});

test("executor failures keep their certainty, workspace, and usage", async () => {
  const failure: GoalWorkerOutcome = {
    ok: false,
    error: {
      code: "execution_unknown",
      message: "Goal Worker dispatch outcome is unknown.",
      retryable: false,
      certainty: "unknown",
      childId: "child-1",
      workspaceId: "workspace-9",
      usage: { tokens: 12, authoritative: true, source: "agent-supervisor" },
    },
  };
  const inspection: GoalWorkerInspection = {
    attemptKey: ATTEMPT_KEY,
    state: "running",
    certainty: "started",
    childId: "child-1",
    workspaceId: "workspace-9",
  };
  const worker: GoalWorkerExecutor = {
    async run() {
      return failure;
    },
    async inspect() {
      return inspection;
    },
  };
  const port = createGoalWorkerExecutorPort(worker);
  const outcome = await port.run({
    attemptKey: ATTEMPT_KEY,
    prompt: "Plan the work",
    cwd: "/repo",
    projectId: "project-1",
    profile: {
      name: "goal-worker",
      contentDigest: PROFILE_DIGEST,
      catalogGeneration: 1,
      source: { scope: "user", path: "/profiles/goal-worker.yaml" },
    },
    timeoutMs: 900_000,
    maxOutputBytes: 262_144,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.certainty, "unknown");
    assert.equal(outcome.error.workspaceId, "workspace-9");
    assert.equal(outcome.error.usage?.authoritative, true);
  }
  assert.deepEqual(await port.inspect(ATTEMPT_KEY), inspection);
});
