import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { ProfileCatalog } from "../platform/src/profiles/index.ts";
import {
  goalWorkerExecutorFor,
  type GoalWorkerExecutor,
} from "../shared/goal-worker.ts";
import type { WorkspaceManager } from "../platform/src/workspaces/index.ts";
import subagentsExtension from "./index.ts";
import {
  createGoalWorkerExecutor,
  type GoalWorkerHostExecutor,
} from "./src/goal-worker.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";

const attemptKey = "a".repeat(64);
const profile = {
  description: "Goal fixture",
  identity: {
    name: "goal-fixture",
    contentDigest: "b".repeat(64),
    catalogGeneration: 7,
    source: { scope: "managed", path: "<goal-fixture>" },
  },
  defaults: { backend: "pi", model: "host-model", effort: "high" },
  policy: {
    role: "goal-worker",
    instructions: ["Execute only the assigned Goal Node."],
    skills: [],
    tools: { allowed: ["read", "rg"], denied: ["write", "edit", "bash"] },
    limits: { maxTurns: 3, timeoutMs: 10_000 },
    resources: { project: false, contextFiles: false },
    workspace: "current",
  },
} as const satisfies ResolvedAgentProfile;

const request = {
  attemptKey,
  prompt: "Inspect repository and report evidence.",
  cwd: "C:\\goal-project",
  projectId: "git:goal-project",
  profile: profile.identity,
  timeoutMs: 10_000,
  maxOutputBytes: 4_096,
} as const;

function snapshot(task: SpawnTask, status: "running" | "done" = "running") {
  return {
    id: "sa-goal",
    origin: task.origin ?? "model",
    backend: profile.defaults.backend,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    profile: task.profile,
    status,
    createdAt: 1,
    ...(status === "done" ? { settledAt: 2 } : {}),
    meta: {
      backend: profile.defaults.backend,
      nativeSessionId: "goal-child",
    },
    usage: {},
    metered: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: status === "done" ? "Evidence: focused tests passed." : "",
    turns: status === "done" ? 1 : 0,
  } satisfies SubagentSnapshot;
}

function fixture() {
  let task: SpawnTask | undefined;
  let spawnCount = 0;
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", next: SpawnTask) {
      spawnCount++;
      task = next;
      return snapshot(next);
    },
    async waitFor() {},
    async get() {
      return task ? snapshot(task, "done") : undefined;
    },
    async cancel() {},
  };
  const lifecycle = new AbortController();
  const executor = createGoalWorkerExecutor({
    profiles: () => ({
      generation: () => 7,
      resolve: (name: string) =>
        name === profile.identity.name ? profile : undefined,
    }),
    manager: async () => manager,
    parent: () => ({
      parentCwd: "C:\\host-parent",
      projectTrusted: false,
    }),
    generation: () => 2,
    lifecycleSignal: () => lifecycle.signal,
  });
  return {
    executor,
    get task() {
      return task;
    },
    get spawnCount() {
      return spawnCount;
    },
  };
}

test("goal worker resolves exact host-pinned goal-worker profile and returns artifact-ready output", async () => {
  const run = fixture();
  const outcome = await run.executor.run(request);

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.status, "completed");
  assert.equal(outcome.value.artifact.body, "Evidence: focused tests passed.");
  assert.equal(outcome.value.artifact.size, 31);
  assert.match(outcome.value.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(outcome.value.artifact.metadata, {
    kind: "goal-worker-output",
    attemptKey,
    trust: "worker-reported",
  });
  assert.deepEqual(outcome.value.execution, {
    attemptKey,
    childId: "sa-goal",
    certainty: "started",
  });
  assert.equal(outcome.value.sessionId, "goal-child");
  assert.equal(run.task?.title, `Goal attempt ${attemptKey}`);
  assert.equal(run.task?.execution?.role, "goal-worker");
  assert.deepEqual(run.task?.profile, profile.identity);
  assert.equal(run.task?.model, "host-model");
  assert.equal(run.task?.reasoningEffort, "high");
});

test("goal worker rejects policy and authority override smuggling before Supervisor dispatch", async () => {
  const run = fixture();
  const smuggled = {
    ...request,
    role: "parent",
    tools: { allowed: ["bash"] },
    authority: { directUser: true },
  };

  assert.deepEqual(await run.executor.run(smuggled), {
    ok: false,
    error: {
      code: "invalid_request",
      message: "Goal Worker request is outside host safety bounds.",
      retryable: false,
      certainty: "not-started",
    },
  });
  assert.equal(run.spawnCount, 0);
});

test("isolated goal worker leases, renews, and preserves failed workspace", async () => {
  const isolated = {
    ...profile,
    policy: { ...profile.policy, workspace: "isolated" as const },
  };
  const guardedPath = "C:\\guarded\\goal-a";
  const dispositions: string[] = [];
  let renewals = 0;
  let capturedTask: SpawnTask | undefined;
  const workspaceManager = {
    async create() {
      return {
        ok: true as const,
        value: {
          workspaceId: "goal-a",
          projectId: request.projectId,
          projectRoot: request.cwd,
          path: guardedPath,
          branch: "pi-workspace/goal-a",
          baseCommit: "1".repeat(40),
          currentCommit: "1".repeat(40),
          state: "ready" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    },
    async lease(input: Parameters<WorkspaceManager["lease"]>[0]) {
      assert.equal(input.role, "goal-worker");
      assert.equal(input.profileDigest, isolated.identity.contentDigest);
      const created = (await this.create()).value;
      return {
        ok: true as const,
        value: {
          workspaceId: created.workspaceId,
          owner: input.owner,
          fence: 4,
          expiresAt: Date.now() + input.ttlMs,
          snapshot: { ...created, state: "leased" as const },
        },
      };
    },
    async renew(lease: Parameters<WorkspaceManager["renew"]>[0]) {
      renewals++;
      return { ok: true as const, value: lease };
    },
    async disposition(
      lease: Parameters<WorkspaceManager["disposition"]>[0],
      action: Parameters<WorkspaceManager["disposition"]>[1],
    ) {
      dispositions.push(action.kind);
      return {
        ok: true as const,
        value: { ...lease.snapshot, state: "dirty" as const },
      };
    },
  };
  const manager = {
    async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
      capturedTask = task;
      await task.workspaceControl?.renew();
      return snapshot(task);
    },
    async waitFor() {},
    async get() {
      return {
        ...snapshot(capturedTask!, "done"),
        status: "error" as const,
        errorText: "blocked on repository state",
      };
    },
    async cancel() {},
  };
  const lifecycle = new AbortController();
  const executor = createGoalWorkerExecutor({
    profiles: () => ({
      generation: () => isolated.identity.catalogGeneration,
      resolve: () => isolated,
    }),
    manager: async () => manager,
    parent: () => ({ parentCwd: request.cwd, projectTrusted: true }),
    workspaces: () => workspaceManager,
    sessionId: () => "goal-host-session",
    generation: () => 1,
    lifecycleSignal: () => lifecycle.signal,
  });

  const outcome = await executor.run({
    ...request,
    profile: isolated.identity,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, "run_failed");
    assert.equal(outcome.error.retryable, false);
    assert.equal(outcome.error.workspaceId, "goal-a");
  }
  assert.equal(capturedTask?.cwd, guardedPath);
  assert.equal(capturedTask?.workspace?.role, "goal-worker");
  assert.equal(renewals, 1);
  assert.deepEqual(dispositions, ["preserve"]);
});

test("subagents binds Goal Worker port lazily and removes it before shutdown", async () => {
  const events = createEventBus();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let managerStarts = 0;
  const api = {
    events,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry() {},
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  subagentsExtension(api, {
    goalWorkerManager: async () => {
      managerStarts++;
      throw new Error("manager must remain lazy");
    },
  });

  assert.ok(goalWorkerExecutorFor(events));
  assert.equal(managerStarts, 0);
  await handlers.get("session_shutdown")?.({
    type: "session_shutdown",
    reason: "reload",
  });
  assert.equal(goalWorkerExecutorFor(events), undefined);
  assert.equal(managerStarts, 0);
});

test("the default Goal Worker manager declares Supervisor token metering", async () => {
  const events = createEventBus();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const catalog = {
    async reload() {
      return {
        generation: profile.identity.catalogGeneration,
        profiles: [profile],
        diagnostics: [],
      };
    },
    inspect: () => ({
      generation: profile.identity.catalogGeneration,
      profiles: [profile],
      diagnostics: [],
    }),
    list: () => [profile],
    resolve: (name: string) =>
      name === profile.identity.name
        ? { ok: true as const, value: profile as ResolvedAgentProfile }
        : {
            ok: false as const,
            error: {
              code: "PROFILE_NOT_FOUND" as const,
              message: "not found",
              retryable: false,
            },
          },
    diagnostics: () => [],
  } satisfies ProfileCatalog;
  const api = {
    events,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry() {},
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  // No goalWorkerManager override: this is the production adapter.
  subagentsExtension(api, { profileCatalog: catalog });
  const executor = goalWorkerExecutorFor(events);
  assert.ok(executor);

  // The Attempt still cannot run — no session is bound — but it must fail on
  // that, not on metering. Reaching any later failure proves the production
  // manager resolved with authoritative whole-attempt metering attached.
  const outcome = await executor.run({ ...request, maxTokens: 100_000 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.notEqual(outcome.error.code, "metering_unavailable");

  await handlers.get("session_shutdown")?.({
    type: "session_shutdown",
    reason: "reload",
  });
});

function retaining(executor: GoalWorkerExecutor | undefined) {
  assert.ok(executor && "retention" in executor && "shutdown" in executor);
  return executor as GoalWorkerHostExecutor;
}

test("session shutdown releases Goal Worker attempt retention held by the extension", async () => {
  const events = createEventBus();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const catalog = {
    async reload() {
      return {
        generation: profile.identity.catalogGeneration,
        profiles: [profile],
        diagnostics: [],
      };
    },
    inspect: () => ({
      generation: profile.identity.catalogGeneration,
      profiles: [profile],
      diagnostics: [],
    }),
    list: () => [profile],
    resolve: (name: string) =>
      name === profile.identity.name
        ? { ok: true as const, value: profile as ResolvedAgentProfile }
        : {
            ok: false as const,
            error: {
              code: "PROFILE_NOT_FOUND" as const,
              message: "not found",
              retryable: false,
            },
          },
    diagnostics: () => [],
  } satisfies ProfileCatalog;
  const api = {
    events,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    appendEntry() {},
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;
  subagentsExtension(api, {
    profileCatalog: catalog,
    goalWorkerManager: async () => ({
      async spawn(_backend: "pi" | "claude" | "codex", task: SpawnTask) {
        return snapshot(task);
      },
      async waitFor() {},
      async get() {
        return undefined;
      },
      async cancel() {},
    }),
  });

  const executor = retaining(goalWorkerExecutorFor(events));
  // No session is bound, so the attempt settles before dispatch and its small
  // failure is retained for inspection.
  const outcome = await executor.run(request);
  assert.equal(outcome.ok, false);
  assert.deepEqual(executor.retention(), {
    live: 0,
    settled: 1,
    retainedOutcomes: 1,
    retainedBytes: outcome.ok ? 0 : Buffer.byteLength(outcome.error.message),
  });

  await handlers.get("session_shutdown")?.({
    type: "session_shutdown",
    reason: "reload",
  });

  assert.deepEqual(executor.retention(), {
    live: 0,
    settled: 1,
    retainedOutcomes: 0,
    retainedBytes: 0,
  });
  const afterShutdown = await executor.run(request);
  assert.equal(afterShutdown.ok, false);
  if (afterShutdown.ok) return;
  assert.equal(afterShutdown.error.code, "execution_unknown");
  assert.equal(afterShutdown.error.certainty, "unknown");
});
