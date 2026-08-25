import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";

test("real timers, watchers, sockets, processes, and client closers release on shutdown", async () => {
  const supervisor = createLifecycleSupervisor({ closeTimeoutMs: 5_000 });
  const directory = await mkdtemp(path.join(tmpdir(), "pi-lifecycle-"));
  let timerTicks = 0;
  let clientCloses = 0;
  let childExited = false;

  try {
    await supervisor.acquire({
      id: "timer",
      async start() {
        const timer = setInterval(() => timerTicks++, 5);
        return { value: timer, close: () => clearInterval(timer) };
      },
    });
    const watcher = await supervisor.acquire({
      id: "watcher",
      async start() {
        const watcher = watch(directory, () => {});
        return { value: watcher, close: () => watcher.close() };
      },
    });
    const server = await supervisor.acquire({
      id: "socket",
      async start() {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        return {
          value: server,
          close: () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        };
      },
    });
    const child = await supervisor.acquire({
      id: "process",
      async start() {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)", "pi-lifecycle-fixture"],
          { stdio: "ignore", windowsHide: true },
        );
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.once("close", () => (childExited = true));
        return {
          value: child,
          close: () =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null) return resolve();
              child.once("close", () => resolve());
              child.kill("SIGTERM");
            }),
        };
      },
    });
    await supervisor.acquire({
      id: "client",
      async start() {
        return {
          value: "client",
          close: async () => void clientCloses++,
        };
      },
    });

    const report = await supervisor.shutdown("reload");
    const ticksAfterShutdown = timerTicks;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(report.status, "clean");
    assert.deepEqual(report.closed, [
      "client",
      "process",
      "socket",
      "watcher",
      "timer",
    ]);
    assert.equal(timerTicks, ticksAfterShutdown);
    assert.equal(clientCloses, 1);
    assert.equal(childExited, true);
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    assert.equal(server.listening, false);
  } finally {
    await supervisor.shutdown("quit");
    await rm(directory, { recursive: true, force: true });
  }
});
