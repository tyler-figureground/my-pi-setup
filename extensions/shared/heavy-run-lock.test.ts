import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acquireHeavyRun,
  isHeavyWorkflow,
  parseHeavyRunLock,
  type HeavyRunDeps,
} from "./heavy-run-lock.ts";

const CLAUDE_SESSION = "aaaaaaaa-0000-0000-0000-000000000001";

function fixture(overrides: Partial<HeavyRunDeps> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-lock-"));
  const projectsDir = path.join(root, "projects");
  fs.mkdirSync(path.join(projectsDir, "P"), { recursive: true });
  const deps: HeavyRunDeps = {
    lockPath: path.join(root, "state", "heavy-run.lock"),
    projectsDir,
    host: "laptop",
    pid: 4242,
    now: () => Date.now(),
    pidAlive: () => false,
    env: {},
    ...overrides,
  };
  const read = () => fs.readFileSync(deps.lockPath, "utf8");
  const exists = () => fs.existsSync(deps.lockPath);
  const writeLock = (line: string) => {
    fs.mkdirSync(path.dirname(deps.lockPath), { recursive: true });
    fs.writeFileSync(deps.lockPath, line);
  };
  const touchClaude = (sid: string, ageMs: number) => {
    const file = path.join(projectsDir, "P", `${sid}.jsonl`);
    fs.writeFileSync(file, "");
    const at = (Date.now() - ageMs) / 1_000;
    fs.utimesSync(file, at, at);
  };
  return { deps, read, exists, writeLock, touchClaude };
}

const iso = (offsetMs = 0) =>
  new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

test("fix-main and cleanup are normal; every other workflow is heavy", () => {
  assert.equal(isHeavyWorkflow("fix-main"), false);
  assert.equal(isHeavyWorkflow("cleanup"), false);
  assert.equal(isHeavyWorkflow("drain"), true);
  assert.equal(isHeavyWorkflow(undefined), true);
});

test("the lock line matches the Claude hook format", () => {
  const parsed = parseHeavyRunLock(
    "tower pi-s1 77 2026-10-24T10:00:00Z my-pi-setup drain\n",
  );
  assert.deepEqual(
    { ...parsed, time: parsed?.time?.toISOString() },
    {
      host: "tower",
      session: "pi-s1",
      pid: "77",
      time: "2026-10-24T10:00:00.000Z",
      repo: "my-pi-setup",
      card: "drain",
    },
  );
});

test("first heavy run takes the lock and release frees it", () => {
  const f = fixture();
  const result = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x/Pyvoid", card: "drain" },
    f.deps,
  );
  assert.equal(result.ok, true);
  assert.match(f.read(), /^laptop pi-s1 4242 \S+ Pyvoid drain\n$/);
  if (result.ok) result.release();
  assert.equal(f.exists(), false);
});

test("a second session is refused while the owner's pid is alive", () => {
  const f = fixture({ pidAlive: (pid) => pid === 77 });
  f.writeLock(`tower pi-other 77 ${iso()} site-axis drain\n`);
  const result = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x/Pyvoid", card: "prs" },
    f.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /HEAVY run already live/);
    assert.match(result.reason, /site-axis/);
  }
  assert.match(f.read(), /pi-other/);
});

test("a dead owner pid is stale and taken over", () => {
  const f = fixture();
  f.writeLock(`tower pi-other 77 ${iso()} site-axis drain\n`);
  const result = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x/Pyvoid", card: "prs" },
    f.deps,
  );
  assert.equal(result.ok, true);
  assert.match(f.read(), /pi-s1/);
});

test("an active Claude session owner blocks; an idle one is stale", () => {
  const f = fixture();
  f.writeLock(`laptop ${CLAUDE_SESSION} - ${iso()} Pyvoid drain\n`);
  f.touchClaude(CLAUDE_SESSION, 5 * 60_000);
  assert.equal(
    acquireHeavyRun({ session: "pi-s1", cwd: "/x", card: "drain" }, f.deps).ok,
    false,
  );
  f.touchClaude(CLAUDE_SESSION, 2 * 60 * 60_000);
  assert.equal(
    acquireHeavyRun({ session: "pi-s1", cwd: "/x", card: "drain" }, f.deps).ok,
    true,
  );
});

test("a hand-written lock without a pid lives 12 hours", () => {
  const f = fixture();
  f.writeLock(`tower codex-1 - ${iso()} site-axis drain\n`);
  assert.equal(
    acquireHeavyRun({ session: "pi-s1", cwd: "/x", card: "drain" }, f.deps).ok,
    false,
  );
  f.writeLock(`tower codex-1 - ${iso(-13 * 60 * 60_000)} site-axis drain\n`);
  assert.equal(
    acquireHeavyRun({ session: "pi-s1", cwd: "/x", card: "drain" }, f.deps).ok,
    true,
  );
});

test("CLAUDE_HEAVY_OK=1 bypasses a live lock without touching it", () => {
  const f = fixture({ pidAlive: () => true, env: { CLAUDE_HEAVY_OK: "1" } });
  f.writeLock(`tower pi-other 77 ${iso()} site-axis drain\n`);
  const result = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x", card: "drain" },
    f.deps,
  );
  assert.equal(result.ok, true);
  if (result.ok) result.release();
  assert.match(f.read(), /pi-other/);
});

test("overlapping runs in one session keep the lock until the last ends", () => {
  const f = fixture();
  const first = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x", card: "drain" },
    f.deps,
  );
  const second = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x", card: "prs" },
    f.deps,
  );
  assert.equal(first.ok && second.ok, true);
  if (first.ok) first.release();
  assert.equal(f.exists(), true);
  if (second.ok) {
    second.release();
    second.release();
  }
  assert.equal(f.exists(), false);
});

test("release never deletes a lock another owner took over", () => {
  const f = fixture();
  const result = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x", card: "drain" },
    f.deps,
  );
  f.writeLock(`tower pi-other 77 ${iso()} site-axis drain\n`);
  if (result.ok) result.release();
  assert.match(f.read(), /pi-other/);
});

test("a resumed session rewrites a lock left by its crashed process", () => {
  const f = fixture({ pid: 5000 });
  f.writeLock(`laptop pi-s1 4999 ${iso(-60_000)} Pyvoid drain\n`);
  const result = acquireHeavyRun(
    { session: "pi-s1", cwd: "/x/Pyvoid", card: "drain" },
    f.deps,
  );
  assert.equal(result.ok, true);
  assert.match(f.read(), /^laptop pi-s1 5000 /);
  if (result.ok) result.release();
  assert.equal(f.exists(), false);
});

test("holds are per session: another session's release cannot free this one", () => {
  const f = fixture();
  const a = acquireHeavyRun(
    { session: "pi-a", cwd: "/x", card: "drain" },
    f.deps,
  );
  fs.rmSync(f.deps.lockPath);
  const b1 = acquireHeavyRun(
    { session: "pi-b", cwd: "/x", card: "drain" },
    f.deps,
  );
  const b2 = acquireHeavyRun(
    { session: "pi-b", cwd: "/x", card: "prs" },
    f.deps,
  );
  assert.equal(a.ok && b1.ok && b2.ok, true);
  if (a.ok) a.release();
  if (b1.ok) b1.release();
  assert.match(f.read(), /pi-b/);
  if (b2.ok) b2.release();
  assert.equal(f.exists(), false);
});

test("a zone-less lock time is UTC and hostnames never split fields", () => {
  assert.equal(
    parseHeavyRunLock("t s 1 2026-10-24T10:00:00 r c")?.time?.toISOString(),
    "2026-10-24T10:00:00.000Z",
  );
  const f = fixture({ host: "my tower" });
  acquireHeavyRun(
    { session: "pi-s1", cwd: "/x/Pyvoid", card: "drain" },
    f.deps,
  );
  assert.equal(parseHeavyRunLock(f.read())?.session, "pi-s1");
  assert.match(f.read(), /^my_tower pi-s1 /);
});
