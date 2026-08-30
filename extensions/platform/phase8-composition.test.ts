import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createPlatformExtension } from "./src/composition.ts";
import { defaultPlatformFlags } from "./src/flags.ts";
import { bindGoalWorkerExecutor } from "../shared/goal-worker.ts";
import { bindScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import {
  bindExecutionRole,
  CHILD_EXECUTION_ROLES,
} from "../shared/execution-role.ts";
import type { GoalRuntime, GoalRuntimeOptions } from "./src/goals/index.ts";
import { defaultPlatformGoalConfiguration } from "./src/goals/config.ts";

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
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    waitForIdle: async () => {},
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => null,
      getSessionFile: () => undefined,
      getSessionId: () => "phase-8-session",
      getSessionName: () => "Phase 8",
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
            send: async () => ({ ok: true as const, value: sendReceipt() }),
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

function idleGoalWorker() {
  return {
    async run() {
      return {
        ok: false as const,
        error: {
          code: "backend_unavailable" as const,
          message: "not used",
          retryable: false,
          certainty: "not-started" as const,
        },
      };
    },
    async inspect(attemptKey: string) {
      return {
        attemptKey,
        state: "not-started" as const,
        certainty: "not-started" as const,
      };
    },
  };
}

function fakeGoalRuntime(events: string[]): GoalRuntime {
  const refused = async () =>
    ({
      ok: false as const,
      error: {
        code: "closed" as const,
        message: "fixture runtime",
        retryable: false,
      },
    }) as never;
  return {
    metering: { tokens: false, cost: false },
    engine: {
      submit: refused,
      resume: refused,
      pause: refused,
      cancel: refused,
      observe: async () => ({
        ok: true as const,
        value: { goals: [], detail: null, nextCursor: null, truncated: false },
      }),
    },
    async drain() {},
    async close() {
      events.push("goals:stop");
    },
  };
}

const goalFlags = {
  ...defaultPlatformFlags,
  goals: true,
  profiles: true,
  messaging: true,
};

test("Parent exposes exact Goal Mode surfaces when every dependency is present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-surfaces-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const unbind = bindGoalWorkerExecutor(harness.api.events, idleGoalWorker());
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: goalFlags,
      ...messagingFixtures(),
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.deepEqual([...harness.commands.keys()].sort(), [
      "goal",
      "goals",
      "messages",
      "sessions",
    ]);
    assert.deepEqual([...harness.tools.keys()].sort(), [
      "goal_change",
      "goal_inspect",
      "session_list",
      "session_send",
    ]);
    assert.ok(harness.activeTools().includes("goal_inspect"));
    assert.ok(harness.activeTools().includes("goal_change"));

    // Token and cost budgets are reachable through the tool the model and the
    // user actually get, not only through the core.
    const change = harness.tools.get("goal_change") as {
      parameters: {
        properties: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    const budget = change.parameters.properties.budget as {
      properties: Record<string, unknown>;
    };
    assert.ok(budget.properties.maxTokens);
    assert.ok(budget.properties.maxCostMicros);
    const nodes = change.parameters.properties.nodes as {
      items: {
        properties: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    const reservation = nodes.items.properties.reservation;
    assert.ok(reservation);
    assert.deepEqual(Object.keys(reservation.properties ?? {}), [
      "runtimeMs",
      "tokens",
      "costMicros",
    ]);
    const goalCommand = harness.commands.get("goal") as {
      description: string;
    };
    assert.ok(goalCommand);

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    assert.equal(harness.activeTools().includes("goal_change"), false);
    unbind();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each Session Incarnation gets a unique lease owner and a bound approval issuer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-owner-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const events: string[] = [];
    const built: {
      ownerId: string;
      authority: GoalRuntimeOptions["authority"];
      maxGoals: GoalRuntimeOptions["maxGoals"];
      terminalRetentionMs: GoalRuntimeOptions["terminalRetentionMs"];
      leaseTtlMs: GoalRuntimeOptions["leaseTtlMs"];
    }[] = [];
    const unbind = bindGoalWorkerExecutor(harness.api.events, idleGoalWorker());
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: goalFlags,
      ...messagingFixtures(events),
      createGoalRuntime(options) {
        built.push({
          ownerId: options.ownerId,
          authority: options.authority,
          maxGoals: options.maxGoals,
          terminalRetentionMs: options.terminalRetentionMs,
          leaseTtlMs: options.leaseTtlMs,
        });
        return fakeGoalRuntime(events);
      },
    })(harness.api);

    for (const _incarnation of [0, 1]) {
      await harness.emit("session_start", {
        type: "session_start",
        reason: "startup",
      });
      await harness.emit("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      });
    }

    assert.equal(built.length, 2);
    const [first, second] = built;
    assert.ok(first && second);
    assert.notEqual(first.ownerId, second.ownerId);
    for (const incarnation of built) {
      // Host policy reaches the runtime rather than sitting unused in config.
      assert.equal(
        incarnation.maxGoals,
        defaultPlatformGoalConfiguration.maxGoals,
      );
      assert.equal(
        incarnation.terminalRetentionMs,
        defaultPlatformGoalConfiguration.terminalRetentionMs,
      );
      assert.equal(
        incarnation.leaseTtlMs,
        defaultPlatformGoalConfiguration.leaseTtlMs,
      );
      assert.match(
        incarnation.ownerId,
        /^goals-[^-]*-?[^-]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // The runtime is handed the host issuer, and an invented token proves
      // nothing against it.
      assert.ok(incarnation.authority);
      assert.equal(
        incarnation.authority?.verify({
          command: {
            type: "cancel",
            requestId: "forged",
            goalId: "ship-feature",
            expectedRevision: 1,
          },
          authority: {
            actor: "direct-user",
            actorId: "forged",
            projectId: "project",
            sessionId: "phase-8-session",
            commandDigest: "0".repeat(64),
            token: "forged-token",
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
          commandDigest: "0".repeat(64),
          projectId: "project",
          sessionId: "phase-8-session",
          now: 0,
        }),
        false,
      );
    }
    unbind();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Goal Mode fails closed without its host execution service or Session Broker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-missing-"));
  try {
    const withoutExecutor = createHarness();
    withoutExecutor.context.cwd = root;
    let runtimes = 0;
    createPlatformExtension({
      agentDir: path.join(root, "no-executor"),
      flags: goalFlags,
      ...messagingFixtures(),
      createGoalRuntime() {
        runtimes += 1;
        throw new Error("Goal runtime must stay absent");
      },
    })(withoutExecutor.api);
    await withoutExecutor.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.equal(runtimes, 0);
    assert.equal([...withoutExecutor.commands.keys()].includes("goal"), false);
    assert.ok(
      withoutExecutor.notifications.some((message) =>
        message.includes("Goal Worker execution service"),
      ),
    );
    await withoutExecutor.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });

    const withoutBroker = createHarness();
    withoutBroker.context.cwd = root;
    const unbind = bindGoalWorkerExecutor(
      withoutBroker.api.events,
      idleGoalWorker(),
    );
    createPlatformExtension({
      agentDir: path.join(root, "no-broker"),
      flags: goalFlags,
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
      createGoalRuntime() {
        runtimes += 1;
        throw new Error("Goal runtime must stay absent");
      },
    })(withoutBroker.api);
    await withoutBroker.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.equal(runtimes, 0);
    assert.equal([...withoutBroker.commands.keys()].includes("goal"), false);
    assert.ok(
      withoutBroker.notifications.some((message) =>
        message.includes("Goal Mode activation was denied"),
      ),
    );
    await withoutBroker.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbind();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Goal Mode requires messaging and Agent Profiles before construction", () => {
  assert.throws(
    () =>
      createPlatformExtension({
        flags: { ...defaultPlatformFlags, goals: true, profiles: true },
      }),
    /messaging/,
  );
  assert.throws(
    () =>
      createPlatformExtension({
        flags: { ...defaultPlatformFlags, goals: true, messaging: true },
      }),
    /profiles/,
  );
});

test("an untrusted project never activates Goal Mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-untrusted-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    harness.context.isProjectTrusted = () => false;
    let runtimes = 0;
    const unbind = bindGoalWorkerExecutor(harness.api.events, idleGoalWorker());
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: goalFlags,
      ...messagingFixtures(),
      createGoalRuntime() {
        runtimes += 1;
        throw new Error("untrusted projects must not build a Goal runtime");
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.equal(runtimes, 0);
    assert.equal([...harness.commands.keys()].includes("goal"), false);
    assert.equal(harness.activeTools().includes("goal_inspect"), false);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbind();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every child execution role has no Goal Mode surface or runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-child-"));
  try {
    for (const role of CHILD_EXECUTION_ROLES) {
      const harness = createHarness();
      harness.context.cwd = root;
      bindExecutionRole(harness.api.events, role);
      let runtimes = 0;
      createPlatformExtension({
        agentDir: path.join(root, role),
        flags: goalFlags,
        ...messagingFixtures(),
        createGoalRuntime() {
          runtimes += 1;
          throw new Error("child roles must not build a Goal runtime");
        },
        createStateStore() {
          throw new Error("child StateStore must stay absent");
        },
      })(harness.api);

      await harness.emit("session_start", {
        type: "session_start",
        reason: "startup",
      });

      assert.equal(runtimes, 0, role);
      assert.deepEqual([...harness.commands], [], role);
      assert.deepEqual([...harness.tools], [], role);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Goal Mode stays inert while its flag is off", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-off-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    let runtimes = 0;
    const unbind = bindGoalWorkerExecutor(harness.api.events, idleGoalWorker());
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: { ...defaultPlatformFlags, profiles: true, messaging: true },
      ...messagingFixtures(),
      createGoalRuntime() {
        runtimes += 1;
        throw new Error("disabled Goal Mode must not build a runtime");
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    assert.equal(runtimes, 0);
    assert.equal([...harness.commands.keys()].includes("goal"), false);
    assert.equal([...harness.commands.keys()].includes("goals"), false);
    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });
    unbind();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("teardown stops Goal Mode before the Scheduler and the lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-phase8-order-"));
  try {
    const harness = createHarness();
    harness.context.cwd = root;
    const events: string[] = [];
    const unbindGoals = bindGoalWorkerExecutor(
      harness.api.events,
      idleGoalWorker(),
    );
    const unbindScheduled = bindScheduledAgentExecutor(harness.api.events, {
      async run() {
        throw new Error("not used");
      },
    });
    createPlatformExtension({
      agentDir: path.join(root, "agent"),
      flags: { ...goalFlags, scheduler: true },
      ...messagingFixtures(events),
      createGoalRuntime: () => fakeGoalRuntime(events),
      async createScheduler() {
        return {
          ok: true as const,
          value: {
            scheduler: {
              inspect: async () => ({
                ok: true as const,
                value: { schedules: [], closed: false },
              }),
              change: async () => ({
                ok: false as const,
                error: {
                  code: "invalid_request" as const,
                  message: "fixture",
                  retryable: false,
                },
              }),
            },
            async close() {
              events.push("scheduler:stop");
            },
          },
        } as never;
      },
    })(harness.api);

    await harness.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    assert.ok([...harness.commands.keys()].includes("goal"));
    assert.ok([...harness.commands.keys()].includes("schedule"));

    await harness.emit("session_shutdown", {
      type: "session_shutdown",
      reason: "quit",
    });

    const goalStop = events.indexOf("goals:stop");
    const schedulerStop = events.indexOf("scheduler:stop");
    const messagingStop = events.indexOf("messaging:stop");
    assert.ok(goalStop >= 0, events.join(","));
    assert.ok(schedulerStop > goalStop, events.join(","));
    assert.ok(messagingStop > schedulerStop, events.join(","));
    unbindGoals();
    unbindScheduled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
