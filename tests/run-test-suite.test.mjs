import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runChild } from "../scripts/run-test-suite.mjs";

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function pollUntil(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("runChild preserves a completed child exit code", async () => {
  const result = await runChild(
    process.execPath,
    ["-e", "process.exit(7)"],
    process.cwd(),
    { timeoutMs: 5_000 },
  );

  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test("runChild watchdog terminates the exact spawned process tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-suite-watchdog-"));
  const pidPath = path.join(directory, "descendant.pid");
  const descendantScript = "setInterval(() => {}, 1000)";
  const parentScript = [
    'const { spawn } = require("node:child_process")',
    'const fs = require("node:fs")',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" })`,
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
    "setInterval(() => {}, 1000)",
  ].join(";");

  try {
    const result = await runChild(
      process.execPath,
      ["-e", parentScript],
      process.cwd(),
      { timeoutMs: 1_500 },
    );

    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.ok(
      await pollUntil(async () => {
        try {
          await readFile(pidPath, "utf8");
          return true;
        } catch {
          return false;
        }
      }),
      "fixture wrote descendant PID before watchdog fired",
    );
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid));
    assert.ok(
      await pollUntil(() => processGone(descendantPid)),
      `descendant ${descendantPid} survived suite watchdog`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
