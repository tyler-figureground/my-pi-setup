import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserControl } from "./src/browser/index.ts";
import { createBrowserCapability } from "./src/wiring/browser.ts";

test("browser wiring exposes bounded tools, direct approval retry, status, and cleanup", async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let active = ["read", "peer_tool"];
  const actions: unknown[] = [];
  let closed = 0;
  const browser: BrowserControl = {
    status: () => ({
      state: "ready",
      profileDirectory: "<private>",
      pageCount: 1,
    }),
    pages: async () => [
      { id: "page-1", url: "https://example.test/", title: "Example" },
    ],
    observe: async (request) => ({
      ok: true,
      value: {
        kind: request.kind,
        preview: "button Submit [ref=e1]",
        truncated: false,
        artifactId: "a".repeat(64),
      },
    }),
    act: async (request) => {
      actions.push(request);
      if (request.kind === "click" && !request.authority)
        return {
          ok: false,
          error: {
            code: "approval_required",
            message: "approval required",
            retryable: false,
          },
        };
      return {
        ok: true,
        value: {
          page: {
            id: "page-1",
            url: "https://example.test/",
            title: "Example",
          },
        },
      };
    },
    close: async () => {
      closed += 1;
    },
  };
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };
  const capability = createBrowserCapability(pi as never, {
    issueAuthority: () => ({
      kind: "external-user-authority",
      value: "host-only",
    }),
  });
  capability.start(browser);

  assert.equal(tools.has("browser_pages"), true);
  assert.equal(tools.has("browser_action"), true);
  assert.equal(tools.has("browser_observe"), true);
  assert.equal(commands.has("browser"), true);
  const result = await tools
    .get("browser_action")
    .execute(
      "click",
      { kind: "click", pageId: "page-1", ref: "e1" },
      undefined,
      undefined,
      {
        hasUI: true,
        ui: { confirm: async () => true },
      },
    );
  assert.equal(result.details.page.id, "page-1");
  assert.equal(actions.length, 2);
  assert.equal((actions[1] as any).authority.value, "host-only");

  await capability.stop();
  assert.equal(closed, 1);
  assert.equal(active.includes("browser_action"), false);
  assert.equal(active.includes("read"), true);
  assert.equal(active.includes("peer_tool"), true);
});
