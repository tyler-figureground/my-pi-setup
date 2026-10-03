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
  });
  const windows = resolveMachinePaths({
    home: "D:/Users/Other",
    platform: "win32",
    env: { Path: "D:/Tools" },
    exists: () => true,
  });
  assert.equal(windows.UV, "D:/Tools/uv.exe");
  assert.equal(windows.PYVOID_ROOT, "D:/Users/Other/Documents/GitHub/Pyvoid");
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
  assert.throws(
    () => resolveMachinePaths({ ...machine, exists: () => false }),
    /Install uv/,
  );
  assert.throws(
    () =>
      resolveMachinePaths({
        ...machine,
        exists: (file) => file.endsWith("uv"),
      }),
    /Install Chrome/,
  );
  assert.throws(
    () =>
      resolveMachinePaths({
        ...machine,
        exists: (file) => !file.endsWith("mcp_server"),
      }),
    /Clone Pyvoid/,
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
