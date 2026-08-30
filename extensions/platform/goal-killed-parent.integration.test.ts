import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteStateStore } from "./src/core/persistence/index.ts";
import type { StateStore } from "./src/core/persistence/state-store.ts";
import { createGoalPersistence } from "./src/goals/index.ts";

/**
 * Phase 8 killed-parent recovery drill.
 *
 * Every other Goal recovery test simulates a lost incarnation by building a
 * second runtime over the same in-memory store. This one does not simulate
 * anything: a real child Node process opens a real `node:sqlite` State Store,
 * runs the real Goal runtime until it reaches a chosen barrier, and is then
 * force-killed by the operating system with no unwind, no `close()`, and no
 * chance to release its node lease. A replacement process starts against the
 * same database and has to reach the right answer on its own.
 *
 * Two barriers matter, because the engine's safety argument splits on them:
 *
 * - **Pre-dispatch** (`prepared`): the fence is durable but nothing outside the
 *   process was ever asked to exist, so the identical Attempt may be resumed.
 * - **Post-dispatch** (`dispatching`): a child may or may not have run. Nothing
 *   short of executor certification can tell, so the Attempt must become
 *   `unknown` and must never be dispatched a second time.
 *
 * The drill is deliberately bounded: short lease TTLs, hard deadlines in the
 * child, and a hard deadline on every wait here, so a hang fails loudly instead
 * of consuming the suite timeout.
 */

const FIXTURE = join(
  import.meta.dirname,
  "test-fixtures",
  "goal-killed-parent-process.mjs",
);
/**
 * Long enough that a force-killed incarnation still holds its node lease when
 * the replacement looks, short enough that waiting the lease out stays a few
 * seconds rather than a suite-timeout risk. Recovery latency tracks this value,
 * because the engine re-sweeps once per lease period.
 */
const LEASE_TTL_MS = 5_000;
const BARRIER_TIMEOUT_MS = 25_000;
const REPLACEMENT_TIMEOUT_MS = 40_000;
const REPLACEMENT_DEADLINE_MS = 25_000;
const STALE_TIMEOUT_MS = 20_000;
const POLL_MS = 25;

type Scenario = "pre-dispatch" | "post-dispatch";

interface DrillMarker {
  readonly barrier: Scenario;
  readonly pid: number;
  readonly goalId: string;
  readonly nodeId: string;
  readonly attemptKey: string;
  readonly owner: string;
  readonly leaseResource: string;
  readonly attemptRecordKey: string;
  readonly attemptCollection: string;
  readonly attemptNumber: number | null;
  readonly attemptPhase: string | null;
  readonly attemptVersion: number | null;
  readonly attemptFence: number | null;
  readonly leaseFence: number | null;
  readonly reachedAt: number;
}

interface AttemptView {
  readonly number: number;
  readonly attemptKey: string;
  readonly phase: string;
  readonly fence: number;
  readonly workspaceId: string | null;
  readonly certainty: string | null;
}

interface NodeView {
  readonly id: string;
  readonly state: string;
  readonly attempts: readonly AttemptView[];
  readonly evidence: readonly { readonly id: string; readonly kind: string }[];
  readonly blockedReason: string | null;
}

interface ReplacementReport {
  readonly role: "replacement";
  readonly pid: number;
  readonly scenario: Scenario;
  readonly ownerId: string;
  readonly settled: boolean;
  readonly recoveryLatencyMs: number | null;
  readonly bootLease: {
    readonly observedAt: number;
    readonly owner: string | null;
    readonly fence: number | null;
    readonly expiresAt: number | null;
    readonly held: boolean;
  };
  readonly observation: {
    readonly state: string;
    readonly blockedReason: string | null;
    readonly nodes: readonly NodeView[];
    readonly evidence: readonly { readonly id: string }[];
    readonly budget: {
      readonly reserved: { readonly calls: number };
      readonly consumed: { readonly calls: number };
    };
  } | null;
  readonly dispatched: readonly string[];
  readonly inspected: readonly string[];
  readonly leases: Readonly<
    Record<
      string,
      { readonly owner: string | null; readonly fence: number | null }
    >
  >;
  readonly deliveries: readonly {
    readonly goalId: string;
    readonly state: string;
    readonly result: string;
  }[];
  readonly eventTypes: readonly string[];
}

interface StaleReport {
  readonly role: "stale-callback";
  readonly probes: readonly {
    readonly probe: string;
    readonly accepted: boolean;
    readonly code: string | null;
  }[];
  readonly before: {
    readonly version: number;
    readonly metadata: unknown;
  } | null;
  readonly after: {
    readonly version: number;
    readonly metadata: unknown;
  } | null;
}

interface LogEntry {
  readonly at: number;
  readonly role: string;
  readonly event: string;
  readonly nodeId?: string;
  readonly attemptKey?: string;
  readonly workspaceId?: string;
  readonly preserve?: boolean;
  readonly outcome?: string;
  readonly deliveryId?: string;
}

function sleep(ms: number) {
  return new Promise<void>((done) => setTimeout(done, ms));
}

/**
 * Delete a drill directory, or refuse to.
 *
 * Recursive deletion on Windows follows junctions, so a reparse point anywhere
 * under the tree would let cleanup escape into whatever it points at - a
 * worktree, a shared `node_modules`. The guard is absolute: the tree must live
 * inside the real temporary directory, and a single link-like entry aborts the
 * whole removal in favour of leaving the directory behind.
 */
function removeDrillTree(
  root: string,
): "removed" | "outside-tmpdir" | "linked" {
  const target = resolve(root);
  const base = realpathSync(tmpdir());
  if (!target.startsWith(base + sep)) return "outside-tmpdir";
  const linked: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      const stats = lstatSync(child);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        linked.push(child);
        continue;
      }
      if (stats.isDirectory()) walk(child);
    }
  };
  if (!existsSync(target)) return "removed";
  walk(target);
  if (linked.length > 0) return "linked";
  rmSync(target, { recursive: true, force: true });
  return "removed";
}

interface DrillProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  stderr(): string;
}

function spawnRole(configPath: string): DrillProcess {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", FIXTURE, configPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((done) => {
    child.once("close", (code) => done(code));
  });
  return { child, exited, stderr: () => stderr };
}

/** Kill the whole tree the way the platform actually requires. */
function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killed = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 10_000 },
    );
    if (killed.error || killed.status !== 0) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function waitForJson<T>(
  path: string,
  timeoutMs: number,
  label: string,
  failed: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
      } catch {
        // Publication is rename-based, so a parse failure is a torn read.
      }
    }
    await sleep(POLL_MS);
  }
  assert.fail(`${label} never appeared within ${timeoutMs}ms. ${failed()}`);
}

async function waitForExit(
  drill: DrillProcess,
  timeoutMs: number,
  label: string,
) {
  const outcome = await Promise.race([
    drill.exited,
    sleep(timeoutMs).then(() => "timeout" as const),
  ]);
  if (outcome === "timeout") {
    killTree(drill.child);
    assert.fail(
      `${label} did not exit within ${timeoutMs}ms. ${drill.stderr()}`,
    );
  }
  return outcome;
}

function readLog(path: string): readonly LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
}

function countEvents(log: readonly LogEntry[], event: string) {
  return log.filter((entry) => entry.event === event).length;
}

function nodeView(report: ReplacementReport, id: string) {
  const found = report.observation?.nodes.find((node) => node.id === id);
  assert.ok(found, `Report is missing node ${id}`);
  return found;
}

interface DrillLayout {
  readonly directory: string;
  readonly dbPath: string;
  readonly markerPath: string;
  readonly victimLog: string;
  readonly replacementLog: string;
  readonly staleLog: string;
  readonly replacementReport: string;
  readonly staleReport: string;
  readonly startGatePath: string;
  configFor(role: string, extra: Record<string, unknown>): string;
}

function layoutFor(t: TestContext, scenario: Scenario): DrillLayout {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "pi-goal-kill-"));
  t.after(() => {
    const disposition = removeDrillTree(directory);
    if (disposition !== "removed") {
      t.diagnostic(`drill directory preserved (${disposition}): ${directory}`);
    }
  });
  const nodes = [
    {
      id: "plan",
      title: "Plan the work",
      prompt: "Plan it",
      dependsOn: [],
      profileName: "goal-worker",
    },
    {
      id: "build",
      title: "Build the work",
      prompt: "Build it",
      dependsOn: ["plan"],
      profileName: "goal-worker",
    },
  ];
  const shared = {
    scenario,
    dbPath: join(directory, "state.sqlite"),
    artifactRoot: join(directory, "artifacts"),
    workspaceRoot: join(directory, "workspaces"),
    markerPath: join(directory, "barrier.json"),
    startGatePath: join(directory, "start-gate"),
    goalId: "killed-parent-drill",
    projectId: "drill-project",
    sessionId: "drill-session",
    requestId: "drill-request-1",
    cwd: join(directory, "repo"),
    leaseTtlMs: LEASE_TTL_MS,
    deadlineMs: REPLACEMENT_DEADLINE_MS,
    barrierNodeId: "plan",
    nodes,
  };
  mkdirSync(shared.cwd, { recursive: true });
  mkdirSync(shared.workspaceRoot, { recursive: true });
  return {
    directory,
    dbPath: shared.dbPath,
    markerPath: shared.markerPath,
    victimLog: join(directory, "log-victim.jsonl"),
    replacementLog: join(directory, "log-replacement.jsonl"),
    staleLog: join(directory, "log-stale.jsonl"),
    replacementReport: join(directory, "report-replacement.json"),
    staleReport: join(directory, "report-stale.json"),
    startGatePath: shared.startGatePath,
    configFor(role, extra) {
      const path = join(directory, `config-${role}.json`);
      writeFileSync(
        path,
        JSON.stringify({ ...shared, role, ...extra }, null, 2),
        "utf8",
      );
      return path;
    },
  };
}

function openStore(path: string): StateStore {
  const opened = createSqliteStateStore({ path, busyTimeoutMs: 5_000 });
  if (!opened.ok) assert.fail(opened.error.message);
  return opened.value;
}

/**
 * The drill's own audit line.
 *
 * A recovery test that only asserts is hard to reason about after the fact, so
 * every run emits one structured record: which barrier was forced, how the
 * fence moved, what the replacement decided, and how long recovery took.
 */
function emitRecoveryMetrics(t: TestContext, metrics: Record<string, unknown>) {
  t.diagnostic(
    `goal.recovery-drill ${JSON.stringify({ schema: "goal-recovery-drill-v1", ...metrics })}`,
  );
}

async function reachBarrierAndKill(
  t: TestContext,
  layout: DrillLayout,
  scenario: Scenario,
) {
  const victim = spawnRole(
    layout.configFor("victim", {
      ownerId: "owner-victim",
      logPath: layout.victimLog,
    }),
  );
  t.after(() => killTree(victim.child));
  const marker = await waitForJson<DrillMarker>(
    layout.markerPath,
    BARRIER_TIMEOUT_MS,
    `${scenario} barrier marker`,
    () => victim.stderr(),
  );
  assert.equal(marker.barrier, scenario);
  assert.equal(marker.nodeId, "plan");
  assert.ok(
    typeof marker.attemptFence === "number" && marker.attemptFence >= 1,
    "The killed incarnation must have bound a durable fence",
  );
  assert.equal(marker.leaseFence, marker.attemptFence);
  assert.equal(marker.attemptVersion !== null, true);

  const killedAt = Date.now();
  killTree(victim.child);
  await waitForExit(victim, 15_000, "victim");
  assert.equal(
    victim.child.exitCode === 0,
    false,
    "The victim must die by force, never by a clean exit",
  );
  return { marker, killedAt };
}

/**
 * Start the replacement early and hold it at the gate.
 *
 * Node boot and type stripping cost more than a short lease TTL, so paying that
 * cost before the kill is what keeps "the corpse's lease was still held" a fact
 * about the drill rather than a fact about the machine.
 */
function startReplacement(t: TestContext, layout: DrillLayout) {
  const replacement = spawnRole(
    layout.configFor("replacement", {
      ownerId: "owner-replacement",
      logPath: layout.replacementLog,
      reportPath: layout.replacementReport,
    }),
  );
  t.after(() => killTree(replacement.child));
  return replacement;
}

async function finishReplacement(
  replacement: DrillProcess,
  layout: DrillLayout,
) {
  writeFileSync(layout.startGatePath, "go", "utf8");
  const code = await waitForExit(
    replacement,
    REPLACEMENT_TIMEOUT_MS,
    "replacement",
  );
  assert.equal(code, 0, `Replacement failed: ${replacement.stderr()}`);
  const report = await waitForJson<ReplacementReport>(
    layout.replacementReport,
    5_000,
    "replacement report",
    () => replacement.stderr(),
  );
  // The drill is only meaningful if the replacement had to wait out a lease it
  // did not own. A corpse whose lease had already lapsed proves nothing.
  assert.equal(report.bootLease.owner, "owner-victim");
  assert.equal(
    report.bootLease.held,
    true,
    "The replacement must boot while the killed incarnation's lease is still live",
  );
  return report;
}

async function runStaleCallback(t: TestContext, layout: DrillLayout) {
  const stale = spawnRole(
    layout.configFor("stale-callback", {
      ownerId: "owner-victim",
      logPath: layout.staleLog,
      reportPath: layout.staleReport,
    }),
  );
  t.after(() => killTree(stale.child));
  const code = await waitForExit(stale, STALE_TIMEOUT_MS, "stale callback");
  assert.equal(code, 0, `Stale callback probe failed: ${stale.stderr()}`);
  const report = await waitForJson<StaleReport>(
    layout.staleReport,
    5_000,
    "stale callback report",
    () => stale.stderr(),
  );
  for (const probe of report.probes) {
    assert.equal(
      probe.accepted,
      false,
      `Stale probe ${probe.probe} was accepted after the fence moved`,
    );
  }
  assert.deepEqual(
    report.probes.map((probe) => [probe.probe, probe.code]),
    [
      ["renew-at-stale-fence", "LEASE_LOST"],
      ["release-at-stale-fence", "LEASE_LOST"],
      ["settle-at-stale-fence", "LEASE_LOST"],
      ["settle-at-stale-version", "VERSION_CONFLICT"],
    ],
  );
  assert.deepEqual(
    report.after,
    report.before,
    "A stale callback must leave the Attempt record byte-identical",
  );
  return report;
}

function assertEvidenceIsUnique(report: ReplacementReport) {
  const ids = [
    ...(report.observation?.evidence ?? []).map((entry) => entry.id),
    ...(report.observation?.nodes ?? []).flatMap((node) =>
      node.evidence.map((entry) => entry.id),
    ),
  ];
  assert.deepEqual(
    ids.length,
    new Set(ids).size,
    "Recovery must never append the same Goal Evidence twice",
  );
}

function assertWorkspacesAreNotDuplicated(
  victimLog: readonly LogEntry[],
  replacementLog: readonly LogEntry[],
) {
  const prepared = [...victimLog, ...replacementLog].filter(
    (entry) => entry.event === "workspace.prepare-complete",
  );
  const byAttempt = new Map<string, number>();
  for (const entry of prepared) {
    const key = entry.attemptKey ?? "";
    byAttempt.set(key, (byAttempt.get(key) ?? 0) + 1);
  }
  for (const [attemptKey, count] of byAttempt) {
    assert.equal(
      count,
      1,
      `Attempt ${attemptKey} prepared ${count} Guarded Workspaces`,
    );
  }
  const workspaceIds = prepared.map((entry) => entry.workspaceId);
  assert.deepEqual(
    workspaceIds.length,
    new Set(workspaceIds).size,
    "Two Attempts must never share one Guarded Workspace identifier",
  );
  return prepared;
}

function assertOutboxIsNotDuplicated(
  report: ReplacementReport,
  replacementLog: readonly LogEntry[],
  expectedState: string,
) {
  assert.deepEqual(
    report.deliveries.map((entry) => [entry.state, entry.result]),
    [[expectedState, "delivered"]],
  );
  const deliveries = replacementLog.filter(
    (entry) => entry.event === "delivery.deliver",
  );
  const ids = deliveries.map((entry) => entry.deliveryId);
  assert.deepEqual(
    ids.length,
    new Set(ids).size,
    "The outbox must not deliver one Goal outcome twice",
  );
}

test("a parent killed before dispatch lets a replacement resume the same Attempt", async (t) => {
  const layout = layoutFor(t, "pre-dispatch");
  const replacement = startReplacement(t, layout);
  const { marker, killedAt } = await reachBarrierAndKill(
    t,
    layout,
    "pre-dispatch",
  );
  // Nothing outside the process was ever asked to exist at this barrier.
  assert.equal(marker.attemptPhase, "prepared");

  const report = await finishReplacement(replacement, layout);
  const victimLog = readLog(layout.victimLog);
  const replacementLog = readLog(layout.replacementLog);

  assert.equal(report.settled, true);
  assert.equal(report.observation?.state, "done");

  // The identical Attempt is resumed: same key, same number, one record.
  const plan = nodeView(report, "plan");
  assert.equal(plan.state, "done");
  assert.equal(plan.attempts.length, 1);
  assert.equal(plan.attempts[0]?.attemptKey, marker.attemptKey);
  assert.equal(plan.attempts[0]?.number, marker.attemptNumber);
  assert.equal(plan.attempts[0]?.phase, "succeeded");
  assert.equal(nodeView(report, "build").state, "done");

  // A reclaimed Attempt is proven not to have started, so it is never inspected
  // and its worst-case reservation is returned rather than charged.
  assert.deepEqual(report.inspected, []);
  assert.equal(report.observation?.budget.consumed.calls, 2);
  assert.equal(report.observation?.budget.reserved.calls, 0);
  assert.equal(
    report.dispatched.filter((key) => key === marker.attemptKey).length,
    1,
    "The resumed Attempt must dispatch exactly one child",
  );
  assert.equal(report.dispatched.length, 2);
  assert.equal(report.eventTypes.includes("goal.attempt-abandoned"), true);

  // Exactly one current fence: takeover then re-claim, each bumping it once,
  // leaving the killed incarnation's fence permanently behind.
  const planFence = report.leases.plan?.fence;
  assert.equal(planFence, (marker.attemptFence ?? 0) + 2);
  assert.equal(plan.attempts[0]?.fence, planFence);

  // The victim asked for a Guarded Workspace and died mid-request, so its
  // half-open preparation must not survive as a second workspace.
  assert.equal(countEvents(victimLog, "workspace.prepare-start"), 1);
  assert.equal(countEvents(victimLog, "workspace.prepare-complete"), 0);
  const prepared = assertWorkspacesAreNotDuplicated(victimLog, replacementLog);
  assert.equal(prepared.length, 2);
  assert.equal(countEvents(replacementLog, "workspace.dispose"), 2);

  assertEvidenceIsUnique(report);
  assert.equal(
    plan.evidence.filter((entry) => entry.kind === "worker-output").length,
    1,
  );
  assertOutboxIsNotDuplicated(report, replacementLog, "done");

  const stale = await runStaleCallback(t, layout);

  emitRecoveryMetrics(t, {
    scenario: "pre-dispatch",
    barrierPhase: marker.attemptPhase,
    victimPid: marker.pid,
    replacementPid: report.pid,
    leaseTtlMs: LEASE_TTL_MS,
    barrierToKillMs: killedAt - marker.reachedAt,
    recoveryLatencyMs: report.recoveryLatencyMs,
    fenceAtKill: marker.attemptFence,
    fenceAfterRecovery: planFence,
    leaseHeldAtReplacementBootMs:
      (report.bootLease.expiresAt ?? 0) - report.bootLease.observedAt,
    decision: "reclaimed",
    goalState: report.observation?.state ?? null,
    attemptsForBarrierNode: plan.attempts.length,
    childDispatches: report.dispatched.length,
    executorInspections: report.inspected.length,
    budgetCallsConsumed: report.observation?.budget.consumed.calls ?? null,
    budgetCallsReserved: report.observation?.budget.reserved.calls ?? null,
    workspacesPrepared: prepared.length,
    deliveries: report.deliveries.length,
    staleProbesRefused: stale.probes.length,
  });
});

test("a parent killed after dispatch blocks the Attempt instead of redispatching", async (t) => {
  const layout = layoutFor(t, "post-dispatch");
  const replacement = startReplacement(t, layout);
  const { marker, killedAt } = await reachBarrierAndKill(
    t,
    layout,
    "post-dispatch",
  );
  // A child was already handed the work; its outcome died with the parent.
  assert.equal(marker.attemptPhase, "dispatching");

  const report = await finishReplacement(replacement, layout);
  const victimLog = readLog(layout.victimLog);
  const replacementLog = readLog(layout.replacementLog);

  assert.equal(report.settled, true);
  assert.equal(report.observation?.state, "blocked");
  assert.equal(report.observation?.blockedReason, "unknown-attempt");

  const plan = nodeView(report, "plan");
  assert.equal(plan.state, "blocked");
  assert.equal(plan.attempts.length, 1);
  assert.equal(plan.attempts[0]?.attemptKey, marker.attemptKey);
  assert.equal(plan.attempts[0]?.phase, "unknown");
  assert.equal(plan.attempts[0]?.certainty, "unknown");

  // Ambiguity must not cascade into speculative work.
  assert.deepEqual(report.dispatched, []);
  assert.deepEqual(report.inspected, [marker.attemptKey]);
  assert.equal(nodeView(report, "build").state, "waiting");
  assert.equal(nodeView(report, "build").attempts.length, 0);

  // An Unknown Attempt is charged exactly once, for its own reservation.
  assert.equal(report.observation?.budget.consumed.calls, 1);
  assert.equal(report.observation?.budget.reserved.calls, 0);

  // Exactly one current fence: the single takeover, one step past the corpse.
  const planFence = report.leases.plan?.fence;
  assert.equal(planFence, (marker.attemptFence ?? 0) + 1);
  assert.equal(plan.attempts[0]?.fence, planFence);

  // The victim's Guarded Workspace is preserved for inspection, not recreated.
  assert.equal(countEvents(victimLog, "workspace.prepare-complete"), 1);
  assert.equal(countEvents(replacementLog, "workspace.prepare-complete"), 0);
  const disposals = replacementLog.filter(
    (entry) => entry.event === "workspace.dispose",
  );
  assert.equal(disposals.length, 1);
  assert.equal(disposals[0]?.preserve, true);
  assert.equal(disposals[0]?.outcome, "unknown");
  assert.equal(disposals[0]?.workspaceId, plan.attempts[0]?.workspaceId);
  assertWorkspacesAreNotDuplicated(victimLog, replacementLog);

  assertEvidenceIsUnique(report);
  assert.deepEqual(plan.evidence, []);
  assertOutboxIsNotDuplicated(report, replacementLog, "blocked");

  const stale = await runStaleCallback(t, layout);

  // The record the stale writer tried to overwrite is still the Unknown one.
  const store = openStore(layout.dbPath);
  const persistence = createGoalPersistence(store, "drill-project");
  const attempts = await persistence.loadAttempts(
    "killed-parent-drill",
    "plan",
  );
  assert.equal(attempts.ok, true);
  if (!attempts.ok) return;
  assert.equal(attempts.value.length, 1);
  assert.equal(attempts.value[0]?.value.phase, "unknown");
  assert.equal(attempts.value[0]?.value.fence, planFence);

  emitRecoveryMetrics(t, {
    scenario: "post-dispatch",
    barrierPhase: marker.attemptPhase,
    victimPid: marker.pid,
    replacementPid: report.pid,
    leaseTtlMs: LEASE_TTL_MS,
    barrierToKillMs: killedAt - marker.reachedAt,
    recoveryLatencyMs: report.recoveryLatencyMs,
    fenceAtKill: marker.attemptFence,
    fenceAfterRecovery: planFence,
    leaseHeldAtReplacementBootMs:
      (report.bootLease.expiresAt ?? 0) - report.bootLease.observedAt,
    decision: "blocked-unknown",
    goalState: report.observation?.state ?? null,
    attemptsForBarrierNode: plan.attempts.length,
    childDispatches: report.dispatched.length,
    executorInspections: report.inspected.length,
    budgetCallsConsumed: report.observation?.budget.consumed.calls ?? null,
    budgetCallsReserved: report.observation?.budget.reserved.calls ?? null,
    workspacesPreserved: disposals.length,
    deliveries: report.deliveries.length,
    staleProbesRefused: stale.probes.length,
  });
});
