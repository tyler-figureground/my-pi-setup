/**
 * Killed-parent recovery drill fixture.
 *
 * One executable, three roles, driven entirely by a JSON configuration file so
 * the drill can be reproduced by hand:
 *
 * - `victim`      submits a Goal, runs it until it reaches the requested
 *                 barrier, publishes a marker describing the durable Attempt at
 *                 that instant, and then stalls forever so the parent test can
 *                 force-kill a genuinely live incarnation.
 * - `replacement` opens the same durable state, waits for the dead
 *                 incarnation's node lease to expire, recovers, and reports
 *                 what the engine decided.
 * - `stale`       replays, at the persistence seam, the exact fenced writes the
 *                 killed incarnation would have issued had it come back to
 *                 life. Every one of them must be refused.
 *
 * Nothing here reaches into engine internals: the victim and the replacement
 * both drive the real `createGoalRuntime` over a real `node:sqlite` State Store
 * and a real filesystem Artifact Store, which is what makes the drill a
 * recovery test rather than a mock choreography.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createFileSystemArtifactStore } from "../src/core/artifacts/index.ts";
import { createSqliteStateStore } from "../src/core/persistence/index.ts";
import {
  createGoalPersistence,
  createGoalRuntime,
  createSystemGoalClock,
  goalCommandDigest,
} from "../src/goals/index.ts";

const TERMINAL_GOAL_STATES = ["done", "failed", "cancelled", "blocked"];
const OPEN_RETRY_MS = 25;
const OPEN_RETRY_LIMIT = 120;
const POLL_MS = 50;
const STALL_TICK_MS = 250;

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("A configuration path is required\n");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(entry) {
  appendFileSync(
    config.logPath,
    `${JSON.stringify({ at: Date.now(), role: config.role, ...entry })}\n`,
    "utf8",
  );
}

/** Publish a whole JSON document or none of it, so a reader never sees half. */
function publish(path, value) {
  const staging = `${path}.${process.pid}.staging`;
  writeFileSync(staging, JSON.stringify(value, null, 2), "utf8");
  renameSync(staging, path);
}

async function openState() {
  for (let attempt = 0; attempt < OPEN_RETRY_LIMIT; attempt += 1) {
    const opened = createSqliteStateStore({
      path: config.dbPath,
      busyTimeoutMs: 5_000,
    });
    if (opened.ok) return opened.value;
    if (!opened.error.retryable) {
      throw new Error(`State Store refused to open: ${opened.error.message}`);
    }
    await sleep(OPEN_RETRY_MS);
  }
  throw new Error("State Store stayed busy for the whole open budget");
}

function completionFor(request, nodeLabel) {
  const body = `goal worker output for ${nodeLabel}`;
  return {
    ok: true,
    value: {
      status: "completed",
      artifact: {
        body,
        filename: `${nodeLabel}-output.txt`,
        mediaType: "text/plain; charset=utf-8",
        size: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
        metadata: {
          kind: "goal-worker-output",
          attemptKey: request.attemptKey,
          trust: "worker-reported",
        },
      },
      execution: {
        attemptKey: request.attemptKey,
        childId: `child-${request.attemptKey.slice(0, 8)}`,
        certainty: "started",
      },
      usage: {
        tokens: 5,
        costMicros: 3,
        authoritative: true,
        source: "agent-supervisor",
      },
    },
  };
}

/**
 * Describe the durable Attempt exactly as it stands at the barrier.
 *
 * The marker is the only thing that survives the kill, so it carries every
 * value the stale-callback probe needs to impersonate the dead incarnation:
 * its owner, its fence, and the record version it last saw.
 */
async function markerFor(store, persistence, nodeId, attemptKey, barrier) {
  const attempts = await persistence.loadAttempts(config.goalId, nodeId);
  const record = attempts.ok
    ? attempts.value.find((entry) => entry.value.attemptKey === attemptKey)
    : undefined;
  const resource = persistence.leaseResource(config.goalId, nodeId);
  const lease = await store.query({ type: "lease", resource });
  return {
    barrier,
    pid: process.pid,
    goalId: config.goalId,
    nodeId,
    attemptKey,
    owner: config.ownerId,
    leaseResource: resource,
    attemptRecordKey: persistence.attemptKeyFor(
      config.goalId,
      nodeId,
      record?.value.number ?? 1,
    ),
    attemptCollection: persistence.collections.ATTEMPTS,
    attemptNumber: record?.value.number ?? null,
    attemptPhase: record?.value.phase ?? null,
    attemptVersion: record?.version ?? null,
    attemptFence: record?.value.fence ?? null,
    attemptRecord: record?.value ?? null,
    leaseFence:
      lease.ok && lease.value.type === "lease"
        ? (lease.value.lease?.fence ?? null)
        : null,
    reachedAt: Date.now(),
  };
}

/** Stall forever without letting the event loop drain the process. */
function stallForever() {
  setInterval(() => {}, STALL_TICK_MS);
  return new Promise(() => {});
}

function buildPorts(store, persistence) {
  const dispatched = [];
  const inspected = [];
  let barrierReached = false;

  const reachBarrier = async (barrier, nodeId, attemptKey) => {
    if (barrierReached) return stallForever();
    barrierReached = true;
    log({ event: "barrier.reached", barrier, nodeId, attemptKey });
    publish(
      config.markerPath,
      await markerFor(store, persistence, nodeId, attemptKey, barrier),
    );
    return stallForever();
  };

  const profiles = {
    async resolve(name) {
      return {
        ok: true,
        value: {
          name,
          contentDigest: "c".repeat(64),
          catalogGeneration: 1,
          source: { scope: "user", path: "/profiles/goal-worker.md" },
          role: "goal-worker",
          workspacePolicy: "isolated",
        },
      };
    },
  };

  const workspaces = {
    async prepare(request) {
      log({
        event: "workspace.prepare-start",
        nodeId: request.nodeId,
        attemptKey: request.attemptKey,
        fence: request.fence,
      });
      if (
        config.role === "victim" &&
        config.scenario === "pre-dispatch" &&
        request.nodeId === config.barrierNodeId
      ) {
        // The killed incarnation dies here: after the fence is durably bound
        // and before anything outside the process has been asked to exist.
        return reachBarrier("pre-dispatch", request.nodeId, request.attemptKey);
      }
      const workspaceId = `ws-${request.nodeId}-${request.attemptKey.slice(0, 12)}`;
      const cwd = join(config.workspaceRoot, workspaceId);
      mkdirSync(cwd, { recursive: true });
      log({
        event: "workspace.prepare-complete",
        nodeId: request.nodeId,
        attemptKey: request.attemptKey,
        workspaceId,
      });
      return { ok: true, value: { workspaceId, cwd } };
    },
    async dispose(request) {
      log({
        event: "workspace.dispose",
        nodeId: request.nodeId,
        attemptKey: request.attemptKey,
        workspaceId: request.workspaceId,
        outcome: request.outcome,
        preserve: request.preserve,
      });
      return {
        ok: true,
        value: { disposition: request.preserve ? "preserved" : "released" },
      };
    },
  };

  const executor = {
    metering: { tokens: true, cost: true },
    dispatched,
    inspected,
    async run(request) {
      dispatched.push(request.attemptKey);
      log({ event: "executor.dispatch", attemptKey: request.attemptKey });
      if (config.role === "victim" && config.scenario === "post-dispatch") {
        // `dispatching` is already durable, so the outcome of this child is
        // exactly the thing recovery cannot prove.
        return reachBarrier(
          "post-dispatch",
          config.barrierNodeId,
          request.attemptKey,
        );
      }
      return completionFor(request, request.attemptKey.slice(0, 8));
    },
    async inspect(attemptKey) {
      inspected.push(attemptKey);
      log({ event: "executor.inspect", attemptKey });
      // The Agent Supervisor of a dead incarnation cannot certify anything.
      return { attemptKey, state: "unknown", certainty: "unknown" };
    },
  };

  const review = {
    async verify(request) {
      log({
        event: "review.verify",
        nodeId: request.nodeId,
        criterionId: request.criterionId,
      });
      return {
        ok: true,
        value: {
          satisfied: true,
          kind: "review-report",
          summary: `verified ${request.criterionId}`,
          artifact: null,
        },
      };
    },
  };

  const delivery = {
    async deliver(request) {
      log({
        event: "delivery.deliver",
        deliveryId: request.deliveryId,
        goalId: request.goalId,
        state: request.state,
        runGeneration: request.runGeneration,
      });
      return { ok: true, value: { state: "delivered" } };
    },
  };

  return { profiles, workspaces, executor, review, delivery };
}

function buildRuntime(store, ports) {
  return createGoalRuntime({
    state: store,
    artifacts: createFileSystemArtifactStore({ root: config.artifactRoot }),
    clock: createSystemGoalClock(),
    executor: ports.executor,
    profiles: ports.profiles,
    workspaces: ports.workspaces,
    review: ports.review,
    delivery: ports.delivery,
    binding: {
      projectId: config.projectId,
      cwd: config.cwd,
      sessionId: config.sessionId,
    },
    ownerId: config.ownerId,
    leaseTtlMs: config.leaseTtlMs,
    // Stand-in host issuer: only the token this fixture minted verifies.
    authority: {
      verify: (request) =>
        request.authority.token === (config.authorityToken ?? "opaque-approval") &&
        request.authority.commandDigest === request.commandDigest &&
        request.authority.projectId === request.projectId &&
        request.authority.sessionId === request.sessionId,
    },
  });
}

function submitCommand() {
  return {
    type: "submit",
    requestId: config.requestId,
    goalId: config.goalId,
    objective: "Survive a killed parent",
    nodes: config.nodes,
    budget: {
      maxConcurrency: 1,
      maxAgentCalls: 8,
      maxRuntimeMs: 3_600_000,
    },
  };
}

async function runVictim() {
  const store = await openState();
  const persistence = createGoalPersistence(store, config.projectId);
  const ports = buildPorts(store, persistence);
  const runtime = buildRuntime(store, ports);
  const command = submitCommand();
  const submitted = await runtime.engine.submit(command, {
    actor: "direct-user",
    actorId: "drill-operator",
    projectId: config.projectId,
    sessionId: config.sessionId,
    commandDigest: goalCommandDigest(command),
    token: "opaque-approval",
    expiresAt: Date.now() + 3_600_000,
  });
  if (!submitted.ok) {
    log({ event: "victim.submit-failed", error: submitted.error });
    process.exit(3);
  }
  log({ event: "victim.submitted", goalId: config.goalId });
  await stallForever();
}

/**
 * Hold the replacement at the starting line until the parent says go.
 *
 * Module loading and type stripping cost real time, and paying it after the
 * kill would make "did the corpse still hold its lease?" a function of machine
 * speed. Paying it before the kill makes the drill deterministic: the gate opens
 * the instant the victim is confirmed dead.
 */
async function waitForStartGate() {
  const deadline = Date.now() + config.deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(config.startGatePath)) return;
    await sleep(20);
  }
  throw new Error("The replacement start gate never opened");
}

async function runReplacement() {
  await waitForStartGate();
  const store = await openState();
  const persistence = createGoalPersistence(store, config.projectId);

  // Prove the starting condition before doing anything: the dead incarnation's
  // node lease is still held and unexpired, so this process must wait it out
  // rather than stomping what could still be a live owner.
  const bootAt = Date.now();
  const bootQuery = await store.query({
    type: "lease",
    resource: persistence.leaseResource(config.goalId, config.barrierNodeId),
  });
  const bootLeaseRecord =
    bootQuery.ok && bootQuery.value.type === "lease"
      ? bootQuery.value.lease
      : null;
  const bootLease = {
    observedAt: bootAt,
    owner: bootLeaseRecord?.owner ?? null,
    fence: bootLeaseRecord?.fence ?? null,
    expiresAt: bootLeaseRecord?.expiresAt ?? null,
    held: (bootLeaseRecord?.expiresAt ?? 0) > bootAt,
  };
  log({ event: "replacement.boot-lease", ...bootLease });

  const ports = buildPorts(store, persistence);
  const runtime = buildRuntime(store, ports);
  const startedAt = Date.now();
  const deadline = startedAt + config.deadlineMs;
  let observation = null;
  let settledAt = null;

  while (Date.now() < deadline) {
    await runtime.drain();
    const observed = await runtime.engine.observe({ goalId: config.goalId });
    if (observed.ok && observed.value.detail) {
      observation = observed.value.detail;
      if (TERMINAL_GOAL_STATES.includes(observation.state)) {
        settledAt = Date.now();
        break;
      }
    }
    await sleep(POLL_MS);
  }
  // A drill must stay bounded even when the deadline expires mid-Attempt.
  await Promise.race([runtime.close(), sleep(5_000)]);

  const leases = {};
  for (const nodeId of config.nodes.map((node) => node.id)) {
    const resource = persistence.leaseResource(config.goalId, nodeId);
    const lease = await store.query({ type: "lease", resource });
    leases[nodeId] =
      lease.ok && lease.value.type === "lease" && lease.value.lease
        ? {
            resource,
            owner: lease.value.lease.owner,
            fence: lease.value.lease.fence,
          }
        : { resource, owner: null, fence: null };
  }
  const deliveries = await persistence.listDeliveries(64);
  const events = await store.query({
    type: "events",
    stream: persistence.eventStream(config.goalId),
    limit: 500,
  });

  publish(config.reportPath, {
    role: "replacement",
    pid: process.pid,
    scenario: config.scenario,
    ownerId: config.ownerId,
    settled: settledAt !== null,
    recoveryLatencyMs: settledAt === null ? null : settledAt - startedAt,
    bootLease,
    observation,
    dispatched: ports.executor.dispatched,
    inspected: ports.executor.inspected,
    leases,
    deliveries: deliveries.ok
      ? deliveries.value.map((entry) => entry.value)
      : [],
    eventTypes:
      events.ok && events.value.type === "events"
        ? events.value.events.map((event) => event.eventType)
        : [],
  });
}

/**
 * Impersonate the killed incarnation coming back to life.
 *
 * Each probe is the shape of a real settlement write, issued with the fence and
 * record version the dead process last held. A fenced store must refuse all of
 * them, and the Attempt must be byte-identical afterwards.
 */
async function runStaleCallback() {
  const store = await openState();
  const marker = JSON.parse(readFileSync(config.markerPath, "utf8"));
  const before = await store.query({
    type: "record",
    collection: marker.attemptCollection,
    key: marker.attemptRecordKey,
  });
  const snapshot =
    before.ok && before.value.type === "record" ? before.value.record : null;

  const probes = [
    {
      name: "renew-at-stale-fence",
      operations: [
        {
          type: "renew-lease",
          resource: marker.leaseResource,
          owner: marker.owner,
          fence: marker.attemptFence,
          ttlMs: 60_000,
        },
      ],
    },
    {
      name: "release-at-stale-fence",
      operations: [
        {
          type: "release-lease",
          resource: marker.leaseResource,
          owner: marker.owner,
          fence: marker.attemptFence,
        },
      ],
    },
    {
      name: "settle-at-stale-fence",
      operations: [
        {
          type: "renew-lease",
          resource: marker.leaseResource,
          owner: marker.owner,
          fence: marker.attemptFence,
          ttlMs: 60_000,
        },
        {
          type: "put-record",
          collection: marker.attemptCollection,
          key: marker.attemptRecordKey,
          metadata: {
            ...marker.attemptRecord,
            phase: "succeeded",
            settledAt: Date.now(),
            certainty: "started",
          },
          expectedVersion: marker.attemptVersion,
        },
      ],
    },
    {
      name: "settle-at-stale-version",
      operations: [
        {
          type: "put-record",
          collection: marker.attemptCollection,
          key: marker.attemptRecordKey,
          metadata: {
            ...marker.attemptRecord,
            phase: "succeeded",
            settledAt: Date.now(),
            certainty: "started",
          },
          expectedVersion: marker.attemptVersion,
        },
      ],
    },
  ];

  const results = [];
  for (const probe of probes) {
    const applied = await store.transact({
      transactionId: `stale-callback:${probe.name}:${randomUUID()}`,
      operations: probe.operations,
    });
    log({
      event: "stale.probe",
      probe: probe.name,
      accepted: applied.ok,
      code: applied.ok ? null : applied.error.code,
    });
    results.push({
      probe: probe.name,
      accepted: applied.ok,
      code: applied.ok ? null : applied.error.code,
    });
  }

  const after = await store.query({
    type: "record",
    collection: marker.attemptCollection,
    key: marker.attemptRecordKey,
  });
  publish(config.reportPath, {
    role: "stale-callback",
    pid: process.pid,
    probes: results,
    before: snapshot,
    after:
      after.ok && after.value.type === "record" ? after.value.record : null,
  });
}

mkdirSync(dirname(config.logPath), { recursive: true });

if (config.role === "victim") await runVictim();
else if (config.role === "replacement") await runReplacement();
else if (config.role === "stale-callback") await runStaleCallback();
else {
  process.stderr.write(`Unknown drill role ${String(config.role)}\n`);
  process.exit(2);
}
