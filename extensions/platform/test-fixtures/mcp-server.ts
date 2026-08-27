import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.env.MCP_FIXTURE_PID_FILE)
  writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));

const server = new McpServer({ name: "phase5-fixture", version: "1.0.0" });
server.registerTool(
  "echo_native",
  {
    description: "Echo native argument types",
    inputSchema: z.object({
      count: z.number().int(),
      enabled: z.boolean(),
      tags: z.array(z.string()),
      nested: z.object({ quoted: z.string() }),
    }),
    annotations: { readOnlyHint: true },
  },
  async (arguments_) => ({
    content: [{ type: "text", text: JSON.stringify(arguments_) }],
    structuredContent: arguments_,
  }),
);
await server.connect(new StdioServerTransport());
