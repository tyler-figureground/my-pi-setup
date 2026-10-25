/**
 * One heavy agent run per machine, shared across harnesses.
 *
 * Claude Code enforces the same lock with its `heavy-run-guard` PreToolUse
 * hook; Codex and hand-run cards write it by hand. The file holds one line,
 * `host session pid ISO-time repo card`, at ~/.claude/state/heavy-run.lock.
 *
 * An owner is live when:
 * - its session is a Claude Code session whose transcript (or a subagent
 *   transcript) changed within 60 minutes;
 * - otherwise, its pid is still running;
 * - otherwise (no pid), the lock is under 12 hours old.
 *
 * `CLAUDE_HEAVY_OK=1` bypasses the check without touching the lock.
 * `HEAVY_RUN_LOCK` / `HEAVY_RUN_PROJECTS` relocate the lock and the Claude
 * transcript root (tests), matching the Claude hook.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ACTIVE_MS = 60 * 60_000;
const STALE_MS = 12 * 60 * 60_000;
const NORMAL_WORKFLOWS = new Set(["fix-main", "cleanup"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HeavyRunLock {
  host: string;
  session: string;
  pid: string;
  time: Date | undefined;
  repo: string;
  card: string;
}

export interface HeavyRunDeps {
  lockPath: string;
  projectsDir: string;
  host: string;
  pid: number;
  now: () => number;
  pidAlive: (pid: number) => boolean;
  env: Record<string, string | undefined>;
}

export type HeavyRunAcquisition =
  { ok: true; release: () => void } | { ok: false; reason: string };

export function isHeavyWorkflow(name: string | undefined) {
  return !NORMAL_WORKFLOWS.has((name ?? "").trim());
}

export function defaultHeavyRunDeps(): HeavyRunDeps {
  const home = os.homedir();
  return {
    lockPath:
      process.env.HEAVY_RUN_LOCK ||
      path.join(home, ".claude", "state", "heavy-run.lock"),
    projectsDir:
      process.env.HEAVY_RUN_PROJECTS || path.join(home, ".claude", "projects"),
    host: os.hostname(),
    pid: process.pid,
    now: () => Date.now(),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    env: process.env,
  };
}

export function parseHeavyRunLock(text: string): HeavyRunLock | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  // A zone-less time is UTC, matching the Claude hook.
  const raw = parts[3]!;
  const time = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  return {
    host: parts[0]!,
    session: parts[1]!,
    pid: parts[2]!,
    time: Number.isNaN(time.getTime()) ? undefined : time,
    repo: parts[4] ?? "?",
    card: parts[5] ?? "?",
  };
}

function readLock(lockPath: string) {
  try {
    return parseHeavyRunLock(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function claudeActivity(projectsDir: string, session: string) {
  let newest: number | undefined;
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  const consider = (file: string) => {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (newest === undefined || mtime > newest) newest = mtime;
    } catch {
      // Missing files carry no activity.
    }
  };
  for (const project of projects) {
    const base = path.join(projectsDir, project);
    consider(path.join(base, `${session}.jsonl`));
    const subagents = path.join(base, session, "subagents");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(subagents);
    } catch {
      continue;
    }
    for (const entry of entries) consider(path.join(subagents, entry));
  }
  return newest;
}

function ownerIsLive(lock: HeavyRunLock, deps: HeavyRunDeps) {
  if (UUID.test(lock.session)) {
    const activity = claudeActivity(deps.projectsDir, lock.session);
    if (activity !== undefined) return deps.now() - activity < ACTIVE_MS;
  }
  if (/^\d+$/.test(lock.pid)) return deps.pidAlive(Number(lock.pid));
  if (!lock.time) return false;
  return deps.now() - lock.time.getTime() < STALE_MS;
}

function describe(lock: HeavyRunLock, lockPath: string) {
  const since = lock.time ? lock.time.toISOString().slice(0, 16) + "Z" : "?";
  return (
    `HEAVY run already live on this machine: ${lock.host} / ${lock.card} in ${lock.repo} ` +
    `(session ${lock.session}, since ${since}). One heavy run per machine (12 Run Tiers). ` +
    "Do not retry. Run this work as NORMAL (no workflow, at most 2 subagents, focused tests only), " +
    `or stop and report the owner. Tyler can override with CLAUDE_HEAVY_OK=1 or by deleting ${lockPath}.`
  );
}

/** Live holds per lock path and session, so overlapping runs in one session share the lock. */
const holds = new Map<string, number>();

export function acquireHeavyRun(
  run: { session: string; cwd: string; card: string },
  deps: HeavyRunDeps = defaultHeavyRunDeps(),
): HeavyRunAcquisition {
  if (deps.env.CLAUDE_HEAVY_OK === "1") return { ok: true, release: () => {} };
  const session = run.session.replace(/\s+/g, "_");
  const host = deps.host.replace(/\s+/g, "_") || "?";
  const key = `${deps.lockPath}\0${session}`;
  const existing = readLock(deps.lockPath);
  if (existing && existing.session !== session && ownerIsLive(existing, deps))
    return { ok: false, reason: describe(existing, deps.lockPath) };
  // Rewrite unless this process already holds the line for this session: a
  // resumed session must not inherit a dead pid from a crashed process.
  const ours =
    existing?.session === session &&
    existing.pid === String(deps.pid) &&
    existing.host === host &&
    (holds.get(key) ?? 0) > 0;
  if (!ours) {
    const repo =
      path.basename(path.resolve(run.cwd)).replace(/\s+/g, "_") || "?";
    const time = new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const card = run.card.replace(/\s+/g, "_") || "inline-workflow";
    fs.mkdirSync(path.dirname(deps.lockPath), { recursive: true });
    fs.writeFileSync(
      deps.lockPath,
      `${host} ${session} ${deps.pid} ${time} ${repo} ${card}\n`,
    );
    holds.set(key, 0);
  }
  holds.set(key, (holds.get(key) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const left = (holds.get(key) ?? 1) - 1;
      holds.set(key, Math.max(0, left));
      if (left > 0) return;
      holds.delete(key);
      if (readLock(deps.lockPath)?.session !== session) return;
      try {
        fs.rmSync(deps.lockPath, { force: true });
      } catch {
        // A lock that cannot be removed goes stale with this process.
      }
    },
  };
}
