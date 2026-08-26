import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageIntelligence } from "./src/language/index.ts";
import { createLanguageCapability } from "./src/wiring/language.ts";

const operationTools = [
  "lsp_diagnostics",
  "lsp_symbols",
  "lsp_navigate",
  "lsp_hover",
  "lsp_call_hierarchy",
];

test("language loader keeps operation tools inactive then adds them without removing peers", async () => {
  const tools = new Map<string, any>();
  let active = ["read", "peer_tool"];
  const language: LanguageIntelligence = {
    discover: async () => ({
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        servers: [
          {
            id: "typescript",
            languages: ["typescript"],
            extensions: [".ts"],
            queries: ["diagnostics", "definition"],
          },
        ],
      },
    }),
    synchronize: async () => ({
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        documents: [],
      },
    }),
    query: async (request) => ({
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        kind: request.kind,
        serverIds: ["typescript"],
        items: [],
        truncated: false,
      },
    }),
  };
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    on() {},
  };
  const capability = createLanguageCapability(pi as never);
  capability.start(language);

  assert.equal(active.includes("language_tools"), true);
  assert.equal(
    operationTools.some((name) => active.includes(name)),
    false,
  );
  const result = await tools
    .get("language_tools")
    .execute("loader", { query: "typescript definitions" });
  assert.equal(result.details.servers[0].id, "typescript");
  assert.equal(active.includes("read"), true);
  assert.equal(active.includes("peer_tool"), true);
  assert.equal(active.includes("lsp_diagnostics"), true);
  assert.equal(active.includes("lsp_navigate"), true);
  assert.equal(active.includes("lsp_symbols"), false);
  assert.equal(active.includes("lsp_hover"), false);
  assert.equal(active.includes("lsp_call_hierarchy"), false);

  await capability.stop();
  assert.equal(
    operationTools.some((name) => active.includes(name)),
    false,
  );
});

test("diagnostics tool synchronizes disk text before advisory query", async () => {
  const tools = new Map<string, any>();
  let active: string[] = [];
  const updates: unknown[] = [];
  const queries: unknown[] = [];
  const language: LanguageIntelligence = {
    discover: async () => ({
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        servers: [],
      },
    }),
    synchronize: async (value) => {
      updates.push(...value);
      return {
        ok: true,
        value: {
          advisory: true,
          authority: "repository-native-checks",
          documents: [],
        },
      };
    },
    query: async (request) => {
      queries.push(request);
      return {
        ok: true,
        value: {
          advisory: true,
          authority: "repository-native-checks",
          kind: request.kind,
          serverIds: ["typescript"],
          items: [],
          truncated: false,
        },
      };
    },
  };
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    on() {},
  };
  const capability = createLanguageCapability(pi as never, {
    readDocument: async () => "const value = 1;\n",
    canonicalizeDocument: async (filePath) => filePath,
  });
  capability.start(language);
  await tools
    .get("lsp_diagnostics")
    .execute("diagnostics", { path: "src/value.ts" }, undefined, undefined, {
      cwd: "C:\\project",
    });

  assert.equal((updates[0] as any).kind, "open");
  assert.match((updates[0] as any).path, /src[\\/]value\.ts$/);
  assert.equal((updates[0] as any).text, "const value = 1;\n");
  assert.equal((queries[0] as any).kind, "diagnostics");
  assert.equal((queries[0] as any).path, (updates[0] as any).path);
  await capability.stop();
});
