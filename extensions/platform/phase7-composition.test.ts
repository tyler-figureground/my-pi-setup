import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createPlatformExtension } from "./src/composition.ts";
import { defaultPlatformFlags } from "./src/flags.ts";
import { bindScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import {
  bindExecutionRole,
  CHILD_EXECUTION_ROLES,
} from "../shared/execution-role.ts";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import { createTriggerEngine } from "./src/automation/triggers/index.ts";
import type { MonitorRegistryOptions } from "./src/automation/monitors/index.ts";
import { createInMemoryCredentialVault } from "./src/external/credentials.ts";
import { platformHookEventProducerFor } from "./src/automation/platform-hook-event-sink.ts";
import { bindNamedProfileExecutionPort } from "./src/agents/named-profile-execution-service.ts";
import { platformArtifactRoot } from "./src/composition.ts";
import { createProfileCatalog } from "./src/profiles/index.ts";

function createHarness() {
  const handlers = new Map<
    string,
    Array<(event: unknown, context: any) => unknown>
  >();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const notifications: string[] = [];
  let activeTools = ["read"];
  const context = {
    cwd: "",
    mode: "tui" as const,
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => null,
      getSessionFile: () => undefined,
      getSessionId: () => "phase-7-session",
      getSessionName: () => "Phase 7",
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      confirm: async () => false,
      setStatus() {},
      setWidget() {},
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  const api = {
    events: createEventBus(),
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerMessageRenderer() {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    sendMessage() {},
    appendEntry() {},
  } as unknown as ExtensionAPI;
  return {
    api,
    commands,
    tools,
    activeTools: () => [...activeTools],
    notifications,
    async emit(name: string, event: unknown) {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, context);
      }
    },
    context,
  };
}

function messagingFixtures(events: string[] = []) {
  return {
    createSessionDeliveryAdapter: () => ({
      snapshot: () => ({ status: "idle" as const, capabilities: [] }),
      subscribe: () => () => {},
      deliverOnce: async () => ({
        ok: true as const,
        value: { state: "accepted" as const, durableReceipt: "fixture" },
      }),
      handleEvent() {},
    }),
    createSessionBrokerModule: () => ({
      async attach() {
        events.push("messaging:start");
        return {
          ok: true as const,
          value: {
            discover: async () => ({ ok: true as const, value: [] }),
            send: async () => ({
              ok: true as const,
              value: sendReceipt(),
            }),
            messages: async () => ({ ok: true as const, value: [] }),
            async close() {
              events.push("messaging:stop");
              return { ok: true as const, value: undefined };
            },
          },
        };
      },
    }),
  };
}

function sendReceipt() {
  return {
    requestId: "fixture",
    body: {
      id: "fixture-artifact",
      sha256: "0".repeat(64),
      size: 0,
      createdAt: 0,
    },
    deliveries: [],
    replayed: false,
  };
}

async function pathDoesNotExist(target: string) {
  await assert.rejects(access(target));
}

test("Parent exposes exact Reactive Monitor and Scheduler surfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-surfaces-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const unbindExecutor = bindScheduledAgentExecutor(harness.api.events, {
      async run() {
        return {
          ok: false,
          error: {
            code: "run_failed",
            message: "not used",
            retryable: false,
          },
        };
      },
    });
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        monitors: true,
        scheduler: true,
        messaging: true,
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
          return {
            ok: true,
            value: {
              discover: async () => ({ ok: true, value: [] }),
              send: async () => ({ ok: true, value: sendReceipt() }),
              messages: async () => ({ ok: true, value: [] }),
              close: async () => ({ ok: true, value: undefined }),
            },
          };
        },
      }),
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.deepEqual([...harness.commands.keys()].sort(), [
      "messages",
      "monitor",
      "monitors",
      "schedule",
      "schedules",
      "sessions",
    ]);
    assert.deepEqual([...harness.tools.keys()].sort(), [
      "monitor_change",
      "monitor_inspect",
      "schedule_change",
      "schedule_inspect",
      "session_list",
      "session_send",
    ]);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbindExecutor();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 7 flags off leave surfaces, factories, and storage inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-off-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    let factories = 0;
    createPlatformExtension({
      agentDir,
      flags: defaultPlatformFlags,
      createStateStore() {
        factories++;
        throw new Error("StateStore must stay lazy");
      },
      createArtifactStore() {
        factories++;
        throw new Error("ArtifactStore must stay lazy");
      },
      createProfileCatalog() {
        factories++;
        throw new Error("ProfileCatalog must stay lazy");
      },
      createTriggerEngine() {
        factories++;
        throw new Error("TriggerEngine must stay absent");
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.equal(factories, 0);
    assert.deepEqual([...harness.commands], []);
    assert.deepEqual([...harness.tools], []);
    await pathDoesNotExist(path.join(agentDir, "state", "platform.sqlite"));
    await pathDoesNotExist(platformArtifactRoot(agentDir));
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("every child execution role has no Phase 7 surfaces or resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-child-"));
  try {
    for (const role of CHILD_EXECUTION_ROLES) {
      const harness = createHarness();
      harness.context.cwd = root;
      bindExecutionRole(harness.api.events, role);
      let factories = 0;
      createPlatformExtension({
        agentDir: path.join(root, role),
        flags: {
          ...defaultPlatformFlags,
          hooks: true,
          messaging: true,
          monitors: true,
          scheduler: true,
        },
        createStateStore() {
          factories++;
          throw new Error("child StateStore must stay absent");
        },
      })(harness.api);

      await harness.emit("session_start", {
        type: "session_start",
        reason: "startup",
      });

      assert.equal(factories, 0, role);
      assert.deepEqual([...harness.commands], [], role);
      assert.deepEqual([...harness.tools], [], role);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabled empty Phase 7 config starts no source, timer, network, or Artifact materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-empty-"));
  const agentDir = path.join(root, "agent");
  const priorLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-app-data");
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    let schedulerArms = 0;
    const unbindExecutor = bindScheduledAgentExecutor(harness.api.events, {
      async run() {
        throw new Error("empty Scheduler must not execute");
      },
    });
    createPlatformExtension({
      agentDir,
      flags: {
        ...defaultPlatformFlags,
        messaging: true,
        monitors: true,
        scheduler: true,
      },
      ...messagingFixtures(),
      createSchedulerClock: () => ({
        now: () => 1_700_000_000_000,
        arm() {
          schedulerArms++;
          return () => {};
        },
      }),
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.equal(schedulerArms, 0);
    await access(path.join(agentDir, "state", "platform.sqlite"));
    await pathDoesNotExist(platformArtifactRoot(agentDir));
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbindExecutor();
  } finally {
    if (priorLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = priorLocalAppData;
    await rm(root, { recursive: true, force: true });
  }
});

test("messaging unavailable fails closed before source, profile, or automation activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-no-broker-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const unbindExecutor = bindScheduledAgentExecutor(harness.api.events, {
      async run() {
        throw new Error("unavailable broker must prevent execution");
      },
    });
    let sourceFactories = 0;
    let profileCatalogs = 0;
    let monitorCores = 0;
    let schedulerCores = 0;
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        messaging: true,
        monitors: true,
        scheduler: true,
      },
      createSessionDeliveryAdapter:
        messagingFixtures().createSessionDeliveryAdapter,
      createSessionBrokerModule: () => ({
        async attach() {
          return {
            ok: false as const,
            error: {
              code: "storage_failed" as const,
              message: "broker unavailable",
              retryable: false,
            },
          };
        },
      }),
      createProfileCatalog() {
        profileCatalogs++;
        throw new Error("profile service must remain lazy");
      },
      createMonitorSourceFactory() {
        sourceFactories++;
        throw new Error("source service must remain lazy");
      },
      async createMonitorRegistry() {
        monitorCores++;
        throw new Error("Monitor core must stay absent");
      },
      async createScheduler() {
        schedulerCores++;
        throw new Error("Scheduler core must stay absent");
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual(
      { sourceFactories, profileCatalogs, monitorCores, schedulerCores },
      {
        sourceFactories: 0,
        profileCatalogs: 0,
        monitorCores: 0,
        schedulerCores: 0,
      },
    );
    assert.deepEqual(
      [...harness.commands.keys()].filter((name) =>
        ["monitor", "monitors", "schedule", "schedules"].includes(name),
      ),
      [],
    );
    assert.equal(harness.activeTools().includes("monitor_inspect"), false);
    assert.equal(harness.activeTools().includes("schedule_inspect"), false);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbindExecutor();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup and teardown preserve Phase 7 dependency order and aggregate through lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-order-"));
  const agentDir = path.join(root, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: startup-order
    event: session_start
    priority: 0
    match: {}
    actions: [{ type: notify, message: hooks:start, level: info }]
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 1024
    failurePolicy: open
  - id: shutdown-order
    event: session_shutdown
    priority: 0
    match: {}
    actions: [{ type: notify, message: hooks:stop, level: info }]
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const harness = createHarness();
    harness.context.cwd = root;
    harness.context.hasUI = true;
    const events: string[] = [];
    harness.context.ui.notify = (message: string) => events.push(message);
    const unbindExecutor = bindScheduledAgentExecutor(harness.api.events, {
      async run() {
        throw new Error("not used");
      },
    });
    createPlatformExtension({
      agentDir,
      flags: {
        ...defaultPlatformFlags,
        hooks: true,
        messaging: true,
        monitors: true,
        scheduler: true,
      },
      ...messagingFixtures(events),
      createLifecycleSupervisor: () => {
        const lifecycle = createLifecycleSupervisor();
        return {
          ...lifecycle,
          async shutdown(reason) {
            events.push("lifecycle:stop");
            return lifecycle.shutdown(reason);
          },
        };
      },
      createTriggerEngine: (input) => {
        const triggers = createTriggerEngine(input);
        return {
          ...triggers,
          async close(reason) {
            events.push("triggers:stop");
            await triggers.close(reason);
          },
        };
      },
      createMonitorSourceFactory: () => ({
        async open() {
          throw new Error("empty Monitor registry must not open a source");
        },
      }),
      async createMonitorRegistry() {
        events.push("monitors:start");
        return {
          ok: true as const,
          value: {
            registry: {
              async change() {
                throw new Error("not used");
              },
              async inspect() {
                throw new Error("not used");
              },
            },
            async close() {
              events.push("monitors:stop");
              return {
                dropped: 0,
                unresolvedCallbacks: 0,
                unresolvedSources: 0,
              };
            },
          },
        };
      },
      async createScheduler() {
        events.push("scheduler:start");
        return {
          ok: true as const,
          value: {
            scheduler: {
              async change() {
                throw new Error("not used");
              },
              async inspect() {
                throw new Error("not used");
              },
            },
            async close() {
              events.push("scheduler:stop");
            },
          },
        };
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.deepEqual(events.slice(0, 4), [
      "hooks:start",
      "messaging:start",
      "monitors:start",
      "scheduler:start",
    ]);

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.deepEqual(events.slice(-6), [
      "scheduler:stop",
      "monitors:stop",
      "hooks:stop",
      "triggers:stop",
      "messaging:stop",
      "lifecycle:stop",
    ]);
    unbindExecutor();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reload replaces every Phase 7 generation and final shutdown leaves no active surfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-reload-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const opened = { triggers: 0, monitors: 0, scheduler: 0, messaging: 0 };
    const closed = { triggers: 0, monitors: 0, scheduler: 0, messaging: 0 };
    const unbindExecutor = bindScheduledAgentExecutor(harness.api.events, {
      async run() {
        throw new Error("not used");
      },
    });
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        hooks: true,
        messaging: true,
        monitors: true,
        scheduler: true,
      },
      createSessionDeliveryAdapter:
        messagingFixtures().createSessionDeliveryAdapter,
      createSessionBrokerModule: () => ({
        async attach() {
          opened.messaging++;
          return {
            ok: true as const,
            value: {
              discover: async () => ({ ok: true as const, value: [] }),
              send: async () => ({
                ok: true as const,
                value: sendReceipt(),
              }),
              messages: async () => ({ ok: true as const, value: [] }),
              async close() {
                closed.messaging++;
                return { ok: true as const, value: undefined };
              },
            },
          };
        },
      }),
      createTriggerEngine: (input) => {
        opened.triggers++;
        const runtime = createTriggerEngine(input);
        return {
          ...runtime,
          async close(reason) {
            closed.triggers++;
            await runtime.close(reason);
          },
        };
      },
      createMonitorSourceFactory: () => ({
        async open() {
          throw new Error("not used");
        },
      }),
      async createMonitorRegistry() {
        opened.monitors++;
        return {
          ok: true as const,
          value: {
            registry: {
              async change() {
                throw new Error("not used");
              },
              async inspect() {
                throw new Error("not used");
              },
            },
            async close() {
              closed.monitors++;
              return {
                dropped: 0,
                unresolvedCallbacks: 0,
                unresolvedSources: 0,
              };
            },
          },
        };
      },
      async createScheduler() {
        opened.scheduler++;
        return {
          ok: true as const,
          value: {
            scheduler: {
              async change() {
                throw new Error("not used");
              },
              async inspect() {
                throw new Error("not used");
              },
            },
            async close() {
              closed.scheduler++;
            },
          },
        };
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    harness.context.sessionManager.getSessionId = () => "phase-7-session-2";
    await harness.emit("session_start", {
      type: "session_start",
      reason: "reload",
    });
    assert.deepEqual(opened, {
      triggers: 2,
      monitors: 2,
      scheduler: 2,
      messaging: 2,
    });
    assert.deepEqual(closed, {
      triggers: 1,
      monitors: 1,
      scheduler: 1,
      messaging: 1,
    });

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.deepEqual(closed, opened);
    for (const tool of [
      "monitor_change",
      "monitor_inspect",
      "schedule_change",
      "schedule_inspect",
      "session_list",
      "session_send",
    ]) {
      assert.equal(harness.activeTools().includes(tool), false, tool);
    }
    unbindExecutor();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued platform producer events flush through Hooks with host-stamped source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-events-"));
  const agentDir = path.join(root, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: queued-platform-event
    event: task.started
    priority: 0
    match: { producerSource: workflows }
    actions: [{ type: notify, message: queued-platform-event, level: info }]
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const harness = createHarness();
    harness.context.cwd = root;
    harness.context.hasUI = true;
    const producer = platformHookEventProducerFor(
      harness.api.events,
      "workflows",
    );
    createPlatformExtension({
      agentDir,
      flags: {
        ...defaultPlatformFlags,
        hooks: true,
        profiles: true,
      },
      createProfileCatalog: (input) => {
        const catalog = createProfileCatalog(input);
        return {
          ...catalog,
          async reload(context) {
            producer.publish("task.started", { runId: "queued-before-hooks" });
            return catalog.reload(context);
          },
        };
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    for (let index = 0; index < 10; index++) {
      if (harness.notifications.includes("queued-platform-event")) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(
      harness.notifications.includes("queued-platform-event"),
      JSON.stringify(harness.notifications),
    );
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hooks receive exact named HTTP, MCP, and Agent adapters from host configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-adapters-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const execution = {
      async revalidateProfile() {
        return { trusted: false, contentDigest: "unavailable" };
      },
      async run() {
        return {};
      },
    };
    const unbindExecution = bindNamedProfileExecutionPort(
      harness.api.events,
      execution,
    );
    const http = [
      {
        id: "build-status",
        url: "https://build.example.test/status",
        method: "GET" as const,
        effect: "network-read" as const,
        allowedOrigins: ["https://build.example.test"],
        allowLoopback: false,
      },
    ];
    const mcp = [
      {
        id: "github.get_pull",
        serverId: "github",
        toolName: "get_pull",
        federatedToolId: "github__get_pull",
      },
    ];
    const captured: {
      http?: unknown;
      mcp?: unknown;
      agent?: unknown;
    } = {};
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        hooks: true,
        mcp: true,
        profiles: true,
      },
      hookActions: { http, mcp },
      createNamedHookHttpAdapter(input) {
        captured.http = input;
        return {
          classify: () => "network-read",
          async invoke() {
            return {};
          },
        };
      },
      createNamedHookMcpAdapter(input) {
        captured.mcp = input;
        return {
          async invoke() {
            return {};
          },
        };
      },
      createNamedHookAgentAdapter(input) {
        captured.agent = input;
        return {
          async run() {
            return {};
          },
        };
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual(
      (captured.http as { definitions: unknown }).definitions,
      http,
    );
    const mcpInput = captured.mcp as {
      definitions: unknown;
      federation: { status(): unknown };
    };
    assert.deepEqual(mcpInput.definitions, mcp);
    assert.equal(typeof mcpInput.federation.status, "function");
    const agentInput = captured.agent as { execution: unknown };
    assert.equal(agentInput.execution, execution);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbindExecution();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Monitor composition feeds exact resolved credential canaries without configuration persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-canary-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const reference = "credential:phase7-monitor-canary";
    const secret = "PHASE7_COMPOSITION_CANARY_91d0a6";
    const vault = createInMemoryCredentialVault({
      createReference: () => reference,
    });
    const binding = {
      integration: "monitor" as const,
      resourceId: "canary-monitor",
      origin: "https://ci.example.test",
    };
    assert.equal((await vault.store({ binding, secret })).ok, true);
    let captured: MonitorRegistryOptions | undefined;
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: {
        ...defaultPlatformFlags,
        messaging: true,
        monitors: true,
      },
      monitors: {
        maxActive: 8,
        maxRemote: 2,
        batchWindowMs: 250,
        pollMinimumMs: 5_000,
        allowedWebSocketOrigins: [],
        allowLoopback: false,
        pollTargets: [
          {
            id: "ci-status",
            endpoint: "https://ci.example.test/status",
            allowedOrigins: ["https://ci.example.test"],
            allowLoopback: false,
            credentialReference: reference,
          },
        ],
      },
      credentialVault: vault,
      ...messagingFixtures(),
      createMonitorSourceFactory: () => ({
        async open() {
          throw new Error("not used");
        },
      }),
      async createMonitorRegistry(options) {
        captured = options;
        return {
          ok: true as const,
          value: {
            registry: {
              async change() {
                throw new Error("not used");
              },
              async inspect() {
                return {
                  ok: true as const,
                  value: { monitors: [], closed: false },
                };
              },
            },
            async close() {
              return {
                dropped: 0,
                unresolvedCallbacks: 0,
                unresolvedSources: 0,
              };
            },
          },
        };
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.ok(captured?.credentialCanaries);
    const canaries = await captured.credentialCanaries({
      id: "canary-monitor",
      revision: 1,
      scope: "durable",
      state: "active",
      source: {
        kind: "poll",
        adapter: "ci-status",
        intervalMs: 5_000,
        credentialReference: reference,
      },
      delivery: { kind: "session", sessionId: captured.binding.sessionId },
    });
    assert.deepEqual(canaries, [secret]);
    assert.equal(
      JSON.stringify(captured.configuration).includes(secret),
      false,
    );

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Scheduler authority resolves only exact scheduled Agent Profile role and host executor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase7-role-"));
  const agentDir = path.join(root, "agent");
  try {
    await mkdir(path.join(agentDir, "agents"), { recursive: true });
    await writeFile(
      path.join(agentDir, "agents", "scheduled-observer.yaml"),
      `name: scheduled-observer
description: Scheduled observer
backend: pi
instructions: { inline: Observe only. }
skills: []
allowedTools: [read]
disallowedTools: [write]
maxTurns: 2
timeoutMs: 60000
workspacePolicy: current
role: scheduled
`,
      "utf8",
    );
    const harness = createHarness();
    harness.context.cwd = root;
    const executor = {
      async run() {
        return {
          ok: false as const,
          error: {
            code: "run_failed" as const,
            message: "not used",
            retryable: false,
          },
        };
      },
    };
    const unbindExecutor = bindScheduledAgentExecutor(
      harness.api.events,
      executor,
    );
    let authorizedRole: string | undefined;
    let exactExecutor = false;
    createPlatformExtension({
      agentDir,
      flags: {
        ...defaultPlatformFlags,
        messaging: true,
        scheduler: true,
      },
      ...messagingFixtures(),
      async createScheduler(input) {
        exactExecutor = input.executor === executor;
        const authorized = await input.authority.authorize({
          projectId: input.binding.project.projectId,
          cwd: input.binding.cwd,
          profileName: "scheduled-observer",
          credentialReferences: [],
        });
        if (authorized.ok)
          authorizedRole = authorized.value.profile.policy.role;
        return {
          ok: true as const,
          value: {
            scheduler: {
              async change() {
                throw new Error("not used");
              },
              async inspect() {
                throw new Error("not used");
              },
            },
            async close() {},
          },
        };
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.equal(exactExecutor, true);
    assert.equal(authorizedRole, "scheduled");
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbindExecutor();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
