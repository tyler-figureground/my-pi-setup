import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { bindPlatformAgentServices } from "../platform/src/agents/services.ts";
import subagentsExtension, { mapGuardedWorkspacePaths } from "./index.ts";
import type { SpawnTask, SubagentSnapshot } from "./src/domain.ts";

function completed(task: SpawnTask): SubagentSnapshot {
  return {
    id: "sa-fixture",
    origin: "model",
    backend: task.profile ? "pi" : "claude",
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    profile: task.profile,
    workspace: task.workspace,
    status: "done",
    createdAt: 1,
    settledAt: 2,
    meta: { backend: "pi" },
    usage: {},
    metered: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "done",
    turns: 1,
  };
}

test("guarded workspace result paths map back to project-relative root", () => {
  const workspace = {
    workspaceId: "workspace-one",
    owner: { sessionId: "session", agentId: "agent" },
    fence: 1,
    expiresAt: 100,
    projectId: "git:fixture",
    projectRoot: "C:\\repo",
    path: "C:\\managed\\workspace-one",
    state: "leased" as const,
    role: "review" as const,
    projectTrusted: true as const,
  };
  assert.equal(
    mapGuardedWorkspacePaths(
      { workspace },
      "Changed C:\\managed\\workspace-one\\src\\index.ts and C:/managed/workspace-one/test.ts",
    ),
    "Changed C:\\repo\\src\\index.ts and C:/repo/test.ts",
  );
});

test("platform-backed isolated profile prepares a guarded workspace before backend spawn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-phase3-wiring-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const eventBus = createEventBus();
    const profile = {
      description: "Isolated reviewer",
      identity: {
        name: "isolated-reviewer",
        contentDigest: "a".repeat(64),
        catalogGeneration: 1,
        source: {
          scope: "user" as const,
          path: path.join(root, "profile.yaml"),
        },
      },
      defaults: { backend: "pi" as const, effort: "high" as const },
      policy: {
        role: "review" as const,
        instructions: ["Review safely."],
        skills: [],
        tools: { allowed: ["read", "write"], denied: [] },
        limits: { timeoutMs: 60_000 },
        workspace: "isolated" as const,
      },
    };
    const workspaceSnapshot = {
      workspaceId: "workspace-one",
      projectId: "git:fixture",
      projectRoot: root,
      path: workspace,
      branch: "pi-agent/workspace-one",
      baseCommit: "a".repeat(40),
      currentCommit: "a".repeat(40),
      state: "leased" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const release = bindPlatformAgentServices(eventBus, {
      profiles: {
        async reload() {
          return { generation: 1, profiles: [profile], diagnostics: [] };
        },
        inspect: () => ({
          generation: 1,
          profiles: [profile],
          diagnostics: [],
        }),
        list: () => [profile],
        resolve: () => ({ ok: true as const, value: profile }),
        diagnostics: () => [],
      },
      workspaces: {
        async recover() {
          return { ok: true as const, value: { recovered: [], blocked: [] } };
        },
        async create() {
          return {
            ok: true as const,
            value: { ...workspaceSnapshot, state: "ready" as const },
          };
        },
        async lease(request) {
          return {
            ok: true as const,
            value: {
              workspaceId: "workspace-one",
              owner: request.owner,
              fence: 1,
              expiresAt: 61_000,
              snapshot: workspaceSnapshot,
            },
          };
        },
        async disposition() {
          return { ok: true as const, value: workspaceSnapshot };
        },
        async integrate() {
          return { ok: true as const, value: workspaceSnapshot };
        },
        async renew() {
          throw new Error("not used");
        },
        async rebind() {
          throw new Error("not used");
        },
        async inspect() {
          return { ok: true as const, value: [] };
        },
      },
    });
    try {
      const tools = new Map<string, ToolDefinition>();
      let observed: SpawnTask | undefined;
      const api = {
        events: eventBus,
        on() {},
        registerTool(tool: ToolDefinition) {
          tools.set(tool.name, tool);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerEntryRenderer() {},
        appendEntry() {},
        getThinkingLevel: () => "medium",
      } as unknown as ExtensionAPI;
      subagentsExtension(api, {
        async spawn(_harness, task) {
          observed = task;
          return completed(task);
        },
      });
      const spawn = tools.get("subagent_spawn");
      assert.ok(spawn);
      await spawn.execute(
        "call-1",
        {
          prompt: "review",
          name: "review",
          profile: "isolated-reviewer",
        } as never,
        undefined,
        undefined,
        {
          cwd: root,
          isProjectTrusted: () => true,
          sessionManager: { getSessionId: () => "parent-session" },
        } as never,
      );
      assert.ok(observed);
      assert.equal(observed.cwd, workspace);
      assert.equal(observed.parent.projectTrusted, true);
      assert.equal(observed.workspace?.workspaceId, "workspace-one");
      assert.equal(observed.workspace?.owner.agentId, "tool-call-1");
      assert.equal(observed.profile?.name, "isolated-reviewer");
    } finally {
      release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
