import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPlatformFlags } from "./src/config.ts";

test("Phase 6 config keeps messaging opt-in and automatic memory behavior off", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-phase6-config-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(
    path.join(agentDir, "platform.json"),
    JSON.stringify({
      messaging: true,
      memory: true,
      messagingSettings: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
      memorySettings: {
        defaultScope: "project",
        automaticRecall: false,
        automaticExtraction: false,
      },
    }),
  );
  await writeFile(
    path.join(project, ".pi", "platform.json"),
    JSON.stringify({
      messagingSettings: { discoverableBy: "local-user" },
      memorySettings: {
        defaultScope: "workspace",
        automaticRecall: true,
        automaticExtraction: true,
      },
    }),
  );
  try {
    const untrusted = loadPlatformFlags({
      cwd: project,
      agentDir,
      projectTrusted: false,
    });
    assert.equal(untrusted.flags.messaging, true);
    assert.equal(untrusted.flags.memory, true);
    assert.deepEqual(untrusted.messaging, {
      discoverableBy: "same-project",
      acceptsFrom: "same-project",
    });
    assert.deepEqual(untrusted.memory, {
      defaultScope: "project",
      automaticRecall: false,
      automaticExtraction: false,
    });

    const trusted = loadPlatformFlags({
      cwd: project,
      agentDir,
      projectTrusted: true,
    });
    assert.equal(trusted.messaging.discoverableBy, "same-project");
    assert.equal(trusted.memory.defaultScope, "workspace");
    assert.equal(trusted.memory.automaticRecall, false);
    assert.equal(trusted.memory.automaticExtraction, false);
    assert.equal(
      trusted.diagnostics.some(({ path }) =>
        path.endsWith(":messagingSettings.discoverableBy"),
      ),
      true,
    );
    assert.equal(
      trusted.diagnostics.some(({ path }) =>
        path.endsWith(":memorySettings.automaticExtraction"),
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 6 settings default to no discovery and no automatic memory work", () => {
  const loaded = loadPlatformFlags({
    cwd: process.cwd(),
    agentDir: path.join(tmpdir(), "pi-phase6-missing-config"),
    projectTrusted: false,
  });
  assert.deepEqual(loaded.messaging, {
    discoverableBy: "none",
    acceptsFrom: "none",
  });
  assert.deepEqual(loaded.memory, {
    defaultScope: "project",
    automaticRecall: false,
    automaticExtraction: false,
  });
});
