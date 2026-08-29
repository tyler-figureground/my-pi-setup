import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { nativeHookEvents } from "./src/automation/hooks/index.ts";
import {
  createCapabilityPolicy,
  type CapabilityPolicy,
} from "./src/core/policy/index.ts";
import { createHooksCapability } from "./src/wiring/hooks.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

function createPiHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const pi = {
    on(event: string, handler: EventHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    handlers,
    commands,
    async emit(event: string, value: unknown, ctx: ExtensionContext) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(value, ctx));
      }
      return results;
    },
  };
}

function createContext(cwd: string, notifications: string[], trusted = true) {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;
}

async function withFixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-hooks-wiring-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

const allowAllPolicy: CapabilityPolicy = {
  decide() {
    return {
      kind: "allow",
      operation: "process",
      capabilities: ["process"],
      sideEffecting: true,
      reason: "fixture allow",
      provenance: { source: "fixture", reference: "allow" },
    };
  },
};

test("production wiring maps every native event plus typed platform and update outcomes", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const observedEvents = [
      "session_start",
      "message_update",
      "tool_execution_update",
      "session_compact",
      "session_compact_failed",
      "worktree.created",
      "session_shutdown",
    ];
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2\nhooks:\n${observedEvents
        .map(
          (event, index) =>
            `  - id: mapped-${index}\n    event: ${event}\n    priority: 0\n    match: {}\n    actions: [{ type: notify, message: ${event}, level: info }]\n    concurrency: 1\n    deadlineMs: 10000\n    outputCapBytes: 1024\n    failurePolicy: open`,
        )
        .join("\n")}\n`,
      "utf8",
    );
    const harness = createPiHarness();
    const notifications: string[] = [];
    const ctx = createContext(directory, notifications);
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: createCapabilityPolicy(),
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "events",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;

    for (const event of nativeHookEvents) {
      if (event === "session_start" || event === "session_shutdown") continue;
      assert.equal(harness.handlers.has(event), true, event);
    }
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    await harness.emit(
      "message_update",
      {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "x" },
      },
      ctx,
    );
    await harness.emit(
      "tool_execution_update",
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { content: [] },
      },
      ctx,
    );
    await harness.emit(
      "session_compact",
      { type: "session_compact", reason: "manual", willRetry: false },
      ctx,
    );
    await harness.emit(
      "session_compact_failed",
      {
        type: "session_compact_failed",
        reason: "manual",
        aborted: false,
        willRetry: false,
        fromExtension: false,
      },
      ctx,
    );
    await capability.handlePlatformEvent("worktree.created", {
      worktreeId: "workspace-1",
    });
    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });

    assert.deepEqual(notifications, observedEvents);
  });
});

test("host stamps cwd and attendance while actor, policy, and Plan Mode stay dynamic", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const marker = path.join(directory, "cwd.txt");
    await mkdir(agentDir, { recursive: true });
    const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd())`;
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: authoritative-command
    event: tool_call
    priority: 0
    match: {}
    actions:
      - type: command
        executable: ${JSON.stringify(process.execPath)}
        args: ["-e", ${JSON.stringify(script)}]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const harness = createPiHarness();
    const confirmations: Array<{
      title: string;
      message: string;
      timeout: number | undefined;
    }> = [];
    const policyCalls: Array<readonly [string, string]> = [];
    let platformMode: "normal" | "plan" = "normal";
    const makeContext = (mode: "tui" | "print") =>
      ({
        cwd: process.cwd(),
        mode,
        hasUI: mode === "tui",
        signal: undefined,
        isProjectTrusted: () => true,
        ui: {
          notify() {},
          setStatus() {},
          async confirm(
            title: string,
            message: string,
            options?: { timeout?: number },
          ) {
            confirmations.push({
              title,
              message,
              timeout: options?.timeout,
            });
            return true;
          },
        },
      }) as unknown as ExtensionContext;
    const tui = makeContext("tui");
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: () => "parent",
      policy: () => ({
        decide(_operation, actor, mode) {
          policyCalls.push([actor, mode.kind]);
          return {
            kind: "require-user-confirmation",
            operation: "process",
            capabilities: ["process"],
            sideEffecting: true,
            reason: "exact approval text",
            provenance: { source: "fixture", reference: "dynamic" },
          };
        },
      }),
      mode: () => platformMode,
    });
    const project = {
      kind: "non-git",
      projectId: "authority",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx: tui },
      { type: "session_start", reason: "startup" },
    );
    const forgedEvent = {
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "read",
      input: { path: "README.md" },
      cwd: path.join(directory, "forged"),
      unattended: true,
    };

    const attended = await harness.emit("tool_call", forgedEvent, tui);
    assert.equal(
      (attended[0] as { block?: boolean } | undefined)?.block,
      undefined,
    );
    assert.equal(await readFile(marker, "utf8"), process.cwd());
    assert.equal(confirmations.length, 1);
    assert.equal(
      confirmations[0]?.title,
      "Hook authoritative-command requests confirmation",
    );
    assert.equal(confirmations[0]?.message, "exact approval text");
    assert.ok((confirmations[0]?.timeout ?? 0) > 0);
    assert.ok((confirmations[0]?.timeout ?? 0) <= 10000);
    assert.ok(policyCalls.every(([actor]) => actor === "parent"));

    await unlink(marker);
    const unattended = await harness.emit(
      "tool_call",
      forgedEvent,
      makeContext("print"),
    );
    assert.equal(
      (unattended[0] as { block?: boolean } | undefined)?.block,
      true,
    );
    assert.equal(confirmations.length, 1);

    platformMode = "plan";
    const planned = await harness.emit("tool_call", forgedEvent, tui);
    assert.equal((planned[0] as { block?: boolean } | undefined)?.block, true);
    assert.match(
      (planned[0] as { reason?: string } | undefined)?.reason ?? "",
      /Plan Mode/,
    );
    assert.equal(confirmations.length, 1);
    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });
  });
});

test("wiring translates only context and block outcomes to exact Pi event returns", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const policyEvents = [
      "tool_call",
      "input",
      "user_bash",
      "session_before_switch",
      "session_before_fork",
      "session_before_compact",
      "session_before_tree",
    ];
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: prompt-context
    event: before_agent_start
    priority: 0
    match: {}
    actions: [{ type: context, content: prompt-context }]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: open
  - id: message-context
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: message-context }]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: closed
  - id: context-block
    event: context
    priority: 10
    match: {}
    actions: [{ type: command, executable: definitely-not-a-real-command, args: [] }]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: closed
${policyEvents
  .map(
    (event, index) =>
      `  - id: deny-${index}\n    event: ${event}\n    priority: 0\n    match: {}\n    actions: [{ type: policy, decision: deny, reason: denied-${event} }]\n    concurrency: 1\n    deadlineMs: 10000\n    outputCapBytes: 1024\n    failurePolicy: closed`,
  )
  .join("\n")}
`,
      "utf8",
    );
    const harness = createPiHarness();
    const notifications: string[] = [];
    let aborted = false;
    const ctx = {
      ...createContext(directory, notifications),
      signal: undefined,
      abort() {
        aborted = true;
      },
    } as unknown as ExtensionContext;
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: {
        decide() {
          return {
            kind: "allow",
            operation: "process",
            capabilities: ["process"],
            sideEffecting: true,
            reason: "fixture allow",
            provenance: { source: "fixture", reference: "allow" },
          };
        },
      },
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "returns",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );

    const prompt = await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base", prompt: "go" },
      ctx,
    );
    assert.deepEqual(prompt[0], {
      systemPrompt: "base\n\n## Declarative hook context\nprompt-context",
    });

    const context = await harness.emit(
      "context",
      { type: "context", messages: [] },
      ctx,
    );
    assert.equal(aborted, true);
    assert.equal(
      (context[0] as { messages?: Array<{ content?: string }> } | undefined)
        ?.messages?.[0]?.content,
      "message-context",
    );

    const tool = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tool-1",
        toolName: "read",
        input: { path: "README.md" },
      },
      ctx,
    );
    assert.deepEqual(tool[0], {
      block: true,
      reason: "denied-tool_call",
    });
    assert.deepEqual(
      (
        await harness.emit(
          "input",
          { type: "input", text: "go", source: "interactive" },
          ctx,
        )
      )[0],
      { action: "handled" },
    );
    assert.equal(
      (
        (
          await harness.emit(
            "user_bash",
            {
              type: "user_bash",
              command: "echo ok",
              cwd: "forged",
              excludeFromContext: false,
            },
            ctx,
          )
        )[0] as { result?: { exitCode?: number } }
      ).result?.exitCode,
      1,
    );
    for (const event of policyEvents.slice(3)) {
      const result = await harness.emit(event, { type: event }, ctx);
      assert.deepEqual(result[0], { cancel: true }, event);
    }

    let accessorReads = 0;
    const hostileInput = {};
    Object.defineProperty(hostileInput, "path", {
      enumerable: true,
      get() {
        accessorReads++;
        return "NEVER_READ";
      },
    });
    const bounded = await harness.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tool-2",
        toolName: "read",
        input: hostileInput,
      },
      ctx,
    );
    assert.equal(accessorReads, 0);
    assert.match(
      (bounded[0] as { reason?: string } | undefined)?.reason ?? "",
      /safety bounds/,
    );

    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });
  });
});

test("reload fences old production actions and commands expose bounded history", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const configPath = path.join(agentDir, "hooks.yaml");
    const marker = path.join(directory, "started.txt");
    await mkdir(agentDir, { recursive: true });
    const slowScript = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setTimeout(() => {}, 10000)`;
    const oldConfig = `version: 2
hooks:
  - id: revisioned
    event: context
    priority: 0
    match: {}
    actions:
      - type: command
        executable: ${JSON.stringify(process.execPath)}
        args: ["-e", ${JSON.stringify(slowScript)}]
      - { type: context, content: stale-context }
    concurrency: 1
    deadlineMs: 15000
    outputCapBytes: 1024
    failurePolicy: closed
`;
    const freshConfig = `version: 2
hooks:
  - id: revisioned
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: fresh-context }]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: closed
`;
    await writeFile(configPath, oldConfig, "utf8");
    const harness = createPiHarness();
    const notifications: string[] = [];
    const ctx = {
      ...createContext(process.cwd(), notifications),
      signal: undefined,
      abort() {},
    } as unknown as ExtensionContext;
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: allowAllPolicy,
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "reload",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );

    const oldInvocation = harness.emit(
      "context",
      { type: "context", messages: [] },
      ctx,
    );
    const waitUntil = Date.now() + 10000;
    while (Date.now() < waitUntil) {
      try {
        await readFile(marker, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(await readFile(marker, "utf8"), "started");
    await writeFile(configPath, freshConfig, "utf8");
    const command = harness.commands.get("hooks");
    assert.ok(command);
    await command("reload", ctx);
    const stale = await oldInvocation;
    assert.equal(
      (
        stale[0] as { messages?: Array<{ content?: string }> } | undefined
      )?.messages?.some(({ content }) => content === "stale-context") ?? false,
      false,
    );

    const fresh = await harness.emit(
      "context",
      { type: "context", messages: [] },
      ctx,
    );
    assert.equal(
      (fresh[0] as { messages?: Array<{ content?: string }> } | undefined)
        ?.messages?.[0]?.content,
      "fresh-context",
    );
    assert.equal(capability.inspect().revision, 2);
    assert.ok(
      capability
        .inspect()
        .history.some(
          ({ type, outcome }) => type === "configured" && outcome === "applied",
        ),
    );

    await command("validate", ctx);
    await command("logs", ctx);
    await command("inspect", ctx);
    assert.ok(notifications.some((message) => /Reloaded 1 hook/.test(message)));
    assert.ok(notifications.some((message) => /configured/.test(message)));
    await assert.rejects(command("unknown", ctx), /Usage:/);
    const printCtx = {
      ...ctx,
      mode: "print",
      hasUI: false,
    } as unknown as ExtensionContext;
    await assert.rejects(command("inspect", printCtx), /TUI or RPC/);

    await capability.stop("reload", {
      type: "session_shutdown",
      reason: "reload",
    });
  });
});

test("dynamic trust and changed config suspend visibly until atomic reload", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const projectRoot = path.join(directory, "project");
    const configDirectory = path.join(projectRoot, ".pi");
    const configPath = path.join(configDirectory, "hooks.yaml");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
    ]);
    const config = (message: string) => `version: 2
hooks:
  - id: mutable
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: status, key: active, text: ${message} }
      - { type: notify, message: ${message}, level: info }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`;
    await writeFile(configPath, config("old"), "utf8");
    const harness = createPiHarness();
    const notifications: string[] = [];
    const statuses: Array<readonly [string, string | undefined]> = [];
    let trusted = true;
    const ctx = {
      cwd: projectRoot,
      mode: "tui",
      hasUI: true,
      signal: undefined,
      isProjectTrusted: () => trusted,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text]);
        },
        confirm: async () => true,
      },
    } as unknown as ExtensionContext;
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: allowAllPolicy,
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "suspension",
      requestedCwd: projectRoot,
      canonicalCwd: projectRoot,
      cwdWasAliased: false,
    } as const;
    const started = await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    assert.equal(
      started.ok,
      true,
      started.ok ? "" : JSON.stringify(started.error),
    );
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    assert.ok(notifications.includes("old"));

    trusted = false;
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    assert.equal(capability.inspect().sources[1]?.status, "suspended");
    assert.ok(
      notifications.some((message) => /source suspended/i.test(message)),
    );
    assert.ok(
      statuses.some(
        ([key, text]) =>
          key === "platform-hook:configuration" &&
          /1 hook source/.test(text ?? ""),
      ),
    );

    const command = harness.commands.get("hooks");
    assert.ok(command);
    await command("reload", ctx);
    assert.equal(capability.inspect().revision, 1);
    trusted = true;
    await writeFile(configPath, config("new"), "utf8");
    await command("reload", ctx);
    assert.equal(capability.inspect().revision, 2);
    assert.equal(capability.inspect().sources[1]?.status, "active");
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    assert.ok(notifications.includes("new"));

    await writeFile(configPath, config("changed-again"), "utf8");
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    assert.equal(capability.inspect().sources[1]?.status, "suspended");
    assert.equal(notifications.includes("changed-again"), false);

    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.ok(
      statuses.some(
        ([key, text]) => key === "platform-hook:active" && text === undefined,
      ),
    );
    assert.ok(statuses.every(([key]) => key.startsWith("platform-hook:")));
  });
});

test("capability is inert before start and after stop with no late UI or Pi returns", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: observer
    event: agent_end
    priority: 0
    match: {}
    actions: [{ type: notify, message: observed, level: info }]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const harness = createPiHarness();
    const notifications: string[] = [];
    const ctx = createContext(directory, notifications);
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: allowAllPolicy,
      mode: () => "normal",
    });
    assert.deepEqual(
      await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx),
      [undefined],
    );
    assert.deepEqual(
      await capability.handlePlatformEvent("task.progress", { percent: 10 }),
      { context: [] },
    );
    const command = harness.commands.get("hooks");
    assert.ok(command);
    await command("inspect", ctx);
    assert.deepEqual(notifications, ["Hooks runtime is inactive."]);

    const project = {
      kind: "non-git",
      projectId: "inert",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });
    const afterStop = notifications.length;
    assert.deepEqual(
      await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx),
      [undefined],
    );
    assert.deepEqual(
      await capability.handlePlatformEvent("task.progress", { percent: 20 }),
      { context: [] },
    );
    assert.equal(notifications.length, afterStop);
    assert.equal(capability.inspect().revision, 0);
  });
});

test("production wiring passes only named HTTP, MCP, and Agent adapter requests", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: named
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: http, name: build-status, input: { build: 42 } }
      - { type: mcp, name: github.get_pull, input: { number: 7 } }
      - { type: agent, profile: reviewer, prompt: review }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const harness = createPiHarness();
    const ctx = createContext(directory, []);
    const requests: Array<{
      readonly name: string;
      readonly cwd: string;
    }> = [];
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: allowAllPolicy,
      mode: () => "normal",
      adapters: {
        http: {
          classify: () => "network-read",
          async invoke(request) {
            requests.push(request);
            return { output: "http" };
          },
        },
        mcp: {
          async invoke(request) {
            requests.push(request);
            return { output: "mcp" };
          },
        },
        agent: {
          async run(request) {
            requests.push(request);
            return { output: "agent" };
          },
        },
      },
    });
    const project = {
      kind: "non-git",
      projectId: "adapters",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);

    assert.deepEqual(
      requests.map(({ name }) => name),
      ["build-status", "github.get_pull", "reviewer"],
    );
    for (const request of requests) {
      assert.equal(request.cwd, directory);
      assert.equal("url" in request, false);
      assert.equal("endpoint" in request, false);
      assert.equal("headers" in request, false);
      assert.equal("credential" in request, false);
    }
    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });
  });
});

test("stop aggregates status cleanup failures and leaves handlers inert", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: status
    event: agent_start
    priority: 0
    match: {}
    actions: [{ type: status, key: busy, text: running }]
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const harness = createPiHarness();
    const statusCalls: Array<readonly [string, string | undefined]> = [];
    const ctx = {
      ...createContext(directory, []),
      ui: {
        notify() {},
        confirm: async () => true,
        setStatus(key: string, text: string | undefined) {
          statusCalls.push([key, text]);
          if (text === undefined) throw new Error("fixture clear failed");
        },
      },
    } as unknown as ExtensionContext;
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: allowAllPolicy,
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "cleanup",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    await harness.emit("agent_start", { type: "agent_start" }, ctx);
    await assert.rejects(
      capability.stop("reload", {
        type: "session_shutdown",
        reason: "reload",
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some(
          (entry) =>
            entry instanceof Error &&
            /fixture clear failed/.test(entry.message),
        ),
    );
    const callCount = statusCalls.length;
    await harness.emit("agent_start", { type: "agent_start" }, ctx);
    assert.equal(statusCalls.length, callCount);
  });
});

test("production wiring atomically executes trusted v1 and v2 hooks through createHooks", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const projectRoot = path.join(directory, "project");
    await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: global-v2
    event: agent_end
    priority: 10
    match: {}
    actions:
      - { type: notify, message: v2-first, level: info }
      - { type: notify, message: v2-second, level: warning }
    concurrency: 1
    deadlineMs: 10000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    await writeFile(
      path.join(projectRoot, ".pi", "hooks.yaml"),
      `version: 1
hooks:
  - id: project-v1
    event: agent_end
    priority: 20
    match: {}
    action: { type: notify, message: v1, level: info }
    timeoutMs: 10000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );

    const harness = createPiHarness();
    const notifications: string[] = [];
    const ctx = createContext(projectRoot, notifications);
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: createCapabilityPolicy(),
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "fixture",
      requestedCwd: projectRoot,
      canonicalCwd: projectRoot,
      cwdWasAliased: false,
    } as const;

    const started = await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    assert.equal(started.ok, true);

    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    assert.deepEqual(notifications, ["v2-first", "v2-second", "v1"]);
    assert.equal(capability.inspect().revision, 1);

    await capability.stop("quit", { type: "session_shutdown", reason: "quit" });
  });
});

test("observe and platform events are unattended even in an interactive session", async () => {
  await withFixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: unattended-observer
    event: agent_end
    priority: 0
    match: {}
    actions: [{ type: command, executable: fixture, args: [] }]
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const harness = createPiHarness();
    let confirmations = 0;
    const ctx = {
      ...createContext(directory, []),
      ui: {
        notify() {},
        setStatus() {},
        async confirm() {
          confirmations++;
          return true;
        },
      },
    } as unknown as ExtensionContext;
    const capability = createHooksCapability({
      pi: harness.pi,
      agentDir,
      actor: "parent",
      policy: {
        decide() {
          return {
            kind: "require-user-confirmation",
            operation: "process",
            capabilities: ["process"],
            sideEffecting: true,
            reason: "direct approval required",
            provenance: { source: "fixture", reference: "confirm" },
          };
        },
      },
      mode: () => "normal",
    });
    const project = {
      kind: "non-git",
      projectId: "unattended",
      requestedCwd: directory,
      canonicalCwd: directory,
      cwdWasAliased: false,
    } as const;
    await capability.start(
      { project, projectTrusted: true, ctx },
      { type: "session_start", reason: "startup" },
    );
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
    await capability.handlePlatformEvent("task.completed", {
      taskId: "task-1",
    });
    assert.equal(confirmations, 0);
    assert.ok(
      capability
        .inspect()
        .history.some(({ outcome }) => outcome === "unattended-confirmation"),
    );
    await capability.stop("quit", {
      type: "session_shutdown",
      reason: "quit",
    });
  });
});
