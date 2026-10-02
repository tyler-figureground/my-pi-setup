// Stand-in for a pi process: connects a stdio MCP server, then dies without
// closing it. Used to prove the server tree does not outlive its host.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOfficialMcpAdapter } from "../src/mcp/official-adapter.ts";

const readyFile = process.env.MCP_JOB_HOST_READY_FILE;
if (!readyFile) throw new Error("MCP_JOB_HOST_READY_FILE is required.");

const connection = await createOfficialMcpAdapter().connect({
  id: "job-host",
  transport: {
    kind: "stdio",
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      fileURLToPath(new URL("./mcp-server.ts", import.meta.url)),
    ],
    env: {
      MCP_FIXTURE_PID_FILE: "${MCP_FIXTURE_PID_FILE}",
      MCP_FIXTURE_GRANDCHILD_PID_FILE: "${MCP_FIXTURE_GRANDCHILD_PID_FILE}",
    },
  },
  enabled: true,
  tools: { include: ["*"], exclude: [] },
});
await connection.listTools();
writeFileSync(readyFile, "ready");
// Abrupt termination: no close(), no exit handlers.
process.kill(process.pid, "SIGKILL");
