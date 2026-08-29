import assert from "node:assert/strict";
import test from "node:test";
import { decodeHookActionConfiguration } from "./src/automation/hooks/configuration.ts";

test("named Hook action config decodes exact HTTP and MCP mappings", () => {
  const decoded = decodeHookActionConfiguration({
    http: [
      {
        id: "build-status",
        url: "https://build.example.test/status",
        method: "GET",
        effect: "network-read",
        allowedOrigins: ["https://build.example.test"],
        allowLoopback: false,
        maxResponseBytes: 65536,
      },
    ],
    mcp: [
      {
        id: "github.get_pull",
        serverId: "github",
        toolName: "get_pull",
        federatedToolId: "github__get_pull",
      },
    ],
  });
  assert.deepEqual(decoded.diagnostics, []);
  assert.equal(decoded.http.length, 1);
  assert.equal(decoded.mcp.length, 1);
  assert.equal(decoded.http[0]?.id, "build-status");
  assert.equal(decoded.mcp[0]?.federatedToolId, "github__get_pull");
});

test("named Hook action config rejects raw authority, duplicate IDs, and unsafe URLs", () => {
  const decoded = decodeHookActionConfiguration({
    http: [
      {
        id: "duplicate",
        url: "https://user:secret@example.test/status",
        method: "POST",
        effect: "remote-write",
        allowedOrigins: ["https://example.test"],
        allowLoopback: false,
        headers: { authorization: "raw" },
      },
      {
        id: "duplicate",
        url: "https://example.test/status",
        method: "GET",
        effect: "network-read",
        allowedOrigins: ["https://example.test"],
        allowLoopback: false,
      },
    ],
    mcp: [],
    credentials: { token: "raw" },
  });
  assert.equal(decoded.http.length, 0);
  assert.ok(decoded.diagnostics.length >= 2);
  assert.equal(JSON.stringify(decoded.diagnostics).includes("secret"), false);
  assert.equal(JSON.stringify(decoded.diagnostics).includes("raw"), false);
});

test("project Hook action config may replace only an exact existing named mapping", () => {
  const base = decodeHookActionConfiguration({
    http: [
      {
        id: "build-status",
        url: "https://build.example.test/status",
        method: "GET",
        effect: "network-read",
        allowedOrigins: ["https://build.example.test"],
        allowLoopback: false,
      },
    ],
    mcp: [],
  });
  const project = decodeHookActionConfiguration(
    {
      http: [
        {
          id: "new-project-endpoint",
          url: "https://attacker.example/status",
          method: "POST",
          effect: "remote-write",
          allowedOrigins: ["https://attacker.example"],
          allowLoopback: false,
        },
      ],
      mcp: [],
    },
    { http: base.http, mcp: base.mcp },
    "project",
  );
  assert.deepEqual(project.http, base.http);
  assert.ok(project.diagnostics.some(({ path }) => path.includes("http")));
});
