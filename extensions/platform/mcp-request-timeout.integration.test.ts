import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createExternalIntegrationControls } from "./src/external/index.ts";
import { decodeMcpServers } from "./src/mcp/config.ts";
import { createToolFederation } from "./src/mcp/index.ts";
import { createOfficialMcpAdapter } from "./src/mcp/official-adapter.ts";

const fixture = fileURLToPath(
  new URL("./test-fixtures/mcp-server.ts", import.meta.url),
);

function federation(requestTimeoutMs?: number) {
  return createToolFederation({
    servers: [
      {
        id: "slow",
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: ["--experimental-strip-types", fixture],
        },
        enabled: true,
        ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
        tools: {
          include: ["sleep_then_reply"],
          exclude: [],
          effects: { sleep_then_reply: "network-read" },
        },
      },
    ],
    adapter: createOfficialMcpAdapter(),
    controls: createExternalIntegrationControls(),
    context: { actor: "parent", mode: () => "normal" },
  });
}

async function sleepCall(requestTimeoutMs: number, ms: number) {
  const tools = federation(requestTimeoutMs);
  try {
    const found = await tools.search({ query: "wait reply", limit: 5 });
    assert.equal(found.ok, true, JSON.stringify(found));
    return await tools.invoke({
      toolId: "slow__sleep_then_reply",
      arguments: { ms },
    });
  } finally {
    await tools.close();
  }
}

test("a server's requestTimeoutMs bounds tool calls below the default", async () => {
  const result = await sleepCall(1_000, 2_500);
  assert.equal(result.ok, false, JSON.stringify(result));
});

test("a server's requestTimeoutMs admits calls the budget covers", async () => {
  const result = await sleepCall(5_000, 2_500);
  assert.equal(result.ok, true, JSON.stringify(result));
});

const source = { path: "platform.json", scope: "project" as const };

function server(extra: Record<string, unknown>) {
  return {
    id: "slow",
    transport: { kind: "stdio", command: "node", args: [] },
    tools: { include: ["*"], exclude: [] },
    ...extra,
  };
}

test("requestTimeoutSeconds decodes to requestTimeoutMs", () => {
  const decoded = decodeMcpServers(
    [server({ requestTimeoutSeconds: 900 })],
    [],
    source,
  );
  assert.equal(decoded.servers[0]?.requestTimeoutMs, 900_000);
});

test("omitted requestTimeoutSeconds keeps the adapter default", () => {
  const decoded = decodeMcpServers([server({})], [], source);
  assert.equal(decoded.servers[0]?.requestTimeoutMs, undefined);
});

for (const bad of [0, -5, 1.5, 3601, "900", null]) {
  test(`requestTimeoutSeconds ${JSON.stringify(bad)} is rejected`, () => {
    const decoded = decodeMcpServers(
      [server({ requestTimeoutSeconds: bad })],
      [],
      source,
    );
    assert.equal(decoded.servers.length, 0);
    assert.ok(decoded.diagnostics.length > 0);
  });
}
