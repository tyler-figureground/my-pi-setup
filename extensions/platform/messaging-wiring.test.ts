import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CapabilityOperation,
  CapabilityPolicy,
  PolicyMode,
} from "./src/core/policy/index.ts";
import type { ResolvedProjectIdentity } from "./src/core/projects/index.ts";
import {
  issueHostSessionProof,
  type HostSessionBinding,
  type SendMessageRequest,
  type SessionBroker,
  type SessionBrokerModule,
} from "./src/messaging/index.ts";
import type { PiSessionDeliveryAdapter } from "./src/messaging/pi-delivery.ts";
import { createMessagingCapability } from "./src/wiring/messaging.ts";

interface SchemaNode {
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface RegisteredTool {
  readonly name: string;
  readonly executionMode?: string;
  readonly parameters: SchemaNode;
  execute(
    toolCallId: string,
    parameters: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<{
    readonly content: readonly { readonly text: string }[];
    readonly details: unknown;
  }>;
  renderCall?(
    parameters: Readonly<Record<string, unknown>>,
    theme: { fg(color: string, text: string): string },
    context: unknown,
  ): RenderedComponent;
  renderResult?(
    result: { readonly details?: unknown },
    options: { readonly expanded: boolean },
    theme: { fg(color: string, text: string): string },
    context: unknown,
  ): RenderedComponent;
}

interface RegisteredCommand {
  handler(args: string, context: unknown): Promise<void>;
}

interface RenderedComponent {
  render(width: number): string[];
}

interface InboxRenderer {
  (
    message: {
      readonly content: string;
      readonly details?: unknown;
    },
    options: { readonly expanded: boolean },
    theme: {
      fg(color: string, text: string): string;
      bold(text: string): string;
    },
  ): RenderedComponent | undefined;
}

type EventHandler = (event: { readonly type: string }) => Promise<void> | void;

const allowPolicy: CapabilityPolicy = {
  decide(operation) {
    const name = operation.kind === "operation" ? operation.name : "read";
    return {
      kind: "allow",
      operation: name,
      capabilities: [name],
      sideEffecting: name !== "read",
      reason: "test allow",
      provenance: { source: "test", reference: "allow" },
    };
  },
};

function createHarness(
  input: {
    readonly policy?: CapabilityPolicy;
    readonly mode?: () => PolicyMode["kind"];
    readonly requestId?: () => string;
  } = {},
) {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const renderers = new Map<string, InboxRenderer>();
  const eventHandlers = new Map<string, EventHandler[]>();
  let activeTools = ["peer_tool"];
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerMessageRenderer(name: string, renderer: InboxRenderer) {
      renderers.set(name, renderer);
    },
    on(name: string, handler: EventHandler) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  };
  const capability = createMessagingCapability({
    pi: pi as unknown as ExtensionAPI,
    policy: input.policy ?? allowPolicy,
    mode: input.mode ?? (() => "normal"),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  });
  return {
    activeTools: () => [...activeTools],
    capability,
    tools,
    commands,
    renderers,
    eventHandlers,
  };
}

test("messaging wiring registers only exact commands, tools, and closed schemas", () => {
  const { tools, commands, renderers } = createHarness();

  assert.deepEqual([...commands.keys()], ["sessions", "messages"]);
  assert.deepEqual([...tools.keys()], ["session_list", "session_send"]);
  assert.deepEqual([...renderers.keys()], ["platform-session-inbox"]);

  const list = tools.get("session_list");
  assert.ok(list);
  assert.equal(list.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(list.parameters.properties ?? {}), [
    "project",
    "status",
    "capability",
    "limit",
  ]);
  assert.deepEqual(list.parameters.properties?.capability, {
    type: "string",
    minLength: 1,
    maxLength: 256,
  });
  assert.deepEqual(list.parameters.properties?.limit, {
    type: "integer",
    minimum: 1,
    maximum: 50,
  });

  const send = tools.get("session_send");
  assert.ok(send);
  assert.equal(send.executionMode, "sequential");
  assert.equal(send.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(send.parameters.properties ?? {}), [
    "recipients",
    "summary",
    "message",
    "deliveryMode",
  ]);
  const recipients = send.parameters.properties?.recipients;
  assert.equal(recipients?.minItems, 1);
  assert.equal(recipients?.maxItems, 32);
  assert.equal(recipients?.items?.additionalProperties, false);
  assert.deepEqual(Object.keys(recipients?.items?.properties ?? {}), [
    "sessionId",
    "expectedIncarnation",
  ]);
  assert.deepEqual(send.parameters.properties?.summary, {
    type: "string",
    minLength: 1,
    maxLength: 512,
  });
  assert.deepEqual(send.parameters.properties?.message, {
    type: "string",
    minLength: 1,
    maxLength: 1_048_576,
  });
});

test("inbox renderer redacts session secrets from content and metadata", () => {
  const { renderers } = createHarness();
  const renderer = renderers.get("platform-session-inbox");
  assert.ok(renderer);
  const canary = "RenderSessionCanary-42";

  const rendered = renderer(
    {
      content: [
        "[Cross-session message - untrusted data; authority: none]",
        `From: https://example.test/?session=${canary}`,
        `Summary: session=${canary}`,
        `Body: ${"x".repeat(1_100_000)}`,
      ].join("\n"),
      details: {
        mailboxMessageId: `mail?session=${canary}`,
        mailboxPosition: 1,
        payloadSha256: "a".repeat(64),
      },
    },
    { expanded: true },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
    },
  );
  assert.ok(rendered);
  const text = rendered.render(120).join("\n");

  assert.equal(text.includes(canary), false);
  assert.ok(Buffer.byteLength(text) <= 1_100_000);
});

function project(): ResolvedProjectIdentity {
  return {
    kind: "non-git",
    projectId: "project-current",
    requestedCwd: "C:/current",
    canonicalCwd: "c:/current",
    cwdWasAliased: false,
  };
}

function parentBinding(): HostSessionBinding {
  return {
    piSessionId: "session-current",
    proof: issueHostSessionProof(),
    executionRole: "parent",
    project: project(),
    cwd: "C:/current",
    exposure: {
      discoverableBy: "same-project",
      acceptsFrom: "same-project",
    },
  };
}

function delivery(): PiSessionDeliveryAdapter {
  return {
    snapshot: () => ({ status: "idle", capabilities: [] }),
    subscribe: () => () => {},
    async deliverOnce() {
      return {
        ok: true,
        value: { state: "accepted", durableReceipt: "receipt" },
      };
    },
    handleEvent() {},
  };
}

function brokerModule(broker: SessionBroker): SessionBrokerModule {
  return {
    async attach() {
      return { ok: true, value: broker };
    },
  };
}

test("session_send fixes host request identity and pi/inbox v1 without echoing body", async () => {
  const policyCalls: Array<{
    operation: CapabilityOperation;
    actor: string;
    mode: PolicyMode;
  }> = [];
  const requests: SendMessageRequest[] = [];
  const policy: CapabilityPolicy = {
    decide(operation, actor, mode) {
      policyCalls.push({ operation, actor, mode });
      return {
        kind: "allow",
        operation: "orchestration",
        capabilities: ["orchestration"],
        sideEffecting: true,
        reason: "test allow",
        provenance: { source: "test", reference: "allow" },
      };
    },
  };
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    async send(request) {
      requests.push(request);
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          body: {
            id: "a".repeat(64),
            sha256: "a".repeat(64),
            size: 24,
            createdAt: 1,
            mediaType: "text/plain",
          },
          deliveries: [
            {
              recipient: request.recipients[0]!,
              messageId: "message-1",
              mailboxPosition: 7,
              state: "queued",
            },
          ],
          replayed: false,
        },
      };
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, tools } = createHarness({ policy });
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  const result = await tools.get("session_send")!.execute("call-17", {
    recipients: [
      {
        sessionId: "session-recipient",
        expectedIncarnation: "incarnation-4",
      },
    ],
    summary: "Coordinate work",
    message: "secret body must not be echoed",
  });

  assert.deepEqual(requests, [
    {
      requestId: "pi-tool:call-17",
      recipients: [
        {
          piSessionId: "session-recipient",
          expectedIncarnation: "incarnation-4",
        },
      ],
      summary: "Coordinate work",
      body: { kind: "text", text: "secret body must not be echoed" },
      delivery: { mode: "pi/inbox", version: 1 },
    },
  ]);
  assert.deepEqual(policyCalls, [
    {
      operation: {
        kind: "tool",
        name: "session_send",
        source: "custom",
      },
      actor: "parent",
      mode: { kind: "normal" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret body must not be echoed/);
  assert.match(result.content[0]!.text, /session-recipient position 7 queued/);
  assert.deepEqual(result.details, {
    replayed: false,
    deliveries: [
      {
        recipient: {
          piSessionId: "session-recipient",
          expectedIncarnation: "incarnation-4",
        },
        messageId: "message-1",
        mailboxPosition: 7,
        state: "queued",
      },
    ],
  });
});

test("session_send exposes fixed safe delivery mode selection", async () => {
  const requests: SendMessageRequest[] = [];
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    async send(request) {
      requests.push(request);
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          body: {
            id: "a".repeat(64),
            sha256: "a".repeat(64),
            size: 1,
            createdAt: 1,
          },
          deliveries: [],
          replayed: false,
        },
      };
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, tools } = createHarness();
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  await tools.get("session_send")!.execute("safe-mode", {
    recipients: [{ sessionId: "recipient" }],
    summary: "Coordinate",
    message: "body",
    deliveryMode: "pi/steer",
  });

  assert.equal(requests[0]?.delivery?.mode, "pi/steer");
});

test("session_list rechecks read policy and forwards only friendly discovery filters", async () => {
  const discoveries: unknown[] = [];
  const policyCalls: CapabilityOperation[] = [];
  const broker: SessionBroker = {
    async discover(input) {
      discoveries.push(input);
      return {
        ok: true,
        value: [
          {
            address: { piSessionId: "session-peer" },
            incarnation: "incarnation-peer",
            executionRole: "parent",
            projectId: "project-current",
            cwd: "C:/peer",
            name: "Peer\u0007",
            status: "idle",
            capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
            lastHeartbeatAt: 123,
            visibleBecause: "same-project",
          },
        ],
      };
    },
    send: async () => {
      throw new Error("not used");
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const policy: CapabilityPolicy = {
    decide(operation) {
      policyCalls.push(operation);
      return {
        kind: "allow",
        operation: "read",
        capabilities: ["read"],
        sideEffecting: false,
        reason: "test allow",
        provenance: { source: "test", reference: "allow" },
      };
    },
  };
  const { capability, tools } = createHarness({ policy });
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  const result = await tools.get("session_list")!.execute("list-1", {
    project: "all-visible",
    status: "all",
    capability: "pi.delivery/inbox",
    limit: 12,
  });

  assert.deepEqual(discoveries, [
    {
      project: "all-visible",
      status: "all",
      capability: "pi.delivery/inbox",
      limit: 12,
    },
  ]);
  assert.deepEqual(policyCalls, [
    { kind: "tool", name: "session_list", source: "custom" },
  ]);
  assert.match(result.content[0]!.text, /session-peer/);
  assert.doesNotMatch(result.content[0]!.text, /\u0007/);
  assert.deepEqual(result.details, {
    sessions: [
      {
        sessionId: "session-peer",
        incarnation: "incarnation-peer",
        name: "Peer",
        status: "idle",
        role: "parent",
        currentProject: true,
        capabilities: ["pi.delivery/inbox@1"],
        lastHeartbeatAt: 123,
      },
    ],
  });
});

test("messaging commands reject every non-TUI mode before broker access", async () => {
  let brokerCalls = 0;
  const broker: SessionBroker = {
    discover: async () => {
      brokerCalls++;
      return { ok: true, value: [] };
    },
    send: async () => {
      brokerCalls++;
      throw new Error("not used");
    },
    messages: async () => {
      brokerCalls++;
      return { ok: true, value: [] };
    },
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, commands } = createHarness();
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  for (const name of ["sessions", "messages"] as const) {
    for (const mode of ["rpc", "json", "print"] as const) {
      await assert.rejects(
        () => commands.get(name)!.handler("", { mode, ui: {} }),
        new RegExp(
          `/${name} requires interactive TUI mode; RPC, JSON, and print mode are not accepted\\.`,
        ),
      );
    }
  }
  assert.equal(brokerCalls, 0);
});

test("TUI inspection commands apply read policy and inspect broker metadata only", async () => {
  const discoveries: unknown[] = [];
  const messageQueries: unknown[] = [];
  const sends: SendMessageRequest[] = [];
  const policyCalls: CapabilityOperation[] = [];
  const notices: string[] = [];
  let waits = 0;
  const broker: SessionBroker = {
    async discover(input) {
      discoveries.push(input);
      return {
        ok: true,
        value: [
          {
            address: { piSessionId: "session-peer" },
            incarnation: "incarnation-peer",
            executionRole: "parent",
            projectId: "project-current",
            cwd: "C:/peer",
            name: "Peer\u0007",
            status: "running",
            capabilities: [{ id: "pi.delivery/inbox", version: 1 }],
            lastHeartbeatAt: 123,
            visibleBecause: "same-project",
          },
        ],
      };
    },
    async send(request) {
      sends.push(request);
      throw new Error("inspection must not send");
    },
    async messages(query) {
      messageQueries.push(query);
      return {
        ok: true,
        value: [
          {
            envelope: {
              id: "mail-1",
              mailboxPosition: 42,
              sender: {
                piSessionId: "session-current",
                incarnation: "incarnation-current",
                executionRole: "parent",
                projectId: "project-current",
              },
              recipient: { piSessionId: "session-peer" },
              sentAt: 100,
              summary: "Needs review\u0000",
              body: {
                id: "body-artifact-must-not-render",
                sha256: "a".repeat(64),
                size: 100,
                createdAt: 100,
                mediaType: "text/plain",
              },
              delivery: { mode: "pi/inbox", version: 1 },
              trust: "untrusted",
              authority: "none",
            },
            state: "failed",
            attempts: 2,
            lastAttemptAt: 110,
            lastErrorCode: "temporary\u0007",
          },
        ],
      };
    },
    close: async () => ({ ok: true, value: undefined }),
  };
  const policy: CapabilityPolicy = {
    decide(operation) {
      policyCalls.push(operation);
      return {
        kind: "allow",
        operation: "read",
        capabilities: ["read"],
        sideEffecting: false,
        reason: "test allow",
        provenance: { source: "test", reference: "allow" },
      };
    },
  };
  const { capability, commands } = createHarness({ policy });
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });
  const context = {
    mode: "tui",
    async waitForIdle() {
      waits++;
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };

  await commands
    .get("sessions")!
    .handler("all all-visible capability pi.delivery/inbox", context);
  await commands.get("messages")!.handler("outbound failed after 41", context);

  assert.equal(waits, 2);
  assert.deepEqual(policyCalls, [
    { kind: "operation", name: "read" },
    { kind: "operation", name: "read" },
  ]);
  assert.deepEqual(discoveries, [
    {
      project: "all-visible",
      status: "all",
      capability: "pi.delivery/inbox",
      limit: 25,
    },
  ]);
  assert.deepEqual(messageQueries, [
    { direction: "outbound", state: "failed", afterPosition: 41, limit: 25 },
  ]);
  assert.equal(sends.length, 0);
  assert.match(notices[0]!, /Peer/);
  assert.match(notices[1]!, /mail-1/);
  assert.doesNotMatch(notices.join("\n"), /[\u0000\u0007]/);
  assert.doesNotMatch(notices.join("\n"), /body-artifact-must-not-render/);
});

test("/messages send mutates only after post-intent confirmation", async () => {
  const requests: SendMessageRequest[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const notices: string[] = [];
  let approve = false;
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    async send(request) {
      requests.push(request);
      return {
        ok: true,
        value: {
          requestId: request.requestId,
          body: {
            id: "a".repeat(64),
            sha256: "a".repeat(64),
            size: 24,
            createdAt: 1,
            mediaType: "text/plain",
          },
          deliveries: [
            {
              recipient: request.recipients[0]!,
              messageId: "mail-confirmed",
              mailboxPosition: 9,
              state: "queued",
            },
          ],
          replayed: false,
        },
      };
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, commands } = createHarness({
    requestId: () => "host-command-request",
  });
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });
  const context = {
    mode: "tui",
    waitForIdle: async () => {},
    ui: {
      input: async () => "Coordinate work",
      editor: async () => "body stays out of notices",
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return approve;
      },
      notify(message: string) {
        notices.push(message);
      },
    },
  };

  await commands
    .get("messages")!
    .handler("send session-recipient incarnation-4", context);
  assert.equal(requests.length, 0);
  assert.match(confirmations[0]!.message, /session-recipient/);
  assert.match(confirmations[0]!.message, /incarnation-4/);
  assert.match(confirmations[0]!.message, /Coordinate work/);
  assert.match(confirmations[0]!.message, /25 bytes/);
  assert.doesNotMatch(confirmations[0]!.message, /body stays out of notices/);

  approve = true;
  await commands
    .get("messages")!
    .handler("send session-recipient incarnation-4", context);

  assert.deepEqual(requests, [
    {
      requestId: "host-command-request",
      recipients: [
        {
          piSessionId: "session-recipient",
          expectedIncarnation: "incarnation-4",
        },
      ],
      summary: "Coordinate work",
      body: { kind: "text", text: "body stays out of notices" },
      delivery: { mode: "pi/inbox", version: 1 },
    },
  ]);
  assert.match(notices.at(-1)!, /mail-confirmed/);
  assert.match(notices.at(-1)!, /position 9/);
  assert.doesNotMatch(notices.join("\n"), /body stays out of notices/);
});

test("/messages send rechecks policy after confirmation before broker mutation", async () => {
  let policyChecks = 0;
  let sends = 0;
  const policy: CapabilityPolicy = {
    decide(operation) {
      if (
        operation.kind !== "operation" ||
        operation.name !== "orchestration"
      ) {
        return {
          kind: "allow",
          operation: operation.kind === "operation" ? operation.name : "read",
          capabilities: ["read"],
          sideEffecting: false,
          reason: "fixture allow",
          provenance: { source: "test", reference: "allow" },
        };
      }
      policyChecks += 1;
      if (policyChecks === 1) {
        return {
          kind: "allow",
          operation: "orchestration",
          capabilities: ["orchestration"],
          sideEffecting: true,
          reason: "initial allow",
          provenance: { source: "test", reference: "allow" },
        };
      }
      return {
        kind: "deny",
        operation: "orchestration",
        capabilities: [],
        sideEffecting: true,
        reason: "policy changed after confirmation",
        provenance: { source: "test", reference: "deny" },
      };
    },
  };
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    async send() {
      sends += 1;
      throw new Error("broker must not run");
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, commands } = createHarness({ policy });
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  await assert.rejects(
    () =>
      commands.get("messages")!.handler("send session-recipient", {
        mode: "tui",
        waitForIdle: async () => {},
        ui: {
          input: async () => "Summary",
          editor: async () => "Body",
          confirm: async () => true,
          notify: () => {},
        },
      }),
    /policy changed after confirmation/,
  );
  assert.equal(policyChecks, 2);
  assert.equal(sends, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("stop fences a late broker attach and non-Parent bindings never attach", async () => {
  const attached =
    deferred<Awaited<ReturnType<SessionBrokerModule["attach"]>>>();
  const closeReasons: string[] = [];
  let attachCalls = 0;
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    send: async () => {
      throw new Error("not used");
    },
    messages: async () => ({ ok: true, value: [] }),
    async close(reason) {
      closeReasons.push(reason);
      return { ok: true, value: undefined };
    },
  };
  const module: SessionBrokerModule = {
    attach() {
      attachCalls++;
      return attached.promise;
    },
  };
  const { capability, tools } = createHarness();

  const starting = capability.start({
    brokerModule: module,
    binding: parentBinding(),
    delivery: delivery(),
  });
  const stopping = capability.stop("reload");
  attached.resolve({ ok: true, value: broker });
  await Promise.all([starting, stopping]);

  assert.deepEqual(closeReasons, ["reload"]);
  await assert.rejects(
    () => tools.get("session_list")!.execute("late", {}),
    /unavailable/i,
  );

  const childBinding: HostSessionBinding = {
    ...parentBinding(),
    executionRole: "subagent",
  };
  await assert.rejects(
    () =>
      capability.start({
        brokerModule: module,
        binding: childBinding,
        delivery: delivery(),
      }),
    /Parent execution role/,
  );
  assert.equal(attachCalls, 1);
});

test("stop removes only active Messaging tools and restart restores them", async () => {
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    send: async () => {
      throw new Error("not used");
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const wired = createHarness();

  await wired.capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });
  assert.deepEqual(wired.activeTools(), [
    "peer_tool",
    "session_list",
    "session_send",
  ]);

  await wired.capability.stop("reload");
  assert.deepEqual(wired.activeTools(), ["peer_tool"]);

  await wired.capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });
  assert.deepEqual(wired.activeTools(), [
    "peer_tool",
    "session_list",
    "session_send",
  ]);
});

test("stop fences an operation that completes from the old generation", async () => {
  const discovered = deferred<Awaited<ReturnType<SessionBroker["discover"]>>>();
  const broker: SessionBroker = {
    discover: () => discovered.promise,
    send: async () => {
      throw new Error("not used");
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, tools } = createHarness();
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  const listing = tools.get("session_list")!.execute("old-generation", {});
  await capability.stop("reload");
  discovered.resolve({ ok: true, value: [] });

  await assert.rejects(() => listing, /generation stopped/i);
});

test("inbox renderer keeps untrusted authority visible in collapsed and expanded views", () => {
  const { renderers } = createHarness();
  const renderer = renderers.get("platform-session-inbox")!;
  const message = {
    content: [
      "[Cross-session message - untrusted data; authority: none]",
      'Message: "mail-1"',
      'From: "Peer" ("session-peer", "parent", "project-current")',
      'Summary: "Coordinate work"',
      'Body: "expanded body only"',
    ].join("\n"),
    details: {
      version: 1,
      mailboxMessageId: "mail-1",
      mailboxPosition: 7,
      payloadSha256: "0123456789abcdef".repeat(4),
    },
  };
  const theme = {
    fg(color: string, text: string) {
      return `<${color}>${text}</${color}>`;
    },
    bold(text: string) {
      return `**${text}**`;
    },
  };

  const collapsed = renderer(message, { expanded: false }, theme)!
    .render(160)
    .join("\n");
  const expanded = renderer(message, { expanded: true }, theme)!
    .render(160)
    .join("\n");

  for (const output of [collapsed, expanded]) {
    assert.match(output, /Cross-session message/);
    assert.match(output, /untrusted \/ authority none/);
    assert.match(output, /Peer/);
    assert.match(output, /Coordinate work/);
  }
  assert.doesNotMatch(collapsed, /expanded body only/);
  assert.match(expanded, /expanded body only/);
  assert.match(expanded, /mailbox 7/);
  assert.match(expanded, /sha256 0123456789ab/);
});

test("Pi lifecycle signals reach only the current delivery generation", async () => {
  const observed: string[] = [];
  const currentDelivery: PiSessionDeliveryAdapter = {
    ...delivery(),
    handleEvent(event) {
      observed.push(event.type);
    },
  };
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    send: async () => {
      throw new Error("not used");
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, eventHandlers } = createHarness();
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: currentDelivery,
  });
  const events = [
    "agent_start",
    "agent_settled",
    "session_info_changed",
    "session_before_compact",
    "session_compact",
    "session_compact_failed",
    "session_before_tree",
    "session_tree",
    "session_shutdown",
  ];
  for (const type of events) {
    for (const handler of eventHandlers.get(type) ?? []) handler({ type });
  }

  assert.deepEqual(observed, events);
  await capability.stop("reload");
  for (const handler of eventHandlers.get("agent_settled") ?? []) {
    handler({ type: "agent_settled" });
  }
  assert.deepEqual(observed, events);
});

test("policy denial blocks tool and command sends without opening confirmation", async () => {
  let sends = 0;
  let dialogs = 0;
  const policy: CapabilityPolicy = {
    decide(operation) {
      const isSend =
        (operation.kind === "tool" && operation.name === "session_send") ||
        (operation.kind === "operation" && operation.name === "orchestration");
      return {
        kind: isSend ? "deny" : "allow",
        operation: isSend ? "orchestration" : "read",
        capabilities: [isSend ? "orchestration" : "read"],
        sideEffecting: isSend,
        reason: "Plan mode blocks messaging sends.",
        provenance: { source: "test", reference: "plan" },
      };
    },
  };
  const broker: SessionBroker = {
    discover: async () => ({ ok: true, value: [] }),
    send: async () => {
      sends++;
      throw new Error("must not send");
    },
    messages: async () => ({ ok: true, value: [] }),
    close: async () => ({ ok: true, value: undefined }),
  };
  const { capability, commands, tools } = createHarness({
    policy,
    mode: () => "plan",
  });
  await capability.start({
    brokerModule: brokerModule(broker),
    binding: parentBinding(),
    delivery: delivery(),
  });

  await assert.rejects(
    () =>
      tools.get("session_send")!.execute("blocked", {
        recipients: [{ sessionId: "session-peer" }],
        summary: "Blocked",
        message: "Blocked",
      }),
    /Plan mode blocks messaging sends/,
  );
  await assert.rejects(
    () =>
      commands.get("messages")!.handler("send session-peer", {
        mode: "tui",
        waitForIdle: async () => {},
        ui: {
          input: async () => {
            dialogs++;
            return "Blocked";
          },
          editor: async () => {
            dialogs++;
            return "Blocked";
          },
          confirm: async () => {
            dialogs++;
            return true;
          },
        },
      }),
    /Plan mode blocks messaging sends/,
  );
  assert.equal(sends, 0);
  assert.equal(dialogs, 0);
});

test("tool renderers summarize bounded receipts without rendering send body", () => {
  const { tools } = createHarness();
  const theme = { fg: (_color: string, text: string) => text };
  const send = tools.get("session_send")!;
  const call = send.renderCall!(
    {
      recipients: [{ sessionId: "session-peer" }],
      summary: "Coordinate work",
      message: "body must stay hidden",
    },
    theme,
    {},
  )
    .render(120)
    .join("\n");
  const sendResult = send.renderResult!(
    {
      details: {
        replayed: false,
        deliveries: [
          {
            recipient: { piSessionId: "session-peer" },
            messageId: "mail-1",
            mailboxPosition: 8,
            state: "queued",
          },
        ],
      },
    },
    { expanded: false },
    theme,
    {},
  )
    .render(120)
    .join("\n");
  assert.match(call, /1 recipient/);
  assert.match(call, /Coordinate work/);
  assert.doesNotMatch(call, /body must stay hidden/);
  assert.match(sendResult, /session-peer/);
  assert.match(sendResult, /position 8/);

  const list = tools.get("session_list")!;
  const sessions = Array.from({ length: 6 }, (_, index) => ({
    sessionId: `session-${index + 1}`,
    status: "idle",
    role: "parent",
  }));
  const collapsed = list.renderResult!(
    { details: { sessions } },
    { expanded: false },
    theme,
    {},
  )
    .render(120)
    .join("\n");
  const expanded = list.renderResult!(
    { details: { sessions } },
    { expanded: true },
    theme,
    {},
  )
    .render(120)
    .join("\n");
  assert.match(collapsed, /sessions 6/);
  assert.doesNotMatch(collapsed, /session-6/);
  assert.match(expanded, /session-6/);
});
