import assert from "node:assert/strict";
import test from "node:test";
import type {
  CapabilityDecision,
  CapabilityOperation,
} from "./src/core/policy/index.ts";
import { createHostMemoryBindingFactory } from "./src/memory/index.ts";
import type {
  HostMemoryBindingAssertion,
  MemoryRecord,
  MemorySearchRequest,
  MemoryStore,
  MemoryStoreModule,
} from "./src/memory/model.ts";
import { createMemoryCapability } from "./src/wiring/memory.ts";

const project = {
  kind: "non-git" as const,
  projectId: "raw-project-key",
  requestedCwd: "C:/repo",
  canonicalCwd: "c:/repo",
  cwdWasAliased: false,
};

interface RegisteredMemoryTool {
  readonly name: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    parameters: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    context: unknown,
  ): Promise<{
    readonly content: readonly [
      { readonly type: "text"; readonly text: string },
    ];
    readonly details: unknown;
  }>;
  renderResult(
    result: unknown,
    options: unknown,
    theme: unknown,
    context: unknown,
  ): { render(width: number): string[] };
}

interface RegisteredMemoryCommand {
  handler(rawArgs: string, context: unknown): Promise<void>;
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    revision: 2,
    kind: { id: "pi/preference", version: 1 },
    scope: { kind: "project", projectId: project.projectId },
    content: "unused canonical content",
    citations: [],
    provenance: {
      ingress: "model-proposal",
      sessionId: "raw-session",
      executionRole: "parent",
    },
    confidence: 0.5,
    status: "active",
    relationships: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    trust: "untrusted",
    authority: "none",
    ...overrides,
  };
}

function harness(
  store: MemoryStore,
  overrides: {
    readonly decide?: (
      operation: CapabilityOperation,
      call: number,
    ) => CapabilityDecision;
    readonly id?: () => string;
    readonly stopTimeoutMs?: number;
  } = {},
) {
  const tools = new Map<string, RegisteredMemoryTool>();
  const commands = new Map<string, RegisteredMemoryCommand>();
  const bindings: HostMemoryBindingAssertion[] = [];
  const policyCalls: CapabilityOperation[] = [];
  let policyCall = 0;
  let activeTools = ["read"];
  const bindingFactory = createHostMemoryBindingFactory();
  const module: MemoryStoreModule = {
    bind(binding) {
      return store;
    },
  };
  const capability = createMemoryCapability(
    {
      registerTool(tool: RegisteredMemoryTool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: RegisteredMemoryCommand) {
        commands.set(name, command);
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(next: string[]) {
        activeTools = [...next];
      },
    } as never,
    {
      role: "parent",
      policy: {
        decide(operation) {
          policyCalls.push(operation);
          policyCall += 1;
          if (overrides.decide) return overrides.decide(operation, policyCall);
          return {
            kind: "allow",
            operation: "read",
            capabilities: ["read"],
            sideEffecting: false,
            reason: "test",
            provenance: { source: "test", reference: "test" },
          };
        },
      },
      mode: () => ({ kind: "normal" }),
      bindings: {
        issue(assertion) {
          bindings.push(assertion);
          return bindingFactory.issue(assertion);
        },
      },
      clock: () => 1_800_000_000_000,
      id: overrides.id ?? (() => "request-1"),
      stopTimeoutMs: overrides.stopTimeoutMs,
    },
  );
  capability.start({ module, project, defaultScope: "project" });
  return {
    activeTools: () => activeTools,
    bindings,
    capability,
    command(name: string) {
      const command = commands.get(name);
      assert.ok(command);
      return command;
    },
    commands,
    policyCalls,
    tool(name: string) {
      const tool = tools.get(name);
      assert.ok(tool);
      return tool;
    },
    tools,
  };
}

test("Memory wiring registers only memory_search for the model and returns bounded untrusted recall", async () => {
  let searchRequest: MemorySearchRequest | undefined;
  const store: MemoryStore = {
    remember: async () => assert.fail("remember must not be model-callable"),
    async search(request) {
      searchRequest = request;
      return {
        ok: true,
        value: [
          {
            memory: memory(),
            rank: 1,
            excerpt: "first line\nsecond line",
            reasons: ["exact"],
          },
        ],
      };
    },
    inspect: async () => assert.fail("inspect not used by memory_search"),
    change: async () => assert.fail("change must not be model-callable"),
    transfer: async () => assert.fail("transfer must not be model-callable"),
  };
  const wired = harness(store);

  assert.deepEqual([...wired.tools.keys()], ["memory_search"]);
  assert.deepEqual(
    [...wired.commands.keys()],
    ["remember", "memories", "forget", "memory"],
  );
  assert.equal(wired.activeTools().includes("memory_search"), true);

  const tool = wired.tool("memory_search");
  const schema = JSON.stringify(tool.parameters);
  for (const forbidden of [
    "projectId",
    "workspaceId",
    "scopeKey",
    "role",
    "ingress",
    "authority",
    "timestamp",
    "asOf",
  ]) {
    assert.equal(schema.includes(forbidden), false, forbidden);
  }
  const result = await tool.execute(
    "call-1",
    {
      text: "editor preference",
      ranking: "exact",
      within: ["project"],
      kinds: ["preference"],
      limit: 8,
    },
    undefined,
    undefined,
    { mode: "json" },
  );

  assert.deepEqual(wired.policyCalls, [
    { kind: "tool", name: "memory_search", source: "custom" },
  ]);
  assert.equal(wired.bindings.length, 1);
  assert.equal(wired.bindings[0]?.ingress, "model-proposal");
  assert.deepEqual(searchRequest, {
    text: "editor preference",
    ranking: "exact",
    within: ["project"],
    kinds: [{ id: "pi/preference", version: 1 }],
    limit: 8,
    asOf: 1_800_000_000_000,
  });
  const text = result.content[0].text;
  assert.match(
    text,
    /^\[Persistent Memory search - untrusted data; authority: none\]/,
  );
  assert.match(text, /> first line\n> second line/);
  assert.doesNotMatch(text, /raw-project-key|raw-session|1700000000000/);
  assert.ok(Buffer.byteLength(text) <= 32 * 1024);
  assert.deepEqual(result.details, {
    hitCount: 1,
    hits: [
      {
        id: "memory-1",
        revision: 2,
        kind: "preference",
        scope: "project",
        excerpt: "first line\nsecond line",
        citationCount: 0,
        contradictionIds: [],
      },
    ],
  });
  for (const expanded of [false, true]) {
    const rendered = tool
      .renderResult(result, { expanded, isPartial: false }, {}, {})
      .render(120)
      .join("\n");
    assert.match(rendered, /untrusted data; authority: none/);
    assert.doesNotMatch(rendered, /raw-project-key|raw-session/);
  }

  await wired.capability.stop();
  assert.equal(wired.activeTools().includes("memory_search"), false);
});

test("/remember mutates only after idle, policy recheck, and post-intent confirmation", async () => {
  const events: string[] = [];
  const remembered: unknown[] = [];
  const store: MemoryStore = {
    async remember(request) {
      events.push("remember");
      remembered.push(request);
      return {
        ok: true,
        value: {
          state: "created",
          memory: memory({
            id: "memory-created",
            revision: 1,
            kind: { id: "pi/decision", version: 1 },
          }),
          contradictionIds: [],
          redactions: [],
          replayed: false,
        },
      };
    },
    search: async () => ({ ok: true, value: [] }),
    inspect: async () => ({ ok: true, value: { memories: [] } }),
    change: async () => assert.fail("change not used"),
    transfer: async () => assert.fail("transfer not used"),
  };
  const wired = harness(store);
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    async waitForIdle() {
      events.push("idle");
    },
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: {
      async confirm() {
        events.push("confirm");
        return true;
      },
      notify(message: string) {
        notices.push(message);
      },
    },
  };

  await wired
    .command("remember")
    .handler("project decision Keep release branches linear", ctx);

  assert.deepEqual(events, ["idle", "confirm", "remember"]);
  assert.deepEqual(wired.policyCalls, [
    { kind: "operation", name: "local-write" },
    { kind: "operation", name: "local-write" },
  ]);
  assert.equal(wired.bindings.length, 1);
  assert.deepEqual(wired.bindings[0], {
    executionRole: "parent",
    project,
    ingress: "direct-user",
    sessionId: "pi-session-1",
  });
  assert.deepEqual(remembered, [
    {
      requestId: "request-1",
      kind: { id: "pi/decision", version: 1 },
      scope: "project",
      content: "Keep release branches linear",
    },
  ]);
  assert.match(notices[0] ?? "", /memory-created.*revision 1/i);

  const declined = harness(store);
  await declined
    .command("remember")
    .handler("project decision Do not persist this", {
      ...ctx,
      ui: { ...ctx.ui, confirm: async () => false },
    });
  assert.equal(declined.bindings.length, 0);
  assert.equal(remembered.length, 1);
});

test("confirmed writes fail closed when policy changes before binding", async () => {
  let writes = 0;
  const store: MemoryStore = {
    remember: async () => {
      writes += 1;
      return assert.fail("policy must block write");
    },
    search: async () => assert.fail("not reached"),
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store, {
    decide: (_operation, call) => ({
      kind: call === 1 ? "allow" : "deny",
      operation: "local-write",
      capabilities: ["local-write"],
      sideEffecting: true,
      reason: "policy changed",
      provenance: { source: "test", reference: "changed" },
    }),
  });

  await assert.rejects(
    wired.command("remember").handler("project decision Recheck me", {
      mode: "tui",
      hasUI: true,
      waitForIdle: async () => {},
      sessionManager: { getSessionId: () => "pi-session-1" },
      ui: { confirm: async () => true },
    }),
    /policy changed/,
  );
  assert.equal(writes, 0);
  assert.equal(wired.bindings.length, 0);
});

test("/memories lists and searches through friendly selectors without exposing host metadata", async () => {
  const inspected: unknown[] = [];
  const searched: unknown[] = [];
  const store: MemoryStore = {
    remember: async () => assert.fail("remember not used"),
    async search(request) {
      searched.push(request);
      return {
        ok: true,
        value: [
          {
            memory: memory(),
            rank: 0.8,
            excerpt: "Use a compact editor",
            reasons: ["lexical"],
          },
        ],
      };
    },
    async inspect(request) {
      inspected.push(request);
      return { ok: true, value: { memories: [memory()] } };
    },
    change: async () => assert.fail("change not used"),
    transfer: async () => assert.fail("transfer not used"),
  };
  const wired = harness(store);
  const notices: string[] = [];
  let idle = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {
      idle += 1;
    },
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: { notify: (message: string) => notices.push(message) },
  };

  await wired
    .command("memories")
    .handler("project active kind preference after next-page", ctx);
  await wired.command("memories").handler("search compact editor", ctx);

  assert.equal(idle, 2);
  assert.deepEqual(inspected, [
    {
      scope: "project",
      status: "active",
      kind: { id: "pi/preference", version: 1 },
      cursor: "next-page",
      limit: 25,
    },
  ]);
  assert.deepEqual(searched, [
    {
      text: "compact editor",
      within: ["project", "user"],
      limit: 8,
      asOf: 1_800_000_000_000,
    },
  ]);
  assert.deepEqual(
    wired.bindings.map(({ ingress }) => ingress),
    ["model-proposal", "model-proposal"],
  );
  assert.equal(wired.policyCalls.length, 2);
  assert.ok(
    notices.every((notice) =>
      notice.includes("untrusted data; authority: none"),
    ),
  );
  assert.ok(
    notices.every(
      (notice) =>
        !/raw-project-key|raw-session|parent|model-proposal|1700000000/.test(
          notice,
        ),
    ),
  );
});

test("all Memory commands reject RPC, JSON, and print modes explicitly", async () => {
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    search: async () => assert.fail("not reached"),
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store);
  for (const mode of ["rpc", "json", "print"] as const) {
    for (const command of wired.commands.values()) {
      await assert.rejects(
        command.handler("", { mode, hasUI: mode === "rpc" }),
        /require TUI mode/,
      );
    }
  }
});

test("workspace search fails without a verified lease and never falls back", async () => {
  let searches = 0;
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    search: async () => {
      searches += 1;
      return { ok: true, value: [] };
    },
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store);
  await assert.rejects(
    wired
      .tool("memory_search")
      .execute(
        "call-workspace",
        { text: "query", within: ["workspace"] },
        undefined,
        undefined,
        { mode: "json" },
      ),
    /Workspace Memory is unavailable/,
  );
  assert.equal(searches, 0);
  assert.equal(wired.bindings.length, 0);
});

test("/forget confirms inspected revision before issuing direct-user deletion", async () => {
  const changes: unknown[] = [];
  let confirms = 0;
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    search: async () => assert.fail("not reached"),
    inspect: async (request) => ({
      ok: true,
      value: {
        memories:
          "id" in request && request.id === "memory-1" ? [memory()] : [],
      },
    }),
    async change(request) {
      changes.push(request);
      return {
        ok: true,
        value: {
          type: "forget",
          id: "memory-1",
          forgottenAt: 1_900_000_000_000,
          replayed: false,
        },
      };
    },
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store);
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: {
      async confirm(_title: string, message: string) {
        confirms += 1;
        assert.match(message, /memory-1.*revision 2/is);
        assert.match(message, /managed deletion/i);
        assert.doesNotMatch(message, /raw-project-key|1700000000/);
        return true;
      },
      notify: (message: string) => notices.push(message),
    },
  };

  await wired.command("forget").handler("memory-1", ctx);

  assert.equal(confirms, 1);
  assert.deepEqual(changes, [
    {
      type: "forget",
      requestId: "request-1",
      id: "memory-1",
      expectedRevision: 2,
    },
  ]);
  assert.deepEqual(
    wired.bindings.map(({ ingress }) => ingress),
    ["model-proposal", "direct-user"],
  );
  assert.match(notices[0] ?? "", /memory-1.*forgotten/i);
  assert.doesNotMatch(notices[0] ?? "", /1900000000000/);

  const declined = harness(store);
  await declined.command("forget").handler("memory-1", {
    ...ctx,
    ui: { ...ctx.ui, confirm: async () => false },
  });
  assert.equal(changes.length, 1);
  assert.deepEqual(
    declined.bindings.map(({ ingress }) => ingress),
    ["model-proposal"],
  );
});

test("/memory edit uses exact revisions and separately confirms review activation", async () => {
  const changes: unknown[] = [];
  let nextRequest = 0;
  const reviewed = memory({ status: "review", content: "Old content" });
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    search: async () => assert.fail("not reached"),
    inspect: async () => ({ ok: true, value: { memories: [reviewed] } }),
    async change(request) {
      changes.push(request);
      if (request.type === "replace")
        return {
          ok: true,
          value: {
            type: "replace",
            memory: memory({
              revision: 3,
              status: "review",
              content: request.content,
            }),
            replayed: false,
          },
        };
      if (request.type === "promote")
        return {
          ok: true,
          value: {
            type: "promote",
            memory: memory({ revision: 4, content: "New content" }),
            replayed: false,
          },
        };
      return assert.fail("forget not used");
    },
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store, {
    id: () => `request-${++nextRequest}`,
  });
  const confirmationTitles: string[] = [];
  await wired.command("memory").handler("edit memory-1", {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: {
      editor: async (_title: string, prefill: string) => {
        assert.equal(prefill, "Old content");
        return "New content";
      },
      async confirm(title: string) {
        confirmationTitles.push(title);
        return true;
      },
      notify() {},
    },
  });

  assert.deepEqual(confirmationTitles, [
    "Replace this Memory?",
    "Activate reviewed Memory?",
  ]);
  assert.deepEqual(changes, [
    {
      type: "replace",
      requestId: "request-1",
      id: "memory-1",
      expectedRevision: 2,
      content: "New content",
    },
    {
      type: "promote",
      requestId: "request-2",
      id: "memory-1",
      expectedRevision: 3,
    },
  ]);
  assert.deepEqual(
    wired.bindings.map(({ ingress }) => ingress),
    ["model-proposal", "direct-user", "direct-user"],
  );
});

test("/memory import confirms preview and commit as separate durable operations", async () => {
  const transfers: unknown[] = [];
  let nextRequest = 0;
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    search: async () => assert.fail("not reached"),
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    async transfer(request) {
      transfers.push(request);
      if (request.type === "preview-import")
        return {
          ok: true,
          value: {
            type: "preview-import",
            previewId: "preview-1",
            manifestSha256: "a".repeat(64),
            accepted: 3,
            duplicates: 1,
            contradictions: 1,
            unsupportedKinds: 0,
            expiresAt: 1_900_000_000_000,
            replayed: false,
          },
        };
      if (request.type === "commit-import")
        return {
          ok: true,
          value: {
            type: "commit-import",
            imported: 2,
            reviewRequired: 1,
            skipped: 0,
            replayed: false,
          },
        };
      return assert.fail("export not used");
    },
  };
  const wired = harness(store, {
    id: () => `request-${++nextRequest}`,
  });
  const titles: string[] = [];
  const notices: string[] = [];
  await wired.command("memory").handler("import artifact-1 project", {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: {
      async confirm(title: string) {
        titles.push(title);
        return true;
      },
      select: async () => "review",
      notify: (message: string) => notices.push(message),
    },
  });

  assert.deepEqual(titles, ["Preview Memory import?", "Commit Memory import?"]);
  assert.deepEqual(transfers, [
    {
      type: "preview-import",
      requestId: "request-1",
      artifactId: "artifact-1",
      targetScope: "project",
    },
    {
      type: "commit-import",
      requestId: "request-2",
      previewId: "preview-1",
      expectedManifestSha256: "a".repeat(64),
      collisions: "review",
    },
  ]);
  assert.deepEqual(
    wired.bindings.map(({ ingress }) => ingress),
    ["direct-user", "direct-user"],
  );
  assert.ok(notices.every((notice) => !notice.includes("1900000000000")));

  const declined = harness(store);
  await declined.command("memory").handler("import artifact-2 user", {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: { confirm: async () => false },
  });
  assert.equal(declined.bindings.length, 0);
  assert.equal(transfers.length, 2);
});

test("/memory export confirms an independent artifact without accepting a path", async () => {
  const transfers: unknown[] = [];
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    search: async () => assert.fail("not reached"),
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    async transfer(request) {
      transfers.push(request);
      if (request.type !== "export") return assert.fail("import not used");
      return {
        ok: true,
        value: {
          type: "export",
          artifact: {
            id: "artifact-export",
            sha256: "b".repeat(64),
            size: 321,
            createdAt: 1_900_000_000_000,
          },
          count: 4,
          replayed: false,
        },
      };
    },
  };
  const wired = harness(store);
  const notices: string[] = [];
  await wired.command("memory").handler("export user kind procedure", {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => "pi-session-1" },
    ui: {
      async confirm(_title: string, message: string) {
        assert.match(message, /independent copy/i);
        return true;
      },
      notify: (message: string) => notices.push(message),
    },
  });

  assert.deepEqual(transfers, [
    {
      type: "export",
      requestId: "request-1",
      format: { id: "pi.memory-bundle", version: 1 },
      scopes: ["user"],
      kinds: [{ id: "pi/procedure", version: 1 }],
    },
  ]);
  assert.match(notices[0] ?? "", /artifact-export/);
  assert.match(notices[0] ?? "", new RegExp("b{64}"));
  assert.doesNotMatch(notices[0] ?? "", /1900000000000/);
});

test("stop aborts and drains tracked search operations", async () => {
  let observedSignal: AbortSignal | undefined;
  let releaseCleanup: (() => void) | undefined;
  let reportAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    reportAbort = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const store: MemoryStore = {
    remember: async () => assert.fail("not reached"),
    async search(_request, signal) {
      observedSignal = signal;
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      reportAbort?.();
      await cleanup;
      return {
        ok: false,
        error: {
          code: "cancelled",
          message: "cancelled",
          retryable: false,
        },
      };
    },
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store);
  const running = wired
    .tool("memory_search")
    .execute("call-stop", { text: "query" }, undefined, undefined, {
      mode: "json",
    });
  await new Promise((resolve) => setTimeout(resolve, 0));

  let stopSettled = false;
  const stopping = wired.capability.stop().then(() => {
    stopSettled = true;
  });
  await aborted;

  assert.equal(observedSignal?.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopSettled, false);
  releaseCleanup?.();
  await stopping;
  await assert.rejects(running, /cancelled|generation stopped/);
  await assert.rejects(
    wired
      .tool("memory_search")
      .execute("call-late", { text: "query" }, undefined, undefined, {
        mode: "json",
      }),
    /unavailable/,
  );
});

test("stale confirmed command cannot bind or update UI after bounded stop", async () => {
  let releaseConfirm: ((confirmed: boolean) => void) | undefined;
  let enteredConfirm: (() => void) | undefined;
  const confirming = new Promise<void>((resolve) => {
    enteredConfirm = resolve;
  });
  const store: MemoryStore = {
    remember: async () => assert.fail("stale command must not write"),
    search: async () => assert.fail("not reached"),
    inspect: async () => assert.fail("not reached"),
    change: async () => assert.fail("not reached"),
    transfer: async () => assert.fail("not reached"),
  };
  const wired = harness(store, { stopTimeoutMs: 5 });
  const notices: string[] = [];
  const running = wired
    .command("remember")
    .handler("project decision Stale intent", {
      mode: "tui",
      hasUI: true,
      waitForIdle: async () => {},
      sessionManager: { getSessionId: () => "pi-session-1" },
      ui: {
        confirm: async () => {
          enteredConfirm?.();
          return new Promise<boolean>((resolve) => {
            releaseConfirm = resolve;
          });
        },
        notify: (message: string) => notices.push(message),
      },
    });
  await confirming;

  await wired.capability.stop();
  releaseConfirm?.(true);

  await assert.rejects(running, /generation stopped/);
  assert.equal(wired.bindings.length, 0);
  assert.deepEqual(notices, []);
});
