import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createPlatformExtension,
  platformArtifactRoot,
} from "./src/composition.ts";
import { defaultPlatformFlags } from "./src/flags.ts";

const execFileAsync = promisify(execFile);

test("production review artifacts live outside the source repository", () => {
  const repository = "C:\\Users\\Tyler\\.pi\\agent";
  const artifactRoot = platformArtifactRoot(repository);
  const relation = path.relative(repository, artifactRoot);
  assert.equal(
    relation === ".." ||
      relation.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relation),
    true,
  );
});

test("platform composition registers deferred language tools without starting servers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase4-language-"));
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const tools: string[] = [];
    const toolDefinitions = new Map<string, any>();
    let active = ["read"];
    const api = {
      events: createEventBus(),
      on(name: string, handler: (...args: any[]) => unknown) {
        handlers.set(name, handler);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
        toolDefinitions.set(tool.name, tool);
        active.push(tool.name);
      },
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;
    createPlatformExtension({
      agentDir: path.join(root, ".agent"),
      flags: { ...defaultPlatformFlags, languageIntelligence: true },
    })(api);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      { cwd: root, hasUI: false, isProjectTrusted: () => false },
    );
    assert.deepEqual(tools.sort(), [
      "language_tools",
      "lsp_call_hierarchy",
      "lsp_diagnostics",
      "lsp_hover",
      "lsp_navigate",
      "lsp_symbols",
    ]);
    assert.equal(active.includes("read"), true);
    assert.equal(active.includes("language_tools"), true);
    assert.equal(active.includes("lsp_diagnostics"), false);
    const discovered = await toolDefinitions
      .get("language_tools")
      .execute("discovery", { query: "typescript" });
    assert.equal(discovered.details.servers[0]?.id, "typescript");
    assert.equal(active.includes("lsp_diagnostics"), true);
    await handlers.get("session_shutdown")?.({
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("platform composition exposes /review only for a trusted Git project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase4-composition-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const commands: string[] = [];
    const api = {
      events: createEventBus(),
      on(name: string, handler: (...args: any[]) => unknown) {
        handlers.set(name, handler);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
    } as unknown as ExtensionAPI;
    createPlatformExtension({
      agentDir: path.join(root, ".agent"),
      flags: { ...defaultPlatformFlags, review: true },
    })(api);
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      {
        cwd: root,
        hasUI: false,
        isProjectTrusted: () => true,
      },
    );
    assert.deepEqual(commands, ["review"]);
    await handlers.get("session_shutdown")?.({
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
