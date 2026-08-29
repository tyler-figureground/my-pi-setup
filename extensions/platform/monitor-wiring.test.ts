import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  MonitorCommand,
  MonitorInspection,
  MonitorQuery,
  MonitorRegistryRuntime,
  MonitorSnapshot,
} from "./src/automation/monitors/index.ts";
import type {
  CapabilityOperation,
  CapabilityPolicy,
  PolicyMode,
} from "./src/core/policy/index.ts";
import { createMonitorCapability } from "./src/wiring/monitors.ts";

interface SchemaNode {
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly anyOf?: readonly SchemaNode[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly enum?: readonly string[];
}

interface RegisteredTool {
  readonly name: string;
  readonly executionMode?: string;
  readonly parameters: SchemaNode;
  execute(
    toolCallId: string,
    parameters: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    update?: unknown,
    context?: unknown,
  ): Promise<{
    readonly content: readonly { readonly text: string }[];
    readonly details: unknown;
  }>;
}

interface RegisteredCommand {
  handler(args: string, context: unknown): Promise<void>;
}

type EventHandler = (event: unknown, context: unknown) => unknown;

const emptyInspection: MonitorInspection = { monitors: [], closed: false };

const allowPolicy: CapabilityPolicy = {
  decide(operation) {
    const name = operation.kind === "operation" ? operation.name : "read";
    return {
      kind: "allow",
      operation: name,
      capabilities: [name],
      sideEffecting: name !== "read",
      reason: "fixture allow",
      provenance: { source: "fixture", reference: "allow" },
    };
  },
};

function monitor(
  input: Partial<MonitorSnapshot> & Pick<MonitorSnapshot, "id" | "source">,
): MonitorSnapshot {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    scope: input.scope ?? "durable",
    state: input.state ?? "active",
    source: input.source,
    ...(input.matcher === undefined ? {} : { matcher: input.matcher }),
    delivery: input.delivery ?? { kind: "session", sessionId: "host-session" },
    deliveries: input.deliveries ?? 2,
    dropped: input.dropped ?? 0,
    unresolved: input.unresolved ?? 0,
    ...(input.lastEventAt === undefined
      ? {}
      : { lastEventAt: input.lastEventAt }),
    ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    ...(input.blockedReason === undefined
      ? {}
      : { blockedReason: input.blockedReason }),
  };
}

function createHarness(
  input: {
    readonly policy?: () => CapabilityPolicy;
    readonly mode?: () => PolicyMode["kind"];
    readonly actor?: () => "parent" | "subagent" | "scheduled";
    readonly sessionId?: () => string;
    readonly requestId?: () => string;
    readonly inspect?: (query?: MonitorQuery) => Promise<
      | { readonly ok: true; readonly value: MonitorInspection }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: "invalid_request";
            readonly message: string;
            readonly retryable: boolean;
          };
        }
    >;
    readonly change?: (command: MonitorCommand) => Promise<
      | {
          readonly ok: true;
          readonly value: {
            readonly monitor: MonitorSnapshot;
            readonly replayed: boolean;
          };
        }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: "revision_conflict" | "invalid_request";
            readonly message: string;
            readonly retryable: boolean;
          };
        }
    >;
    readonly close?: () => Promise<void>;
  } = {},
) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, EventHandler[]>();
  const policyCalls: Array<{
    readonly operation: CapabilityOperation;
    readonly actor: string;
    readonly mode: PolicyMode;
  }> = [];
  let activeTools = ["peer_tool"];
  let closeCalls = 0;
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  };
  const policy = () => {
    const selected = input.policy?.() ?? allowPolicy;
    return {
      decide(
        operation: CapabilityOperation,
        actor: "parent" | "subagent" | "scheduled",
        mode: PolicyMode,
      ) {
        policyCalls.push({ operation, actor, mode });
        return selected.decide(operation, actor, mode);
      },
    } satisfies CapabilityPolicy;
  };
  const runtime: MonitorRegistryRuntime = {
    registry: {
      inspect:
        input.inspect ?? (async () => ({ ok: true, value: emptyInspection })),
      change:
        input.change ??
        (async () => ({
          ok: false,
          error: {
            code: "invalid_request",
            message: "fixture change unavailable",
            retryable: false,
          },
        })),
    },
    async close() {
      closeCalls += 1;
      await input.close?.();
      return { dropped: 0, unresolvedCallbacks: 0, unresolvedSources: 0 };
    },
  };
  const capability = createMonitorCapability({
    pi: pi as unknown as ExtensionAPI,
    actor: input.actor ?? (() => "parent"),
    policy,
    mode: input.mode ?? (() => "normal"),
    sessionId: input.sessionId ?? (() => "host-session"),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  return {
    activeTools: () => [...activeTools],
    capability,
    closeCalls: () => closeCalls,
    commands,
    handlers,
    policyCalls,
    runtime,
    tools,
  };
}

function tui(confirm: (title: string, message: string) => Promise<boolean>) {
  return {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => undefined,
    ui: { confirm, notify() {} },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

test("monitor wiring registers exact commands and strict bounded model schemas", () => {
  const wired = createHarness();

  assert.deepEqual([...wired.commands.keys()], ["monitor", "monitors"]);
  assert.deepEqual(
    [...wired.tools.keys()],
    ["monitor_inspect", "monitor_change"],
  );
  const inspect = wired.tools.get("monitor_inspect");
  assert.ok(inspect);
  assert.equal(inspect.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(inspect.parameters.properties ?? {}), [
    "id",
    "state",
    "afterId",
    "limit",
  ]);
  assert.equal(inspect.parameters.properties?.limit?.minimum, 1);
  assert.equal(inspect.parameters.properties?.limit?.maximum, 25);

  const change = wired.tools.get("monitor_change");
  assert.ok(change);
  assert.equal(change.executionMode, "sequential");
  assert.equal(change.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(change.parameters.properties ?? {}), [
    "action",
    "id",
    "expectedRevision",
    "scope",
    "source",
    "matcher",
  ]);
  assert.deepEqual(change.parameters.properties?.action?.enum, [
    "create",
    "replace",
    "pause",
    "resume",
    "stop",
    "delete",
  ]);
  const sources = change.parameters.properties?.source?.anyOf;
  assert.equal(sources?.length, 4);
  for (const source of sources ?? [])
    assert.equal(source.additionalProperties, false);
  const matchers = change.parameters.properties?.matcher?.anyOf;
  assert.equal(matchers?.length, 2);
  for (const matcher of matchers ?? [])
    assert.equal(matcher.additionalProperties, false);

  const serialized = JSON.stringify(change.parameters);
  for (const forbidden of [
    "projectId",
    "sessionId",
    "delivery",
    "resultRoute",
    "trust",
    "authority",
    "headers",
    "credentials",
  ])
    assert.doesNotMatch(serialized, new RegExp(`\"${forbidden}\"`));
});

test("all source kinds produce exact host-fixed core requests after digest-bound confirmation", async () => {
  const changes: MonitorCommand[] = [];
  const confirmations: string[] = [];
  const wired = createHarness({
    inspect: async () => ({ ok: true, value: emptyInspection }),
    async change(command) {
      changes.push(command);
      assert.ok(command.type === "create" || command.type === "replace");
      return {
        ok: true,
        value: {
          monitor: monitor({
            id: command.id,
            revision: 1,
            scope: command.scope,
            source: command.source,
            ...(command.matcher === undefined
              ? {}
              : { matcher: command.matcher }),
          }),
          replayed: false,
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const change = wired.tools.get("monitor_change");
  assert.ok(change);
  const definitions = [
    {
      id: "term-build",
      scope: "session",
      source: { kind: "terminal", terminalId: "terminal:7", framing: "line" },
      matcher: { kind: "literal", value: "build complete" },
    },
    {
      id: "file-build",
      scope: "durable",
      source: { kind: "file", root: "./dist output", recursive: true },
      matcher: { kind: "field", field: "type", equals: "update" },
    },
    {
      id: "poll-pr",
      scope: "durable",
      source: {
        kind: "poll",
        adapter: "github-pr",
        intervalMs: 60_000,
        input: { repository: "owner/repo", number: 17 },
        credentialReference: "credential:github-ci",
      },
    },
    {
      id: "socket-ci",
      scope: "durable",
      source: {
        kind: "websocket",
        url: "wss://EXAMPLE.com:443/events",
        credentialReference: "credential:socket-ci",
      },
    },
  ] as const;

  for (const [index, definition] of definitions.entries()) {
    await change.execute(
      `call-${index}`,
      { action: "create", expectedRevision: 0, ...definition },
      undefined,
      undefined,
      tui(async (_title, message) => {
        confirmations.push(message);
        return true;
      }),
    );
  }

  assert.equal(changes.length, 4);
  for (const [index, command] of changes.entries()) {
    assert.ok(command.type === "create" || command.type === "replace");
    assert.equal(command.requestId, `pi-tool:call-${index}`);
    assert.deepEqual(command.delivery, {
      kind: "session",
      sessionId: "host-session",
    });
    assert.deepEqual(
      Object.keys(command).sort(),
      [
        "delivery",
        "expectedRevision",
        "id",
        ...(command.matcher === undefined ? [] : ["matcher"]),
        "requestId",
        "scope",
        "source",
        "type",
      ].sort(),
    );
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          source: command.source,
          ...(command.matcher === undefined
            ? {}
            : { matcher: command.matcher }),
        }),
      )
      .digest("hex");
    assert.match(confirmations[index]!, new RegExp(digest));
    assert.match(confirmations[index]!, new RegExp(`ID: ${command.id}`));
    assert.match(confirmations[index]!, /Expected revision: 0/);
  }
  assert.equal(
    changes[3]?.type === "create" || changes[3]?.type === "replace"
      ? changes[3].source.kind === "websocket" && changes[3].source.url
      : undefined,
    "wss://example.com/events",
  );
  const confirmationText = confirmations.join("\n");
  assert.doesNotMatch(
    confirmationText,
    /credential:(?:github-ci|socket-ci)|owner\/repo/,
  );
  assert.doesNotMatch(
    confirmationText,
    /EXAMPLE\.com|dist output|build complete/,
  );
});

test("pause, stop, and delete confirmations bind exact id, revision, source, and matcher", async () => {
  const existing = monitor({
    id: "build-log",
    revision: 8,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal:9", framing: "chunk" },
    matcher: { kind: "literal", value: "finished" },
  });
  const commands: MonitorCommand[] = [];
  const confirmations: string[] = [];
  const wired = createHarness({
    inspect: async () => ({
      ok: true,
      value: { monitors: [existing], closed: false },
    }),
    async change(command) {
      commands.push(command);
      return {
        ok: true,
        value: { monitor: existing, replayed: false },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const change = wired.tools.get("monitor_change");
  assert.ok(change);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({ source: existing.source, matcher: existing.matcher }),
    )
    .digest("hex");

  for (const action of ["pause", "stop", "delete"] as const) {
    await change.execute(
      `control-${action}`,
      { action, id: existing.id, expectedRevision: 8 },
      undefined,
      undefined,
      tui(async (_title, message) => {
        confirmations.push(message);
        return true;
      }),
    );
  }

  assert.deepEqual(
    commands,
    ["pause", "stop", "delete"].map((type) => ({
      type,
      requestId: `pi-tool:control-${type}`,
      id: "build-log",
      expectedRevision: 8,
    })),
  );
  for (const [index, action] of ["pause", "stop", "delete"].entries()) {
    assert.match(confirmations[index]!, new RegExp(`Action: ${action}`));
    assert.match(confirmations[index]!, /ID: build-log/);
    assert.match(confirmations[index]!, /Expected revision: 8/);
    assert.match(confirmations[index]!, new RegExp(digest));
    assert.doesNotMatch(confirmations[index]!, /finished|terminal:9/);
  }
});

test("replace confirms normalized new definition while rechecking prior definition", async () => {
  const prior = monitor({
    id: "build-log",
    revision: 3,
    source: { kind: "file", root: "./old", recursive: false },
  });
  let received: MonitorCommand | undefined;
  let confirmation = "";
  const wired = createHarness({
    inspect: async () => ({
      ok: true,
      value: { monitors: [prior], closed: false },
    }),
    async change(command) {
      received = command;
      assert.equal(command.type, "replace");
      return {
        ok: true,
        value: {
          monitor: monitor({
            id: command.id,
            revision: 4,
            source: command.source,
          }),
          replayed: false,
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  await wired.tools.get("monitor_change")!.execute(
    "replace",
    {
      action: "replace",
      id: "build-log",
      expectedRevision: 3,
      scope: "durable",
      source: { kind: "file", root: "./new", recursive: true },
    },
    undefined,
    undefined,
    tui(async (_title, message) => {
      confirmation = message;
      return true;
    }),
  );

  assert.equal(received?.type, "replace");
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        source: { kind: "file", root: "./new", recursive: true },
      }),
    )
    .digest("hex");
  assert.match(confirmation, new RegExp(expected));
  assert.doesNotMatch(confirmation, /\.\/old|\.\/new/);
});

test("mutation fails closed on decline, stale approval, dynamic policy, Plan Mode, child role, and output mode", async () => {
  let changes = 0;
  const decline = createHarness({
    inspect: async () => ({ ok: true, value: emptyInspection }),
    change: async () => {
      changes += 1;
      throw new Error("must not change");
    },
  });
  await decline.capability.start(decline.runtime);
  const createInput = {
    action: "create",
    id: "build-log",
    expectedRevision: 0,
    scope: "session",
    source: { kind: "terminal", terminalId: "terminal:1" },
  };
  await assert.rejects(
    () =>
      decline.tools.get("monitor_change")!.execute(
        "decline",
        createInput,
        undefined,
        undefined,
        tui(async () => false),
      ),
    /denied by user/,
  );
  assert.equal(changes, 0);

  let inspection = 0;
  const stale = createHarness({
    inspect: async () => {
      inspection += 1;
      return {
        ok: true,
        value: {
          monitors: [
            monitor({
              id: "build-log",
              revision: inspection === 1 ? 4 : 5,
              source: { kind: "file", root: "." },
            }),
          ],
          closed: false,
        },
      };
    },
  });
  await stale.capability.start(stale.runtime);
  await assert.rejects(
    () =>
      stale.tools.get("monitor_change")!.execute(
        "stale",
        { action: "pause", id: "build-log", expectedRevision: 4 },
        undefined,
        undefined,
        tui(async () => true),
      ),
    /approval is stale/,
  );

  let denied = false;
  const denyPolicy: CapabilityPolicy = {
    decide(operation) {
      const name = operation.kind === "operation" ? operation.name : "read";
      return denied
        ? {
            kind: "deny",
            operation: name,
            capabilities: [],
            sideEffecting: true,
            reason: "policy changed after confirmation",
            provenance: { source: "fixture", reference: "deny" },
          }
        : {
            kind: "allow",
            operation: name,
            capabilities: [name],
            sideEffecting: name !== "read",
            reason: "allowed",
            provenance: { source: "fixture", reference: "allow" },
          };
    },
  };
  const policyDrift = createHarness({
    policy: () => denyPolicy,
    inspect: async () => ({ ok: true, value: emptyInspection }),
  });
  await policyDrift.capability.start(policyDrift.runtime);
  await assert.rejects(
    () =>
      policyDrift.tools.get("monitor_change")!.execute(
        "policy",
        createInput,
        undefined,
        undefined,
        tui(async () => {
          denied = true;
          return true;
        }),
      ),
    /policy changed after confirmation/,
  );

  let mode: PolicyMode["kind"] = "normal";
  const planDrift = createHarness({
    mode: () => mode,
    inspect: async () => ({ ok: true, value: emptyInspection }),
  });
  await planDrift.capability.start(planDrift.runtime);
  await assert.rejects(
    () =>
      planDrift.tools.get("monitor_change")!.execute(
        "plan",
        createInput,
        undefined,
        undefined,
        tui(async () => {
          mode = "plan";
          return true;
        }),
      ),
    /Plan Mode/,
  );

  let actor: "parent" | "subagent" = "parent";
  const childDrift = createHarness({
    actor: () => actor,
    inspect: async () => ({ ok: true, value: emptyInspection }),
  });
  await childDrift.capability.start(childDrift.runtime);
  await assert.rejects(
    () =>
      childDrift.tools.get("monitor_change")!.execute(
        "child",
        createInput,
        undefined,
        undefined,
        tui(async () => {
          actor = "subagent";
          return true;
        }),
      ),
    /Only Parent/,
  );
  const child = createHarness({ actor: () => "subagent" });
  await assert.rejects(
    () => child.capability.start(child.runtime),
    /requires Parent/,
  );

  for (const outputMode of ["json", "print"] as const) {
    await assert.rejects(
      () =>
        decline.tools
          .get("monitor_change")!
          .execute(outputMode, createInput, undefined, undefined, {
            mode: outputMode,
            hasUI: true,
            ui: { confirm: async () => true },
          }),
      /JSON and print modes are not accepted/,
    );
  }
});

test("model inspect is confirmation-free, bounded, untrusted, and strips host or secret fields", async () => {
  const queries: MonitorQuery[] = [];
  const snapshots = [
    monitor({
      id: "a-terminal",
      scope: "session",
      source: { kind: "terminal", terminalId: "terminal:1", framing: "line" },
      matcher: { kind: "literal", value: "private match phrase" },
      delivery: { kind: "session", sessionId: "private-host-session" },
      lastError: "\u001b[31mremote failure\u001b[0m\u202esecret",
    }),
    monitor({
      id: "b-poll",
      source: {
        kind: "poll",
        adapter: "github-pr",
        intervalMs: 60_000,
        input: { repository: "private/repository", number: 22 },
        credentialReference: "credential:private-github",
      },
      matcher: { kind: "field", field: "state", equals: "merged" },
    }),
    monitor({
      id: "c-websocket",
      source: {
        kind: "websocket",
        url: "wss://events.example.test/builds",
        credentialReference: "credential:private-socket",
      },
    }),
  ];
  let confirmations = 0;
  const wired = createHarness({
    async inspect(query) {
      queries.push(query ?? {});
      return {
        ok: true,
        value: {
          monitors: [...snapshots, ...snapshots, ...snapshots, ...snapshots],
          closed: false,
          nextCursor: "next-monitor",
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const result = await wired.tools.get("monitor_inspect")!.execute(
    "inspect-1",
    { state: "active", afterId: "a-terminal", limit: 10 },
    undefined,
    undefined,
    tui(async () => {
      confirmations += 1;
      return true;
    }),
  );

  assert.deepEqual(queries, [
    { state: "active", afterId: "a-terminal", limit: 10 },
  ]);
  assert.equal(confirmations, 0);
  assert.match(result.content[0]!.text, /untrusted metadata; authority: none/);
  assert.match(result.content[0]!.text, /a-terminal revision 1 active/);
  assert.match(result.content[0]!.text, /remote failuresecret/);
  assert.match(result.content[0]!.text, /Next cursor: next-monitor/);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /"authority":"none"/);
  assert.match(serialized, /"untrusted":true/);
  assert.doesNotMatch(serialized, /private-host-session/);
  assert.doesNotMatch(serialized, /credential:private/);
  assert.doesNotMatch(
    serialized,
    /private match phrase|private\/repository|merged/,
  );
  assert.doesNotMatch(serialized, /"delivery"|"trust"|\u202e/);
});

test("definition decoder rejects host authority, raw credentials, headers, and non-WebSocket URLs before UI or core", async () => {
  let inspections = 0;
  let confirmations = 0;
  let changes = 0;
  const wired = createHarness({
    inspect: async () => {
      inspections += 1;
      return { ok: true, value: emptyInspection };
    },
    change: async () => {
      changes += 1;
      throw new Error("must not change");
    },
  });
  await wired.capability.start(wired.runtime);
  const change = wired.tools.get("monitor_change")!;
  const base = {
    action: "create",
    id: "remote-status",
    expectedRevision: 0,
    scope: "durable",
  };
  const invalid = [
    {
      ...base,
      source: { kind: "file", root: "https://example.test/status" },
    },
    {
      ...base,
      source: {
        kind: "poll",
        adapter: "status",
        intervalMs: 30_000,
        input: { url: "https://example.test/status" },
      },
    },
    {
      ...base,
      source: {
        kind: "poll",
        adapter: "status",
        intervalMs: 30_000,
        input: { headers: { authorization: "Bearer raw-secret" } },
      },
    },
    {
      ...base,
      source: {
        kind: "websocket",
        url: "wss://example.test/events",
        credentials: "raw-secret",
      },
    },
    {
      ...base,
      source: {
        kind: "websocket",
        url: "wss://example.test/events",
        credentialReference: " credential:socket ",
      },
    },
    {
      ...base,
      source: { kind: "file", root: "." },
      projectId: "model-project",
      sessionId: "model-session",
      delivery: { kind: "session", sessionId: "model-session" },
      trust: "trusted",
      authority: "all",
    },
  ];
  for (const [index, input] of invalid.entries()) {
    await assert.rejects(
      () =>
        change.execute(
          `invalid-${index}`,
          input,
          undefined,
          undefined,
          tui(async () => {
            confirmations += 1;
            return true;
          }),
        ),
      /invalid/,
    );
  }
  assert.equal(inspections, 0);
  assert.equal(confirmations, 0);
  assert.equal(changes, 0);
});

test("Plan Mode dynamically keeps inspect active and removes mutation", async () => {
  let mode: PolicyMode["kind"] = "normal";
  const wired = createHarness({ mode: () => mode });
  assert.deepEqual(wired.activeTools(), ["peer_tool"]);
  await wired.capability.start(wired.runtime);
  assert.deepEqual(wired.activeTools(), [
    "peer_tool",
    "monitor_inspect",
    "monitor_change",
  ]);

  mode = "plan";
  for (const handler of wired.handlers.get("before_agent_start") ?? [])
    await handler({}, {});
  assert.deepEqual(wired.activeTools(), ["peer_tool", "monitor_inspect"]);
  await assert.rejects(
    () =>
      wired.tools.get("monitor_change")!.execute(
        "plan",
        {
          action: "create",
          id: "build-log",
          expectedRevision: 0,
          scope: "session",
          source: { kind: "terminal", terminalId: "terminal:1" },
        },
        undefined,
        undefined,
        tui(async () => true),
      ),
    /Plan Mode/,
  );

  mode = "normal";
  for (const handler of wired.handlers.get("before_agent_start") ?? [])
    await handler({}, {});
  assert.deepEqual(wired.activeTools(), [
    "peer_tool",
    "monitor_inspect",
    "monitor_change",
  ]);
});

test("commands use deterministic friendly grammar for every source kind and reject JSON or noninteractive modes", async () => {
  const changes: MonitorCommand[] = [];
  const queries: MonitorQuery[] = [];
  const notices: string[] = [];
  let request = 0;
  const wired = createHarness({
    requestId: () => `command-${++request}`,
    async inspect(query) {
      queries.push(query ?? {});
      return { ok: true, value: emptyInspection };
    },
    async change(command) {
      changes.push(command);
      assert.ok(command.type === "create" || command.type === "replace");
      return {
        ok: true,
        value: {
          monitor: monitor({
            id: command.id,
            scope: command.scope,
            source: command.source,
          }),
          replayed: false,
        },
      };
    },
  });
  await wired.capability.start(wired.runtime);
  const context = {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => undefined,
    ui: {
      confirm: async () => true,
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  const commands = [
    "create terminal term-build terminal:3 chunk",
    'create file file-build durable recursive "./build output"',
    "create poll poll-pr durable github-pr 60000 credential:github-ci",
    "create websocket socket-ci durable wss://EXAMPLE.com:443/events credential:socket-ci",
  ];
  for (const command of commands)
    await wired.commands.get("monitor")!.handler(command, context);

  assert.deepEqual(
    changes.map((command) => command.type),
    ["create", "create", "create", "create"],
  );
  assert.deepEqual(
    changes.map((command) => command.requestId),
    ["command-1", "command-2", "command-3", "command-4"],
  );
  assert.equal(
    changes[1]?.type === "create" || changes[1]?.type === "replace"
      ? changes[1].source.kind === "file" && changes[1].source.root
      : undefined,
    "./build output",
  );
  assert.equal(
    changes[3]?.type === "create" || changes[3]?.type === "replace"
      ? changes[3].source.kind === "websocket" && changes[3].source.url
      : undefined,
    "wss://example.com/events",
  );
  assert.equal(notices.length, 4);
  assert.doesNotMatch(
    notices.join("\n"),
    /credential:|github-ci|EXAMPLE\.com|build output/,
  );

  await wired.commands
    .get("monitors")!
    .handler("active after file-build limit 5", context);
  assert.deepEqual(queries.at(-1), {
    state: "active",
    afterId: "file-build",
    limit: 5,
  });

  await assert.rejects(
    () =>
      wired.commands
        .get("monitor")!
        .handler('{"action":"delete","id":"term-build"}', context),
    /JSON definitions are not accepted/,
  );
  for (const outputMode of ["json", "print"] as const) {
    await assert.rejects(
      () =>
        wired.commands.get("monitor")!.handler("stop term-build 1", {
          ...context,
          mode: outputMode,
        }),
      /JSON and print modes are not accepted/,
    );
    await assert.rejects(
      () =>
        wired.commands.get("monitors")!.handler("", {
          ...context,
          mode: outputMode,
        }),
      /JSON and print modes are not accepted/,
    );
  }
});

test("stop closes and fences pending confirmation, drains invoked core change, and prevents late UI", async () => {
  const approval = deferred<boolean>();
  let confirmationOpened = false;
  let changes = 0;
  const pending = createHarness({
    inspect: async () => ({ ok: true, value: emptyInspection }),
    change: async () => {
      changes += 1;
      throw new Error("stopped generation must not change");
    },
  });
  await pending.capability.start(pending.runtime);
  const mutation = pending.tools.get("monitor_change")!.execute(
    "pending",
    {
      action: "create",
      id: "build-log",
      expectedRevision: 0,
      scope: "session",
      source: { kind: "terminal", terminalId: "terminal:1" },
    },
    undefined,
    undefined,
    tui(async () => {
      confirmationOpened = true;
      return approval.promise;
    }),
  );
  for (let spin = 0; !confirmationOpened && spin < 20; spin += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmationOpened, true);
  await pending.capability.stop();
  approval.resolve(true);
  await assert.rejects(() => mutation, /generation stopped/);
  assert.equal(changes, 0);
  assert.equal(pending.closeCalls(), 1);
  assert.deepEqual(pending.activeTools(), ["peer_tool"]);

  const core = deferred<{
    readonly ok: true;
    readonly value: {
      readonly monitor: MonitorSnapshot;
      readonly replayed: boolean;
    };
  }>();
  let coreStarted = false;
  const notices: string[] = [];
  const draining = createHarness({
    inspect: async () => ({ ok: true, value: emptyInspection }),
    change: async () => {
      coreStarted = true;
      return core.promise;
    },
  });
  await draining.capability.start(draining.runtime);
  const command = draining.commands
    .get("monitor")!
    .handler("create terminal build-log terminal:2 line", {
      mode: "tui",
      hasUI: true,
      waitForIdle: async () => undefined,
      ui: {
        confirm: async () => true,
        notify(message: string) {
          notices.push(message);
        },
      },
    });
  for (let spin = 0; !coreStarted && spin < 20; spin += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coreStarted, true);
  let stopped = false;
  const stopping = draining.capability.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  core.resolve({
    ok: true,
    value: {
      monitor: monitor({
        id: "build-log",
        scope: "session",
        source: { kind: "terminal", terminalId: "terminal:2" },
      }),
      replayed: false,
    },
  });
  await stopping;
  await assert.rejects(() => command, /generation stopped/);
  assert.deepEqual(notices, []);
  assert.equal(draining.closeCalls(), 1);

  await draining.capability.start(draining.runtime);
  assert.ok(draining.activeTools().includes("monitor_inspect"));
  await draining.capability.stop();
  assert.equal(draining.closeCalls(), 2);
});
