import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  bindExecutionRole,
  CHILD_EXECUTION_ROLES,
} from "../shared/execution-role.ts";
import {
  createPlatformExtension,
  platformArtifactRoot,
} from "./src/composition.ts";
import { defaultPlatformFlags } from "./src/flags.ts";
import type {
  HostSessionBinding,
  SessionBroker,
} from "./src/messaging/index.ts";
import { createInMemoryMemoryPersistenceAdapter } from "./src/memory/memory-persistence.ts";

const execFileAsync = promisify(execFile);

function createHarness() {
  const handlers = new Map<
    string,
    Array<(event: any, context: any) => unknown>
  >();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const renderers = new Map<string, any>();
  const notifications: string[] = [];
  const entries: any[] = [];
  let activeTools = ["read"];
  const api = {
    events: createEventBus(),
    on(name: string, handler: (event: any, context: any) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
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
    registerMessageRenderer(name: string, renderer: any) {
      renderers.set(name, renderer);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [
      {
        name: "read",
        sourceInfo: {
          path: "<builtin:read>",
          source: "builtin",
          scope: "user",
          origin: "top-level",
        },
      },
      ...tools.values(),
    ],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    sendMessage() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: `entry-${entries.length + 1}`,
        parentId: entries.at(-1)?.id ?? null,
        customType,
        data,
      });
    },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: "",
    mode: "tui",
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    sessionManager: {
      getEntries: () => [...entries],
      getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionFile: () => undefined,
      getSessionId: () => "phase-6-session",
      getSessionName: () => "Phase 6",
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => false,
      setStatus() {},
      setWidget() {},
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  const emit = async (name: string, event: any) => {
    for (const handler of handlers.get(name) ?? []) {
      await handler(event, context);
    }
  };
  return {
    api,
    activeTools: () => [...activeTools],
    commands,
    context,
    emit,
    entries,
    handlers,
    notifications,
    renderers,
    tools,
  };
}

async function pathDoesNotExist(target: string) {
  await assert.rejects(access(target));
}

test("memory composition registers its surface without opening persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-memory-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    createPlatformExtension({
      agentDir,
      flags: { ...defaultPlatformFlags, memory: true },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual(
      [...harness.commands.keys()],
      ["remember", "memories", "forget", "memory"],
    );
    assert.deepEqual([...harness.tools.keys()], ["memory_search"]);
    await pathDoesNotExist(path.join(agentDir, "state", "memory.sqlite"));
    await pathDoesNotExist(platformArtifactRoot(agentDir));

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("first Memory search initializes dedicated persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-search-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    createPlatformExtension({
      agentDir,
      flags: { ...defaultPlatformFlags, memory: true },
    })(harness.api);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    const result = await harness.tools
      .get("memory_search")
      .execute("search-1", { text: "nothing stored" });

    assert.match(result.content[0].text, /Hits: 0/);
    await access(path.join(agentDir, "state", "memory.sqlite"));
    await pathDoesNotExist(platformArtifactRoot(agentDir));
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("messaging attaches with exact host binding after registering surfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-message-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const bindings: HostSessionBinding[] = [];
    const events: string[] = [];
    const broker: SessionBroker = {
      discover: async () => ({ ok: true, value: [] }),
      send: async () => {
        throw new Error("not used");
      },
      messages: async () => ({ ok: true, value: [] }),
      async close(reason) {
        events.push(`broker:close:${reason}`);
        return { ok: true, value: undefined };
      },
    };
    createPlatformExtension({
      agentDir,
      flags: { ...defaultPlatformFlags, messaging: true },
      messaging: {
        discoverableBy: "same-project",
        acceptsFrom: "local-user",
      },
      createSessionDeliveryAdapter: () => ({
        snapshot: () => ({ status: "idle", capabilities: [] }),
        subscribe: () => () => {},
        deliverOnce: async () => ({
          ok: true,
          value: { state: "accepted", durableReceipt: "fixture" },
        }),
        handleEvent(event) {
          events.push(`delivery:${event.type}`);
        },
      }),
      createSessionBrokerModule: () => ({
        async attach(binding) {
          events.push("broker:attach");
          assert.equal(harness.tools.has("session_list"), true);
          assert.equal(harness.tools.has("session_send"), true);
          await access(path.join(agentDir, "state", "platform.sqlite"));
          bindings.push(binding);
          return { ok: true, value: broker };
        },
      }),
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual([...harness.commands.keys()], ["sessions", "messages"]);
    assert.deepEqual(
      [...harness.tools.keys()],
      ["session_list", "session_send"],
    );
    assert.equal(bindings.length, 1);
    assert.deepEqual(
      {
        piSessionId: bindings[0]?.piSessionId,
        executionRole: bindings[0]?.executionRole,
        cwd: bindings[0]?.cwd,
        exposure: bindings[0]?.exposure,
      },
      {
        piSessionId: "phase-6-session",
        executionRole: "parent",
        cwd: root,
        exposure: {
          discoverableBy: "same-project",
          acceptsFrom: "local-user",
        },
      },
    );
    assert.equal(typeof bindings[0]?.proof, "object");
    await pathDoesNotExist(platformArtifactRoot(agentDir));

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.deepEqual(events, [
      "broker:attach",
      "delivery:session_shutdown",
      "broker:close:quit",
    ]);
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 6 flags off leave surfaces and storage paths inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-off-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    createPlatformExtension({ agentDir, flags: defaultPlatformFlags })(
      harness.api,
    );
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual([...harness.commands], []);
    assert.deepEqual([...harness.tools], []);
    assert.deepEqual([...harness.renderers], []);
    await pathDoesNotExist(path.join(agentDir, "state", "platform.sqlite"));
    await pathDoesNotExist(path.join(agentDir, "state", "memory.sqlite"));
    await pathDoesNotExist(platformArtifactRoot(agentDir));
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("first messaging send materializes the shared Artifact store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-send-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    createPlatformExtension({
      agentDir,
      flags: { ...defaultPlatformFlags, messaging: true },
      messaging: {
        discoverableBy: "same-project",
        acceptsFrom: "same-project",
      },
      createSessionDeliveryAdapter: () => ({
        snapshot: () => ({
          status: "idle",
          capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
        }),
        subscribe: () => () => {},
        deliverOnce: async () => ({
          ok: true,
          value: { state: "accepted", durableReceipt: "fixture" },
        }),
        handleEvent() {},
      }),
    })(harness.api);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    await pathDoesNotExist(platformArtifactRoot(agentDir));

    const result = await harness.tools.get("session_send").execute("send-1", {
      recipients: [{ sessionId: "phase-6-session" }],
      summary: "Self-check",
      message: "Artifact body",
    });

    assert.match(result.content[0].text, /phase-6-session position 1/);
    await access(platformArtifactRoot(agentDir));
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("every child execution role leaves the broker and Phase 6 surfaces absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-child-"));
  try {
    for (const role of CHILD_EXECUTION_ROLES) {
      const harness = createHarness();
      harness.context.cwd = root;
      bindExecutionRole(harness.api.events, role);
      let brokerModules = 0;
      createPlatformExtension({
        agentDir: path.join(root, role),
        flags: {
          ...defaultPlatformFlags,
          messaging: true,
          memory: true,
        },
        createSessionBrokerModule: () => {
          brokerModules += 1;
          throw new Error("child broker must not be created");
        },
      })(harness.api);

      await harness.emit("session_start", {
        type: "session_start",
        reason: "startup",
      });

      assert.equal(brokerModules, 0, role);
      assert.deepEqual([...harness.commands], [], role);
      assert.deepEqual([...harness.tools], [], role);
      await pathDoesNotExist(path.join(root, role, "state", "platform.sqlite"));
      await pathDoesNotExist(path.join(root, role, "state", "memory.sqlite"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory initialization failure is cached and never becomes empty success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-failure-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    let initializations = 0;
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: { ...defaultPlatformFlags, memory: true },
      createMemoryPersistenceAdapter: () => {
        initializations += 1;
        return {
          ok: false,
          error: {
            code: "storage_failed",
            message: "Memory full-text index unavailable.",
            retryable: false,
          },
        };
      },
    })(harness.api);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    const search = harness.tools.get("memory_search");
    const attempts = await Promise.allSettled([
      search.execute("failure-1", { text: "query" }),
      search.execute("failure-2", { text: "query" }),
    ]);

    assert.equal(initializations, 1);
    assert.ok(attempts.every(({ status }) => status === "rejected"));
    assert.ok(
      attempts.every(
        (attempt) =>
          attempt.status === "rejected" &&
          /cleanup failed|storage/i.test(String(attempt.reason)),
      ),
    );
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace Memory default diagnoses absence without automatic work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-workspace-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    harness.context.hasUI = true;
    let persistenceCalls = 0;
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: { ...defaultPlatformFlags, memory: true },
      memory: {
        defaultScope: "workspace",
        automaticRecall: false,
        automaticExtraction: false,
      },
      createMemoryPersistenceAdapter: () => {
        persistenceCalls += 1;
        return {
          ok: true,
          value: createInMemoryMemoryPersistenceAdapter(),
        };
      },
    })(harness.api);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.ok(
      harness.notifications.some((message) =>
        /Workspace Memory is unavailable/.test(message),
      ),
    );
    assert.equal(persistenceCalls, 0);
    assert.equal(harness.handlers.has("before_agent_start"), false);
    assert.equal(harness.handlers.has("agent_end"), false);
    await assert.rejects(
      harness.tools
        .get("memory_search")
        .execute("workspace-1", { text: "query", within: ["workspace"] }),
      /Workspace Memory is unavailable/,
    );
    assert.equal(persistenceCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumed Plan state reconciles Phase 6 tools before broker attach", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-plan-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    harness.entries.push({
      type: "custom",
      id: "plan-entry",
      parentId: null,
      customType: "platform-plan-mode",
      data: {
        version: 1,
        state: "planning",
        activeTools: ["read", "session_list", "session_send", "memory_search"],
        prePlanActiveTools: [
          "read",
          "session_list",
          "session_send",
          "memory_search",
        ],
        prePlanTools: [],
        planId: "phase-6-plan",
        prompt: "Inspect only",
        destination: { scope: "user" },
      },
    });
    let attached = false;
    const broker: SessionBroker = {
      discover: async () => ({ ok: true, value: [] }),
      send: async () => {
        throw new Error("not used");
      },
      messages: async () => ({ ok: true, value: [] }),
      close: async () => ({ ok: true, value: undefined }),
    };
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        planMode: true,
        rules: true,
        hooks: true,
        messaging: true,
        memory: true,
      },
      createSessionDeliveryAdapter: () => ({
        snapshot: () => ({ status: "idle", capabilities: [] }),
        subscribe: () => () => {},
        deliverOnce: async () => ({
          ok: true,
          value: { state: "accepted", durableReceipt: "fixture" },
        }),
        handleEvent() {},
      }),
      createSessionBrokerModule: () => ({
        async attach() {
          attached = true;
          assert.deepEqual([...harness.commands.keys()].sort(), [
            "forget",
            "hooks",
            "memories",
            "memory",
            "messages",
            "plan",
            "remember",
            "rules",
            "sessions",
          ]);
          assert.equal(harness.activeTools().includes("session_list"), true);
          assert.equal(harness.activeTools().includes("memory_search"), true);
          assert.equal(harness.activeTools().includes("session_send"), false);
          return { ok: true, value: broker };
        },
      }),
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.equal(attached, true);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reload replaces messaging proof, adapter, and broker generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-reload-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const bindings: HostSessionBinding[] = [];
    const deliveryEvents: string[][] = [];
    const closeReasons: string[] = [];
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: { ...defaultPlatformFlags, messaging: true },
      createSessionDeliveryAdapter: () => {
        const events: string[] = [];
        deliveryEvents.push(events);
        return {
          snapshot: () => ({ status: "idle", capabilities: [] }),
          subscribe: () => () => {},
          deliverOnce: async () => ({
            ok: true,
            value: { state: "accepted", durableReceipt: "fixture" },
          }),
          handleEvent: (event) => events.push(event.type),
        };
      },
      createSessionBrokerModule: () => ({
        async attach(binding) {
          bindings.push(binding);
          return {
            ok: true,
            value: {
              discover: async () => ({ ok: true, value: [] }),
              send: async () => {
                throw new Error("not used");
              },
              messages: async () => ({ ok: true, value: [] }),
              async close(reason) {
                closeReasons.push(reason);
                return { ok: true, value: undefined };
              },
            },
          };
        },
      }),
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "reload",
    });
    harness.context.sessionManager.getSessionId = () => "phase-6-session-2";
    await harness.emit("session_start", {
      type: "session_start",
      reason: "reload",
    });
    await harness.emit("session_info_changed", {
      type: "session_info_changed",
    });

    assert.equal(bindings.length, 2);
    assert.notEqual(bindings[0]?.proof, bindings[1]?.proof);
    assert.deepEqual(
      bindings.map(({ piSessionId }) => piSessionId),
      ["phase-6-session", "phase-6-session-2"],
    );
    assert.deepEqual(deliveryEvents[0], ["agent_start", "session_shutdown"]);
    assert.deepEqual(deliveryEvents[1], ["session_info_changed"]);
    assert.deepEqual(closeReasons, ["reload"]);

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.deepEqual(closeReasons, ["reload", "quit"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("teardown aggregates messaging failure after stopping Memory and lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-teardown-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const events: string[] = [];
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        messaging: true,
        memory: true,
      },
      createLifecycleSupervisor: () => ({
        acquire: async <T>() => undefined as T,
        async shutdown(reason) {
          events.push(`lifecycle:${reason}`);
          assert.equal(harness.activeTools().includes("memory_search"), false);
          return { reason, status: "clean", closed: [], failures: [] };
        },
      }),
      createSessionDeliveryAdapter: () => ({
        snapshot: () => ({ status: "idle", capabilities: [] }),
        subscribe: () => () => {},
        deliverOnce: async () => ({
          ok: true,
          value: { state: "accepted", durableReceipt: "fixture" },
        }),
        handleEvent(event) {
          events.push(`delivery:${event.type}`);
        },
      }),
      createSessionBrokerModule: () => ({
        async attach() {
          return {
            ok: true,
            value: {
              discover: async () => ({ ok: true, value: [] }),
              send: async () => {
                throw new Error("not used");
              },
              messages: async () => ({ ok: true, value: [] }),
              async close() {
                events.push("broker:close");
                return {
                  ok: false,
                  error: {
                    code: "storage_failed",
                    message: "broker close failed",
                    retryable: false,
                  },
                };
              },
            },
          };
        },
      }),
    })(harness.api);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    await assert.rejects(
      harness.emit("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.some((failure) =>
          /broker close failed/.test(String(failure)),
        ),
    );
    assert.deepEqual(events, [
      "delivery:session_shutdown",
      "broker:close",
      "lifecycle:quit",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory follows Git Project Identity across worktrees and excludes unrelated projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase6-project-"));
  const repository = path.join(root, "repository");
  const linked = path.join(root, "linked");
  const unrelated = path.join(root, "unrelated");
  try {
    await mkdir(repository, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repository });
    await execFileAsync(
      "git",
      ["config", "user.email", "phase6@example.invalid"],
      { cwd: repository },
    );
    await execFileAsync("git", ["config", "user.name", "Phase 6"], {
      cwd: repository,
    });
    await writeFile(path.join(repository, "tracked.txt"), "fixture\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "fixture"], {
      cwd: repository,
    });
    await execFileAsync("git", ["worktree", "add", "-b", "linked", linked], {
      cwd: repository,
    });

    const harness = createHarness();
    harness.context.cwd = repository;
    harness.context.ui.confirm = async () => true;
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: { ...defaultPlatformFlags, memory: true },
    })(harness.api);
    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    await harness.commands
      .get("remember")
      .handler("project project-fact Shared worktree fact", harness.context);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "resume",
    });

    harness.context.cwd = linked;
    harness.context.sessionManager.getSessionId = () => "linked-session";
    await harness.emit("session_start", {
      type: "session_start",
      reason: "resume",
    });
    const linkedResult = await harness.tools
      .get("memory_search")
      .execute("linked-search", { text: "Shared worktree fact" });
    assert.match(linkedResult.content[0].text, /Hits: 1/);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "new",
    });

    harness.context.cwd = unrelated;
    harness.context.sessionManager.getSessionId = () => "unrelated-session";
    await harness.emit("session_start", {
      type: "session_start",
      reason: "new",
    });
    const unrelatedResult = await harness.tools
      .get("memory_search")
      .execute("unrelated-search", { text: "Shared worktree fact" });
    assert.match(unrelatedResult.content[0].text, /Hits: 0/);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
