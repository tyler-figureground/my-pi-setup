import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNode,
  planInstall,
  applyPlan,
  updateCheckout,
} from "../scripts/setup.mjs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const platformExample = fs.readFileSync(
  new URL("../config/platform.example.json", import.meta.url),
);
const cliPackage = "@earendil-works/pi-coding-agent";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-setup-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source checkout");
  const agentDir = path.join(directory, "isolated agent");
  write(path.join(root, "package.json"), JSON.stringify(manifest));
  write(path.join(root, "config/platform.example.json"), platformExample);
  return { directory, root, agentDir };
}

// Compare bytes and directory entries, including unexpected backup/temp files.
function snapshot(directory) {
  if (!fs.existsSync(directory)) return null;
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .sort()
      .map((name) => {
        const file = path.join(directory, name);
        return [
          name,
          fs.statSync(file).isDirectory()
            ? snapshot(file)
            : fs.readFileSync(file).toString("hex"),
        ];
      }),
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function injectedRunner(responses = {}) {
  const calls = [];
  const execute = (command, args, cwd, capture) => {
    calls.push({ command, args, cwd, capture });
    const response = responses[args[0]] ?? "";
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, execute };
}

test("assertNode enforces locked-dependency Node version boundaries", () => {
  assert.equal(manifest.engines.node, "^22.22.2 || ^24.15.0 || >=26.0.0");
  for (const version of [
    "18.20.8",
    "20.19.0",
    "21.99.0",
    "22.19.0",
    "22.21.99",
    "22.22.1",
    "23.0.0",
    "23.99.0",
    "24.14.99",
    "25.0.0",
    "25.99.0",
  ]) {
    assert.throws(
      () => assertNode(version),
      /Node\.js .*required by locked dependencies/,
    );
  }
  for (const version of [
    "22.22.2",
    "22.22.3",
    "22.23.0",
    "24.15.0",
    "24.15.1",
    "24.16.0",
    "26.0.0",
    "27.0.0",
  ]) {
    assert.doesNotThrow(() => assertNode(version));
  }
});

test("fresh plan is read-only and installs settings and exact platform template", (t) => {
  const { root, agentDir } = fixture(t);
  const sourceBefore = snapshot(root);
  const plan = planInstall(root, agentDir);
  assert.equal(fs.existsSync(agentDir), false);
  assert.deepEqual(snapshot(root), sourceBefore);
  assert.equal(plan.root, fs.realpathSync(root));
  assert.equal(plan.agentDir, path.resolve(agentDir));
  assert.equal(plan.version, manifest.dependencies[cliPackage]);
  assert.deepEqual(
    plan.files.map((file) => path.basename(file.path)),
    ["settings.json", "platform.json"],
  );
  assert.ok(plan.files.every((file) => file.original === undefined));
  assert.equal(applyPlan(plan), undefined);
  assert.deepEqual(readJson(path.join(agentDir, "settings.json")), {
    packages: [fs.realpathSync(root).replaceAll("\\", "/")],
    theme: "github-dark-default",
  });
  assert.deepEqual(
    fs.readFileSync(path.join(agentDir, "platform.json")),
    platformExample,
  );
  assert.equal(readJson(path.join(agentDir, "platform.json")).browser, false);
  assert.deepEqual(snapshot(root), sourceBefore);
  assert.deepEqual(fs.readdirSync(agentDir).sort(), [
    "platform.json",
    "settings.json",
  ]);
});

test("merge preserves custom settings and backs up original bytes; repeat is a no-op", (t) => {
  const { root, agentDir } = fixture(t);
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = {
    theme: "my-theme",
    packages: [
      "npm:other-package",
      { source: "/some/other/package", extensions: ["one"] },
    ],
    defaultProvider: "custom",
    nested: { unicode: "café", enabled: false },
  };
  const original = Buffer.from(`\t${JSON.stringify(settings)}\r\n`, "utf8");
  write(settingsPath, original);
  const platform = Buffer.from(' { "browser": true, "custom": "keep" }\r\n');
  const secret = Buffer.from([255, 0, 254, 123, 13, 10]);
  write(path.join(agentDir, "platform.json"), platform);
  write(path.join(agentDir, "auth.json"), secret);
  const plan = planInstall(root, agentDir);
  assert.deepEqual(fs.readFileSync(settingsPath), original);
  const backup = applyPlan(plan);
  assert.equal(path.dirname(backup), agentDir);
  assert.match(path.basename(backup), /^setup-backup-/);
  assert.deepEqual(fs.readdirSync(backup), ["settings.json"]);
  assert.deepEqual(
    fs.readFileSync(path.join(backup, "settings.json")),
    original,
  );
  assert.deepEqual(readJson(settingsPath), {
    ...settings,
    packages: [
      ...settings.packages,
      fs.realpathSync(root).replaceAll("\\", "/"),
    ],
  });
  assert.deepEqual(
    fs.readFileSync(path.join(agentDir, "platform.json")),
    platform,
  );
  assert.deepEqual(fs.readFileSync(path.join(agentDir, "auth.json")), secret);
  const before = snapshot(agentDir);
  const repeat = planInstall(root, agentDir);
  assert.deepEqual(repeat.files, []);
  assert.equal(applyPlan(repeat), undefined);
  assert.deepEqual(snapshot(agentDir), before);
});

for (const relativeSource of [false, true]) {
  for (const objectEntry of [false, true]) {
    test(`existing ${relativeSource ? "relative" : "absolute"} ${objectEntry ? "object" : "string"} package keeps config and opaque secrets byte-for-byte`, (t) => {
      const { root, agentDir } = fixture(t);
      const source = relativeSource
        ? path.relative(agentDir, root).replaceAll("\\", "/")
        : fs.realpathSync(root);
      const entry = objectEntry
        ? { source, extensions: [], skills: ["custom"] }
        : source;
      write(
        path.join(agentDir, "settings.json"),
        ` { "theme": "custom", "packages": ${JSON.stringify([entry])}, "extra": true }\r\n`,
      );
      write(
        path.join(agentDir, "platform.json"),
        '{ "browser": true, "unknown": { "token": "local-only" } }\r\n',
      );
      const opaque = Buffer.from([0, 255, 254, 128, 13, 10, 123]);
      for (const file of [
        "auth.json",
        "models.json",
        ".env",
        "sessions/private.bin",
        "extensions/unrelated/index.ts",
      ]) {
        write(path.join(agentDir, file), opaque);
      }
      const before = snapshot(agentDir);
      const plan = planInstall(root, agentDir);
      assert.deepEqual(plan.files, []);
      assert.equal(applyPlan(plan), undefined);
      assert.deepEqual(snapshot(agentDir), before);
    });
  }
}

for (const kind of ["same manifest name", "legacy checkout"]) {
  for (const objectEntry of [false, true]) {
    test(`refuses alternate local ${kind} as ${objectEntry ? "object" : "string"} package without writes`, (t) => {
      const { directory, root, agentDir } = fixture(t);
      const other = path.join(directory, "alternate checkout");
      if (kind === "same manifest name") {
        write(
          path.join(other, "package.json"),
          JSON.stringify({ name: manifest.name }),
        );
      } else {
        // No manifest: the legacy extension layout must identify this copy alone.
        for (const name of ["ask-user", "platform", "subagents", "workflows"]) {
          write(
            path.join(other, "extensions", name, "index.ts"),
            "// legacy fixture\n",
          );
        }
      }
      const source = path.relative(agentDir, other).replaceAll("\\", "/");
      write(
        path.join(agentDir, "settings.json"),
        JSON.stringify({
          packages: [
            fs.realpathSync(root),
            objectEntry ? { source, extensions: [] } : source,
          ],
        }),
      );
      write(path.join(agentDir, "auth.json"), Buffer.from([0, 255, 128]));
      const before = snapshot(directory);
      assert.throws(
        () => planInstall(root, agentDir),
        /Another copy of this setup is already registered/,
      );
      assert.deepEqual(snapshot(directory), before);
    });
  }
}

for (const owner of ["tyler-figureground", "davis7dotsh"]) {
  for (const source of [
    `git:github.com/${owner}/my-pi-setup`,
    `git:https://github.com/${owner}/my-pi-setup.git`,
    `git:git@github.com:${owner}/my-pi-setup.git@v1.2.3`,
    `https://github.com/${owner}/my-pi-setup/`,
  ]) {
    for (const objectEntry of [false, true]) {
      test(`refuses known Git source ${source} as ${objectEntry ? "object" : "string"} package without writes`, (t) => {
        const { directory, root, agentDir } = fixture(t);
        write(
          path.join(agentDir, "settings.json"),
          JSON.stringify({
            packages: [objectEntry ? { source, skills: [] } : source],
          }),
        );
        const before = snapshot(directory);
        assert.throws(
          () => planInstall(root, agentDir),
          /Another copy of this setup is already registered/,
        );
        assert.deepEqual(snapshot(directory), before);
      });
    }
  }
}

for (const entry of [null, false, 42, {}, { source: null }, { source: 42 }]) {
  test(`rejects package without string source: ${JSON.stringify(entry)}`, (t) => {
    const { directory, root, agentDir } = fixture(t);
    write(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [entry] }),
    );
    const before = snapshot(directory);
    assert.throws(
      () => planInstall(root, agentDir),
      /Each settings package needs a string source/,
    );
    assert.deepEqual(snapshot(directory), before);
  });
}

for (const file of ["settings.json", "platform.json"]) {
  for (const value of ["{broken", "[]", "null", '"text"', "42"]) {
    test(`rejects invalid/non-object ${file}: ${value}`, (t) => {
      const { root, agentDir } = fixture(t);
      write(path.join(agentDir, file), value);
      const before = snapshot(agentDir);
      assert.throws(
        () => planInstall(root, agentDir),
        value === "{broken" ? SyntaxError : /Expected JSON object/,
      );
      assert.deepEqual(snapshot(agentDir), before);
    });
  }
}

for (const packages of [null, {}, "npm:package", 1]) {
  test(`rejects non-array packages: ${JSON.stringify(packages)}`, (t) => {
    const { root, agentDir } = fixture(t);
    write(path.join(agentDir, "settings.json"), JSON.stringify({ packages }));
    const before = snapshot(agentDir);
    assert.throws(
      () => planInstall(root, agentDir),
      /packages must be an array/,
    );
    assert.deepEqual(snapshot(agentDir), before);
  });
}

for (const resource of manifest.pi.extensions) {
  test(`refuses legacy extension collision: ${resource}`, (t) => {
    const { root, agentDir } = fixture(t);
    write(
      path.join(agentDir, "extensions", path.basename(resource), "sentinel"),
      "keep",
    );
    const before = snapshot(agentDir);
    assert.throws(
      () => planInstall(root, agentDir),
      /Existing extension would load twice/,
    );
    assert.deepEqual(snapshot(agentDir), before);
  });
}

test("refuses private agent data inside the source checkout", (t) => {
  const { root, directory } = fixture(t);
  const before = snapshot(directory);
  assert.throws(
    () => planInstall(root, path.join(root, "private-home")),
    /neither directory may contain the other/,
  );
  assert.deepEqual(snapshot(directory), before);
});

for (const nested of [false, true]) {
  test(`refuses source ${nested ? "inside" : "equal to"} agent directory`, (t) => {
    const { root, directory } = fixture(t);
    const agentDir = nested ? directory : root;
    const before = snapshot(directory);
    assert.throws(
      () => planInstall(root, agentDir),
      /outside the Pi agent directory/,
    );
    assert.deepEqual(snapshot(directory), before);
  });
}

for (const version of [
  undefined,
  "^0.84.3",
  "~0.84.3",
  "latest",
  "0.84",
  "0.84.3-beta.1",
  "0.84.3+build",
  84,
]) {
  test(`rejects non-exact CLI version: ${version}`, (t) => {
    const { root, agentDir } = fixture(t);
    write(
      path.join(root, "package.json"),
      JSON.stringify({ ...manifest, dependencies: { [cliPackage]: version } }),
    );
    assert.throws(() => planInstall(root, agentDir), /exact release version/);
    assert.equal(fs.existsSync(agentDir), false);
  });
}

test("plan returns the fixture's exact version, not a hard-coded installer version", (t) => {
  const { root, agentDir } = fixture(t);
  write(
    path.join(root, "package.json"),
    JSON.stringify({ ...manifest, dependencies: { [cliPackage]: "1.2.3" } }),
  );
  assert.equal(planInstall(root, agentDir).version, "1.2.3");
});

for (const change of ["modify", "delete", "create-later-file"]) {
  test(`stale plan refuses all writes before any backup: ${change}`, (t) => {
    const { root, agentDir } = fixture(t);
    const settingsPath = path.join(agentDir, "settings.json");
    write(settingsPath, '{"theme":"custom"}\n');
    const plan = planInstall(root, agentDir);
    if (change === "modify") write(settingsPath, '{"theme":"changed"}\n');
    if (change === "delete") fs.unlinkSync(settingsPath);
    if (change === "create-later-file")
      write(path.join(agentDir, "platform.json"), '{"browser":true}\n');
    const before = snapshot(agentDir);
    assert.throws(
      () => applyPlan(plan),
      /Configuration changed during installation/,
    );
    assert.deepEqual(snapshot(agentDir), before);
  });
}

test("updater fetches before status and refuses tracked or untracked dirt without switching", (t) => {
  const { root } = fixture(t);
  for (const status of [" M package.json", "?? private.txt"]) {
    const { calls, execute } = injectedRunner({ status });
    assert.throws(
      () => updateCheckout(root, "v1.2.3", "origin", execute),
      /Checkout has local changes/,
    );
    assert.deepEqual(calls, [
      {
        command: "git",
        args: ["fetch", "origin", "refs/tags/v1.2.3:refs/tags/v1.2.3"],
        cwd: root,
        capture: undefined,
      },
      {
        command: "git",
        args: ["status", "--porcelain", "--untracked-files=all"],
        cwd: root,
        capture: true,
      },
    ]);
  }
});

for (const ref of [
  undefined,
  "",
  "--force",
  "../v1",
  "refs/heads/main",
  "v1 x",
  "v1;echo",
  "v1\n",
]) {
  test(`updater rejects invalid tag before running Git: ${JSON.stringify(ref)}`, (t) => {
    const { root } = fixture(t);
    const { calls, execute } = injectedRunner();
    assert.throws(
      () => updateCheckout(root, ref, "origin", execute),
      /release-tag/,
    );
    assert.deepEqual(calls, []);
  });
}

for (const remote of [
  "",
  "--upload-pack=bad",
  "../origin",
  "origin name",
  "origin\n",
]) {
  test(`updater rejects invalid remote: ${JSON.stringify(remote)}`, (t) => {
    const { root } = fixture(t);
    const { calls, execute } = injectedRunner();
    assert.throws(
      () => updateCheckout(root, "v1.2.3", remote, execute),
      /Invalid remote name/,
    );
    assert.deepEqual(calls, []);
  });
}

test("updater switches to explicit pinned tag and returns previous revision", (t) => {
  const { root } = fixture(t);
  const previous = "a".repeat(40);
  const { calls, execute } = injectedRunner({ "rev-parse": previous });
  assert.equal(
    updateCheckout(root, "v1.2.3-rc_1", "upstream", execute),
    previous,
  );
  assert.deepEqual(calls, [
    {
      command: "git",
      args: [
        "fetch",
        "upstream",
        "refs/tags/v1.2.3-rc_1:refs/tags/v1.2.3-rc_1",
      ],
      cwd: root,
      capture: undefined,
    },
    {
      command: "git",
      args: ["status", "--porcelain", "--untracked-files=all"],
      cwd: root,
      capture: true,
    },
    { command: "git", args: ["rev-parse", "HEAD"], cwd: root, capture: true },
    {
      command: "git",
      args: [
        "switch",
        "--no-overwrite-ignore",
        "--detach",
        "refs/tags/v1.2.3-rc_1",
      ],
      cwd: root,
      capture: undefined,
    },
  ]);
});

for (const failingCommand of ["fetch", "status", "rev-parse", "switch"]) {
  test(`updater propagates ${failingCommand} failure and stops`, (t) => {
    const { root } = fixture(t);
    const error = new Error(`${failingCommand} failed`);
    const { calls, execute } = injectedRunner({ [failingCommand]: error });
    assert.throws(
      () => updateCheckout(root, "v1", undefined, execute),
      (actual) => actual === error,
    );
    const order = ["fetch", "status", "rev-parse", "switch"];
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      order.slice(0, order.indexOf(failingCommand) + 1),
    );
    assert.equal(calls[0].args[1], "origin");
  });
}

for (const ignored of [false, true]) {
  test(`real Git update preserves ${ignored ? "conflicting ignored private file" : "untracked private file"}, refuses without switching, then pins release and supports recovery`, (t) => {
    const { directory, root } = fixture(t);
    const home = path.join(directory, "git-home");
    fs.mkdirSync(home);
    // Isolate Git configuration, hooks, identity, and repository-selection variables.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
    );
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(home, "no-global-config"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Setup Test",
      GIT_AUTHOR_EMAIL: "setup@example.invalid",
      GIT_COMMITTER_NAME: "Setup Test",
      GIT_COMMITTER_EMAIL: "setup@example.invalid",
    });
    const execute = (command, args, cwd) => {
      assert.equal(command, "git");
      assert.ok(
        path.relative(directory, cwd) === "" ||
          !path.relative(directory, cwd).startsWith(".."),
      );
      const result = spawnSync(
        command,
        [
          "-c",
          "core.hooksPath=" + home,
          "-c",
          "commit.gpgSign=false",
          "-c",
          "tag.gpgSign=false",
          ...args,
        ],
        {
          cwd,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
        },
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const git = (cwd, ...args) => execute("git", args, cwd);
    const remote = path.join(directory, "remote.git");
    const checkout = path.join(directory, "consumer");
    git(directory, "init", "--bare", "--template=", remote);
    git(root, "init", "--template=", "--initial-branch=main");
    git(root, "add", ".");
    git(root, "commit", "-m", "initial");
    const previous = git(root, "rev-parse", "HEAD");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "origin", "main");
    git(
      directory,
      "clone",
      "--template=",
      "--branch",
      "main",
      remote,
      checkout,
    );
    write(path.join(root, "release.txt"), "pinned release\n");
    git(root, "add", "release.txt");
    git(root, "commit", "-m", "release");
    const release = git(root, "rev-parse", "HEAD");
    git(root, "tag", "v1.2.3");
    git(root, "push", "origin", "main", "refs/tags/v1.2.3");
    assert.equal(git(checkout, "tag", "--list", "v1.2.3"), "");
    const dirtyPath = path.join(
      checkout,
      ignored ? "release.txt" : "private.txt",
    );
    const privateBytes = Buffer.from([0, 255, 254, 128, 13, 10, 123]);
    if (ignored) {
      write(path.join(checkout, ".git", "info", "exclude"), "release.txt\n");
    }
    write(dirtyPath, privateBytes);
    if (ignored) {
      assert.equal(git(checkout, "check-ignore", "release.txt"), "release.txt");
      assert.equal(
        git(checkout, "status", "--porcelain", "--untracked-files=all"),
        "",
      );
    }
    assert.throws(
      () => updateCheckout(checkout, "v1.2.3", "origin", execute),
      ignored ? /would be overwritten by checkout/ : /local changes/,
    );
    assert.equal(git(checkout, "rev-parse", "refs/tags/v1.2.3"), release);
    assert.equal(git(checkout, "rev-parse", "HEAD"), previous);
    assert.equal(git(checkout, "symbolic-ref", "--short", "HEAD"), "main");
    assert.deepEqual(fs.readFileSync(dirtyPath), privateBytes);
    fs.unlinkSync(dirtyPath);
    assert.equal(
      updateCheckout(checkout, "v1.2.3", "origin", execute),
      previous,
    );
    assert.equal(git(checkout, "rev-parse", "HEAD"), release);
    assert.equal(git(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(
      fs.readFileSync(path.join(checkout, "release.txt"), "utf8"),
      "pinned release\n",
    );
    git(checkout, "switch", "--detach", previous);
    assert.equal(git(checkout, "rev-parse", "HEAD"), previous);
    assert.equal(fs.existsSync(path.join(checkout, "release.txt")), false);
  });
}
