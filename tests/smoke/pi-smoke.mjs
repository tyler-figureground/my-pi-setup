import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cli = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const fixture = path.join(
  root,
  "tests",
  "smoke",
  "fixtures",
  "lifecycle-extension.ts",
);
const publicToolContract = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests", "smoke", "fixtures", "public-tool-contract.json"),
    "utf8",
  ),
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-phase-0-smoke-"));
const agentDir = path.join(tempRoot, "agent");
const logPath = path.join(tempRoot, "lifecycle.jsonl");
fs.mkdirSync(agentDir, { recursive: true });

const commonArgs = [
  cli,
  "--offline",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--extension",
  fixture,
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-approve",
];
const baseEnv = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_SMOKE_LOG: logPath,
};

function startPi(extraArgs, token) {
  return spawn(
    process.execPath,
    [...commonArgs, "--name", token, ...extraArgs],
    {
      cwd: root,
      env: baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

function waitForExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Pi smoke process timed out. stderr:\n${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runPi(extraArgs, token) {
  const child = startPi(extraArgs, token);
  child.stdin.end();
  return waitForExit(child);
}

function readLog() {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function matchingProcesses(token) {
  if (process.platform === "win32") {
    const escaped = token.replaceAll("'", "''");
    const script = `$token='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $token + '*') } | ForEach-Object { $_.ProcessId }`;
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const result = await waitForExit(child, 10_000);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  const child = spawn("ps", ["-eo", "pid=,args="], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await waitForExit(child, 10_000);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout
    .split("\n")
    .filter((line) => line.includes(token))
    .map((line) => line.trim().split(/\s+/, 1)[0]);
}

async function assertNoLeak(token) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await matchingProcesses(token)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(
    await matchingProcesses(token),
    [],
    `process leak for ${token}`,
  );
}

function createJsonlReader(stream) {
  let buffer = "";
  const records = [];
  const waiters = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      const record = JSON.parse(line);
      records.push(record);
      for (const waiter of [...waiters]) waiter(record);
    }
  });
  return {
    records,
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = records.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const onRecord = (record) => {
          if (!predicate(record)) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(onRecord), 1);
          resolve(record);
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(onRecord), 1);
          reject(new Error("Timed out waiting for RPC record"));
        }, timeoutMs);
        waiters.push(onRecord);
      });
    },
  };
}

async function smokeRepositoryExtensions() {
  const token = `pi-smoke-extensions-${process.pid}-${Date.now()}`;
  const before = readLog().length;
  const child = spawn(
    process.execPath,
    [
      cli,
      "--offline",
      "--no-session",
      "--extension",
      fixture,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--name",
      token,
      "--print",
    ],
    {
      cwd: tempRoot,
      env: { ...baseEnv, PI_CODING_AGENT_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin.end();
  const result = await waitForExit(child, 60_000);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stderr,
    "",
    "repository extensions load without diagnostics",
  );

  const events = readLog().slice(before);
  const start = events.find((event) => event.event === "session_start");
  assert.ok(start, "repository extension session started");
  const surface = events.find(
    (event) =>
      event.event === "resources_discover" && event.reason === "startup",
  );
  assert.ok(surface, "repository extension discovery completed");
  for (const tool of [
    "ask_user",
    "search",
    "scrape",
    "crawl",
    "fd",
    "rg",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_list_files",
    "bg_start",
    "bg_status",
    "bg_list",
    "bg_kill",
    "subagent_spawn",
    "subagent_check",
    "subagent_list",
    "subagent_cancel",
    "subagent_wait",
    "workflow",
  ]) {
    assert.ok(
      surface.tools.includes(tool),
      `registered tool ${tool}; saw ${surface.tools.join(", ")}`,
    );
  }
  const actualToolContract = surface.toolContracts
    .filter(
      (contract) =>
        contract.source !== "builtin" && contract.name !== "smoke_probe",
    )
    .map(({ name, parameters }) => ({ name, parameters }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(
    actualToolContract,
    publicToolContract,
    "public tool names and parameter schemas remain compatible",
  );

  for (const command of [
    "ps",
    "copy-all",
    "lg",
    "pr",
    "btw",
    "subagents",
    "summary-model",
    "workflows",
    "plan",
    "rules",
    "hooks",
  ]) {
    assert.ok(
      surface.commands.includes(command),
      `registered command ${command}`,
    );
  }
  await assertNoLeak(token);
}

async function smokePlatformRpc() {
  const token = `pi-smoke-platform-rpc-${process.pid}-${Date.now()}`;
  const child = spawn(
    process.execPath,
    [
      cli,
      "--offline",
      "--no-session",
      "--extension",
      fixture,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
      "--name",
      token,
      "--mode",
      "rpc",
    ],
    {
      cwd: tempRoot,
      env: { ...baseEnv, PI_CODING_AGENT_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const reader = createJsonlReader(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);

  send({ id: "commands", type: "get_commands" });
  const commands = await reader.waitFor(
    (record) => record.id === "commands",
    60_000,
  );
  assert.equal(commands.success, true);
  for (const name of ["plan", "rules", "hooks"]) {
    assert.ok(
      commands.data.commands.some((command) => command.name === name),
      `platform RPC command ${name}`,
    );
  }

  for (const [id, message] of [
    ["plan-status", "/plan status"],
    ["rules", "/rules"],
    ["hooks", "/hooks validate"],
  ]) {
    send({ id, type: "prompt", message });
    const response = await reader.waitFor((record) => record.id === id);
    assert.equal(
      response.success,
      true,
      `${message}: ${JSON.stringify(response)}`,
    );
  }

  send({ id: "exit", type: "prompt", message: "/smoke-exit" });
  const exitResponse = await reader.waitFor((record) => record.id === "exit");
  assert.equal(exitResponse.success, true);
  child.stdin.end();
  const result = await waitForExit(child, 60_000);
  assert.equal(result.code, 0, stderr || result.stderr);
  await assertNoLeak(token);
}

async function smokePrint() {
  const token = `pi-smoke-print-${process.pid}-${Date.now()}`;
  const result = await runPi(["--print", "/smoke-exit"], token);
  assert.equal(result.code, 0, result.stderr);
  await assertNoLeak(token);
}

async function smokeJson() {
  const token = `pi-smoke-json-${process.pid}-${Date.now()}`;
  const result = await runPi(["--mode", "json", "/smoke-exit"], token);
  assert.equal(result.code, 0, result.stderr);
  const records = result.stdout.split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(records[0]?.type, "session");
  await assertNoLeak(token);
}

async function smokeRpc() {
  const token = `pi-smoke-rpc-${process.pid}-${Date.now()}`;
  const child = startPi(["--mode", "rpc"], token);
  const reader = createJsonlReader(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);

  send({ id: "state", type: "get_state" });
  const state = await reader.waitFor((record) => record.id === "state");
  assert.equal(state.success, true);

  send({ id: "reload", type: "prompt", message: "/smoke-reload" });
  const reload = await reader.waitFor((record) => record.id === "reload");
  assert.equal(reload.success, true);

  send({ id: "commands", type: "get_commands" });
  const commands = await reader.waitFor((record) => record.id === "commands");
  assert.equal(commands.success, true);
  assert.ok(
    commands.data.commands.some((command) => command.name === "smoke-exit"),
    "extension commands survive reload",
  );

  send({ id: "exit", type: "prompt", message: "/smoke-exit" });
  const exitResponse = await reader.waitFor((record) => record.id === "exit");
  assert.equal(exitResponse.success, true);
  child.stdin.end();
  const result = await waitForExit(child);
  assert.equal(result.code, 0, stderr || result.stderr);
  await assertNoLeak(token);
}

try {
  await smokeRepositoryExtensions();
  await smokePlatformRpc();
  await smokePrint();
  await smokeJson();
  await smokeRpc();

  const events = readLog();
  for (const mode of ["print", "json", "rpc"]) {
    assert.ok(
      events.some(
        (event) => event.event === "session_start" && event.mode === mode,
      ),
      `${mode} session started`,
    );
    assert.ok(
      events.some(
        (event) => event.event === "session_shutdown" && event.mode === mode,
      ),
      `${mode} session shut down`,
    );
  }
  assert.ok(
    events.some(
      (event) =>
        event.event === "session_shutdown" && event.reason === "reload",
    ),
    "reload shuts down old runtime",
  );
  assert.ok(
    events.some(
      (event) => event.event === "session_start" && event.reason === "reload",
    ),
    "reload starts new runtime",
  );

  console.log(
    "Pi smoke passed: repository extensions, print, JSON, RPC, reload, shutdown, no leaks.",
  );
} finally {
  fs.rmSync(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
