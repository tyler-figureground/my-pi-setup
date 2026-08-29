import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { ScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import {
  createScheduler,
  createSchedulerHostAuthority,
  type HostAuthority,
  type ResultDelivery,
  type SchedulerClock,
} from "./src/automation/scheduler/index.ts";
import type { ArtifactStore } from "./src/core/artifacts/index.ts";
import type { StateStore } from "./src/core/persistence/index.ts";
import {
  createFileSystemArtifactStore,
  createInMemoryArtifactStore,
} from "./src/core/artifacts/index.ts";
import {
  createMemoryStateStore,
  createSqliteStateStore,
} from "./src/core/persistence/index.ts";

const project = {
  kind: "non-git" as const,
  projectId: "non-git:scheduler-project",
  requestedCwd: "C:/scheduler-project",
  canonicalCwd: "C:/scheduler-project",
  cwdWasAliased: false,
};

const profile: ResolvedAgentProfile = {
  description: "Pinned scheduled work",
  identity: {
    name: "nightly",
    contentDigest: "a".repeat(64),
    catalogGeneration: 7,
    source: { scope: "user", path: "C:/agent/profiles/nightly.yaml" },
  },
  defaults: { backend: "pi", model: "test-model", effort: "medium" },
  policy: {
    role: "scheduled",
    instructions: [],
    skills: [],
    tools: { denied: [] },
    limits: {},
    workspace: "current",
  },
};

class FakeClock implements SchedulerClock {
  nowMs = Date.parse("2027-01-01T00:00:00.000Z");
  armedAt: number | null = null;
  maximumArmed = 0;
  #wake: (() => void) | undefined;

  now = () => this.nowMs;

  arm(at: number, wake: () => void) {
    this.armedAt = at;
    this.#wake = wake;
    this.maximumArmed = Math.max(this.maximumArmed, 1);
    return () => {
      if (this.#wake !== wake) return;
      this.#wake = undefined;
      this.armedAt = null;
    };
  }

  async advanceTo(at: number) {
    this.nowMs = at;
    const wake =
      this.armedAt !== null && this.armedAt <= at ? this.#wake : undefined;
    if (wake) {
      this.#wake = undefined;
      this.armedAt = null;
      wake();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createAuthority(boundProject = project): HostAuthority {
  return {
    async authorize(request) {
      if (
        request.projectId !== boundProject.projectId ||
        request.cwd !== boundProject.canonicalCwd
      )
        return {
          ok: false,
          error: {
            code: "project_denied",
            message: "Project changed.",
            retryable: false,
          },
        };
      return {
        ok: true,
        value: { project: boundProject, projectTrusted: true, profile },
      };
    },
  };
}

function createExecutor(): ScheduledAgentExecutor {
  return {
    async run() {
      return {
        ok: true,
        value: { status: "completed", output: "done", outputBytes: 4 },
      };
    },
  };
}

function createDelivery(): ResultDelivery {
  return {
    async deliver() {
      return { ok: true, value: { state: "delivered" } };
    },
  };
}

async function openScheduler(
  clock = new FakeClock(),
  overrides: {
    state?: StateStore;
    artifacts?: ArtifactStore;
    authority?: HostAuthority;
    executor?: ScheduledAgentExecutor;
    delivery?: ResultDelivery;
    ownerId?: string;
    retention?: { maxOccurrences?: number; maxInspection?: number };
    project?: typeof project;
    creatorSessionId?: string;
  } = {},
) {
  const boundProject = overrides.project ?? project;
  const opened = await createScheduler({
    state: overrides.state ?? createMemoryStateStore({ now: clock.now }),
    artifacts:
      overrides.artifacts ?? createInMemoryArtifactStore({ clock: clock.now }),
    clock,
    authority: overrides.authority ?? createAuthority(boundProject),
    executor: overrides.executor ?? createExecutor(),
    delivery: overrides.delivery ?? createDelivery(),
    ownerId: overrides.ownerId ?? "scheduler-owner",
    retention: overrides.retention,
    binding: {
      project: boundProject,
      cwd: boundProject.canonicalCwd,
      creatorSessionId: overrides.creatorSessionId ?? "parent-session",
      resultRoute: { kind: "session", sessionId: "result-session" },
    },
  });
  if (!opened.ok) throw new Error("Scheduler failed to open.");
  return { ...opened.value, clock };
}

test("runtime missed policy collapses backlog and preserves anchored cadence", async () => {
  const clock = new FakeClock();
  const occurrences: string[] = [];
  const executor: ScheduledAgentExecutor = {
    async run(request) {
      occurrences.push(request.occurrenceId);
      return {
        ok: true,
        value: { status: "completed", output: "done", outputBytes: 4 },
      };
    },
  };
  const { scheduler } = await openScheduler(clock, { executor });
  for (const [id, missedRunPolicy] of [
    ["missed-run-once", "run-once"],
    ["missed-skip", "skip"],
  ] as const) {
    const created = await scheduler.change({
      type: "create",
      requestId: `${id}-create`,
      id,
      expectedRevision: 0,
      scope: "durable",
      schedule: {
        kind: "interval",
        anchor: "2027-01-01T01:00:00Z",
        everyMs: 3_600_000,
      },
      missedRunPolicy,
      profileName: "nightly",
      prompt: `Execute ${id}.`,
    });
    assert.equal(created.ok, true);
  }

  await clock.advanceTo(Date.parse("2027-01-01T05:30:00Z"));
  for (let spin = 0; occurrences.length === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(occurrences.length, 1);
  const inspected = await scheduler.inspect({ includeHistory: true });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.deepEqual(
      inspected.value.schedules.map(({ id, nextAt }) => ({ id, nextAt })),
      [
        { id: "missed-run-once", nextAt: "2027-01-01T06:00:00.000Z" },
        { id: "missed-skip", nextAt: "2027-01-01T06:00:00.000Z" },
      ],
    );
    assert.equal(
      inspected.value.schedules.find(({ id }) => id === "missed-run-once")
        ?.recentOccurrences[0]?.dueAt,
      "2027-01-01T01:00:00.000Z",
    );
    assert.equal(
      inspected.value.schedules.find(({ id }) => id === "missed-skip")
        ?.recentOccurrences.length,
      0,
    );
  }
});

test("inspection and occurrence history stay within configured retention bounds", async () => {
  const clock = new FakeClock();
  const { scheduler } = await openScheduler(clock, {
    retention: { maxOccurrences: 2, maxInspection: 2 },
  });
  for (const id of ["retained-a", "retained-b", "retained-c"]) {
    const created = await scheduler.change({
      type: "create",
      requestId: `${id}-create`,
      id,
      expectedRevision: 0,
      scope: "durable",
      schedule: {
        kind: "interval",
        anchor: "2027-01-02T00:00:00Z",
        everyMs: 86_400_000,
      },
      missedRunPolicy: "skip",
      profileName: "nightly",
      prompt: `Run ${id}.`,
    });
    assert.equal(created.ok, true);
  }
  let revision = 1;
  for (const [index, requestId] of [
    "retained-now-1",
    "retained-now-2",
    "retained-now-3",
  ].entries()) {
    const changed = await scheduler.change({
      type: "run-now",
      requestId,
      id: "retained-a",
      expectedRevision: revision,
    });
    assert.equal(changed.ok, true);
    revision += 1;
    await clock.advanceTo(clock.nowMs);
    for (let spin = 0; spin < 20; spin += 1) {
      const current = await scheduler.inspect({
        id: "retained-a",
        includeHistory: true,
      });
      if (
        current.ok &&
        current.value.schedules[0]?.currentOccurrence === null &&
        current.value.schedules[0]?.recentOccurrences.length ===
          Math.min(index + 1, 2)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const page = await scheduler.inspect({ includeHistory: true });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.deepEqual(
      page.value.schedules.map(({ id }) => id),
      ["retained-a", "retained-b"],
    );
    assert.equal(page.value.nextCursor, "retained-b");
    assert.equal(
      page.value.schedules[0]?.recentOccurrences.length,
      2,
      JSON.stringify(page.value.schedules[0]),
    );
  }
  const tooLarge = await scheduler.inspect({ limit: 3 });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.error.code, "invalid_request");
});

test("multibyte executor output and failure Artifact remain within byte bound", async () => {
  const clock = new FakeClock();
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  const deliveryArtifacts: Parameters<
    ResultDelivery["deliver"]
  >[0]["artifact"][] = [];
  const { scheduler } = await openScheduler(clock, {
    artifacts,
    executor: {
      async run() {
        return {
          ok: true,
          value: { status: "completed", output: "ðŸ’¥", outputBytes: 4 },
        };
      },
    },
    delivery: {
      async deliver(request) {
        deliveryArtifacts.push(request.artifact);
        return { ok: true, value: { state: "delivered" } };
      },
    },
  });
  await scheduler.change({
    type: "create",
    requestId: "multibyte-bound-create",
    id: "multibyte-bound",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Bound UTF-8 output.",
    policy: { timeoutMs: 5_000, maxRetries: 0, maxOutputBytes: 1 },
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; deliveryArtifacts.length === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(deliveryArtifacts.length, 1);
  assert.ok((deliveryArtifacts[0]?.size ?? Number.POSITIVE_INFINITY) <= 1);
  const stored = await artifacts.get(deliveryArtifacts[0]!.id);
  assert.equal(stored.ok, true);
  if (stored.ok) assert.ok(stored.value.body.byteLength <= 1);
});

test("executor results are secret-redacted and control-sanitized before Artifact delivery", async () => {
  const clock = new FakeClock();
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  let deliveredArtifact:
    Parameters<ResultDelivery["deliver"]>[0]["artifact"] | undefined;
  const { scheduler } = await openScheduler(clock, {
    artifacts,
    executor: {
      async run() {
        const output = "token=result-secret-canary\u0000\u001b[31m visible";
        return {
          ok: true,
          value: {
            status: "completed",
            output,
            outputBytes: Buffer.byteLength(output),
          },
        };
      },
    },
    delivery: {
      async deliver(request) {
        deliveredArtifact = request.artifact;
        return { ok: true, value: { state: "delivered" } };
      },
    },
  });
  await scheduler.change({
    type: "create",
    requestId: "sanitize-result-create",
    id: "sanitize-result",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "sanitize output",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !deliveredArtifact && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(deliveredArtifact);
  const stored = await artifacts.get(deliveredArtifact!.id);
  assert.equal(stored.ok, true);
  if (stored.ok) {
    const body = new TextDecoder().decode(stored.value.body);
    assert.equal(body.includes("result-secret-canary"), false);
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(body), false);
    assert.match(body, /token=\[REDACTED\]/);
  }
});

test("retryable executor outcome is never replayed because spawn status is ambiguous", async () => {
  const clock = new FakeClock();
  let authorityChecks = 0;
  const authority: HostAuthority = {
    async authorize() {
      authorityChecks += 1;
      return { ok: true, value: { project, projectTrusted: true, profile } };
    },
  };
  let attempts = 0;
  const executor: ScheduledAgentExecutor = {
    async run() {
      attempts += 1;
      return {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "token=must-not-reach-inspection",
          retryable: true,
        },
      };
    },
  };
  const deliveries: Parameters<ResultDelivery["deliver"]>[0][] = [];
  const delivery: ResultDelivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const { scheduler } = await openScheduler(clock, {
    authority,
    executor,
    delivery,
  });
  await scheduler.change({
    type: "create",
    requestId: "timeout-create",
    id: "timeout-job",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Never replay an ambiguous executor outcome.",
    policy: { timeoutMs: 1_000, maxRetries: 5, maxOutputBytes: 1_024 },
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; deliveries.length === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(attempts, 1);
  assert.equal(authorityChecks, 2);
  assert.equal(deliveries.length, 1);
  const inspected = await scheduler.inspect({
    id: "timeout-job",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    const occurrence = inspected.value.schedules[0]?.recentOccurrences[0];
    assert.equal(occurrence?.attempt, 1);
    assert.equal(occurrence?.state, "failed");
    assert.equal(occurrence?.error?.code, "backend_unavailable");
    assert.equal(
      JSON.stringify(occurrence).includes("must-not-reach-inspection"),
      false,
    );
  }
});

test("lease loss aborts executor and fences its stale successful completion", async () => {
  const clock = new FakeClock();
  let started = false;
  let aborted = false;
  let finish: (() => void) | undefined;
  const executor: ScheduledAgentExecutor = {
    run(_request, signal) {
      started = true;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            ok: true,
            value: { status: "completed", output: "stale", outputBytes: 5 },
          });
      });
    },
  };
  let deliveries = 0;
  const delivery: ResultDelivery = {
    async deliver() {
      deliveries += 1;
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const { scheduler } = await openScheduler(clock, { executor, delivery });
  await scheduler.change({
    type: "create",
    requestId: "lease-loss-create",
    id: "lease-loss",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Lose the claim.",
    policy: { timeoutMs: 300_000, maxRetries: 0, maxOutputBytes: 1_024 },
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !started && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  await clock.advanceTo(Date.parse("2027-01-01T00:01:01.001Z"));
  assert.equal(aborted, true);

  finish?.();
  for (let spin = 0; spin < 10; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveries, 0);
  const inspected = await scheduler.inspect({ id: "lease-loss" });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.schedules[0]?.state, "blocked");
    assert.equal(
      inspected.value.schedules[0]?.currentOccurrence?.state,
      "unknown",
    );
  }
});

test("one physical wake renews a long-running occurrence lease", async () => {
  const clock = new FakeClock();
  let finish: ((output: string) => void) | undefined;
  const executor: ScheduledAgentExecutor = {
    run() {
      return new Promise((resolve) => {
        finish = (output) =>
          resolve({
            ok: true,
            value: {
              status: "completed",
              output,
              outputBytes: Buffer.byteLength(output),
            },
          });
      });
    },
  };
  const deliveries: Parameters<ResultDelivery["deliver"]>[0][] = [];
  const delivery: ResultDelivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const { scheduler } = await openScheduler(clock, { executor, delivery });
  await scheduler.change({
    type: "create",
    requestId: "renew-create",
    id: "renew-job",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Keep the lease alive.",
    policy: { timeoutMs: 300_000, maxRetries: 0, maxOutputBytes: 1_024 },
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let attempt = 0; !finish && attempt < 20; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(finish);

  for (const elapsed of [20_001, 40_002, 60_003, 80_004])
    await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z") + elapsed);
  finish!("renewed result");
  for (let attempt = 0; deliveries.length === 0 && attempt < 20; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(deliveries.length, 1);
  assert.equal(clock.maximumArmed, 1);
  const inspected = await scheduler.inspect({
    id: "renew-job",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok)
    assert.equal(
      inspected.value.schedules[0]?.recentOccurrences[0]?.state,
      "completed",
    );
});

test("profile drift immediately before spawn blocks with redacted inspection error", async () => {
  const clock = new FakeClock();
  let checks = 0;
  const authority: HostAuthority = {
    async authorize() {
      checks += 1;
      if (checks === 1)
        return { ok: true, value: { project, projectTrusted: true, profile } };
      return {
        ok: true,
        value: {
          project,
          projectTrusted: true,
          profile: {
            ...profile,
            identity: {
              ...profile.identity,
              contentDigest: "b".repeat(64),
            },
          },
        },
      };
    },
  };
  let executions = 0;
  const executor: ScheduledAgentExecutor = {
    async run() {
      executions += 1;
      return {
        ok: false,
        error: {
          code: "run_failed",
          message: "token=super-secret-value",
          retryable: false,
        },
      };
    },
  };
  const { scheduler } = await openScheduler(clock, { authority, executor });
  await scheduler.change({
    type: "create",
    requestId: "drift-create",
    id: "drift-job",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Do not run with changed authority.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let attempt = 0; attempt < 20; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(executions, 0);
  const inspected = await scheduler.inspect({
    id: "drift-job",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    const schedule = inspected.value.schedules[0];
    assert.equal(schedule?.state, "blocked");
    assert.equal(schedule?.currentOccurrence, null);
    assert.equal(schedule?.recentOccurrences[0]?.state, "failed");
    assert.equal(
      schedule?.recentOccurrences[0]?.error?.code,
      "profile_changed",
    );
    assert.equal(
      JSON.stringify(schedule).includes("super-secret-value"),
      false,
    );
  }
});

test("restart safely reclaims an expired pre-spawn occurrence", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  let authorityChecks = 0;
  let executionAuthorityStarted = false;
  const blockedAuthority: HostAuthority = {
    async authorize() {
      authorityChecks += 1;
      if (authorityChecks === 1)
        return { ok: true, value: { project, projectTrusted: true, profile } };
      executionAuthorityStarted = true;
      return new Promise(() => {});
    },
  };
  const first = await openScheduler(clock, {
    state,
    artifacts,
    authority: blockedAuthority,
    ownerId: "pre-spawn-owner-before",
  });
  await first.scheduler.change({
    type: "create",
    requestId: "pre-spawn-recovery-create",
    id: "pre-spawn-recovery",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Recover only before spawn.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !executionAuthorityStarted && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executionAuthorityStarted, true);
  await first.close();
  clock.nowMs += 60_001;

  let executions = 0;
  const restarted = await openScheduler(clock, {
    state,
    artifacts,
    ownerId: "pre-spawn-owner-after",
    executor: {
      async run() {
        executions += 1;
        return {
          ok: true,
          value: { status: "completed", output: "recovered", outputBytes: 9 },
        };
      },
    },
  });
  for (let spin = 0; executions === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 1);
  const inspected = await restarted.scheduler.inspect({
    id: "pre-spawn-recovery",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok)
    assert.equal(
      inspected.value.schedules[0]?.recentOccurrences[0]?.state,
      "completed",
    );
});

test("restart resumes idempotent delivery of a committed result without rerunning executor", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  let executions = 0;
  const executor: ScheduledAgentExecutor = {
    async run() {
      executions += 1;
      return {
        ok: true,
        value: { status: "completed", output: "committed", outputBytes: 9 },
      };
    },
  };
  let failedDeliveries = 0;
  const failingDelivery: ResultDelivery = {
    async deliver() {
      failedDeliveries += 1;
      return {
        ok: false,
        error: {
          code: "delivery_failed",
          message: "Session is offline.",
          retryable: true,
        },
      };
    },
  };
  const first = await openScheduler(clock, {
    state,
    artifacts,
    executor,
    delivery: failingDelivery,
    ownerId: "delivery-owner-before",
  });
  await first.scheduler.change({
    type: "create",
    requestId: "delivery-recovery-create",
    id: "delivery-recovery",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Persist before delivery.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; failedDeliveries === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 1);
  assert.equal(failedDeliveries, 1);
  await first.close();
  clock.nowMs += 60_001;

  const deliveryIds: string[] = [];
  const restarted = await openScheduler(clock, {
    state,
    artifacts,
    executor,
    ownerId: "delivery-owner-after",
    delivery: {
      async deliver(request) {
        deliveryIds.push(request.deliveryId);
        return { ok: true, value: { state: "delivered" } };
      },
    },
  });
  for (let spin = 0; deliveryIds.length === 0 && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 1);
  assert.equal(deliveryIds.length, 1);
  const inspected = await restarted.scheduler.inspect({
    id: "delivery-recovery",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.schedules[0]?.currentOccurrence, null);
    assert.equal(
      inspected.value.schedules[0]?.recentOccurrences[0]?.delivered,
      true,
    );
  }
});

test("post-spawn restart becomes blocked unknown without automatic replay", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  let executions = 0;
  const executor: ScheduledAgentExecutor = {
    async run() {
      executions += 1;
      return new Promise(() => {});
    },
  };
  const first = await openScheduler(clock, {
    state,
    artifacts,
    executor,
    ownerId: "owner-before-crash",
  });
  await first.scheduler.change({
    type: "create",
    requestId: "unknown-create",
    id: "unknown-job",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Potentially side-effecting prompt.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let attempt = 0; executions === 0 && attempt < 20; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 1);
  await first.close();
  clock.nowMs += 60_001;

  const restarted = await openScheduler(clock, {
    state,
    artifacts,
    executor,
    ownerId: "owner-after-crash",
  });
  const inspected = await restarted.scheduler.inspect({
    id: "unknown-job",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.schedules[0]?.state, "blocked");
    assert.equal(
      inspected.value.schedules[0]?.currentOccurrence?.state,
      "unknown",
    );
    assert.match(inspected.value.schedules[0]?.blockedReason ?? "", /unknown/i);
  }
  await clock.advanceTo(clock.nowMs + 120_000);
  assert.equal(executions, 1);
});

test("due occurrence revalidates authority, runs exact profile, stores result Artifact, and delivers once", async () => {
  const clock = new FakeClock();
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  const authorityRequests: Parameters<HostAuthority["authorize"]>[0][] = [];
  const authority: HostAuthority = {
    async authorize(request) {
      authorityRequests.push(request);
      return { ok: true, value: { project, projectTrusted: true, profile } };
    },
  };
  const executorRequests: Parameters<ScheduledAgentExecutor["run"]>[0][] = [];
  const executor: ScheduledAgentExecutor = {
    async run(request) {
      executorRequests.push(request);
      return {
        ok: true,
        value: {
          status: "completed",
          output: "bounded scheduled result",
          outputBytes: 24,
          sessionId: "scheduled-child",
        },
      };
    },
  };
  const deliveries: Parameters<ResultDelivery["deliver"]>[0][] = [];
  const delivery: ResultDelivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "offline" } };
    },
  };
  const { scheduler } = await openScheduler(clock, {
    artifacts,
    authority,
    executor,
    delivery,
  });
  const created = await scheduler.change({
    type: "create",
    requestId: "due-create",
    id: "due-job",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Run this exact Artifact prompt.",
    credentialReferences: ["credential:ci-read"],
    policy: { timeoutMs: 5_000, maxRetries: 1, maxOutputBytes: 1_024 },
  });
  assert.equal(created.ok, true);

  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let attempt = 0; deliveries.length === 0 && attempt < 20; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(authorityRequests.length, 2);
  assert.deepEqual(authorityRequests[1]?.expectedProfile, {
    name: "nightly",
    contentDigest: "a".repeat(64),
    source: { scope: "user", path: "C:/agent/profiles/nightly.yaml" },
  });
  assert.equal(executorRequests.length, 1);
  assert.deepEqual(executorRequests[0], {
    occurrenceId:
      "d9da5e068839367ed091b9e3917cf1bb0289acef57aa26c112de35cb05dda7cf",
    prompt: "Run this exact Artifact prompt.",
    cwd: project.canonicalCwd,
    projectId: project.projectId,
    profile,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.deliveryId, executorRequests[0]?.occurrenceId);
  assert.equal(deliveries[0]?.route.sessionId, "result-session");
  const result = await artifacts.get(deliveries[0]!.artifact.id);
  assert.equal(result.ok, true);
  if (result.ok)
    assert.equal(
      new TextDecoder().decode(result.value.body),
      "bounded scheduled result",
    );

  const inspected = await scheduler.inspect({
    id: "due-job",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    assert.equal(inspected.value.schedules[0]?.currentOccurrence, null);
    assert.deepEqual(inspected.value.schedules[0]?.recentOccurrences, [
      {
        id: executorRequests[0]?.occurrenceId,
        kind: "regular",
        dueAt: "2027-01-01T00:00:01.000Z",
        state: "completed",
        attempt: 1,
        claimedAt: "2027-01-01T00:00:01.000Z",
        startedAt: "2027-01-01T00:00:01.000Z",
        completedAt: "2027-01-01T00:00:01.000Z",
        resultArtifact: deliveries[0]?.artifact,
        delivered: true,
      },
    ]);
  }
});

test("revisioned controls pause, resume, run now, and delete idempotently", async () => {
  const { scheduler, clock } = await openScheduler();
  const created = await scheduler.change({
    type: "create",
    requestId: "controls-create",
    id: "controlled",
    expectedRevision: 0,
    scope: "durable",
    schedule: {
      kind: "interval",
      anchor: "2027-01-01T01:00:00Z",
      everyMs: 3_600_000,
    },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Controlled prompt.",
  });
  assert.equal(created.ok, true);
  assert.equal(clock.armedAt, Date.parse("2027-01-01T01:00:00Z"));

  const paused = await scheduler.change({
    type: "pause",
    requestId: "controls-pause",
    id: "controlled",
    expectedRevision: 1,
  });
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(paused.value.schedule.state, "paused");
  assert.equal(paused.value.schedule.revision, 2);
  assert.equal(clock.armedAt, null);

  const pauseReplay = await scheduler.change({
    type: "pause",
    requestId: "controls-pause",
    id: "controlled",
    expectedRevision: 1,
  });
  assert.equal(pauseReplay.ok, true);
  if (pauseReplay.ok) assert.equal(pauseReplay.value.replayed, true);

  const staleResume = await scheduler.change({
    type: "resume",
    requestId: "controls-resume-stale",
    id: "controlled",
    expectedRevision: 1,
  });
  assert.equal(staleResume.ok, false);
  if (!staleResume.ok)
    assert.equal(staleResume.error.code, "revision_conflict");

  const resumed = await scheduler.change({
    type: "resume",
    requestId: "controls-resume",
    id: "controlled",
    expectedRevision: 2,
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.value.schedule.state, "active");
  assert.equal(resumed.value.schedule.revision, 3);
  assert.equal(clock.armedAt, Date.parse("2027-01-01T01:00:00Z"));

  const runNow = await scheduler.change({
    type: "run-now",
    requestId: "controls-run-now",
    id: "controlled",
    expectedRevision: 3,
  });
  assert.equal(runNow.ok, true);
  if (!runNow.ok) return;
  assert.equal(runNow.value.schedule.revision, 4);
  assert.equal(runNow.value.schedule.nextAt, "2027-01-01T01:00:00.000Z");
  assert.equal(clock.armedAt, clock.nowMs);

  const deleted = await scheduler.change({
    type: "delete",
    requestId: "controls-delete",
    id: "controlled",
    expectedRevision: 4,
  });
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.value.schedule.state, "deleted");
  assert.equal(deleted.value.schedule.revision, 5);
  assert.equal(clock.armedAt, null);

  const inspected = await scheduler.inspect();
  assert.equal(inspected.ok, true);
  if (inspected.ok) assert.deepEqual(inspected.value.schedules, []);
});

function spawnSchedulerWorker(
  databasePath: string,
  artifactRoot: string,
  gate: string,
  marker: string,
  ownerId: string,
  now: number,
) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(import.meta.dirname, "scheduler-sqlite-worker.ts"),
      databasePath,
      artifactRoot,
      gate,
      marker,
      ownerId,
      String(now),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error(`Scheduler worker did not become ready: ${stderr}`)),
      10_000,
    );
    const inspect = () => {
      if (!stdout.includes("READY\n")) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.once("close", (code) => {
      if (stdout.includes("READY\n")) return;
      clearTimeout(timeout);
      reject(
        new Error(
          `Scheduler worker exited ${code}: stdout=${JSON.stringify(stdout)} stderr=${stderr}`,
        ),
      );
    });
  });
  const result = new Promise<{ executions: number; deliveries: number }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Scheduler worker exited ${code}: ${stderr}`));
          return;
        }
        const line = stdout.trim().split("\n").at(-1);
        try {
          const parsed = JSON.parse(line ?? "") as unknown;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("executions" in parsed) ||
            !("deliveries" in parsed) ||
            typeof parsed.executions !== "number" ||
            typeof parsed.deliveries !== "number"
          )
            throw new Error("invalid result shape");
          resolve({
            executions: parsed.executions,
            deliveries: parsed.deliveries,
          });
        } catch {
          reject(
            new Error(`Scheduler worker returned invalid output: ${stdout}`),
          );
        }
      });
    },
  );
  return {
    ready,
    result,
    cancel() {
      if (child.exitCode === null) child.kill();
    },
  };
}

test("two native Node and SQLite schedulers claim one occurrence for one executor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-scheduler-sqlite-"));
  const databasePath = join(directory, "scheduler.sqlite");
  const artifactRoot = join(directory, "artifacts");
  const gate = join(directory, "gate");
  const marker = join(directory, "executions.txt");
  const clock = new FakeClock();
  const state = createSqliteStateStore({ path: databasePath, now: clock.now });
  assert.equal(state.ok, true);
  if (!state.ok) return;
  try {
    const prepared = await openScheduler(clock, {
      state: state.value,
      artifacts: createFileSystemArtifactStore({
        root: artifactRoot,
        clock: clock.now,
      }),
      ownerId: "scheduler-preparer",
    });
    const created = await prepared.scheduler.change({
      type: "create",
      requestId: "native-race-create",
      id: "native-race",
      expectedRevision: 0,
      scope: "durable",
      schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
      missedRunPolicy: "run-once",
      profileName: "nightly",
      prompt: "Only one native worker may execute.",
    });
    assert.equal(created.ok, true);
    await prepared.close();

    const dueAt = Date.parse("2027-01-01T00:00:01Z");
    const workers = [
      spawnSchedulerWorker(
        databasePath,
        artifactRoot,
        gate,
        marker,
        "native-owner-a",
        dueAt,
      ),
      spawnSchedulerWorker(
        databasePath,
        artifactRoot,
        gate,
        marker,
        "native-owner-b",
        dueAt,
      ),
    ];
    try {
      await Promise.all(workers.map(({ ready }) => ready));
      await writeFile(gate, "go", { flag: "wx" });
      const results = await Promise.all(workers.map(({ result }) => result));
      assert.equal(
        results.reduce((total, result) => total + result.executions, 0),
        1,
      );
      assert.equal(
        results.reduce((total, result) => total + result.deliveries, 0),
        1,
      );
      const markers = (await readFile(marker, "utf8")).trim().split(/\r?\n/);
      assert.equal(markers.length, 1);
      assert.match(markers[0] ?? "", /^native-owner-[ab]$/);
    } finally {
      for (const worker of workers) worker.cancel();
      await Promise.allSettled(workers.map(({ result }) => result));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host authority re-resolves project, trust, profile, and credentials", async () => {
  let trusted = true;
  let credentialsAvailable = true;
  const authority = createSchedulerHostAuthority({
    projects: {
      async resolve(cwd) {
        assert.equal(cwd, project.canonicalCwd);
        return { ok: true, value: project };
      },
    },
    profiles: {
      async reload() {
        return { generation: 7, profiles: [profile], diagnostics: [] };
      },
      inspect() {
        return { generation: 7, profiles: [profile], diagnostics: [] };
      },
      list() {
        return [profile];
      },
      resolve(name) {
        return name === profile.identity.name
          ? { ok: true, value: profile }
          : {
              ok: false,
              error: {
                code: "PROFILE_NOT_FOUND",
                message: "Missing profile.",
                retryable: false,
              },
            };
      },
      diagnostics() {
        return [];
      },
    },
    projectTrusted(resolved) {
      assert.equal(resolved.projectId, project.projectId);
      return trusted;
    },
    credentialsAvailable(references) {
      assert.deepEqual(references, ["credential:ci-read"]);
      return credentialsAvailable;
    },
  });
  const request = {
    projectId: project.projectId,
    cwd: project.canonicalCwd,
    profileName: "nightly",
    credentialReferences: ["credential:ci-read"],
  };
  const allowed = await authority.authorize(request);
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.value.profile, profile);

  credentialsAvailable = false;
  const deniedCredential = await authority.authorize(request);
  assert.equal(deniedCredential.ok, false);
  if (!deniedCredential.ok)
    assert.equal(deniedCredential.error.code, "credential_denied");

  credentialsAvailable = true;
  trusted = false;
  const deniedTrust = await authority.authorize(request);
  assert.equal(deniedTrust.ok, false);
  if (!deniedTrust.ok) assert.equal(deniedTrust.error.code, "trust_denied");
});

test("close boundedly awaits an exact in-flight delivery and fences late settlement", async () => {
  const clock = new FakeClock();
  let deliveryStarted = false;
  let releaseDelivery: (() => void) | undefined;
  const runtime = await openScheduler(clock, {
    delivery: {
      async deliver() {
        deliveryStarted = true;
        await new Promise<void>((resolve) => {
          releaseDelivery = resolve;
        });
        return { ok: true, value: { state: "delivered" } };
      },
    },
  });
  await runtime.scheduler.change({
    type: "create",
    requestId: "close-delivery-create",
    id: "close-delivery",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "close during delivery",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !deliveryStarted && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveryStarted, true);

  let closeAcknowledged = false;
  const closing = runtime.close().then(() => {
    closeAcknowledged = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closeAcknowledged, false);
  releaseDelivery?.();
  await closing;
  assert.equal(closeAcknowledged, true);
});

test("close aborts active execution and ignores a stale successful completion", async () => {
  const clock = new FakeClock();
  let started = false;
  let aborted = false;
  let finish: (() => void) | undefined;
  const executor: ScheduledAgentExecutor = {
    run(_request, signal) {
      started = true;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            ok: true,
            value: { status: "completed", output: "stale", outputBytes: 5 },
          });
      });
    },
  };
  let deliveries = 0;
  const delivery: ResultDelivery = {
    async deliver() {
      deliveries += 1;
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const runtime = await openScheduler(clock, { executor, delivery });
  await runtime.scheduler.change({
    type: "create",
    requestId: "close-active-create",
    id: "close-active",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Close while active.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !started && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  await runtime.close();
  assert.equal(aborted, true);
  finish?.();
  for (let spin = 0; spin < 5; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveries, 0);
  const inspected = await runtime.scheduler.inspect();
  assert.equal(inspected.ok, false);
  if (!inspected.ok) assert.equal(inspected.error.code, "closed");
});

test("delete aborts an in-flight occurrence and stale completion cannot deliver", async () => {
  const clock = new FakeClock();
  let started = false;
  let aborted = false;
  let finish: (() => void) | undefined;
  const executor: ScheduledAgentExecutor = {
    run(_request, signal) {
      started = true;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            ok: true,
            value: { status: "completed", output: "stale", outputBytes: 5 },
          });
      });
    },
  };
  const deliveries: Parameters<ResultDelivery["deliver"]>[0][] = [];
  const delivery: ResultDelivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const { scheduler } = await openScheduler(clock, { executor, delivery });
  await scheduler.change({
    type: "create",
    requestId: "delete-active-create",
    id: "delete-active",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Delete while active.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !started && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));

  const deleted = await scheduler.change({
    type: "delete",
    requestId: "delete-active-command",
    id: "delete-active",
    expectedRevision: 1,
  });
  assert.equal(deleted.ok, true);
  assert.equal(aborted, true);
  finish?.();
  for (let spin = 0; spin < 5; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveries.length, 0);
});

test("pause fences and aborts an in-flight occurrence without delivering stale completion", async () => {
  const clock = new FakeClock();
  let started = false;
  let aborted = false;
  let finish: (() => void) | undefined;
  const executor: ScheduledAgentExecutor = {
    run(_request, signal) {
      started = true;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            ok: true,
            value: { status: "completed", output: "stale", outputBytes: 5 },
          });
      });
    },
  };
  const deliveries: Parameters<ResultDelivery["deliver"]>[0][] = [];
  const delivery: ResultDelivery = {
    async deliver(request) {
      deliveries.push(request);
      return { ok: true, value: { state: "delivered" } };
    },
  };
  const { scheduler } = await openScheduler(clock, { executor, delivery });
  await scheduler.change({
    type: "create",
    requestId: "pause-active-create",
    id: "pause-active",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-01T00:00:01Z" },
    missedRunPolicy: "run-once",
    profileName: "nightly",
    prompt: "Pause while active.",
  });
  await clock.advanceTo(Date.parse("2027-01-01T00:00:01Z"));
  for (let spin = 0; !started && spin < 20; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, true);

  const paused = await scheduler.change({
    type: "pause",
    requestId: "pause-active-command",
    id: "pause-active",
    expectedRevision: 1,
  });
  assert.equal(paused.ok, true);
  if (!paused.ok) return;
  assert.equal(aborted, true);
  assert.equal(paused.value.schedule.currentOccurrence, null);
  assert.equal(
    paused.value.schedule.recentOccurrences.at(-1)?.error?.code,
    "cancelled",
  );

  finish?.();
  for (let spin = 0; spin < 5; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveries.length, 0);
});

test("request idempotency digest is stable across object key order", async () => {
  const { scheduler } = await openScheduler();
  const first = await scheduler.change({
    type: "create",
    requestId: "stable-digest-create",
    id: "stable-digest",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "Stable intent.",
  });
  assert.equal(first.ok, true);

  const replay = await scheduler.change({
    prompt: "Stable intent.",
    profileName: "nightly",
    missedRunPolicy: "skip",
    schedule: { at: "2027-01-02T00:00:00Z", kind: "one-shot" },
    scope: "durable",
    expectedRevision: 0,
    id: "stable-digest",
    requestId: "stable-digest-create",
    type: "create",
  });
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.value.replayed, true);
});

test("replace revision pins a new definition and request replay returns the same receipt", async () => {
  const { scheduler } = await openScheduler();
  const created = await scheduler.change({
    type: "create",
    requestId: "replace-create",
    id: "replaceable",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "Original prompt.",
  });
  assert.equal(created.ok, true);

  const command = {
    type: "replace" as const,
    requestId: "replace-definition",
    id: "replaceable",
    expectedRevision: 1,
    scope: "session" as const,
    schedule: {
      kind: "interval" as const,
      anchor: "2027-01-01T02:00:00Z",
      everyMs: 7_200_000,
    },
    missedRunPolicy: "run-once" as const,
    profileName: "nightly",
    prompt: "Replacement prompt.",
    policy: { timeoutMs: 12_000, maxRetries: 0, maxOutputBytes: 2_048 },
  };
  const replaced = await scheduler.change(command);
  assert.equal(replaced.ok, true);
  if (!replaced.ok) return;
  assert.equal(replaced.value.schedule.revision, 2);
  assert.equal(replaced.value.schedule.scope, "session");
  assert.deepEqual(replaced.value.schedule.schedule, {
    kind: "interval",
    anchor: "2027-01-01T02:00:00.000Z",
    everyMs: 7_200_000,
  });
  assert.equal(replaced.value.schedule.missedRunPolicy, "run-once");
  assert.equal(replaced.value.schedule.nextAt, "2027-01-01T02:00:00.000Z");
  assert.deepEqual(replaced.value.schedule.policy, {
    timeoutMs: 12_000,
    maxRetries: 0,
    maxOutputBytes: 2_048,
  });
  assert.notEqual(
    replaced.value.schedule.promptArtifact.id,
    created.ok ? created.value.schedule.promptArtifact.id : "",
  );

  const replay = await scheduler.change(command);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(replay.value.schedule, replaced.value.schedule);
  }
});

test("corrupt persisted scheduler schema fails closed without exposing secret canaries", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  const prepared = await openScheduler(clock, { state, artifacts });
  await prepared.scheduler.change({
    type: "create",
    requestId: "corrupt-create",
    id: "corrupt-record",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "corrupt later",
  });
  await prepared.close();
  const exported = await state.export({ format: "snapshot" });
  assert.equal(exported.ok, true);
  if (!exported.ok || exported.value.format !== "snapshot") return;
  const definition = exported.value.snapshot.records.find(({ collection }) =>
    collection.startsWith("scheduler.definitions."),
  );
  assert.ok(definition);
  const corrupted = await state.transact({
    transactionId: "inject-corrupt-scheduler-record",
    operations: [
      {
        type: "put-record",
        collection: definition!.collection,
        key: definition!.key,
        metadata: {
          ...definition!.metadata,
          revision: "secret=corruption-canary",
        },
        expectedVersion: definition!.version,
      },
    ],
  });
  assert.equal(corrupted.ok, true);

  const reopened = await createScheduler({
    state,
    artifacts,
    clock,
    authority: createAuthority(),
    executor: createExecutor(),
    delivery: createDelivery(),
    ownerId: "corrupt-reader",
    binding: {
      project,
      cwd: project.canonicalCwd,
      creatorSessionId: "corrupt-reader-session",
      resultRoute: { kind: "session", sessionId: "result-session" },
    },
  });
  assert.equal(reopened.ok, false);
  if (!reopened.ok) {
    assert.equal(reopened.error.code, "storage_failed");
    assert.equal(JSON.stringify(reopened.error).includes("canary"), false);
  }
});

test("close removes its session definitions and receipts while durable records survive", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const first = await openScheduler(clock, {
    state,
    creatorSessionId: "cleanup-session",
  });
  for (const [id, scope] of [
    ["cleanup-ephemeral", "session"],
    ["cleanup-durable", "durable"],
  ] as const) {
    const created = await first.scheduler.change({
      type: "create",
      requestId: `${id}-request`,
      id,
      expectedRevision: 0,
      scope,
      schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
      missedRunPolicy: "skip",
      profileName: "nightly",
      prompt: "session cleanup",
    });
    assert.equal(created.ok, true);
  }
  await first.close();

  const reopened = await openScheduler(clock, {
    state,
    creatorSessionId: "cleanup-session",
  });
  const inspected = await reopened.scheduler.inspect();
  assert.equal(inspected.ok, true);
  if (inspected.ok)
    assert.deepEqual(
      inspected.value.schedules.map(({ id }) => id),
      ["cleanup-durable"],
    );
  const recreated = await reopened.scheduler.change({
    type: "create",
    requestId: "cleanup-ephemeral-request",
    id: "cleanup-ephemeral",
    expectedRevision: 0,
    scope: "session",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "session cleanup",
  });
  assert.equal(recreated.ok, true);
  if (recreated.ok) assert.equal(recreated.value.replayed, false);
  const durableReplay = await reopened.scheduler.change({
    type: "create",
    requestId: "cleanup-durable-request",
    id: "cleanup-durable",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "session cleanup",
  });
  assert.equal(durableReplay.ok, true);
  if (durableReplay.ok) assert.equal(durableReplay.value.replayed, true);
  await reopened.close();
});

test("past one-shot and interval creation applies skip or one collapsed run-once", async () => {
  const clock = new FakeClock();
  clock.nowMs = Date.parse("2027-01-01T00:30:00Z");
  let executions = 0;
  const runtime = await openScheduler(clock, {
    executor: {
      async run() {
        executions += 1;
        return {
          ok: true,
          value: { status: "completed", output: "past", outputBytes: 4 },
        };
      },
    },
  });
  for (const [id, schedule, missedRunPolicy] of [
    ["past-one-skip", { kind: "one-shot", at: "2026-12-31T23:00:00Z" }, "skip"],
    [
      "past-one-once",
      { kind: "one-shot", at: "2026-12-31T23:00:00Z" },
      "run-once",
    ],
    [
      "past-interval-skip",
      { kind: "interval", anchor: "2026-12-31T22:00:00Z", everyMs: 3_600_000 },
      "skip",
    ],
    [
      "past-interval-once",
      { kind: "interval", anchor: "2026-12-31T22:00:00Z", everyMs: 3_600_000 },
      "run-once",
    ],
  ] as const) {
    const created = await runtime.scheduler.change({
      type: "create",
      requestId: `${id}-create`,
      id,
      expectedRevision: 0,
      scope: "durable",
      schedule,
      missedRunPolicy,
      profileName: "nightly",
      prompt: "past creation",
    });
    assert.equal(created.ok, true);
  }
  await clock.advanceTo(clock.nowMs);
  for (let spin = 0; executions < 2 && spin < 30; spin += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executions, 2);
  const inspected = await runtime.scheduler.inspect({ includeHistory: true });
  assert.equal(inspected.ok, true);
  if (inspected.ok) {
    const byId = new Map(
      inspected.value.schedules.map((schedule) => [schedule.id, schedule]),
    );
    assert.equal(byId.get("past-one-skip")?.recentOccurrences.length, 0);
    assert.equal(byId.get("past-one-skip")?.nextAt, null);
    assert.equal(byId.get("past-one-once")?.recentOccurrences.length, 1);
    assert.equal(byId.get("past-interval-skip")?.recentOccurrences.length, 0);
    assert.equal(
      byId.get("past-interval-skip")?.nextAt,
      "2027-01-01T01:00:00.000Z",
    );
    assert.equal(byId.get("past-interval-once")?.recentOccurrences.length, 1);
  }
  await runtime.close();
});

test("each mutation refreshes persisted revision across scheduler processes", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const first = await openScheduler(clock, { state, ownerId: "stale-first" });
  const stale = await openScheduler(clock, { state, ownerId: "stale-second" });
  const created = await first.scheduler.change({
    type: "create",
    requestId: "stale-create",
    id: "stale-shared",
    expectedRevision: 0,
    scope: "durable",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "refresh before mutation",
  });
  assert.equal(created.ok, true);
  const paused = await stale.scheduler.change({
    type: "pause",
    requestId: "stale-pause",
    id: "stale-shared",
    expectedRevision: 1,
  });
  assert.equal(paused.ok, true);
  if (paused.ok) assert.equal(paused.value.schedule.revision, 2);
  const staleResume = await first.scheduler.change({
    type: "resume",
    requestId: "stale-resume-conflict",
    id: "stale-shared",
    expectedRevision: 1,
  });
  assert.equal(staleResume.ok, false);
  if (!staleResume.ok)
    assert.equal(staleResume.error.code, "revision_conflict");
  await first.close();
  await stale.close();
});

test("project identity namespaces definitions and request receipts", async () => {
  const clock = new FakeClock();
  const state = createMemoryStateStore({ now: clock.now });
  const projectB = {
    ...project,
    projectId: "non-git:scheduler-project-b",
    requestedCwd: "C:/scheduler-project-b",
    canonicalCwd: "C:/scheduler-project-b",
  };
  const runtimeA = await openScheduler(clock, { state });
  const runtimeB = await openScheduler(clock, { state, project: projectB });
  const definition = {
    type: "create" as const,
    requestId: "same-request",
    id: "same-schedule",
    expectedRevision: 0,
    scope: "durable" as const,
    schedule: { kind: "one-shot" as const, at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip" as const,
    profileName: "nightly",
    prompt: "project-bound",
  };
  const createdA = await runtimeA.scheduler.change(definition);
  assert.equal(createdA.ok, true);
  const hiddenFromB = await runtimeB.scheduler.inspect();
  assert.equal(hiddenFromB.ok, true);
  if (hiddenFromB.ok) assert.deepEqual(hiddenFromB.value.schedules, []);
  const crossProjectPause = await runtimeB.scheduler.change({
    type: "pause",
    requestId: "project-b-cannot-pause-a",
    id: "same-schedule",
    expectedRevision: 1,
  });
  assert.equal(crossProjectPause.ok, false);
  if (!crossProjectPause.ok)
    assert.equal(crossProjectPause.error.code, "not_found");
  const createdB = await runtimeB.scheduler.change(definition);
  assert.equal(createdB.ok, true);
  const inspectedA = await runtimeA.scheduler.inspect();
  const inspectedB = await runtimeB.scheduler.inspect();
  assert.equal(inspectedA.ok, true);
  assert.equal(inspectedB.ok, true);
  if (inspectedA.ok && inspectedB.ok) {
    assert.equal(
      inspectedA.value.schedules[0]?.binding.projectId,
      project.projectId,
    );
    assert.equal(
      inspectedB.value.schedules[0]?.binding.projectId,
      projectB.projectId,
    );
  }
  await runtimeA.close();
  await runtimeB.close();
});

test("hostile descriptors, proxies, toJSON hooks, and cycles decode as invalid requests", async () => {
  const { scheduler } = await openScheduler();
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "create";
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("secret=proxy-canary");
      },
    },
  );
  const cyclic: Record<string, unknown> = {
    type: "create",
    requestId: "cyclic-create",
    id: "cyclic",
    expectedRevision: 0,
    scope: "durable",
    missedRunPolicy: "skip",
    profileName: "nightly",
    prompt: "cycle",
  };
  cyclic.schedule = cyclic;
  const withToJson = {
    type: "pause",
    requestId: "to-json-command",
    id: "missing",
    expectedRevision: 1,
    toJSON() {
      throw new Error("secret=to-json-canary");
    },
  };

  for (const hostile of [accessor, throwingProxy, cyclic, withToJson]) {
    const changed = await scheduler.change(hostile as never);
    assert.equal(changed.ok, false);
    if (!changed.ok) {
      assert.equal(changed.error.code, "invalid_request");
      assert.equal(JSON.stringify(changed.error).includes("canary"), false);
    }
  }
  assert.equal(getterCalls, 0);

  const queryAccessor = Object.defineProperty({}, "limit", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  const queried = await scheduler.inspect(queryAccessor as never);
  assert.equal(queried.ok, false);
  if (!queried.ok) assert.equal(queried.error.code, "invalid_request");
  assert.equal(getterCalls, 0);
});

test("durable create binds host authority and stores prompt as pinned Artifact metadata", async () => {
  const { scheduler, clock } = await openScheduler();
  const command = {
    type: "create" as const,
    requestId: "create-nightly",
    id: "nightly-review",
    expectedRevision: 0,
    scope: "durable" as const,
    schedule: { kind: "one-shot" as const, at: "2027-01-02T00:00:00Z" },
    missedRunPolicy: "skip" as const,
    profileName: "nightly",
    prompt: "Review the repository without exposing this body in state.",
    credentialReferences: ["credential:github-readonly"],
    policy: { timeoutMs: 30_000, maxRetries: 1, maxOutputBytes: 8_192 },
  };

  const created = await scheduler.change(command);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.value.replayed, false);
  assert.deepEqual(created.value.schedule, {
    id: "nightly-review",
    revision: 1,
    scope: "durable",
    state: "active",
    schedule: { kind: "one-shot", at: "2027-01-02T00:00:00.000Z" },
    missedRunPolicy: "skip",
    nextAt: "2027-01-02T00:00:00.000Z",
    binding: {
      projectId: project.projectId,
      cwd: project.canonicalCwd,
      creatorSessionId: "parent-session",
      resultRoute: { kind: "session", sessionId: "result-session" },
      executionRole: "scheduled",
    },
    profile: {
      name: "nightly",
      contentDigest: "a".repeat(64),
      source: { scope: "user", path: "C:/agent/profiles/nightly.yaml" },
    },
    promptArtifact: {
      id: created.value.schedule.promptArtifact.id,
      sha256: created.value.schedule.promptArtifact.sha256,
      size: 58,
      mediaType: "text/plain; charset=utf-8",
    },
    policy: { timeoutMs: 30_000, maxRetries: 1, maxOutputBytes: 8_192 },
    credentialReferenceCount: 1,
    currentOccurrence: null,
    recentOccurrences: [],
  });
  assert.equal("prompt" in created.value.schedule, false);
  assert.equal(clock.armedAt, Date.parse("2027-01-02T00:00:00.000Z"));
  assert.equal(clock.maximumArmed, 1);

  const replay = await scheduler.change(command);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.replayed, true);
    assert.deepEqual(replay.value.schedule, created.value.schedule);
  }

  const inspected = await scheduler.inspect({
    id: "nightly-review",
    includeHistory: true,
  });
  assert.equal(inspected.ok, true);
  if (inspected.ok)
    assert.deepEqual(inspected.value.schedules, [created.value.schedule]);
});
