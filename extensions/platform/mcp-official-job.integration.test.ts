import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { officialMcpAdapterTestSeams } from "./src/mcp/official-adapter.ts";

const { OwnedStdioClientTransport } = officialMcpAdapterTestSeams;

// Job objects are the Windows process-tree mechanism; POSIX uses process
// groups and has no equivalent code path here.
const windowsOnly = process.platform !== "win32" && "Windows job objects only";

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`${label} process ${pid} remained alive`);
}

test(
  "a stdio server that cannot join a Windows job is refused and stopped",
  { skip: windowsOnly },
  async () => {
    let assignedPid: number | undefined;
    const transport = new OwnedStdioClientTransport(
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        stderr: "pipe",
      },
      async () => ({
        assign(pid) {
          assignedPid = pid;
          throw new Error("AssignProcessToJobObject failed (injected).");
        },
        terminate() {},
        close() {},
      }),
    );
    try {
      await assert.rejects(
        transport.start(),
        /could not join a Windows job object: AssignProcessToJobObject failed \(injected\)/,
      );
      assert.equal(transport.ownsProcessTree, false);
      assert.ok(assignedPid, "job assignment was attempted");
      await waitForExit(assignedPid, "refused server");
    } finally {
      if (assignedPid && processExists(assignedPid)) {
        try {
          process.kill(assignedPid, "SIGKILL");
        } catch {}
      }
    }
  },
);

test(
  "a stdio server tree does not outlive a crashed host",
  { skip: windowsOnly },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-mcp-job-host-"));
    const files = {
      server: path.join(root, "server.pid"),
      grandchild: path.join(root, "grandchild.pid"),
      ready: path.join(root, "ready"),
    };
    let pids: number[] = [];
    try {
      const host = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(
            new URL("./test-fixtures/mcp-job-host.ts", import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            MCP_FIXTURE_PID_FILE: files.server,
            MCP_FIXTURE_GRANDCHILD_PID_FILE: files.grandchild,
            MCP_JOB_HOST_READY_FILE: files.ready,
          },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      host.stderr.setEncoding("utf8");
      host.stderr.on("data", (chunk) => (stderr += chunk));
      await new Promise<void>((resolve) => host.once("close", () => resolve()));
      assert.equal(existsSync(files.ready), true, `host failed: ${stderr}`);
      pids = [
        Number.parseInt(await readFile(files.server, "utf8"), 10),
        // Spawned detached, so libuv's own job does not cover it.
        Number.parseInt(await readFile(files.grandchild, "utf8"), 10),
      ];
      await waitForExit(pids[0]!, "orphaned server");
      await waitForExit(pids[1]!, "orphaned grandchild");
    } finally {
      for (const pid of pids) {
        if (processExists(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
