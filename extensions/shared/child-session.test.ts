import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHILD_EXECUTION_ROLES } from "./execution-role.ts";
import {
  bindChildSessionExtensions,
  canonicalPathKey,
  CHILD_EXCLUDED_EXTENSION_NAMES,
  CHILD_EXCLUDED_TOOL_NAMES,
  childToolPolicy,
  createChildResources,
  normalizeCanonicalPath,
  resolveStandaloneChildProjectContext,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  workspaceContainsWriteTarget,
  type DisposableChildSession,
} from "./child-session.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-child-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("child denylist keeps extension and workflow structured tools available", async () => {
  await withTempDir(async (directory) => {
    let starts = 0;
    let shutdowns = 0;
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const inlineLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            starts++;
          });
          pi.on("session_shutdown", () => {
            shutdowns++;
          });
          for (const name of [
            "fixture_extension_tool",
            ...CHILD_EXCLUDED_TOOL_NAMES,
          ]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await inlineLoader.reload();

    const structuredOutput = defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: "fixture structured result",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.value }],
          details: {},
        };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      resourceLoader: inlineLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [structuredOutput],
      ...childToolPolicy("workflow"),
    });
    await bindChildSessionExtensions(session);

    assert.deepEqual(
      [...CHILD_EXCLUDED_TOOL_NAMES],
      [
        "subagent_spawn",
        "subagent_wait",
        "subagent_cancel",
        "subagent_check",
        "subagent_list",
        "workflow",
        "workspace_list",
        "ask_user",
      ],
    );
    const allTools = new Set(session.getAllTools().map((tool) => tool.name));
    const activeTools = new Set(session.getActiveToolNames());
    assert.equal(starts, 1);
    assert.equal(allTools.has("fixture_extension_tool"), true);
    assert.equal(activeTools.has("fixture_extension_tool"), true);
    assert.equal(allTools.has("structured_output"), true);
    assert.equal(activeTools.has("structured_output"), true);
    for (const denied of CHILD_EXCLUDED_TOOL_NAMES) {
      assert.equal(allTools.has(denied), false, `${denied} should be denied`);
      assert.equal(
        activeTools.has(denied),
        false,
        `${denied} should be inactive`,
      );
    }
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.equal(
        activeTools.has(builtin),
        true,
        `${builtin} should stay active`,
      );
    }

    await Promise.all([
      shutdownAndDisposeChildSession(session),
      shutdownAndDisposeChildSession(session),
    ]);
    assert.equal(shutdowns, 1);
  });
});

test("resource loading gates project extensions but retains global extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    const extensionSource = (name: string) => `
      export default function (pi) {
        pi.registerTool({
          name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
          description: "fixture", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource("global_fixture"),
    );
    await writeFile(
      path.join(cwd, ".pi", "extensions", "project.ts"),
      extensionSource("project_fixture"),
    );

    const untrusted = await createChildResources({
      role: "subagent",
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const untrustedTools = untrusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(untrustedTools.includes("global_fixture"), true);
    assert.equal(untrustedTools.includes("project_fixture"), false);

    const trusted = await createChildResources({
      role: "review",
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const trustedTools = trusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(trustedTools.includes("global_fixture"), true);
    assert.equal(trustedTools.includes("project_fixture"), true);
    assert.equal(untrusted.role, "subagent");
    assert.equal(trusted.role, "review");
  });
});

test("child loading omits parent lifecycle hooks but keeps child-safe extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const parentMarker = path.join(directory, "parent-started");
    const safeMarker = path.join(directory, "safe-started");
    await mkdir(cwd);
    await mkdir(path.join(agentDir, "extensions", "subagents"), {
      recursive: true,
    });
    await mkdir(path.join(agentDir, "extensions", "file-search"), {
      recursive: true,
    });
    const extensionSource = (toolName: string, marker: string) => `
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.on("session_start", () => writeFileSync(${JSON.stringify(marker)}, "started"));
        pi.registerTool({
          name: ${JSON.stringify(toolName)}, label: ${JSON.stringify(toolName)},
          description: "fixture", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "subagents", "index.ts"),
      extensionSource("subagent_spawn", parentMarker),
    );
    await writeFile(
      path.join(agentDir, "extensions", "file-search", "index.ts"),
      extensionSource("child_safe_tool", safeMarker),
    );

    const resources = await createChildResources({
      role: "workflow",
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: resources.loader,
      settingsManager: resources.settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      ...resources.sessionOptions,
    });
    await bindChildSessionExtensions(session);

    assert.equal(existsSync(parentMarker), false);
    assert.equal(existsSync(safeMarker), true);
    assert.equal(
      session.getAllTools().some((tool) => tool.name === "subagent_spawn"),
      false,
    );
    assert.equal(
      session.getActiveToolNames().includes("child_safe_tool"),
      true,
    );
    await shutdownAndDisposeChildSession(session);
  });
});

test("guarded workspace write containment rejects absolute and junction escapes", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const outside = path.join(directory, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    const alias = path.join(workspace, "escape");
    await symlink(
      outside,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      workspaceContainsWriteTarget(workspace, workspace, "inside.txt"),
      true,
    );
    assert.equal(
      workspaceContainsWriteTarget(
        workspace,
        workspace,
        path.join(outside, "x.txt"),
      ),
      false,
    );
    assert.equal(
      workspaceContainsWriteTarget(workspace, workspace, "escape/x.txt"),
      false,
    );
  });
});

test("profile tool restrictions narrow Pi children without restoring orchestration", () => {
  assert.deepEqual(
    childToolPolicy("review", {
      allowedTools: ["read", "rg", "subagent_spawn"],
      disallowedTools: ["bash", "read"],
    }),
    {
      tools: ["read", "rg", "subagent_spawn"],
      excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES, "bash", "read"],
    },
  );
});

test("role profiles retain the child tool contract", () => {
  assert.deepEqual(CHILD_EXCLUDED_EXTENSION_NAMES, [
    "ask-user",
    "copy-all",
    "git-info",
    "model-info",
    "platform",
    "subagents",
    "summaries",
    "ui-customization",
    "workflows",
  ]);
  for (const role of CHILD_EXECUTION_ROLES) {
    assert.deepEqual(childToolPolicy(role), {
      excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES],
    });
  }
});

test("canonical path seam owns Windows display and comparison rules", () => {
  if (process.platform !== "win32") return;
  const extended = "\\\\?\\c:\\Users\\Fixture\\Project";
  assert.equal(normalizeCanonicalPath(extended), "C:/Users/Fixture/Project");
  assert.equal(
    canonicalPathKey(extended),
    canonicalPathKey("C:\\USERS\\FIXTURE\\PROJECT"),
  );
});

test("alternate standalone cwd only uses explicit saved trust", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const childCwd = path.join(directory, "alternate");
    const agentDir = path.join(directory, "agent");
    await mkdir(parentCwd, { recursive: true });
    await mkdir(childCwd, { recursive: true });

    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: parentCwd,
        parentTrusted: true,
        agentDir,
      }),
      true,
    );
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: true,
        agentDir,
      }),
      false,
    );

    const trustStore = new ProjectTrustStore(agentDir);
    trustStore.set(childCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: false,
        agentDir,
      }),
      true,
    );

    const aliasCwd = path.join(directory, "parent-alias");
    await symlink(
      parentCwd,
      aliasCwd,
      process.platform === "win32" ? "junction" : "dir",
    );
    trustStore.set(aliasCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: aliasCwd,
        parentTrusted: false,
        agentDir,
      }),
      false,
      "an alias of the live parent inherits its distrust",
    );
  });
});

test("resolved child context is stable after a junction is retargeted", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const trustedCwd = path.join(directory, "trusted");
    const untrustedCwd = path.join(directory, "untrusted");
    const aliasCwd = path.join(directory, "alias");
    const agentDir = path.join(directory, "agent");
    await Promise.all(
      [parentCwd, trustedCwd, untrustedCwd].map((value) =>
        mkdir(value, { recursive: true }),
      ),
    );
    await symlink(
      trustedCwd,
      aliasCwd,
      process.platform === "win32" ? "junction" : "dir",
    );
    new ProjectTrustStore(agentDir).set(trustedCwd, true);

    const context = resolveStandaloneChildProjectContext({
      parentCwd,
      childCwd: aliasCwd,
      parentTrusted: false,
      agentDir,
    });
    assert.equal(context.projectTrusted, true);
    assert.equal(context.cwd, await realpath(trustedCwd));

    await unlink(aliasCwd);
    await symlink(
      untrustedCwd,
      aliasCwd,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(context.cwd, await realpath(trustedCwd));
    assert.notEqual(context.cwd, await realpath(aliasCwd));
  });
});

test("shutdown helper balances hooks and disposal despite errors", async () => {
  let emits = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event: SessionShutdownEvent) {
        emits++;
        assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
        throw new Error("fixture shutdown failure");
      },
    },
    dispose() {
      disposals++;
    },
  };

  await Promise.all([
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
  ]);
  assert.equal(emits, 1);
  assert.equal(disposals, 1);
});

test("shutdown helper bounds a stuck hook before disposal", async () => {
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: () => new Promise(() => {}),
    },
    dispose() {
      disposals++;
    },
  };

  await shutdownAndDisposeChildSession(session, { timeoutMs: 10 });
  assert.equal(disposals, 1);
});
