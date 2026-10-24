import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mergeModelsConfig,
  renderTemplate,
  resolveMachinePaths,
  syncConfig,
  writeJsonAtomic,
} from "../scripts/sync-config.mjs";

const machine = {
  home: "/home/other-user",
  platform: "linux",
  env: { PATH: "/usr/bin" },
  exists: () => true,
};

test("machine paths follow the current home and installed executables", () => {
  assert.deepEqual(resolveMachinePaths(machine), {
    UV: "/usr/bin/uv",
    BROWSER: "/usr/bin/google-chrome",
    PYVOID_ROOT: "/home/other-user/Documents/GitHub/Pyvoid",
    PYVOID_PRESENT: true,
    SHELL_PATH: "/bin/bash",
  });
  const windows = resolveMachinePaths({
    home: "D:/Users/Other",
    platform: "win32",
    env: { Path: "D:/Tools" },
    exists: () => true,
  });
  assert.equal(windows.UV, "D:/Tools/uv.exe");
  assert.equal(windows.PYVOID_ROOT, "D:/Users/Other/Documents/GitHub/Pyvoid");
  assert.equal(windows.SHELL_PATH, "C:/Program Files/Git/bin/bash.exe");
  assert.ok(!JSON.stringify(windows).includes("YOLOTRON"));
  assert.throws(
    () =>
      resolveMachinePaths({
        ...machine,
        platform: "win32",
        overrides: { uv: "/drive-relative/uv.exe" },
      }),
    /must be absolute/,
  );
  const mac = resolveMachinePaths({
    ...machine,
    platform: "darwin",
    home: "/Users/Other",
  });
  assert.equal(
    mac.BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
});

test("machine overrides only permit paths, and missing dependencies fail clearly", () => {
  const overrides = {
    uv: "/custom/uv",
    browser: "/custom/chrome",
    pyvoidRoot: "/src/Pyvoid",
  };
  assert.deepEqual(resolveMachinePaths({ ...machine, overrides }), {
    UV: overrides.uv,
    BROWSER: overrides.browser,
    PYVOID_ROOT: overrides.pyvoidRoot,
    PYVOID_PRESENT: true,
    SHELL_PATH: "/bin/bash",
  });
  assert.throws(
    () => resolveMachinePaths({ ...machine, overrides: { monitors: true } }),
    /Unknown machine setting/,
  );
  assert.throws(
    () => resolveMachinePaths({ ...machine, overrides: { uv: 123 } }),
    /Invalid machine path/,
  );
  assert.throws(
    () => resolveMachinePaths({ ...machine, overrides: { uv: "./uv" } }),
    /must be absolute/,
  );
  // Nothing installed: pyvoid absent so uv is not required; only the
  // browser prerequisite fails.
  assert.throws(
    () => resolveMachinePaths({ ...machine, exists: () => false }),
    /Install Chrome/,
  );
  // Only Chrome exists: resolves without uv because Pyvoid is absent.
  const chromeOnly = resolveMachinePaths({
    ...machine,
    exists: (file) => file.endsWith("chrome"),
  });
  assert.equal(chromeOnly.PYVOID_PRESENT, false);
  assert.equal(chromeOnly.BROWSER, "/usr/bin/google-chrome");
  // uv missing while Pyvoid is present: hard failure.
  assert.throws(
    () =>
      resolveMachinePaths({
        ...machine,
        exists: (file) => !file.includes("uv"),
      }),
    /Install uv/,
  );
  // Pyvoid absent: paths resolve without the Revit integration.
  const pyvoidNoUv = resolveMachinePaths({
    ...machine,
    exists: (file) => !file.endsWith("mcp_server"),
  });
  assert.equal(pyvoidNoUv.PYVOID_PRESENT, false);
  assert.deepEqual(
    resolveMachinePaths({
      ...machine,
      overrides: { shellPath: "/custom/bash" },
    }).SHELL_PATH,
    "/custom/bash",
  );
  assert.throws(
    () => resolveMachinePaths({ ...machine, overrides: { shellPath: "bash" } }),
    /must be absolute/,
  );
});

test("template rendering preserves types and safely handles quotes and backslashes", () => {
  const result = renderTemplate(
    { command: "{{UV}}", args: ["{{ROOT}}/server", false, 2, null] },
    { UV: 'C:\\a "tool"\\uv.exe', ROOT: "D:/source" },
  );
  assert.equal(result.command, 'C:\\a "tool"\\uv.exe');
  assert.deepEqual(result.args, ["D:/source/server", false, 2, null]);
  assert.throws(
    () => renderTemplate("{{TYPO}}", {}),
    /Unknown config placeholder/,
  );
});

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-sync-config-"));
  try {
    await mkdir(path.join(directory, "config"));
    await writeFile(
      path.join(directory, "config/settings.json"),
      JSON.stringify({ theme: "shared", defaultModel: "shared-model" }),
    );
    await writeFile(
      path.join(directory, "config/platform.json"),
      JSON.stringify({
        hooks: true,
        browserSettings: { executablePath: "{{BROWSER}}" },
      }),
    );
    await run(directory);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

test("check is read-only; apply backs up, preserves local settings and credentials, and is idempotent", async () => {
  await fixture(async (directory) => {
    const original = JSON.stringify({
      theme: "old",
      sessionDir: "private-sessions",
      lastChangelogVersion: "local",
    });
    await writeFile(path.join(directory, "settings.json"), original);
    await writeFile(path.join(directory, "auth.json"), "private-auth-sentinel");
    assert.deepEqual(await syncConfig({ directory, machine }), [
      "settings.json",
      "platform.json",
    ]);
    assert.equal(
      await readFile(path.join(directory, "settings.json"), "utf8"),
      original,
    );
    assert.ok(!(await readdir(directory)).includes("state"));
    await syncConfig({ directory, machine, apply: true });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")),
      {
        theme: "shared",
        defaultModel: "shared-model",
        sessionDir: "private-sessions",
        lastChangelogVersion: "local",
        shellPath: "/bin/bash",
      },
    );
    assert.equal(
      await readFile(path.join(directory, "auth.json"), "utf8"),
      "private-auth-sentinel",
    );
    const backups = await readdir(path.join(directory, "state/config-backups"));
    assert.equal(backups.length, 1);
    assert.equal(
      await readFile(
        path.join(
          directory,
          "state/config-backups",
          backups[0],
          "settings.json",
        ),
        "utf8",
      ),
      original,
    );
    assert.deepEqual(
      await readdir(path.join(directory, "state/config-backups", backups[0])),
      ["settings.json"],
    );
    assert.deepEqual(await syncConfig({ directory, machine, apply: true }), []);
    assert.deepEqual(await syncConfig({ directory, machine }), []);
  });
});

test("atomic config writes preserve existing data and clean up after failure", async () => {
  await fixture(async (directory) => {
    const file = path.join(directory, "existing.json");
    await writeFile(file, '{"original":true}');
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(writeJsonAtomic(file, cyclic));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      original: true,
    });
    const destinationDirectory = path.join(directory, "not-a-file");
    await mkdir(destinationDirectory);
    await writeFile(path.join(destinationDirectory, "keep"), "untouched");
    await assert.rejects(
      writeJsonAtomic(destinationDirectory, { replacement: true }),
    );
    assert.equal(
      await readFile(path.join(destinationDirectory, "keep"), "utf8"),
      "untouched",
    );
    assert.ok(
      !(await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
    );
    await writeJsonAtomic(file, { replacement: true });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      replacement: true,
    });
  });
});

test("pyvoid-less machines drop the pyvoid-revit server and keep others", async () => {
  await fixture(async (directory) => {
    await writeFile(
      path.join(directory, "config/platform.json"),
      JSON.stringify({
        mcpServers: [
          {
            id: "pyvoid-revit",
            transport: { kind: "stdio", command: "{{UV}}" },
          },
          { id: "other", transport: { kind: "stdio", command: "node" } },
        ],
      }),
    );
    await syncConfig({
      directory,
      machine: { ...machine, exists: (file) => !file.endsWith("mcp_server") },
      apply: true,
    });
    const rendered = JSON.parse(
      await readFile(path.join(directory, "platform.json"), "utf8"),
    );
    assert.deepEqual(
      rendered.mcpServers.map((server) => server.id),
      ["other"],
    );
    // With Pyvoid present, both servers render.
    await rm(path.join(directory, "platform.json"));
    await syncConfig({ directory, machine, apply: true });
    const full = JSON.parse(
      await readFile(path.join(directory, "platform.json"), "utf8"),
    );
    assert.deepEqual(
      full.mcpServers.map((server) => server.id),
      ["pyvoid-revit", "other"],
    );
  });
});

test("shared models.json overlays upsert providers and merge by id", async () => {
  await fixture(async (directory) => {
    await writeFile(
      path.join(directory, "config/models.json"),
      JSON.stringify({
        providers: {
          "kimi-code-api": {
            baseUrl: "https://api.kimi.ai/coding/v1",
            models: [
              { id: "k3.1-pro", contextWindow: 1048576 },
              { id: "k3.1-pro-highspeed", contextWindow: 1048576 },
            ],
          },
        },
      }),
    );
    await writeFile(
      path.join(directory, "models.json"),
      JSON.stringify({
        providers: {
          "local-llama": { baseUrl: "http://127.0.0.1:8081/v1" },
          "kimi-code-api": {
            baseUrl: "https://old.example/v1",
            models: [
              { id: "k3.1-pro", contextWindow: 65536 },
              { id: "machine-only", contextWindow: 8192 },
            ],
            modelOverrides: { "machine-override": { maxTokens: 4096 } },
          },
        },
      }),
    );
    assert.deepEqual(await syncConfig({ directory, machine }), [
      "settings.json",
      "platform.json",
      "models.json",
    ]);
    await syncConfig({ directory, machine, apply: true });
    const merged = JSON.parse(
      await readFile(path.join(directory, "models.json"), "utf8"),
    );
    assert.equal(
      merged.providers["local-llama"].baseUrl,
      "http://127.0.0.1:8081/v1",
    );
    const shared = merged.providers["kimi-code-api"];
    assert.equal(shared.baseUrl, "https://api.kimi.ai/coding/v1");
    assert.deepEqual(
      shared.models.map((model) => model.id),
      ["k3.1-pro", "machine-only", "k3.1-pro-highspeed"],
    );
    assert.equal(
      shared.models.find((model) => model.id === "k3.1-pro").contextWindow,
      1048576,
    );
    assert.deepEqual(shared.modelOverrides, {
      "machine-override": { maxTokens: 4096 },
    });
    // Idempotent: a second check reports no drift.
    assert.deepEqual(await syncConfig({ directory, machine }), []);
  });
});

test("a missing root models.json is created from the shared overlay", async () => {
  await fixture(async (directory) => {
    await writeFile(
      path.join(directory, "config/models.json"),
      JSON.stringify({ providers: { "kimi-code-api": { models: [] } } }),
    );
    await syncConfig({ directory, machine, apply: true });
    const created = JSON.parse(
      await readFile(path.join(directory, "models.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(created.providers), ["kimi-code-api"]);
  });
});

test("no config/models.json leaves root models.json untouched", async () => {
  await fixture(async (directory) => {
    await writeFile(
      path.join(directory, "models.json"),
      JSON.stringify({ providers: { "local-llama": { models: [] } } }),
    );
    const changed = await syncConfig({ directory, machine, apply: true });
    assert.deepEqual(changed, ["settings.json", "platform.json"]);
  });
});

test("mergeModelsConfig rejects invalid shapes and unknown keys", () => {
  assert.throws(() => mergeModelsConfig({}, []), /JSON object/);
  assert.throws(
    () => mergeModelsConfig({}, { providers: {}, extra: true }),
    /Unknown models.json key/,
  );
  // Shared model overrides merge per key over root values.
  const merged = mergeModelsConfig(
    {
      providers: {
        p: { modelOverrides: { a: { maxTokens: 1 }, b: { maxTokens: 2 } } },
      },
    },
    { providers: { p: { modelOverrides: { a: { maxTokens: 9 } } } } },
  );
  assert.deepEqual(merged.providers.p.modelOverrides, {
    a: { maxTokens: 9 },
    b: { maxTokens: 2 },
  });
});

test("invalid templates or local JSON never overwrite working configuration", async () => {
  await fixture(async (directory) => {
    const original = '{"theme":"keep"}';
    await writeFile(path.join(directory, "settings.json"), original);
    await writeFile(
      path.join(directory, "config/platform.json"),
      '{"command":"{{TYPO}}"}',
    );
    await assert.rejects(
      syncConfig({ directory, machine, apply: true }),
      /Unknown config placeholder/,
    );
    assert.equal(
      await readFile(path.join(directory, "settings.json"), "utf8"),
      original,
    );
    await writeFile(path.join(directory, "config/machine.local.json"), "[]");
    await assert.rejects(
      syncConfig({ directory, machine, apply: true }),
      /Expected a JSON object/,
    );
  });
});
