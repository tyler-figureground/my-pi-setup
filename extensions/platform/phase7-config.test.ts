import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPlatformFlags } from "./src/config.ts";
import { decodePlatformFlags } from "./src/flags.ts";

test("Phase 7 flags expose monitors and scheduler without enabling them by default", () => {
  const defaults = decodePlatformFlags();
  assert.equal(defaults.flags.monitors, false);
  assert.equal(defaults.flags.scheduler, false);
  assert.deepEqual(defaults.diagnostics, []);

  const enabled = decodePlatformFlags({ monitors: true, scheduler: true });
  assert.equal(enabled.flags.monitors, true);
  assert.equal(enabled.flags.scheduler, true);
  assert.deepEqual(enabled.diagnostics, []);
});

test("Phase 7 settings merge trusted config while preserving host safety ceilings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-phase7-config-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(
    path.join(agentDir, "platform.json"),
    JSON.stringify({
      monitors: true,
      scheduler: true,
      monitorSettings: {
        maxActive: 64,
        maxRemote: 8,
        batchWindowMs: 500,
        pollMinimumMs: 10_000,
        allowedWebSocketOrigins: ["wss://events.example.test"],
        allowLoopback: false,
        pollTargets: [
          {
            id: "ci-status",
            endpoint: "https://ci.example.test/status",
            allowedOrigins: ["https://ci.example.test"],
            allowLoopback: false,
            maxResponseBytes: 65536,
          },
        ],
      },
      schedulerSettings: {
        maxSchedules: 500,
        maxConcurrent: 2,
        defaultTimeoutMs: 600_000,
        leaseTtlMs: 60_000,
      },
    }),
  );
  await writeFile(
    path.join(project, ".pi", "platform.json"),
    JSON.stringify({
      monitorSettings: {
        maxActive: 10_000,
        allowLoopback: true,
        allowedWebSocketOrigins: ["ws://127.0.0.1:9000"],
      },
      schedulerSettings: {
        maxSchedules: 10_000,
        maxConcurrent: 100,
      },
    }),
  );
  try {
    const untrusted = loadPlatformFlags({
      cwd: project,
      agentDir,
      projectTrusted: false,
    });
    assert.equal(untrusted.flags.monitors, true);
    assert.equal(untrusted.flags.scheduler, true);
    assert.deepEqual(untrusted.monitors, {
      maxActive: 64,
      maxRemote: 8,
      batchWindowMs: 500,
      pollMinimumMs: 10_000,
      allowedWebSocketOrigins: ["wss://events.example.test"],
      allowLoopback: false,
      pollTargets: [
        {
          id: "ci-status",
          endpoint: "https://ci.example.test/status",
          allowedOrigins: ["https://ci.example.test"],
          allowLoopback: false,
          maxResponseBytes: 65536,
        },
      ],
    });
    assert.deepEqual(untrusted.scheduler, {
      maxSchedules: 500,
      maxConcurrent: 2,
      defaultTimeoutMs: 600_000,
      leaseTtlMs: 60_000,
    });

    const trusted = loadPlatformFlags({
      cwd: project,
      agentDir,
      projectTrusted: true,
    });
    assert.equal(trusted.monitors.maxActive, 64);
    assert.equal(trusted.monitors.allowLoopback, false);
    assert.deepEqual(trusted.monitors.allowedWebSocketOrigins, [
      "wss://events.example.test",
    ]);
    assert.equal(trusted.scheduler.maxSchedules, 500);
    assert.equal(trusted.scheduler.maxConcurrent, 2);
    assert.ok(
      trusted.diagnostics.some(({ path }) =>
        path.endsWith(":monitorSettings.maxActive"),
      ),
    );
    assert.ok(
      trusted.diagnostics.some(({ path }) =>
        path.endsWith(":schedulerSettings.maxConcurrent"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 7 defaults open no remote monitor or scheduler capacity beyond fixed ceilings", () => {
  const loaded = loadPlatformFlags({
    cwd: process.cwd(),
    agentDir: path.join(tmpdir(), "pi-phase7-missing-config"),
    projectTrusted: false,
  });
  assert.deepEqual(loaded.monitors, {
    maxActive: 128,
    maxRemote: 16,
    batchWindowMs: 250,
    pollMinimumMs: 5_000,
    allowedWebSocketOrigins: [],
    allowLoopback: false,
    pollTargets: [],
  });
  assert.deepEqual(loaded.scheduler, {
    maxSchedules: 1_000,
    maxConcurrent: 4,
    defaultTimeoutMs: 900_000,
    leaseTtlMs: 60_000,
  });
});
