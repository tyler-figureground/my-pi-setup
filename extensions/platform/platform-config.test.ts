import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPlatformFlags } from "./src/config.ts";
import { defaultPlatformFlags } from "./src/flags.ts";

test("platform config reads global and trusted-project sources without enabling Phase 1 flags", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-platform-config-"));
  const agentDir = path.join(directory, "agent");
  const cwd = path.join(directory, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "platform.json"),
    JSON.stringify({ planMode: true }),
  );
  await writeFile(
    path.join(cwd, ".pi", "platform.json"),
    JSON.stringify({ browser: "yes" }),
  );
  try {
    const untrusted = loadPlatformFlags({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    assert.deepEqual(untrusted.flags, defaultPlatformFlags);
    assert.equal(untrusted.diagnostics.length, 1);
    assert.match(untrusted.diagnostics[0]?.path ?? "", /agent.*platform\.json/);

    const trusted = loadPlatformFlags({ cwd, agentDir, projectTrusted: true });
    assert.deepEqual(trusted.flags, defaultPlatformFlags);
    assert.equal(trusted.diagnostics.length, 2);
    assert.match(trusted.diagnostics[1]?.path ?? "", /\.pi.*platform\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
