import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHookProcessRunner } from "./src/automation/hooks/process.ts";

const windowsTest = process.platform === "win32" ? test : test.skip;

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process ${pid} remained alive`);
}

windowsTest("rejects a pre-aborted command before spawning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-pre-abort-"));
  const runner = createHookProcessRunner();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      runner.run({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd,
        env: {},
        timeoutMs: 1_000,
        outputCapBytes: 1,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
  } finally {
    await runner.shutdown(2_000);
    await rm(cwd, { recursive: true, force: true });
  }
});

windowsTest(
  "runs a structured native command with isolated process inputs",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-success-"));
    const runner = createHookProcessRunner();
    try {
      const script = `
      process.stdin.resume();
      process.stdin.once("end", () => {
        process.stdout.write(JSON.stringify({
          cwd: process.cwd(),
          marker: process.env.HOOK_MARKER,
          inheritedPath: process.env.PATH ?? null,
          literalArgument: process.argv[1],
          stdinEnded: true,
        }));
        process.stderr.write("native stderr");
      });
    `;
      const result = await runner.run({
        executable: process.execPath,
        args: ["-e", script, "literal & | > < argument"],
        cwd,
        env: { HOOK_MARKER: "isolated" },
        timeoutMs: 5_000,
        outputCapBytes: 4_096,
      });

      assert.deepEqual(JSON.parse(result.stdout), {
        cwd,
        marker: "isolated",
        inheritedPath: "",
        literalArgument: "literal & | > < argument",
        stdinEnded: true,
      });
      assert.equal(result.stderr, "native stderr");
      assert.equal(result.totalBytes, Buffer.byteLength(result.stdout) + 13);
      assert.equal(result.truncated, false);
      assert.equal(result.code, 0);
      assert.equal(result.killed, false);
    } finally {
      await runner.shutdown(2_000);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

windowsTest(
  "caps captured output while spilling every complete chunk",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-output-"));
    const runner = createHookProcessRunner();
    const spilled = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    try {
      const expectedStdout = "A".repeat(96 * 1_024);
      const expectedStderr = "B".repeat(64 * 1_024);
      const result = await runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write("A".repeat(96 * 1024)); process.stderr.write("B".repeat(64 * 1024));`,
        ],
        cwd,
        env: {},
        timeoutMs: 5_000,
        outputCapBytes: 31,
        onSpill: async ({ stream, chunk }) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          spilled[stream].push(Buffer.from(chunk));
        },
      });

      assert.equal(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
        31,
      );
      assert.equal(result.totalBytes, 160 * 1_024);
      assert.equal(result.stdoutBytes, 96 * 1_024);
      assert.equal(result.stderrBytes, 64 * 1_024);
      assert.equal(result.truncated, true);
      assert.equal(result.stdoutTruncated || result.stderrTruncated, true);
      assert.equal(Buffer.concat(spilled.stdout).toString(), expectedStdout);
      assert.equal(Buffer.concat(spilled.stderr).toString(), expectedStderr);
      assert.equal(result.code, 0);
      assert.equal(result.killed, false);
    } finally {
      await runner.shutdown(2_000);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

windowsTest(
  "spill cap terminates output before temporary storage can grow unbounded",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-spill-cap-"));
    const runner = createHookProcessRunner();
    const spilled: Buffer[] = [];
    try {
      const result = await runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `for (let i = 0; i < 1024; i++) process.stdout.write("x".repeat(1024));`,
        ],
        cwd,
        env: {},
        timeoutMs: 5_000,
        outputCapBytes: 64,
        spillCapBytes: 1_024,
        onSpill: ({ chunk }) => {
          spilled.push(Buffer.from(chunk));
        },
      });

      assert.equal(result.spillLimitExceeded, true);
      assert.equal(result.killed, true);
      assert.equal(Buffer.concat(spilled).length, 1_024);
    } finally {
      await runner.shutdown(2_000);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

windowsTest(
  "timeout terminates the complete native Windows process tree",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-timeout-"));
    const runner = createHookProcessRunner();
    let grandchildPid: number | undefined;
    try {
      const script = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      process.stdout.write(String(grandchild.pid) + "\\n");
      setInterval(() => {}, 1000);
    `;
      const startedAt = Date.now();
      const result = await runner.run({
        executable: process.execPath,
        args: ["-e", script],
        cwd,
        env: {},
        timeoutMs: 800,
        outputCapBytes: 1_024,
      });
      const elapsedMs = Date.now() - startedAt;
      grandchildPid = Number.parseInt(result.stdout.trim(), 10);

      assert.equal(Number.isSafeInteger(grandchildPid), true);
      assert.equal(result.killed, true);
      assert.equal(elapsedMs < 5_000, true);
      await waitForProcessExit(grandchildPid);
    } finally {
      await runner.shutdown(2_000);
      if (grandchildPid && processExists(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Best-effort cleanup after a failed assertion.
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

windowsTest(
  "shutdown terminates and settles every active child within its deadline",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-shutdown-"));
    const runner = createHookProcessRunner();
    const ready: Array<Promise<void>> = [];
    const readyResolvers: Array<() => void> = [];
    const running = Array.from({ length: 2 }, () => {
      ready.push(
        new Promise<void>((resolve) => {
          readyResolvers.push(resolve);
        }),
      );
      const index = ready.length - 1;
      return runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000);`,
        ],
        cwd,
        env: {},
        timeoutMs: 30_000,
        outputCapBytes: 1_024,
        onSpill: () => readyResolvers[index]?.(),
      });
    });
    const pids: number[] = [];
    try {
      await Promise.all(ready);
      const startedAt = Date.now();
      await runner.shutdown(3_000);
      const elapsedMs = Date.now() - startedAt;
      const results = await Promise.all(running);
      pids.push(...results.map((result) => Number.parseInt(result.stdout, 10)));

      assert.equal(pids.every(Number.isSafeInteger), true);
      assert.equal(elapsedMs < 3_500, true);
      assert.deepEqual(
        results.map((result) => result.killed),
        [true, true],
      );
      for (const pid of pids) await waitForProcessExit(pid);
      await assert.rejects(
        runner.run({
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd,
          env: {},
          timeoutMs: 1_000,
          outputCapBytes: 1,
        }),
        /shut down/,
      );
    } finally {
      await runner.shutdown(500);
      for (const pid of pids) {
        if (!processExists(pid)) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Best-effort cleanup after a failed assertion.
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

windowsTest(
  "AbortSignal terminates and settles an active native process",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-hook-process-abort-"));
    const runner = createHookProcessRunner();
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let pid: number | undefined;
    try {
      const running = runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000);`,
        ],
        cwd,
        env: {},
        timeoutMs: 30_000,
        outputCapBytes: 1_024,
        signal: controller.signal,
        onSpill: ready,
      });
      await started;
      controller.abort();
      const result = await running;
      pid = Number.parseInt(result.stdout, 10);

      assert.equal(Number.isSafeInteger(pid), true);
      assert.equal(result.killed, true);
      await waitForProcessExit(pid);
    } finally {
      await runner.shutdown(2_000);
      if (pid && processExists(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Best-effort cleanup after a failed assertion.
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
