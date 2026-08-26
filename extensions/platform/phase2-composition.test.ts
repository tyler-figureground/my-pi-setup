import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createPlatformExtension } from "./index.ts";

const execFileAsync = promisify(execFile);

function createHarness() {
  const handlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const commands = new Map<
    string,
    { handler: (args: string, context: any) => Promise<void> }
  >();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  const userMessages: any[] = [];
  const notifications: string[] = [];
  const execCalls: unknown[][] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, unknown>();
  let activeTools = ["read", "bash", "edit", "write", "rg", "fd"];
  const seed = (name: string, source: string) =>
    tools.set(name, {
      name,
      description: name,
      parameters: {},
      sourceInfo: {
        path: source === "builtin" ? `<builtin:${name}>` : `<fixture:${name}>`,
        source,
        scope: "user",
        origin: "top-level",
      },
    });
  for (const name of ["read", "bash", "edit", "write"]) seed(name, "builtin");
  for (const name of ["rg", "fd"]) seed(name, "file-search");

  const api = {
    events: createEventBus(),
    on(event: string, handler: (event: any, context: any) => unknown) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerTool(tool: any) {
      tools.set(tool.name, {
        ...tool,
        sourceInfo: {
          path: "<platform>",
          source: "platform",
          scope: "user",
          origin: "top-level",
        },
      });
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...tools.values()],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      const parentId = entries.at(-1)?.id ?? null;
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId,
        customType,
        data,
      });
    },
    sendMessage(message: unknown, options?: unknown) {
      messages.push({ message, options });
    },
    sendUserMessage(content: unknown, options?: unknown) {
      userMessages.push({ content, options });
    },
    exec: async (...args: unknown[]) => {
      execCalls.push(args);
      return {
        stdout: "x".repeat(100),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI;

  const context = {
    cwd: "",
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    sessionManager: {
      getEntries: () => [...entries],
      getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionId: () => "phase-2-session",
    },
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      notify: (message: string) => notifications.push(message),
      setStatus: (key: string, value: string | undefined) =>
        statuses.set(key, value),
      setWidget: (key: string, value: unknown) => widgets.set(key, value),
      confirm: async () => false,
      editor: async () => undefined,
    },
  };

  async function emit(event: string, value: any): Promise<any[]> {
    const results = [];
    for (const handler of [...(handlers.get(event) ?? [])]) {
      results.push(await handler(value, context));
    }
    return results;
  }

  return {
    api,
    context,
    handlers,
    commands,
    tools,
    entries,
    messages,
    userMessages,
    notifications,
    execCalls,
    statuses,
    widgets,
    activeTools: () => [...activeTools],
    emit,
  };
}

const rule = `---
id: source-rule
include: ["src/**/*.ts"]
priority: 10
---
Use the source module interface; do not reach into internals.
`;

const docsRule = `---
id: docs-rule
include: ["docs/**/*.md"]
---
Use concise public documentation language.
`;

const hooks = `version: 1
hooks:
  - id: planning-context
    event: before_agent_start
    priority: 0
    match: {}
    action:
      type: context
      content: Trusted hook context.
    timeoutMs: 100
    outputCapBytes: 1024
    failurePolicy: open
  - id: command-on-start
    event: agent_start
    priority: 0
    match: {}
    action:
      type: command
      executable: git
      args: [--version]
    timeoutMs: 100
    outputCapBytes: 16
    failurePolicy: open
  - id: status-on-start
    event: agent_start
    priority: 1
    match: {}
    action:
      type: status
      key: lifecycle
      text: started
    timeoutMs: 100
    outputCapBytes: 16
    failurePolicy: open
  - id: shutdown-command
    event: session_shutdown
    priority: 0
    match: {}
    action:
      type: command
      executable: node
      args: [-e, __SHUTDOWN_SCRIPT__]
    timeoutMs: 1000
    outputCapBytes: 1024
    failurePolicy: open
  - id: block-write
    event: tool_call
    priority: 0
    match:
      toolName: write
    action:
      type: policy
      decision: deny
      reason: Hook blocks write.
    timeoutMs: 100
    outputCapBytes: 1024
    failurePolicy: closed
`;

test("platform wiring composes plan mode, lazy rules, hooks, persistence, trust, and UI", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-phase2-wiring-"));
  const agentDir = path.join(directory, "agent");
  const project = path.join(directory, "project");
  await mkdir(path.join(agentDir, "rules"), { recursive: true });
  await mkdir(path.join(project, ".pi", "rules"), { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "docs"), { recursive: true });
  const shutdownMarker = path.join(directory, "shutdown-hook-ran");
  const shutdownScript = `require("node:fs").writeFileSync(${JSON.stringify(shutdownMarker)}, "ran")`;
  await writeFile(
    path.join(agentDir, "hooks.yaml"),
    hooks.replace("__SHUTDOWN_SCRIPT__", JSON.stringify(shutdownScript)),
  );
  await writeFile(path.join(agentDir, "rules", "source.md"), rule);
  await writeFile(path.join(agentDir, "rules", "docs.md"), docsRule);
  await writeFile(path.join(project, "src", "index.ts"), "export {}\n");
  await writeFile(path.join(project, "docs", "guide.md"), "# Guide\n");
  await execFileAsync("git", ["init"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "phase2@example.test"], {
    cwd: project,
  });
  await execFileAsync("git", ["config", "user.name", "Phase 2"], {
    cwd: project,
  });
  await execFileAsync("git", ["add", "src/index.ts"], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: project });
  await writeFile(
    path.join(project, "src", "index.ts"),
    "export const changed = true;\n",
  );
  const externalMarker = path.join(directory, "external-diff-ran");
  const externalScript = path.join(directory, "external-diff.cjs");
  await writeFile(
    externalScript,
    `require("node:fs").writeFileSync(${JSON.stringify(externalMarker)}, "ran")`,
  );
  await execFileAsync(
    "git",
    [
      "config",
      "diff.external",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(externalScript)}`,
    ],
    { cwd: project },
  );

  try {
    const harness = createHarness();
    harness.context.cwd = project;
    createPlatformExtension({
      agentDir,
      flags: { planMode: true, hooks: true, rules: true },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual([...harness.commands.keys()].sort(), [
      "hooks",
      "plan",
      "rules",
    ]);
    const headless = { ...harness.context, hasUI: false };
    await assert.rejects(
      () => harness.commands.get("plan")!.handler("status", headless),
      /TUI or RPC/,
    );
    await assert.rejects(
      () => harness.commands.get("rules")!.handler("", headless),
      /TUI or RPC/,
    );
    await assert.rejects(
      () => harness.commands.get("hooks")!.handler("", headless),
      /TUI or RPC/,
    );

    for (const name of [
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_list_files",
    ]) {
      assert.ok(harness.tools.has(name), name);
      assert.equal(harness.activeTools().includes(name), false, name);
    }
    const gitResult = await harness.tools
      .get("git_diff")
      ?.execute(
        "git-diff-test",
        { path: "src/index.ts" },
        new AbortController().signal,
        undefined,
        harness.context,
      );
    const gitArgs = gitResult.details.args as string[];
    assert.ok(gitArgs.includes("--no-optional-locks"));
    assert.ok(gitArgs.includes("core.fsmonitor=false"));
    assert.ok(gitArgs.includes("diff.external="));
    assert.ok(gitArgs.includes("--no-ext-diff"));
    assert.ok(gitArgs.includes("--no-textconv"));
    await assert.rejects(access(externalMarker));
    await harness.emit("agent_start", { type: "agent_start" });
    assert.equal(harness.execCalls.length, 0);
    assert.equal(harness.statuses.get("platform-hook:lifecycle"), "started");

    await harness.commands
      .get("plan")
      ?.handler("Inspect src/index.ts", harness.context);
    assert.deepEqual(harness.activeTools(), [
      "read",
      "rg",
      "fd",
      "git_status",
      "git_diff",
      "git_log",
      "git_show",
      "git_list_files",
    ]);
    assert.equal(harness.userMessages.length, 1);
    assert.equal(harness.entries.at(-1)?.data.state, "planning");
    assert.match(harness.statuses.get("platform-plan") ?? "", /planning/i);

    const originalGitStatus = harness.tools.get("git_status");
    harness.tools.set("git_status", {
      ...originalGitStatus,
      sourceInfo: {
        ...originalGitStatus.sourceInfo,
        path: "<malicious-override>",
        source: "malicious-extension",
      },
    });
    const overriddenGit = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "overridden-git",
      toolName: "git_status",
      input: {},
    });
    assert.ok(
      overriddenGit.some(
        (result) =>
          result?.block === true && /identity changed/.test(result.reason),
      ),
    );
    harness.tools.set("git_status", originalGitStatus);

    const before = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Inspect src/index.ts",
      systemPrompt: "base",
      systemPromptOptions: {},
    });
    assert.ok(
      before.some((result) =>
        String(result?.systemPrompt ?? "").includes("Trusted hook context"),
      ),
    );
    assert.ok(
      before.some((result) =>
        String(result?.systemPrompt ?? "").includes("PLAN MODE"),
      ),
    );
    assert.ok(
      before.some((result) =>
        String(result?.systemPrompt ?? "").includes("source module interface"),
      ),
    );

    await harness.emit("agent_start", { type: "agent_start" });
    assert.equal(
      harness.execCalls.length,
      0,
      "plan mode must suppress hook command effects",
    );

    const denied = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "write-1",
      toolName: "write",
      input: { path: "src/index.ts", content: "mutated" },
    });
    assert.ok(denied.some((result) => result?.block === true));

    const readResults = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "src/index.ts" },
    });
    assert.equal(
      readResults.some((result) => result?.block === true),
      false,
    );

    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "read-docs",
      toolName: "read",
      input: { path: "docs/guide.md" },
    });
    const lazyRuleMessage = harness.messages.at(-1)?.message;
    assert.match(String(lazyRuleMessage?.content ?? ""), /concise public/);
    const currentContext = await harness.emit("context", {
      type: "context",
      messages: [lazyRuleMessage],
    });
    assert.ok(
      currentContext.some((result) =>
        result?.messages?.includes(lazyRuleMessage),
      ),
    );
    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "New unrelated request",
      systemPrompt: "base",
      systemPromptOptions: {},
    });
    const nextContext = await harness.emit("context", {
      type: "context",
      messages: [lazyRuleMessage],
    });
    assert.ok(
      nextContext.some(
        (result) => !result?.messages?.includes(lazyRuleMessage),
      ),
      "stale lazy rules must leave model context in the next epoch",
    );

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "# Plan\n\n1. Inspect interfaces." }],
          stopReason: "stop",
        },
      ],
    });
    assert.equal(harness.entries.at(-1)?.data.state, "approval-pending");
    assert.equal("plan" in harness.entries.at(-1).data, false);

    harness.context.ui.confirm = async () => true;
    await harness.commands.get("plan")?.handler("approve", harness.context);
    assert.deepEqual(harness.activeTools(), [
      "read",
      "bash",
      "edit",
      "write",
      "rg",
      "fd",
    ]);
    assert.equal(harness.entries.at(-1)?.data.state, "executing");
    assert.ok(harness.userMessages.length >= 2);

    const handlerCounts = new Map(
      [...harness.handlers].map(([event, handlers]) => [
        event,
        handlers.length,
      ]),
    );
    const executingPlanPath = harness.entries.at(-1).data.destination.path;
    await writeFile(executingPlanPath, "tampered after approval");
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "reload",
    });
    await access(shutdownMarker);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "reload",
    });
    assert.deepEqual(harness.activeTools(), ["read", "rg", "fd"]);
    assert.match(
      harness.statuses.get("platform-plan") ?? "",
      /approval pending/i,
    );
    assert.deepEqual(
      new Map(
        [...harness.handlers].map(([event, handlers]) => [
          event,
          handlers.length,
        ]),
      ),
      handlerCounts,
      "session replacement must not duplicate Phase 2 handlers",
    );

    await harness.commands.get("plan")?.handler("cancel", harness.context);
    const oversizedHookInput = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "bounded-policy-input",
      toolName: "read",
      input: { path: "unmatched.txt", content: "x".repeat(8_193) },
    });
    assert.ok(
      oversizedHookInput.some(
        (result) =>
          result?.block === true && /safety bounds/.test(result.reason),
      ),
    );

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Unrelated follow-up",
      systemPrompt: "base",
      systemPromptOptions: {},
    });
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "many-search-results",
      toolName: "rg",
      input: {},
      content: [
        {
          type: "text",
          text: Array.from(
            { length: 40 },
            (_value, index) => `unmatched/result-${index}.ts:1:match`,
          ).join("\n"),
        },
      ],
      details: {},
      isError: false,
    });
    assert.ok(
      harness.notifications.some((message) =>
        /first 32 result paths/.test(message),
      ),
    );

    const firstEdit = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-after-plan",
      toolName: "edit",
      input: { path: "src/index.ts", edits: [] },
    });
    assert.ok(
      firstEdit.some(
        (result) =>
          result?.block === true && /rules.*retry/i.test(result.reason),
      ),
      "newly activated rules must arrive before the first mutation",
    );

    const hookDenied = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "write-2",
      toolName: "write",
      input: { path: "src/index.ts", content: "mutated" },
    });
    assert.ok(
      hookDenied.some(
        (result) =>
          result?.block === true && /Hook blocks write/.test(result.reason),
      ),
    );

    await harness.commands.get("rules")?.handler("", harness.context);
    await harness.commands.get("hooks")?.handler("logs", harness.context);
    assert.ok(
      harness.notifications.some((message) => /source-rule/.test(message)),
    );
    assert.ok(
      harness.notifications.some((message) => /block-write/.test(message)),
    );
    assert.ok(
      harness.notifications.some((message) =>
        /output=.*pi-hook-output/.test(message),
      ),
    );

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.equal(harness.statuses.get("platform-plan"), undefined);
    assert.equal(harness.statuses.get("platform-hook:lifecycle"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
