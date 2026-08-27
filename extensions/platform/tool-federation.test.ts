import assert from "node:assert/strict";
import test from "node:test";
import { createExternalIntegrationControls } from "./src/external/index.ts";
import {
  createToolFederation,
  type McpConnection,
  type McpServerDefinition,
} from "./src/mcp/index.ts";

function server(id: string): McpServerDefinition {
  return {
    id,
    transport: { kind: "stdio", command: "fixture", args: [] },
    enabled: true,
    tools: {
      include: ["*"],
      exclude: [],
      effects: { lookup: "network-read" },
    },
  };
}

test("ToolFederation stays disconnected until search and namespaces colliding server tools", async () => {
  const connections: string[] = [];
  const closed: string[] = [];
  const federation = createToolFederation({
    servers: [server("alpha"), server("beta")],
    adapter: {
      async connect(definition): Promise<McpConnection> {
        connections.push(definition.id);
        return {
          async listTools() {
            return [
              {
                name: "lookup",
                description: `Lookup from ${definition.id}`,
                inputSchema: {
                  type: "object",
                  properties: {
                    count: { type: "integer" },
                    enabled: { type: "boolean" },
                    tags: { type: "array", items: { type: "string" } },
                  },
                  required: ["count", "enabled", "tags"],
                },
                annotations: { readOnlyHint: true },
              },
            ];
          },
          async callTool() {
            throw new Error("not used");
          },
          async close() {
            closed.push(definition.id);
          },
        };
      },
    },
  });

  assert.deepEqual(federation.status().servers, [
    { id: "alpha", state: "disconnected", toolCount: 0 },
    { id: "beta", state: "disconnected", toolCount: 0 },
  ]);
  assert.deepEqual(connections, []);

  const found = await federation.search({ query: "lookup", limit: 10 });
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.deepEqual(
    found.value.tools.map(({ id, description }) => ({ id, description })),
    [
      { id: "alpha__lookup", description: "Lookup from alpha" },
      { id: "beta__lookup", description: "Lookup from beta" },
    ],
  );
  assert.equal("inputSchema" in found.value.tools[0]!, false);
  assert.deepEqual(connections, ["alpha", "beta"]);

  const activated = await federation.activate(["alpha__lookup"]);
  assert.equal(activated.ok, true);
  if (!activated.ok) return;
  assert.deepEqual(activated.value.tools[0]?.inputSchema, {
    type: "object",
    properties: {
      count: { type: "integer" },
      enabled: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["count", "enabled", "tags"],
  });

  await federation.close();
  assert.deepEqual(closed.sort(), ["alpha", "beta"]);
});

test("ToolFederation preserves native argument types and sanitizes invoked results", async () => {
  const calls: unknown[] = [];
  const federation = createToolFederation({
    servers: [server("typed")],
    controls: createExternalIntegrationControls(),
    context: { actor: "parent", mode: () => "normal" },
    adapter: {
      async connect(): Promise<McpConnection> {
        return {
          async listTools() {
            return [
              {
                name: "lookup",
                description: "Typed lookup",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    count: { type: "integer" },
                    enabled: { type: "boolean" },
                    tags: { type: "array", items: { type: "string" } },
                    nested: { type: "object" },
                  },
                  required: ["count", "enabled", "tags", "nested"],
                },
              },
            ];
          },
          async callTool(request) {
            calls.push(request.arguments);
            return {
              content: [
                {
                  type: "text",
                  text: "ok",
                  access_token: "secret-from-server",
                },
              ],
            };
          },
          async close() {},
        };
      },
    },
  });
  await federation.search({ query: "lookup" });
  const args = {
    count: 3,
    enabled: false,
    tags: ["a", "b"],
    nested: { quoted: 'line\\n"value"' },
  };
  const result = await federation.invoke({
    toolId: "typed__lookup",
    arguments: args,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [args]);
  if (!result.ok) return;
  assert.deepEqual(result.value.content, [
    { type: "text", text: "ok", access_token: "[REDACTED]" },
  ]);
  assert.equal(JSON.stringify(result).includes("secret-from-server"), false);
});

test("ToolFederation treats unclassified tools as protected and plan mode remains authoritative", async () => {
  let calls = 0;
  let mode: "normal" | "plan" = "normal";
  const definition = server("protected");
  const federation = createToolFederation({
    servers: [
      {
        ...definition,
        tools: { include: ["*"], exclude: [] },
      },
    ],
    controls: createExternalIntegrationControls({
      authority: { verify: (token) => token.value === "direct-user" },
    }),
    context: { actor: "parent", mode: () => mode },
    adapter: {
      async connect(): Promise<McpConnection> {
        return {
          async listTools() {
            return [
              {
                name: "mutate",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {},
                },
              },
            ];
          },
          async callTool() {
            calls += 1;
            return { content: [] };
          },
          async close() {},
        };
      },
    },
  });

  const pending = await federation.invoke({
    toolId: "protected__mutate",
    arguments: {},
  });
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.error.code, "approval_required");
  assert.equal(calls, 0);

  const approved = await federation.invoke({
    toolId: "protected__mutate",
    arguments: {},
    authority: {
      kind: "external-user-authority",
      value: "direct-user",
    },
  });
  assert.equal(approved.ok, true);
  assert.equal(calls, 1);

  mode = "plan";
  const denied = await federation.invoke({
    toolId: "protected__mutate",
    arguments: {},
    authority: {
      kind: "external-user-authority",
      value: "direct-user",
    },
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "policy_denied");
  assert.equal(calls, 1);
});

test("ToolFederation applies configured include and exclude patterns before publication", async () => {
  const definition = server("filtered");
  const federation = createToolFederation({
    servers: [
      {
        ...definition,
        tools: {
          include: ["lookup_*", "delete_*"],
          exclude: ["delete_*"],
          effects: { lookup_item: "network-read" },
        },
      },
    ],
    adapter: {
      async connect(): Promise<McpConnection> {
        return {
          async listTools() {
            return ["lookup_item", "delete_item", "unlisted"].map((name) => ({
              name,
              description: name,
              inputSchema: { type: "object", properties: {} },
            }));
          },
          async callTool() {
            return { content: [] };
          },
          async close() {},
        };
      },
    },
  });
  const search = await federation.search({ query: "item", limit: 10 });
  assert.equal(search.ok, true);
  if (!search.ok) return;
  assert.deepEqual(
    search.value.tools.map(({ id }) => id),
    ["filtered__lookup_item"],
  );
  const blocked = await federation.activate(["filtered__delete_item"]);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, "tool_not_found");
});
