import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { applyPlan, planInstall } from "../../scripts/setup.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-portable-"));
const agentDir = path.join(temporary, "agent");
const logPath = path.join(temporary, "lifecycle.jsonl");
try {
  applyPlan(planInstall(root, agentDir));
  assert.equal(planInstall(root, agentDir).files.length, 0);
  assert.equal(
    fs.existsSync(path.join(agentDir, "auth.json")),
    false,
    "installer never copies credentials",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(
        root,
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      ),
      "--offline",
      "--no-session",
      "--no-context-files",
      "--approve",
      "--extension",
      path.join(root, "tests/smoke/fixtures/lifecycle-extension.ts"),
      "--print",
      "/smoke-exit",
    ],
    {
      cwd: temporary,
      env: {
        ...process.env,
        HOME: temporary,
        USERPROFILE: temporary,
        LOCALAPPDATA: path.join(temporary, "local"),
        XDG_STATE_HOME: path.join(temporary, "state"),
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_SMOKE_LOG: logPath,
      },
      input: "",
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stderr,
    "",
    "fresh-home extension startup has no diagnostics",
  );
  const events = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const discovery = events.find(
    (event) => event.event === "resources_discover",
  );
  assert.ok(discovery, "installed package discovered from fresh settings");
  for (const tool of [
    "bg_start",
    "subagent_spawn",
    "workflow",
    "ask_user",
    "fd",
    "rg",
    "memory_search",
    "goal_inspect",
    "search",
  ]) {
    assert.ok(
      discovery.tools.includes(tool),
      `installed tool ${tool}; saw ${discovery.tools.join(", ")}`,
    );
  }
  assert.ok(events.some((event) => event.event === "session_shutdown"));
  if (fs.existsSync(path.join(agentDir, "auth.json"))) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")),
      {},
      "Pi may initialize an empty credential store, never copied credentials",
    );
  }
  console.log(
    "Portable setup smoke passed: fresh agent directory, local package discovery, tools, shutdown, repeat-install no-op.",
  );
} finally {
  fs.rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
