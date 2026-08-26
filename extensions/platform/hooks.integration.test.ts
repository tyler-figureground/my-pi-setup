import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTriggerEngine } from "./src/automation/hooks/index.ts";

const globalYaml = `version: 1
hooks:
  - id: global-status
    event: agent_start
    priority: 20
    match: {}
    action:
      type: status
      key: hooks
      text: global
    timeoutMs: 100
    outputCapBytes: 1024
    failurePolicy: open
`;

const projectYaml = `version: 1
hooks:
  - id: project-command
    event: tool_call
    priority: 10
    match:
      toolName: bash
    action:
      type: command
      executable: git
      args: [status, --short]
    timeoutMs: 500
    outputCapBytes: 2048
    failurePolicy: closed
`;

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-hooks-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("real Windows filesystem adapter loads global and caller-confirmed trusted-project YAML with provenance", async () => {
  await fixture(async (directory) => {
    const globalPath = join(directory, "global hooks.yaml");
    const projectPath = join(directory, "project hooks.yaml");
    const untrustedPath = join(directory, "must-not-be-read.yaml");
    await writeFile(globalPath, globalYaml, "utf8");
    await writeFile(projectPath, projectYaml, "utf8");
    await writeFile(
      untrustedPath,
      projectYaml.replace("project-command", "untrusted-command"),
      "utf8",
    );
    const sources = [
      { scope: "global", path: globalPath },
      { scope: "project", path: projectPath, trusted: true },
      { scope: "project", path: untrustedPath, trusted: false },
      { scope: "global", path: join(directory, "optional-missing.yaml") },
    ] as const;
    const engine = createTriggerEngine();

    const validation = await engine.validate(sources);
    assert.equal(validation.valid, true);
    assert.deepEqual(
      validation.sources.map(({ status }) => status),
      ["valid", "valid", "untrusted-skipped", "missing"],
    );
    assert.deepEqual(
      validation.hooks.map(({ hook, provenance }) => [
        hook.id,
        provenance.scope,
        provenance.source,
        provenance.trusted,
      ]),
      [
        ["global-status", "global", globalPath, true],
        ["project-command", "project", projectPath, true],
      ],
    );

    const started = await engine.start(sources);
    assert.equal(started.applied, true);
    const dispatched = await engine.dispatch({
      event: "tool_call",
      mode: "normal",
      payload: { toolName: "bash" },
    });
    assert.deepEqual(
      dispatched.effects.map(({ hookId }) => hookId),
      ["project-command"],
    );
    assert.equal(
      engine.inspect().hooks.some(({ id }) => id === "untrusted-command"),
      false,
    );

    await writeFile(
      projectPath,
      "version: 1\nhooks:\n  - id: broken\n    event: nope\n",
      "utf8",
    );
    const failed = await engine.reload();
    assert.equal(failed.applied, false);
    assert.equal(
      (
        await engine.dispatch({
          event: "tool_call",
          mode: "normal",
          payload: { toolName: "bash" },
        })
      ).effects[0]?.hookId,
      "project-command",
      "failed reload must retain last known-good config atomically",
    );

    await writeFile(
      projectPath,
      projectYaml.replace("project-command", "project-command-v2"),
      "utf8",
    );
    const reloaded = await engine.reload();
    assert.equal(reloaded.applied, true);
    assert.deepEqual(
      engine
        .inspect()
        .hooks.map(({ id }) => id)
        .sort(),
      ["global-status", "project-command-v2"],
    );

    assert.equal(
      (await readFile(globalPath, "utf8")).includes("global-status"),
      true,
    );
  });
});

test("trusted-project hook config cannot escape its canonical root through a junction", async () => {
  await fixture(async (directory) => {
    const project = join(directory, "project");
    const outside = join(directory, "outside");
    const projectConfig = join(project, ".pi");
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "hooks.yaml"), projectYaml, "utf8");
    await symlink(
      outside,
      projectConfig,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      const result = await createTriggerEngine().validate([
        {
          scope: "project",
          path: join(projectConfig, "hooks.yaml"),
          root: project,
          trusted: true,
        },
      ]);
      assert.equal(result.valid, false);
      assert.ok(
        result.diagnostics.some(({ code }) => code === "unsafe-config-path"),
      );
    } finally {
      if (process.platform === "win32") await rmdir(projectConfig);
      else await unlink(projectConfig);
    }
  });
});

test("YAML adapter rejects aliases and bounded byte, depth, and node inputs without partial loading", async () => {
  await fixture(async (directory) => {
    const aliasPath = join(directory, "alias.yaml");
    const largePath = join(directory, "large.yaml");
    const deepPath = join(directory, "deep.yaml");
    const nodesPath = join(directory, "nodes.yaml");
    await writeFile(
      aliasPath,
      `version: 1
hooks:
  - &shared
    id: aliased
    event: agent_start
    priority: 0
    match: {}
    action: { type: notify, message: hi, level: info }
    timeoutMs: 100
    outputCapBytes: 100
    failurePolicy: open
  - *shared
`,
      "utf8",
    );
    await writeFile(
      largePath,
      `version: 1\nhooks: []\npadding: ${"x".repeat(500)}`,
      "utf8",
    );
    await writeFile(
      deepPath,
      `version: 1\nhooks: []\nextra: { a: { b: { c: { d: value } } } }\n`,
      "utf8",
    );
    await writeFile(
      nodesPath,
      `version: 1\nhooks: []\nextra: [1, 2, 3, 4, 5, 6, 7, 8]\n`,
      "utf8",
    );

    const cases = [
      [aliasPath, {}, "yaml-alias-disabled"],
      [largePath, { maxConfigBytes: 128 }, "config-too-large"],
      [deepPath, { maxConfigDepth: 3 }, "config-depth-limit"],
      [nodesPath, { maxConfigNodes: 8 }, "config-node-limit"],
    ] as const;
    for (const [path, options, code] of cases) {
      const engine = createTriggerEngine(options);
      const result = await engine.validate([{ scope: "global", path }]);
      assert.equal(result.valid, false, path);
      assert.equal(result.hooks.length, 0, path);
      assert.ok(
        result.diagnostics.some((entry) => entry.code === code),
        path,
      );
    }
  });
});
