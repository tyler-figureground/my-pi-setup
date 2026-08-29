import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedAgentProfile } from "../shared/agent-profile.ts";
import type { ScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import {
  createMonitorRegistry,
  createProductionMonitorSourceFactory,
  type MonitorDeliveryRequest,
  type MonitorSourceEvent,
  type MonitorRegistryRuntime,
  type TerminalObservation,
} from "./src/automation/monitors/index.ts";
import {
  createScheduler,
  type HostAuthority,
  type ResultDelivery,
  type SchedulerClock,
} from "./src/automation/scheduler/index.ts";
import {
  createTriggerEngine,
  type TriggerDelivery,
} from "./src/automation/triggers/index.ts";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import { WebSocketServer } from "ws";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const METRICS_MAX_BYTES = 8 * 1_024;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function flush(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  attempts = 200,
  intervalMs = 5,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  assert.fail(message);
}

function valueOf<T>(
  outcome: { ok: true; value: T } | { ok: false; error: unknown },
) {
  if (!outcome.ok) assert.fail(JSON.stringify(outcome.error));
  return outcome.value;
}

async function emitMetrics(mode: string, metrics: Record<string, unknown>) {
  const bounded = {
    schemaVersion: 1,
    classification: "integration",
    mode,
    ...metrics,
  };
  const json = JSON.stringify(bounded);
  assert.ok(Buffer.byteLength(json) <= METRICS_MAX_BYTES);
  const path = join(
    tmpdir(),
    `pi-phase7-soak-${process.pid}-${mode.replaceAll(/[^a-z0-9-]/giu, "-")}.json`,
  );
  await writeFile(path, json, "utf8");
  console.log(`PHASE7_SOAK_METRICS ${json}`);
  console.log(`PHASE7_SOAK_METRICS_PATH ${path}`);
}

class TriggerSoakClock {
  nowMs = 0;
  #nextId = 0;
  #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  now = () => this.nowMs;

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  clearTimeout = (id: unknown) => {
    if (typeof id === "number") this.#timers.delete(id);
  };

  async advance(ms: number) {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.#timers]
        .filter(([, timer]) => timer.at <= target)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.at - right.at || leftId - rightId,
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.nowMs = timer.at;
      timer.callback();
      await flush();
    }
    this.nowMs = target;
    await flush();
  }
}

class SchedulerSoakClock implements SchedulerClock {
  nowMs = Date.parse("2027-01-01T00:00:00.000Z");
  maximumArmed = 0;
  #nextId = 0;
  #arms = new Map<number, { readonly at: number; readonly wake: () => void }>();

  now = () => this.nowMs;

  arm(at: number, wake: () => void) {
    const id = ++this.#nextId;
    this.#arms.set(id, { at, wake });
    this.maximumArmed = Math.max(this.maximumArmed, this.#arms.size);
    return () => void this.#arms.delete(id);
  }

  async advanceTo(at: number) {
    assert.ok(at >= this.nowMs);
    this.nowMs = at;
    const due = [...this.#arms]
      .filter(([, arm]) => arm.at <= this.nowMs)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.at - right.at || leftId - rightId,
      );
    for (const [id, arm] of due) {
      if (this.#arms.delete(id)) arm.wake();
    }
    await flush(12);
  }
}

const schedulerProject = {
  kind: "non-git" as const,
  projectId: "non-git:phase7-soak",
  requestedCwd: "C:/phase7-soak",
  canonicalCwd: "C:/phase7-soak",
  cwdWasAliased: false,
};

const schedulerProfile: ResolvedAgentProfile = {
  description: "Phase 7 soak profile",
  identity: {
    name: "phase7-soak",
    contentDigest: "a".repeat(64),
    catalogGeneration: 1,
    source: { scope: "user", path: "C:/phase7-soak/profile.yaml" },
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

const schedulerAuthority: HostAuthority = {
  async authorize() {
    return {
      ok: true,
      value: {
        project: schedulerProject,
        projectTrusted: true,
        profile: schedulerProfile,
      },
    };
  },
};

async function openSoakScheduler(
  clock: SchedulerSoakClock,
  state: ReturnType<typeof createMemoryStateStore>,
  artifacts: ReturnType<typeof createInMemoryArtifactStore>,
  ownerId: string,
  executor: ScheduledAgentExecutor,
  delivery: ResultDelivery,
) {
  return valueOf(
    await createScheduler({
      state,
      artifacts,
      clock,
      authority: schedulerAuthority,
      executor,
      delivery,
      ownerId,
      binding: {
        project: schedulerProject,
        cwd: schedulerProject.canonicalCwd,
        creatorSessionId: "phase7-soak-parent",
        resultRoute: { kind: "session", sessionId: "phase7-soak-results" },
      },
      retention: {
        maxOccurrences: 4,
        maxInspection: 8,
        maxRequestReceipts: 16,
      },
    }),
  );
}

async function soakTriggerEngine() {
  const clock = new TriggerSoakClock();
  let nextEventId = 0;
  let batchCallbacks = 0;
  const deliveredEventIds: string[] = [];
  const derivedResults: Awaited<ReturnType<TriggerDelivery["publish"]>>[] = [];
  const runtime = createTriggerEngine({
    hostId: "phase7-soak-trigger",
    clock,
    createEventId: () => `soak-event-${++nextEventId}`,
    maxInspectionEntries: 8,
    maxInspectionBytes: 4 * 1_024,
    maxRootFirings: 5,
    maxCausalDepth: 4,
  });
  const publisher = valueOf(
    runtime.bindSource({
      kind: "fixture",
      id: "phase7-soak-source",
      projectId: schedulerProject.projectId,
      sessionId: "phase7-soak-parent",
      trust: "untrusted",
    }),
  );

  valueOf(
    await runtime.engine.reconcile({
      ownerId: "phase7-soak-owner",
      generation: 1,
      bindings: [
        {
          id: "bounded-batches",
          eventTypes: ["soak.batch"],
          batch: { maxCount: 4, maxWaitMs: 1_000 },
          deliver: async ({ events }) => {
            batchCallbacks += 1;
            deliveredEventIds.push(...events.map(({ id }) => id));
          },
        },
        {
          id: "causal-parent",
          eventTypes: ["soak.causal-root"],
          deliver: async ({ publish }) => {
            for (let index = 0; index < 8; index += 1)
              derivedResults.push(
                await publish({
                  type: "soak.causal-child",
                  payload: { index },
                }),
              );
          },
        },
        {
          id: "causal-child",
          eventTypes: ["soak.causal-child"],
          deliver: async () => undefined,
        },
      ],
    }),
  );

  const batchEvents = 6;
  const hours = 26;
  for (let hour = 0; hour < hours; hour += 1) {
    const publications = Array.from({ length: batchEvents }, (_, index) =>
      publisher.publish({
        type: "soak.batch",
        payload: { hour, index },
      }),
    );
    await clock.advance(HOUR_MS);
    assert.ok((await Promise.all(publications)).every(({ ok }) => ok));
  }
  assert.ok(clock.nowMs > DAY_MS);
  assert.equal(deliveredEventIds.length, hours * batchEvents);
  assert.equal(new Set(deliveredEventIds).size, deliveredEventIds.length);
  assert.equal(batchCallbacks, hours * 2);

  assert.equal(
    (await publisher.publish({ type: "soak.causal-root", payload: {} })).ok,
    true,
  );
  assert.equal(derivedResults.filter(({ ok }) => ok).length, 4);
  assert.equal(derivedResults.filter(({ ok }) => !ok).length, 4);
  for (const result of derivedResults.filter(({ ok }) => !ok)) {
    if (!result.ok) assert.equal(result.error.code, "RECURSION_LIMIT");
  }

  await runtime.close("phase7-soak-complete");
  const inspection = runtime.engine.inspect();
  assert.equal(inspection.state, "closed");
  assert.deepEqual(inspection.queue, {
    count: 0,
    bytes: 0,
    running: 0,
    admitting: 0,
  });
  assert.equal(inspection.counters.unresolvedCallbacks, 0);
  assert.equal(inspection.counters.unresolvedOperations, 0);
  assert.ok(inspection.history.length <= 8);

  return {
    fakeElapsedMs: clock.nowMs,
    published: hours * batchEvents + 1,
    deliveredEvents: deliveredEventIds.length,
    batchCallbacks,
    causalAccepted: derivedResults.filter(({ ok }) => ok).length,
    causalRejected: derivedResults.filter(({ ok }) => !ok).length,
    historyEntries: inspection.history.length,
  };
}

async function soakScheduler() {
  const clock = new SchedulerSoakClock();
  const startedAt = clock.nowMs;
  const state = createMemoryStateStore({ now: clock.now });
  const artifacts = createInMemoryArtifactStore({ clock: clock.now });
  const occurrenceIds: string[] = [];
  const deliveryIds: string[] = [];
  const deliveriesBySchedule = new Map<string, number>();
  const executionOwners: string[] = [];

  const executorFor = (ownerId: string): ScheduledAgentExecutor => ({
    async run(request) {
      executionOwners.push(ownerId);
      occurrenceIds.push(request.occurrenceId);
      return {
        ok: true,
        value: { status: "completed", output: "done", outputBytes: 4 },
      };
    },
  });
  const delivery: ResultDelivery = {
    async deliver(request) {
      deliveryIds.push(request.deliveryId);
      deliveriesBySchedule.set(
        request.scheduleId,
        (deliveriesBySchedule.get(request.scheduleId) ?? 0) + 1,
      );
      return { ok: true, value: { state: "delivered" } };
    },
  };

  const preparer = await openSoakScheduler(
    clock,
    state,
    artifacts,
    "phase7-soak-preparer",
    executorFor("preparer"),
    delivery,
  );
  const definitions = [
    {
      id: "one-shot",
      schedule: {
        kind: "one-shot" as const,
        at: new Date(startedAt + HOUR_MS).toISOString(),
      },
      missedRunPolicy: "run-once" as const,
    },
    {
      id: "interval",
      schedule: {
        kind: "interval" as const,
        anchor: new Date(startedAt + 2 * HOUR_MS).toISOString(),
        everyMs: 2 * HOUR_MS,
      },
      missedRunPolicy: "run-once" as const,
    },
    {
      id: "cron",
      schedule: {
        kind: "cron" as const,
        expression: "0 */6 * * *",
        timeZone: "UTC",
      },
      missedRunPolicy: "run-once" as const,
    },
    {
      id: "missed-run-once",
      schedule: {
        kind: "interval" as const,
        anchor: new Date(startedAt + HOUR_MS / 2).toISOString(),
        everyMs: HOUR_MS,
      },
      missedRunPolicy: "run-once" as const,
    },
    {
      id: "missed-skip",
      schedule: {
        kind: "interval" as const,
        anchor: new Date(startedAt + (3 * HOUR_MS) / 4).toISOString(),
        everyMs: HOUR_MS,
      },
      missedRunPolicy: "skip" as const,
    },
  ];
  for (const definition of definitions) {
    valueOf(
      await preparer.scheduler.change({
        type: "create",
        requestId: `prepare-${definition.id}`,
        id: definition.id,
        expectedRevision: 0,
        scope: "durable",
        schedule: definition.schedule,
        missedRunPolicy: definition.missedRunPolicy,
        profileName: schedulerProfile.identity.name,
        prompt: `Execute ${definition.id}.`,
      }),
    );
  }
  await preparer.close();

  const runtimes = await Promise.all(
    ["scheduler-a", "scheduler-b"].map((ownerId) =>
      openSoakScheduler(
        clock,
        state,
        artifacts,
        ownerId,
        executorFor(ownerId),
        delivery,
      ),
    ),
  );

  const waitUntilIdle = async () => {
    await waitFor(
      async () => {
        const inspected = await runtimes[0]!.scheduler.inspect({
          includeHistory: true,
        });
        return (
          inspected.ok &&
          inspected.value.schedules.every(
            ({ currentOccurrence }) => currentOccurrence === null,
          )
        );
      },
      "Scheduler did not settle all claimed occurrences.",
      300,
      2,
    );
  };

  await clock.advanceTo(startedAt + 5 * HOUR_MS);
  await waitUntilIdle();
  for (let hour = 6; hour <= 30; hour += 1) {
    await clock.advanceTo(startedAt + hour * HOUR_MS);
    await waitUntilIdle();
  }
  assert.ok(clock.nowMs - startedAt > DAY_MS);

  const inspected = valueOf(
    await runtimes[0]!.scheduler.inspect({ includeHistory: true }),
  );
  assert.ok(
    inspected.schedules.every(
      ({ currentOccurrence, recentOccurrences }) =>
        currentOccurrence === null && recentOccurrences.length <= 4,
    ),
  );
  assert.equal(deliveriesBySchedule.get("one-shot"), 1);
  assert.ok((deliveriesBySchedule.get("interval") ?? 0) >= 10);
  assert.ok((deliveriesBySchedule.get("cron") ?? 0) >= 4);
  assert.ok((deliveriesBySchedule.get("missed-run-once") ?? 0) >= 20);
  assert.equal(deliveriesBySchedule.get("missed-skip"), undefined);
  assert.equal(new Set(occurrenceIds).size, occurrenceIds.length);
  assert.equal(new Set(deliveryIds).size, deliveryIds.length);
  assert.deepEqual(new Set(deliveryIds), new Set(occurrenceIds));

  await Promise.all(runtimes.map(({ close }) => close()));
  const closedInspection = await runtimes[0]!.scheduler.inspect();
  assert.equal(closedInspection.ok, false);
  if (!closedInspection.ok) assert.equal(closedInspection.error.code, "closed");

  const snapshot = valueOf(await state.export({ format: "snapshot" })).snapshot;
  assert.equal(snapshot.leases.filter(({ owner }) => owner !== null).length, 0);
  const diagnostics = valueOf(await state.diagnose());
  assert.ok(diagnostics.counts.records <= 32);
  assert.ok(diagnostics.counts.events <= 8);
  assert.ok(diagnostics.counts.transactions <= 512);

  return {
    fakeElapsedMs: clock.nowMs - startedAt,
    instances: runtimes.length,
    occurrences: occurrenceIds.length,
    deliveries: deliveryIds.length,
    executionOwners: new Set(executionOwners).size,
    maximumArmed: clock.maximumArmed,
    maxHistoryEntries: Math.max(
      ...inspected.schedules.map(
        ({ recentOccurrences }) => recentOccurrences.length,
      ),
    ),
    activeClaimsAfterClose: snapshot.leases.filter(
      ({ owner }) => owner !== null,
    ).length,
    stateCounts: diagnostics.counts,
  };
}

async function soakMonitorRegistry() {
  const state = createMemoryStateStore();
  const artifacts = createInMemoryArtifactStore();
  const lifecycle = createLifecycleSupervisor();
  const triggers = createTriggerEngine({
    hostId: "phase7-soak-monitors",
    maxInspectionEntries: 12,
    maxInspectionBytes: 8 * 1_024,
  });
  const emitters = new Map<string, (event: MonitorSourceEvent) => void>();
  const deliveryIds: string[] = [];
  let activeSources = 0;
  let maximumActiveSources = 0;
  let sourceStarts = 0;

  const opened = valueOf(
    await createMonitorRegistry({
      ownerId: "phase7-soak-monitor-registry",
      binding: {
        projectId: schedulerProject.projectId,
        cwd: schedulerProject.canonicalCwd,
        sessionId: "phase7-soak-parent",
      },
      triggers,
      lifecycle,
      artifacts,
      state,
      sources: {
        async open(definition, emit) {
          sourceStarts += 1;
          activeSources += 1;
          maximumActiveSources = Math.max(maximumActiveSources, activeSources);
          emitters.set(definition.id, emit);
          let closed = false;
          return {
            close() {
              if (closed) return;
              closed = true;
              activeSources -= 1;
              if (emitters.get(definition.id) === emit)
                emitters.delete(definition.id);
            },
          };
        },
      },
      delivery: {
        async deliver(request) {
          deliveryIds.push(request.deliveryId);
          return { ok: true, value: { state: "delivered" } };
        },
      },
      authority: {
        async authorize() {
          return { ok: true, value: { allowed: true } };
        },
      },
      limits: {
        maxInspection: 3,
        batchWindowMs: 2,
        maxBatchCount: 4,
        maxReceipts: 8,
      },
    }),
  );

  const cycles = 8;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const id = `monitor-${cycle}`;
    valueOf(
      await opened.registry.change({
        type: "create",
        requestId: `${id}-create`,
        id,
        expectedRevision: 0,
        scope: "session",
        source: { kind: "terminal", terminalId: `${id}-terminal-a` },
        delivery: { kind: "session", sessionId: "phase7-soak-results" },
      }),
    );
    const beforeBurst = deliveryIds.length;
    for (let event = 0; event < 5; event += 1)
      emitters.get(id)?.({
        type: "terminal.line",
        payload: { cycle, event },
      });
    await waitFor(
      () => deliveryIds.length >= beforeBurst + 2,
      `Monitor ${id} did not deliver its bounded batches.`,
    );

    valueOf(
      await opened.registry.change({
        type: "pause",
        requestId: `${id}-pause-1`,
        id,
        expectedRevision: 1,
      }),
    );
    valueOf(
      await opened.registry.change({
        type: "resume",
        requestId: `${id}-resume-1`,
        id,
        expectedRevision: 2,
      }),
    );
    const beforeResume = deliveryIds.length;
    emitters.get(id)?.({
      type: "terminal.line",
      payload: { cycle, resumed: true },
    });
    await waitFor(
      () => deliveryIds.length > beforeResume,
      `Monitor ${id} did not deliver after resume.`,
    );
    valueOf(
      await opened.registry.change({
        type: "replace",
        requestId: `${id}-replace`,
        id,
        expectedRevision: 3,
        scope: "session",
        source: { kind: "terminal", terminalId: `${id}-terminal-b` },
        delivery: { kind: "session", sessionId: "phase7-soak-results" },
      }),
    );
    valueOf(
      await opened.registry.change({
        type: "pause",
        requestId: `${id}-pause-2`,
        id,
        expectedRevision: 4,
      }),
    );
    valueOf(
      await opened.registry.change({
        type: "resume",
        requestId: `${id}-resume-2`,
        id,
        expectedRevision: 5,
      }),
    );
    valueOf(
      await opened.registry.change({
        type: "stop",
        requestId: `${id}-stop`,
        id,
        expectedRevision: 6,
      }),
    );
    valueOf(
      await opened.registry.change({
        type: "delete",
        requestId: `${id}-delete`,
        id,
        expectedRevision: 7,
      }),
    );
    assert.deepEqual(valueOf(await opened.registry.inspect()).monitors, []);
    assert.equal(activeSources, 0);
  }

  assert.equal(new Set(deliveryIds).size, deliveryIds.length);
  assert.deepEqual(triggers.engine.inspect().bindings, []);
  const report = await opened.close();
  assert.deepEqual(report, {
    dropped: 0,
    unresolvedCallbacks: 0,
    unresolvedSources: 0,
  });
  assert.equal(activeSources, 0);
  await triggers.close("phase7-soak-monitor-complete");
  const triggerInspection = triggers.engine.inspect();
  assert.deepEqual(triggerInspection.queue, {
    count: 0,
    bytes: 0,
    running: 0,
    admitting: 0,
  });
  assert.equal(triggerInspection.counters.unresolvedCallbacks, 0);
  assert.equal(triggerInspection.counters.unresolvedOperations, 0);
  assert.ok(triggerInspection.history.length <= 12);
  assert.equal((await lifecycle.shutdown("quit")).status, "clean");

  const diagnostics = valueOf(await state.diagnose());
  assert.ok(diagnostics.counts.records <= 16);
  assert.ok(diagnostics.counts.events <= 8);
  assert.ok(diagnostics.counts.transactions <= 256);

  return {
    cycles,
    sourceStarts,
    maximumActiveSources,
    deliveries: deliveryIds.length,
    historyEntries: triggerInspection.history.length,
    closeReport: report,
    stateCounts: diagnostics.counts,
  };
}

test(
  "Phase 7 deterministic 24h+ soak leaves bounded, duplicate-free automation state",
  { timeout: 30_000 },
  async () => {
    const startedAt = Date.now();
    const trigger = await soakTriggerEngine();
    const scheduler = await soakScheduler();
    const monitors = await soakMonitorRegistry();
    await emitMetrics("fake-time", {
      status: "passed",
      durationMs: Date.now() - startedAt,
      trigger,
      scheduler,
      monitors,
    });
  },
);

function activeResourceCounts() {
  const counts: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo())
    counts[resource] = (counts[resource] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function resourceTotal(counts: Record<string, number>) {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

async function windowsDescendantPids() {
  const script = [
    `$parentPid = ${process.pid}`,
    "$ids = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $parentPid -and $_.ProcessId -ne $PID } | ForEach-Object { [int]$_.ProcessId })",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $ids -Compress))",
  ].join("; ");
  return new Promise<number[] | undefined>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const parsed = JSON.parse(stdout || "[]") as unknown;
          const values = Array.isArray(parsed)
            ? parsed
            : typeof parsed === "number"
              ? [parsed]
              : [];
          resolve(
            values.filter(
              (value): value is number =>
                typeof value === "number" && Number.isSafeInteger(value),
            ),
          );
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

function createTerminalProcessObservation(
  generation: number,
  startedPids: number[],
  exitedPids: Set<number>,
) {
  return {
    async observe(
      request: { terminalId: string; afterSequence?: number },
      listener: (event: TerminalObservation) => unknown,
    ) {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `let sequence=0;console.log('READY generation ${generation}');setInterval(()=>console.log('READY tick '+(++sequence)),200)`,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      assert.ok(child.pid);
      startedPids.push(child.pid);
      let sequence = request.afterSequence ?? 0;
      let offset = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        const byteLength = Buffer.byteLength(text);
        listener({
          kind: "output",
          terminalId: request.terminalId,
          sequence: ++sequence,
          stream: "stdout",
          text,
          byteLength,
          startByte: offset,
          endByte: offset + byteLength,
        });
        offset += byteLength;
      });
      child.stderr.resume();
      const closed = new Promise<void>((resolve) => {
        child.once("close", (code, signal) => {
          if (child.pid) exitedPids.add(child.pid);
          listener({
            kind: "settled",
            terminalId: request.terminalId,
            sequence: ++sequence,
            snapshot: {
              status: signal ? "killed" : code === 0 ? "done" : "failed",
              ...(code !== null ? { exitCode: code } : {}),
              ...(signal ? { signal } : {}),
            },
            consumed: false,
          });
          resolve();
        });
      });
      return {
        ok: true as const,
        value: {
          async close() {
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGTERM");
            await closed;
          },
        },
      };
    },
  };
}

test(
  "Phase 7 Windows real-resource loop releases watcher, WebSocket, and terminal generations",
  { skip: process.platform !== "win32", timeout: 55_000 },
  async () => {
    const soakStartedAt = Date.now();
    const resourceBaseline = activeResourceCounts();
    const descendantsBefore = await windowsDescendantPids();
    const allDeliveryIds: string[] = [];
    const startedPids: number[] = [];
    const exitedPids = new Set<number>();
    const resourceAfterGenerations: Record<string, number>[] = [];
    let generations = 0;
    let fileDeliveries = 0;
    let websocketDeliveries = 0;
    let terminalDeliveries = 0;
    let maximumWebSocketClients = 0;

    while (Date.now() - soakStartedAt < 25_000) {
      const generation = ++generations;
      const directory = await mkdtemp(
        join(tmpdir(), `pi-phase7-soak-generation-${generation}-`),
      );
      const lifecycle = createLifecycleSupervisor({ closeTimeoutMs: 5_000 });
      const triggers = createTriggerEngine({
        hostId: `phase7-real-${generation}`,
        maxInspectionEntries: 16,
        maxInspectionBytes: 8 * 1_024,
      });
      let runtime: MonitorRegistryRuntime | undefined;
      let server: WebSocketServer | undefined;
      let shutdownStatus: "clean" | "degraded" | undefined;
      try {
        const serverHandle = lifecycle.acquireHandle({
          id: `phase7-soak-websocket-server-${generation}`,
          async start() {
            const opened = new WebSocketServer({
              host: "127.0.0.1",
              port: 0,
              perMessageDeflate: false,
            });
            await new Promise<void>((resolve, reject) => {
              opened.once("listening", resolve);
              opened.once("error", reject);
            });
            server = opened;
            return {
              value: opened,
              close: () =>
                new Promise<void>((resolve, reject) => {
                  for (const client of opened.clients) client.terminate();
                  opened.close((error) => (error ? reject(error) : resolve()));
                }),
            };
          },
        });
        const websocketServer = await serverHandle.value;
        websocketServer.on("connection", () => {
          maximumWebSocketClients = Math.max(
            maximumWebSocketClients,
            websocketServer.clients.size,
          );
        });
        const address = websocketServer.address();
        assert.ok(address && typeof address === "object");
        const origin = `ws://phase7-soak.invalid:${address.port}`;
        const monitorDeliveries: MonitorDeliveryRequest[] = [];
        const opened = await createMonitorRegistry({
          ownerId: `phase7-real-registry-${generation}`,
          binding: {
            projectId: schedulerProject.projectId,
            cwd: directory,
            sessionId: `phase7-real-session-${generation}`,
          },
          triggers,
          lifecycle,
          artifacts: createInMemoryArtifactStore(),
          sources: createProductionMonitorSourceFactory({
            terminal: createTerminalProcessObservation(
              generation,
              startedPids,
              exitedPids,
            ),
            filesystem: { reconcileIntervalMs: 100, maxEntries: 256 },
            websocket: {
              allowedOrigins: [origin],
              control: {
                async authorize(request) {
                  return {
                    ok: true,
                    value: {
                      canonicalUrl: request.url,
                      addresses: [{ address: "127.0.0.1", family: 4 as const }],
                    },
                  };
                },
              },
              random: () => 0,
              limits: {
                maxMessageBytes: 1_024,
                maxFragments: 4,
                maxBufferedChunks: 16,
                maxBufferedMessages: 8,
                maxBufferedBytes: 8 * 1_024,
                reconnectBaseMs: 25,
                reconnectMaxMs: 100,
                maxReconnectAttempts: 20,
                reconnectWindowMs: 10_000,
                handshakeTimeoutMs: 1_000,
                idleTimeoutMs: 2_000,
                lifetimeMs: 15_000,
              },
            },
          }),
          delivery: {
            async deliver(request) {
              monitorDeliveries.push(request);
              allDeliveryIds.push(request.deliveryId);
              if (request.monitorId.startsWith("file-")) fileDeliveries += 1;
              if (request.monitorId.startsWith("websocket-"))
                websocketDeliveries += 1;
              if (request.monitorId.startsWith("terminal-"))
                terminalDeliveries += 1;
              return { ok: true, value: { state: "delivered" } };
            },
          },
          authority: {
            async authorize() {
              return { ok: true, value: { allowed: true } };
            },
          },
          configuration: {
            maxActive: 16,
            maxRemote: 4,
            batchWindowMs: 25,
            pollMinimumMs: 5_000,
            allowedWebSocketOrigins: [origin],
            allowLoopback: true,
            pollTargets: [],
          },
          limits: {
            maxInspection: 8,
            batchWindowMs: 25,
            maxBatchCount: 16,
            closeDrainMs: 5_000,
          },
        });
        runtime = valueOf(opened);

        const ids = {
          file: `file-${generation}`,
          websocket: `websocket-${generation}`,
          terminal: `terminal-${generation}`,
        };
        valueOf(
          await runtime.registry.change({
            type: "create",
            requestId: `${ids.file}-create`,
            id: ids.file,
            expectedRevision: 0,
            scope: "session",
            source: { kind: "file", root: directory },
            delivery: { kind: "session", sessionId: "phase7-real-results" },
          }),
        );
        valueOf(
          await runtime.registry.change({
            type: "create",
            requestId: `${ids.websocket}-create`,
            id: ids.websocket,
            expectedRevision: 0,
            scope: "session",
            source: { kind: "websocket", url: `${origin}/events` },
            delivery: { kind: "session", sessionId: "phase7-real-results" },
          }),
        );
        valueOf(
          await runtime.registry.change({
            type: "create",
            requestId: `${ids.terminal}-create`,
            id: ids.terminal,
            expectedRevision: 0,
            scope: "session",
            source: {
              kind: "terminal",
              terminalId: `phase7-real-terminal-${generation}`,
              framing: "line",
            },
            matcher: { kind: "literal", value: "READY" },
            delivery: { kind: "session", sessionId: "phase7-real-results" },
          }),
        );

        for (let pulse = 0; pulse < 5; pulse += 1) {
          await writeFile(
            join(directory, `pulse-${pulse}.txt`),
            `generation=${generation} pulse=${pulse}`,
            "utf8",
          );
          for (const client of websocketServer.clients) {
            if (client.readyState === 1)
              client.send(JSON.stringify({ generation, pulse, ready: true }));
          }
          if (pulse === 2) {
            valueOf(
              await runtime.registry.change({
                type: "pause",
                requestId: `${ids.websocket}-pause`,
                id: ids.websocket,
                expectedRevision: 1,
              }),
            );
            valueOf(
              await runtime.registry.change({
                type: "resume",
                requestId: `${ids.websocket}-resume`,
                id: ids.websocket,
                expectedRevision: 2,
              }),
            );
          }
          await sleep(900);
        }

        await waitFor(
          () =>
            monitorDeliveries.some(({ monitorId }) => monitorId === ids.file) &&
            monitorDeliveries.some(
              ({ monitorId }) => monitorId === ids.websocket,
            ) &&
            monitorDeliveries.some(
              ({ monitorId }) => monitorId === ids.terminal,
            ),
          `Real-resource generation ${generation} did not observe every source.`,
          100,
          20,
        );

        valueOf(
          await runtime.registry.change({
            type: "stop",
            requestId: `${ids.file}-stop`,
            id: ids.file,
            expectedRevision: 1,
          }),
        );
        valueOf(
          await runtime.registry.change({
            type: "stop",
            requestId: `${ids.websocket}-stop`,
            id: ids.websocket,
            expectedRevision: 3,
          }),
        );
        valueOf(
          await runtime.registry.change({
            type: "stop",
            requestId: `${ids.terminal}-stop`,
            id: ids.terminal,
            expectedRevision: 1,
          }),
        );
        const inspection = valueOf(await runtime.registry.inspect());
        assert.equal(inspection.monitors.length, 3);
        assert.ok(
          inspection.monitors.every(
            ({ state, unresolved }) => state === "stopped" && unresolved === 0,
          ),
        );

        const closeReport = await runtime.close();
        runtime = undefined;
        assert.deepEqual(closeReport, {
          dropped: 0,
          unresolvedCallbacks: 0,
          unresolvedSources: 0,
        });
        await triggers.close(`phase7-real-generation-${generation}`);
        const triggerInspection = triggers.engine.inspect();
        assert.deepEqual(triggerInspection.queue, {
          count: 0,
          bytes: 0,
          running: 0,
          admitting: 0,
        });
        assert.equal(triggerInspection.counters.unresolvedCallbacks, 0);
        assert.equal(triggerInspection.counters.unresolvedOperations, 0);
        assert.ok(triggerInspection.history.length <= 16);

        const shutdown = await lifecycle.shutdown("reload");
        shutdownStatus = shutdown.status;
        assert.equal(shutdown.status, "clean");
        assert.equal(websocketServer.clients.size, 0);
        assert.equal(websocketServer.address(), null);
      } finally {
        await runtime?.close().catch(() => undefined);
        await triggers.close("phase7-real-cleanup").catch(() => undefined);
        const shutdown = await lifecycle.shutdown("reload");
        shutdownStatus ??= shutdown.status;
        await rm(directory, { recursive: true, force: true });
      }
      assert.equal(shutdownStatus, "clean");
      assert.equal(server?.clients.size ?? 0, 0);
      await sleep(150);
      const resources = activeResourceCounts();
      resourceAfterGenerations.push(resources);
      assert.ok(
        resourceTotal(resources) <= resourceTotal(resourceBaseline) + 3,
        `Generation ${generation} retained active resources: ${JSON.stringify({ resourceBaseline, resources })}`,
      );
    }

    const durationMs = Date.now() - soakStartedAt;
    assert.ok(durationMs >= 25_000);
    assert.ok(durationMs < 60_000);
    assert.ok(generations >= 3);
    assert.equal(new Set(allDeliveryIds).size, allDeliveryIds.length);
    assert.ok(fileDeliveries >= generations);
    assert.ok(websocketDeliveries >= generations);
    assert.ok(terminalDeliveries >= generations);
    assert.ok(maximumWebSocketClients >= 1);
    assert.equal(new Set(startedPids).size, startedPids.length);
    assert.ok(startedPids.every((pid) => exitedPids.has(pid)));

    const descendantsAfter = await windowsDescendantPids();
    if (descendantsBefore && descendantsAfter) {
      const baseline = new Set(descendantsBefore);
      assert.deepEqual(
        descendantsAfter.filter((pid) => !baseline.has(pid)),
        [],
      );
    }
    const resourceAfter = activeResourceCounts();
    assert.ok(
      resourceTotal(resourceAfter) <= resourceTotal(resourceBaseline) + 3,
    );

    await emitMetrics("windows-real-time", {
      status: "passed",
      durationMs,
      generations,
      deliveries: {
        total: allDeliveryIds.length,
        file: fileDeliveries,
        websocket: websocketDeliveries,
        terminal: terminalDeliveries,
      },
      processes: {
        started: startedPids.length,
        exited: exitedPids.size,
        descendantsBefore: descendantsBefore?.length,
        descendantsAfter: descendantsAfter?.length,
      },
      resources: {
        baseline: resourceBaseline,
        after: resourceAfter,
        maximumAfterGeneration: Math.max(
          ...resourceAfterGenerations.map(resourceTotal),
        ),
      },
      maximumWebSocketClients,
    });
  },
);
