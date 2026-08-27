import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createExternalIntegrationControls } from "./src/external/index.ts";
import { createToolFederation } from "./src/mcp/index.ts";
import { createOfficialMcpAdapter } from "./src/mcp/official-adapter.ts";

async function fixtureServer() {
  const mcp = new McpServer({ name: "phase5-http", version: "1.0.0" });
  mcp.registerTool(
    "lookup",
    {
      description: "HTTP lookup",
      inputSchema: z.object({ query: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => ({
      content: [{ type: "text", text: `found:${query}` }],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);
  let requests = 0;
  const server = createServer(async (incoming, outgoing) => {
    requests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const address = server.address();
    const url = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}${incoming.url ?? "/mcp"}`;
    const body = Buffer.concat(chunks);
    const request = new Request(url, {
      method: incoming.method,
      headers: Object.fromEntries(
        Object.entries(incoming.headers).flatMap(([name, value]) =>
          value === undefined
            ? []
            : [[name, Array.isArray(value) ? value.join(", ") : value]],
        ),
      ),
      ...(body.length > 0 ? { body } : {}),
    });
    const response = await transport.handleRequest(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers)
      outgoing.setHeader(name, value);
    if (!response.body) {
      outgoing.end();
      return;
    }
    Readable.fromWeb(response.body as never).pipe(outgoing);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`;
  return {
    origin,
    requests: () => requests,
    close: async () => {
      await transport.close();
      await mcp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("official MCP Streamable HTTP adapter invokes a mock server through the origin gate", async () => {
  const fixture = await fixtureServer();
  const federation = createToolFederation({
    servers: [
      {
        id: "http",
        transport: {
          kind: "http",
          url: `${fixture.origin}/mcp`,
          allowedOrigins: [fixture.origin],
          allowLoopback: true,
        },
        enabled: true,
        tools: {
          include: ["*"],
          exclude: [],
          effects: { lookup: "network-read" },
        },
      },
    ],
    adapter: createOfficialMcpAdapter({
      authorizeUrl: async (_server, url) =>
        new URL(url).origin === fixture.origin,
    }),
    controls: createExternalIntegrationControls({
      resolveHost: async () => ["127.0.0.1"],
    }),
  });
  try {
    const search = await federation.search({ query: "lookup" });
    assert.equal(search.ok, true, JSON.stringify(search));
    const result = await federation.invoke({
      toolId: "http__lookup",
      arguments: { query: "docs" },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok)
      assert.match(JSON.stringify(result.value.content), /found:docs/);
    assert.equal(fixture.requests() > 0, true);
  } finally {
    await federation.close();
    await fixture.close();
  }
});
