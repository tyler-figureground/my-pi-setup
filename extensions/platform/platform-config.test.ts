import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPlatformFlags } from "./src/config.ts";
import { defaultPlatformFlags } from "./src/flags.ts";

test("platform config merges available flags from global and trusted-project sources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-platform-config-"));
  const agentDir = path.join(directory, "agent");
  const cwd = path.join(directory, "project");
  const nestedCwd = path.join(cwd, "packages", "app");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await mkdir(path.join(cwd, ".git"), { recursive: true });
  await mkdir(nestedCwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "platform.json"),
    JSON.stringify({
      planMode: true,
      hooks: true,
      plan: { userDirectory: "my-plans" },
    }),
  );
  await writeFile(
    path.join(cwd, ".pi", "platform.json"),
    JSON.stringify({
      planMode: false,
      rules: true,
      browser: "yes",
      plan: {
        defaultScope: "project",
        projectDirectory: ".pi/project-plans",
      },
    }),
  );
  try {
    const untrusted = loadPlatformFlags({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    assert.deepEqual(untrusted.flags, {
      ...defaultPlatformFlags,
      planMode: true,
      hooks: true,
    });
    assert.deepEqual(untrusted.plan, {
      defaultScope: "user",
      userDirectory: "my-plans",
      projectDirectory: path.join(".pi", "plans"),
    });
    assert.deepEqual(untrusted.diagnostics, []);

    const trusted = loadPlatformFlags({
      cwd: nestedCwd,
      agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(trusted.flags, {
      ...defaultPlatformFlags,
      planMode: false,
      hooks: true,
      rules: true,
    });
    assert.deepEqual(trusted.plan, {
      defaultScope: "project",
      userDirectory: "my-plans",
      projectDirectory: path.join(".pi", "project-plans"),
    });
    assert.equal(trusted.diagnostics.length, 1);
    assert.match(
      trusted.diagnostics[0]?.path ?? "",
      /\.pi.*platform\.json:browser/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
