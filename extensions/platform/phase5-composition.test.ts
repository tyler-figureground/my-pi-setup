import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { BrowserAdapter } from "./src/browser/index.ts";
import { createPlatformExtension } from "./src/composition.ts";
import { createInMemoryCredentialVault } from "./src/external/credentials.ts";
import { defaultPlatformBrowserConfiguration } from "./src/browser/config.ts";
import { defaultPlatformFlags } from "./src/flags.ts";
import type { McpTransportAdapter } from "./src/mcp/index.ts";

test("platform composition wires MCP and browser lazily without starting external resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-phase5-composition-"));
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const tools = new Map<string, any>();
    const commands: string[] = [];
    let active = ["read"];
    let mcpConnections = 0;
    let browserStarts = 0;
    const mcpAdapter: McpTransportAdapter = {
      async connect() {
        mcpConnections += 1;
        return {
          async listTools() {
            return [
              {
                name: "lookup",
                description: "lookup",
                inputSchema: { type: "object", properties: {} },
              },
            ];
          },
          async callTool() {
            return { content: [] };
          },
          async close() {},
        };
      },
    };
    const browserAdapter: BrowserAdapter = {
      async start() {
        browserStarts += 1;
        return {
          async listPages() {
            return [];
          },
          async openPage(url) {
            return { id: "adapter-page", url, title: "Fixture" };
          },
          async closePage() {},
          async observe() {
            return { kind: "snapshot", text: "button [ref=e1]" };
          },
          async act() {
            return { changed: true };
          },
          async close() {},
        };
      },
    };
    const api = {
      events: createEventBus(),
      on(name: string, handler: (...args: any[]) => unknown) {
        handlers.set(name, handler);
      },
      registerTool(tool: any) {
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      getActiveTools: () => [...active],
      getAllTools: () => [...tools.values()],
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;
    createPlatformExtension({
      agentDir: path.join(root, ".agent"),
      flags: {
        ...defaultPlatformFlags,
        mcp: true,
        browser: true,
      },
      mcpServers: [
        {
          id: "fixture",
          transport: { kind: "stdio", command: "fixture", args: [] },
          enabled: true,
          tools: {
            include: ["*"],
            exclude: [],
            effects: { lookup: "network-read" },
          },
        },
      ],
      browser: {
        ...defaultPlatformBrowserConfiguration,
        executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        allowedOrigins: ["http://127.0.0.1:4173"],
        allowLoopback: true,
      },
      mcpAdapter,
      browserAdapter,
      credentialVault: createInMemoryCredentialVault(),
    })(api);

    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      { cwd: root, hasUI: false, isProjectTrusted: () => false },
    );
    assert.equal(tools.has("mcp_tools"), true);
    assert.equal(tools.has("browser_action"), true);
    assert.deepEqual(commands.sort(), ["browser", "mcp"]);
    assert.equal(mcpConnections, 0);
    assert.equal(browserStarts, 0);

    await tools.get("mcp_tools").execute("search", {
      query: "lookup",
      limit: 5,
    });
    assert.equal(mcpConnections, 1);
    await tools.get("browser_action").execute("open", {
      kind: "open",
      url: "http://127.0.0.1:4173/",
    });
    assert.equal(browserStarts, 1);

    await handlers.get("session_shutdown")?.({
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
