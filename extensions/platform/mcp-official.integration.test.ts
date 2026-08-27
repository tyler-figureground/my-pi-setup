import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExternalIntegrationControls } from "./src/external/index.ts";
import { createToolFederation } from "./src/mcp/index.ts";
import { createOfficialMcpAdapter } from "./src/mcp/official-adapter.ts";

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, label = "fixture") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`MCP ${label} process ${pid} remained alive`);
}

test("official MCP STDIO adapter preserves native arguments and closes its process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-mcp-official-"));
  const pidFile = path.join(root, "server.pid");
  const grandchildPidFile = path.join(root, "grandchild.pid");
  const fixture = fileURLToPath(
    new URL("./test-fixtures/mcp-server.ts", import.meta.url),
  );
  const priorPidFile = process.env.MCP_FIXTURE_PID_FILE;
  const priorGrandchildPidFile = process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE;
  process.env.MCP_FIXTURE_PID_FILE = pidFile;
  process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE = grandchildPidFile;
  const federation = createToolFederation({
    servers: [
      {
        id: "fixture",
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: ["--experimental-strip-types", fixture],
          env: {
            MCP_FIXTURE_PID_FILE: "${MCP_FIXTURE_PID_FILE}",
            MCP_FIXTURE_GRANDCHILD_PID_FILE:
              "${MCP_FIXTURE_GRANDCHILD_PID_FILE}",
          },
        },
        enabled: true,
        tools: {
          include: ["*"],
          exclude: [],
          effects: { echo_native: "network-read" },
        },
      },
    ],
    adapter: createOfficialMcpAdapter(),
    controls: createExternalIntegrationControls(),
    context: { actor: "parent", mode: () => "normal" },
  });
  let pid: number | undefined;
  let grandchildPid: number | undefined;
  try {
    const found = await federation.search({
      query: "native argument",
      limit: 5,
    });
    assert.equal(found.ok, true, JSON.stringify(found));
    if (!found.ok) return;
    assert.equal(found.value.tools[0]?.id, "fixture__echo_native");
    const arguments_ = {
      count: 7,
      enabled: false,
      tags: ["one", "two"],
      nested: { quoted: 'line\\n"quoted"' },
    };
    const invoked = await federation.invoke({
      toolId: "fixture__echo_native",
      arguments: arguments_,
    });
    assert.equal(invoked.ok, true, JSON.stringify(invoked));
    if (!invoked.ok) return;
    assert.deepEqual(invoked.value.structuredContent, arguments_);
    assert.equal(existsSync(pidFile), true);
    pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    grandchildPid = Number.parseInt(
      await readFile(grandchildPidFile, "utf8"),
      10,
    );
    assert.equal(processExists(pid), true);
    assert.equal(processExists(grandchildPid), true);
    await federation.close();
    await waitForExit(pid);
    await waitForExit(grandchildPid);
  } finally {
    await federation.close().catch(() => undefined);
    for (const processId of [pid, grandchildPid]) {
      if (processId && processExists(processId)) {
        try {
          process.kill(processId, "SIGKILL");
        } catch {}
      }
    }
    if (priorPidFile === undefined) delete process.env.MCP_FIXTURE_PID_FILE;
    else process.env.MCP_FIXTURE_PID_FILE = priorPidFile;
    if (priorGrandchildPidFile === undefined)
      delete process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE;
    else process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE = priorGrandchildPidFile;
    await rm(root, { recursive: true, force: true });
  }
});

test("official MCP STDIO adapter cleans the full process tree after aborted connect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-mcp-abort-"));
  const pidFile = path.join(root, "server.pid");
  const grandchildPidFile = path.join(root, "grandchild.pid");
  const fixture = fileURLToPath(
    new URL("./test-fixtures/mcp-server.ts", import.meta.url),
  );
  const prior = {
    pid: process.env.MCP_FIXTURE_PID_FILE,
    grandchild: process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE,
    hang: process.env.MCP_FIXTURE_HANG,
  };
  process.env.MCP_FIXTURE_PID_FILE = pidFile;
  process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE = grandchildPidFile;
  process.env.MCP_FIXTURE_HANG = "1";
  let pids: number[] = [];
  try {
    await assert.rejects(() =>
      createOfficialMcpAdapter().connect(
        {
          id: "aborted",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: ["--experimental-strip-types", fixture],
            env: {
              MCP_FIXTURE_PID_FILE: "${MCP_FIXTURE_PID_FILE}",
              MCP_FIXTURE_GRANDCHILD_PID_FILE:
                "${MCP_FIXTURE_GRANDCHILD_PID_FILE}",
              MCP_FIXTURE_HANG: "${MCP_FIXTURE_HANG}",
            },
          },
          enabled: true,
          tools: { include: ["*"], exclude: [] },
        },
        AbortSignal.timeout(500),
      ),
    );
    pids = [
      Number.parseInt(await readFile(pidFile, "utf8"), 10),
      Number.parseInt(await readFile(grandchildPidFile, "utf8"), 10),
    ];
    await waitForExit(pids[0]!, "aborted root");
    await waitForExit(pids[1]!, "aborted grandchild");
  } finally {
    if (prior.pid === undefined) delete process.env.MCP_FIXTURE_PID_FILE;
    else process.env.MCP_FIXTURE_PID_FILE = prior.pid;
    if (prior.grandchild === undefined)
      delete process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE;
    else process.env.MCP_FIXTURE_GRANDCHILD_PID_FILE = prior.grandchild;
    if (prior.hang === undefined) delete process.env.MCP_FIXTURE_HANG;
    else process.env.MCP_FIXTURE_HANG = prior.hang;
    for (const pid of pids) {
      if (processExists(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
