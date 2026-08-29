import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCapabilityPolicy,
  type CapabilityPolicy,
} from "./src/core/policy/index.ts";
import {
  createHooks,
  createNamedHookHttpAdapter,
  createTriggerEngine,
  platformHookEvents,
  type HookProcessResult,
} from "./src/automation/hooks/index.ts";
import { createExternalIntegrationControls } from "./src/external/index.ts";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-hooks-phase7-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const allowPolicy = createCapabilityPolicy();

const allowEverything: CapabilityPolicy = {
  decide() {
    return {
      kind: "allow",
      operation: "read",
      capabilities: ["read"],
      sideEffecting: false,
      reason: "fixture allow",
      provenance: { source: "fixture", reference: "allow" },
    };
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function processResult(): HookProcessResult {
  return {
    stdout: "recorded",
    stderr: "",
    totalBytes: 8,
    stdoutBytes: 8,
    stderrBytes: 0,
    truncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    spillLimitExceeded: false,
    code: 0,
    signal: null,
    killed: false,
  };
}

test("legacy TriggerEngine rejects v2 actions instead of silently dropping actions", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: incompatible
    event: tool_call
    priority: 0
    match: {}
    actions:
      - { type: command, executable: fixture, args: [] }
      - { type: policy, decision: deny, reason: must-not-disappear }
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );

    const engine = createTriggerEngine();
    const validation = await engine.validate([{ scope: "global", path }]);
    assert.equal(validation.valid, false);
    assert.ok(
      validation.diagnostics.some(
        ({ code }) => code === "v2-requires-create-hooks",
      ),
    );
    const started = await engine.start([{ scope: "global", path }]);
    assert.equal(started.applied, false);
    assert.deepEqual(engine.inspect().hooks, []);
  });
});

test("legacy TriggerEngine sanitizes host-facing v1 effects", async () => {
  const engine = createTriggerEngine();
  assert.equal(
    engine.register({
      hook: {
        id: "legacy-safe",
        event: "agent_end",
        priority: 0,
        match: {},
        action: {
          type: "notify",
          message: "\u001b[31mALERT\u001b[0m\u0007",
          level: "warning",
        },
        timeoutMs: 500,
        outputCapBytes: 1024,
        failurePolicy: "open",
      },
      provenance: {
        scope: "runtime",
        source: "fixture",
        trusted: true,
      },
    }).accepted,
    true,
  );
  await engine.start();
  const dispatched = await engine.dispatch({
    event: "agent_end",
    mode: "normal",
    payload: {},
  });
  assert.equal(dispatched.effects[0]?.type, "notify");
  const effect = dispatched.effects[0];
  if (effect?.type === "notify") assert.equal(effect.message, "ALERT");
});

test("concurrent apply commands serialize expected revisions so only one snapshot commits", async () => {
  await fixture(async (directory) => {
    const firstPath = join(directory, "first.yaml");
    const secondPath = join(directory, "second.yaml");
    const yaml = (id: string) => `version: 1
hooks:
  - id: ${id}
    event: agent_end
    priority: 0
    match: {}
    action: { type: notify, message: ${id}, level: info }
    timeoutMs: 500
    outputCapBytes: 1024
    failurePolicy: open
`;
    await Promise.all([
      writeFile(firstPath, yaml("first"), "utf8"),
      writeFile(secondPath, yaml("second"), "utf8"),
    ]);
    let releaseTrust!: () => void;
    const trustGate = new Promise<void>((resolve) => {
      releaseTrust = resolve;
    });
    let firstTrustStarted!: () => void;
    const trustStarted = new Promise<void>((resolve) => {
      firstTrustStarted = resolve;
    });
    let trustCalls = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: {
        async isTrusted() {
          trustCalls++;
          if (trustCalls === 1) {
            firstTrustStarted();
            await trustGate;
          }
          return true;
        },
      },
    });

    const first = hooks.configure({
      type: "apply",
      expectedRevision: 0,
      sources: [{ scope: "global", path: firstPath }],
    });
    await trustStarted;
    const second = hooks.configure({
      type: "apply",
      expectedRevision: 0,
      sources: [{ scope: "global", path: secondPath }],
    });
    releaseTrust();
    const results = await Promise.all([first, second]);

    assert.equal(results.filter(({ ok }) => ok).length, 1);
    const rejected = results.find(({ ok }) => !ok);
    assert.equal(rejected?.ok, false);
    if (rejected && !rejected.ok) {
      assert.equal(rejected.error.code, "STALE_REVISION");
    }
    const inspection = hooks.inspect();
    assert.equal(inspection.revision, 1);
    assert.equal(inspection.hooks.length, 1);
    assert.ok(["first", "second"].includes(inspection.hooks[0]?.id ?? ""));
  });
});

test("Hooks compiles v1 action and v2 actions, then executes deterministic hook/action order", async () => {
  await fixture(async (directory) => {
    const v1Path = join(directory, "v1.yaml");
    const v2Path = join(directory, "v2.yaml");
    await writeFile(
      v1Path,
      `version: 1
hooks:
  - id: legacy
    event: tool_call
    priority: 20
    match: {}
    action: { type: notify, message: legacy, level: info }
    timeoutMs: 100
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    await writeFile(
      v2Path,
      `version: 2
hooks:
  - id: multi
    event: tool_call
    priority: 10
    match: {}
    actions:
      - { type: notify, message: first, level: info }
      - { type: command, executable: git, args: [status, --short] }
      - { type: notify, message: third, level: warning }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );

    const calls: string[] = [];
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowPolicy,
      trust: {
        isTrusted: async () => true,
      },
      adapters: {
        command: {
          async run(request) {
            calls.push(
              `command:${request.executable}:${request.args.join(" ")}`,
            );
            return processResult();
          },
          async shutdown() {},
        },
        ui: {
          notify(message, level) {
            calls.push(`notify:${level}:${message}`);
          },
          setStatus(key, text) {
            calls.push(`status:${key}:${text ?? ""}`);
          },
          async confirm() {
            calls.push("confirm");
            return true;
          },
        },
      },
    });
    const sources = [
      { scope: "global" as const, path: v1Path },
      { scope: "global" as const, path: v2Path },
    ];

    const validation = await hooks.configure({ type: "validate", sources });
    assert.equal(
      validation.ok,
      true,
      validation.ok ? "" : JSON.stringify(validation.error),
    );
    if (validation.ok) {
      assert.equal(validation.value.applied, false);
      assert.equal(validation.value.hookCount, 2);
    }

    const configured = await hooks.configure({ type: "apply", sources });
    assert.equal(
      configured.ok,
      true,
      configured.ok ? "" : JSON.stringify(configured.error),
    );
    if (configured.ok) assert.equal(configured.value.revision, 1);

    const handled = await hooks.handle({
      event: "tool_call",
      payload: { toolName: "bash" },
      cwd: directory,
      unattended: false,
    });
    assert.equal(handled.ok, true);
    if (handled.ok) assert.deepEqual(handled.value, { context: [] });
    assert.deepEqual(calls, [
      "notify:info:first",
      "command:git:status --short",
      "notify:warning:third",
      "notify:info:legacy",
    ]);
  });
});

test("typed platform hook events cover Phase 7 producers without Goal Engine events", () => {
  for (const prefix of [
    "worktree.",
    "subagent.",
    "task.",
    "monitor.",
    "schedule.",
  ]) {
    assert.ok(platformHookEvents.some((event) => event.startsWith(prefix)));
  }
  assert.equal(
    platformHookEvents.some((event) => event.startsWith("goal.")),
    false,
  );
});

test("named HTTP, MCP, and Agent Profile adapters stay lazy and raw authority fields are rejected", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: integrations
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: http, name: build-status, input: { build: 42 } }
      - { type: mcp, name: github.get_pull, input: { number: 7 } }
      - { type: agent, profile: reviewer, prompt: Review completed work }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const calls: string[] = [];
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: async () => true },
      adapters: {
        http: {
          classify: () => "network-read",
          async invoke(request) {
            calls.push(`http:${request.name}`);
            return { output: "ok" };
          },
        },
        mcp: {
          async invoke(request) {
            calls.push(`mcp:${request.name}`);
            return { output: "ok" };
          },
        },
        agent: {
          async run(request) {
            calls.push(`agent:${request.name}`);
            return { output: "ok" };
          },
        },
      },
    });
    const source = { scope: "global" as const, path };
    assert.equal(
      (await hooks.configure({ type: "apply", sources: [source] })).ok,
      true,
    );

    await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.deepEqual(calls, [], "unmatched hooks must not resolve adapters");

    const handled = await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(handled.ok, true);
    assert.deepEqual(calls, [
      "http:build-status",
      "mcp:github.get_pull",
      "agent:reviewer",
    ]);

    await writeFile(
      path,
      `version: 2
hooks:
  - id: unsafe
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: http, name: build-status, headers: { Authorization: raw } }
      - { type: monitor, name: recursive-daemon }
      - { type: schedule, name: recursive-timer }
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const rejected = await hooks.configure({
      type: "validate",
      sources: [source],
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      const codes = rejected.error.diagnostics?.map(({ code }) => code) ?? [];
      assert.ok(codes.includes("invalid-action-field"));
      assert.ok(codes.includes("invalid-action"));
    }

    await writeFile(
      path,
      `version: 2
hooks:
  - id: raw-credential
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: http, name: build-status, input: { value: "Bearer NEVER_LOG_THIS" } }
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const rawCredential = await hooks.configure({
      type: "validate",
      sources: [source],
    });
    assert.equal(rawCredential.ok, false);
    if (!rawCredential.ok) {
      assert.ok(
        rawCredential.error.diagnostics?.some(
          ({ code }) => code === "raw-authority-forbidden",
        ),
      );
    }
  });
});

test("closed failure policy is accepted only for gate events", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
    });
    const source = { scope: "global" as const, path };
    const yaml = (event: string) => `version: 2
hooks:
  - id: closed
    event: ${event}
    priority: 0
    match: {}
    actions: [{ type: command, executable: git, args: [status] }]
    concurrency: 1
    deadlineMs: 100
    outputCapBytes: 1024
    failurePolicy: closed
`;

    await writeFile(path, yaml("agent_end"), "utf8");
    const observe = await hooks.configure({
      type: "validate",
      sources: [source],
    });
    assert.equal(observe.ok, false);
    if (!observe.ok) {
      assert.ok(
        observe.error.diagnostics?.some(
          ({ code }) => code === "invalid-failure-policy",
        ),
      );
    }

    await writeFile(path, yaml("tool_call"), "utf8");
    assert.equal(
      (await hooks.configure({ type: "validate", sources: [source] })).ok,
      true,
    );
  });
});

test("Hooks rechecks trust and CapabilityPolicy immediately before actions", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: guarded
    event: tool_call
    priority: 0
    match: {}
    actions:
      - { type: notify, message: first, level: info }
      - { type: notify, message: second, level: info }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    let trustChecks = 0;
    let checkingActions = false;
    let policyChecks = 0;
    const calls: string[] = [];
    const policy: CapabilityPolicy = {
      decide() {
        policyChecks++;
        return {
          kind: "allow",
          operation: "local-write",
          capabilities: ["local-write"],
          sideEffecting: true,
          reason: "allowed",
          provenance: { source: "fixture", reference: "allow" },
        };
      },
    };
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy,
      trust: {
        isTrusted() {
          if (!checkingActions) return true;
          trustChecks++;
          return trustChecks === 1;
        },
      },
      adapters: {
        ui: {
          notify(message) {
            calls.push(message);
          },
          setStatus() {},
          async confirm() {
            return true;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    checkingActions = true;
    trustChecks = 0;

    await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.deepEqual(calls, ["first"]);
    assert.equal(trustChecks, 2);
    assert.equal(policyChecks, 1);
  });
});

test("Plan Mode and unattended confirmation block side effects; attended approval is rechecked", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: command
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: command, executable: git, args: [status] }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const source = { scope: "global" as const, path };
    let mode: "normal" | "plan" = "plan";
    let executions = 0;
    let confirmations = 0;
    let policyChecks = 0;
    const confirmationPolicy: CapabilityPolicy = {
      decide() {
        policyChecks++;
        return {
          kind: "require-user-confirmation",
          operation: "process",
          capabilities: ["process"],
          sideEffecting: true,
          reason: "confirm command",
          provenance: { source: "fixture", reference: "confirm" },
        };
      },
    };
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => mode,
      policy: confirmationPolicy,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          async run() {
            executions++;
            return processResult();
          },
          async shutdown() {},
        },
        ui: {
          notify() {},
          setStatus() {},
          async confirm() {
            confirmations++;
            return true;
          },
        },
      },
    });
    assert.equal(
      (await hooks.configure({ type: "apply", sources: [source] })).ok,
      true,
    );

    const planned = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(planned.ok, true);
    if (planned.ok)
      assert.match(planned.value.block?.reason ?? "", /Plan Mode/i);
    assert.equal(executions, 0);
    assert.equal(confirmations, 0);

    mode = "normal";
    const unattended = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: true,
    });
    assert.equal(unattended.ok, true);
    if (unattended.ok)
      assert.match(unattended.value.block?.reason ?? "", /confirm command/);
    assert.equal(executions, 0);
    assert.equal(confirmations, 0);

    const attended = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(attended.ok, true);
    if (attended.ok) assert.equal(attended.value.block, undefined);
    assert.equal(executions, 1);
    assert.equal(confirmations, 1);
    assert.equal(
      policyChecks,
      3,
      "one unattended check plus two attended checks",
    );
  });
});

test("named POST actions are remote writes and issue no request in Plan Mode", async () => {
  await fixture(async (directory) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const origin = `http://plan-hook.example.test:${port}`;
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: plan-post
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: http, name: publish, input: { build: 42 } }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const adapter = createNamedHookHttpAdapter({
      definitions: [
        {
          id: "publish",
          url: `${origin}/status`,
          method: "POST",
          effect: "remote-write",
          allowedOrigins: [origin],
          allowLoopback: true,
        },
      ],
      controls: createExternalIntegrationControls({
        resolveHost: async () => ["127.0.0.1"],
      }),
      actor: () => "parent",
      mode: () => "plan",
    });
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "plan",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: { http: adapter },
    });
    try {
      assert.equal(adapter.classify("publish"), "remote-write");
      assert.equal(
        (
          await hooks.configure({
            type: "apply",
            sources: [{ scope: "global", path }],
          })
        ).ok,
        true,
      );
      const handled = await hooks.handle({
        event: "tool_call",
        payload: {},
        cwd: directory,
        unattended: false,
      });
      assert.equal(handled.ok, true);
      if (handled.ok)
        assert.match(handled.value.block?.reason ?? "", /Plan Mode/i);
      assert.equal(requests, 0);
    } finally {
      await hooks.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("default-policy confirmation authorizes one named POST end to end", async () => {
  await fixture(async (directory) => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      assert.equal(request.method, "POST");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const origin = `http://confirmed-hook.example.test:${port}`;
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: confirmed-named-post
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: http, name: publish, input: { build: 42 } }]
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const grants = new Map<string, { scope: string; deadlineMs: number }>();
    const controls = createExternalIntegrationControls({
      resolveHost: async () => ["127.0.0.1"],
      authority: {
        verify(token) {
          const grant = grants.get(token.value);
          if (!grant) return false;
          grants.delete(token.value);
          return token.scope === grant.scope && Date.now() <= grant.deadlineMs;
        },
      },
    });
    let confirmations = 0;
    const adapter = createNamedHookHttpAdapter({
      definitions: [
        {
          id: "publish",
          url: `${origin}/status`,
          method: "POST",
          effect: "remote-write",
          allowedOrigins: [origin],
          allowLoopback: true,
        },
      ],
      controls,
      actor: () => "parent",
      mode: () => "normal",
      issueAuthority(grant) {
        const value = `confirmed-${grants.size + 1}`;
        grants.set(value, grant);
        return {
          kind: "external-user-authority",
          value,
          scope: grant.scope,
        };
      },
    });
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: createCapabilityPolicy(),
      trust: { isTrusted: () => true },
      adapters: {
        http: adapter,
        ui: {
          notify() {},
          setStatus() {},
          async confirm() {
            confirmations++;
            return true;
          },
        },
      },
    });
    try {
      assert.equal(
        (
          await hooks.configure({
            type: "apply",
            sources: [{ scope: "global", path }],
          })
        ).ok,
        true,
      );
      const handled = await hooks.handle({
        event: "tool_call",
        payload: {},
        cwd: directory,
        unattended: false,
      });
      assert.equal(handled.ok, true);
      if (handled.ok) assert.equal(handled.value.block, undefined);
      assert.equal(confirmations, 1);
      assert.equal(requests, 1);
      assert.equal(grants.size, 0);
    } finally {
      await hooks.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("confirmed HTTP writes receive one exact generation-bound authority", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: confirmed-http
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: http, name: publish, input: { build: 42 } }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const authority = {
      kind: "external-user-authority" as const,
      value: "one-shot",
      scope: "exact-http-operation",
    };
    let confirmations = 0;
    let authorizations = 0;
    let invocations = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: createCapabilityPolicy(),
      trust: { isTrusted: () => true },
      adapters: {
        ui: {
          notify() {},
          setStatus() {},
          async confirm() {
            confirmations++;
            return true;
          },
        },
        http: {
          classify: () => "remote-write",
          authorize(request) {
            authorizations++;
            assert.equal(request.name, "publish");
            assert.deepEqual(request.input, { build: 42 });
            assert.equal(request.generation, 1);
            return authority;
          },
          async invoke(request) {
            invocations++;
            assert.equal(request.authority, authority);
            assert.equal(request.generation, 1);
            return { output: "ok" };
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    const handled = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(handled.ok, true);
    if (handled.ok) assert.equal(handled.value.block, undefined);
    assert.equal(confirmations, 1);
    assert.equal(authorizations, 1);
    assert.equal(invocations, 1);
  });
});

test("HTTP writes without exact authority support fail before prompting", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: unsupported-http-confirmation
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: http, name: publish }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    let confirmations = 0;
    let invocations = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: createCapabilityPolicy(),
      trust: { isTrusted: () => true },
      adapters: {
        ui: {
          notify() {},
          setStatus() {},
          async confirm() {
            confirmations++;
            return true;
          },
        },
        http: {
          classify: () => "remote-write",
          async invoke() {
            invocations++;
            return {};
          },
        },
      },
    });
    await hooks.configure({
      type: "apply",
      sources: [{ scope: "global", path }],
    });
    const handled = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(handled.ok, true);
    if (handled.ok)
      assert.match(handled.value.block?.reason ?? "", /authority|confirm/i);
    assert.equal(confirmations, 0);
    assert.equal(invocations, 0);
  });
});

test("global active-action cap of eight composes with per-hook concurrency", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const definitions = Array.from(
      { length: 9 },
      (_, index) => `  - id: bounded-${index}
    event: agent_end
    priority: ${index}
    match: { slot: ${index} }
    actions: [{ type: command, executable: fixture-${index}, args: [] }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open`,
    ).join("\n");
    await writeFile(path, `version: 2\nhooks:\n${definitions}\n`, "utf8");
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          run(request) {
            started.push(request.executable);
            return new Promise((resolve) => {
              releases.push(() => resolve(processResult()));
            });
          },
          async shutdown() {},
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    const pending = Array.from({ length: 9 }, (_, slot) =>
      hooks.handle({
        event: "agent_end",
        payload: { slot },
        cwd: directory,
        unattended: false,
      }),
    );
    const waitUntil = Date.now() + 1_000;
    while (started.length < 8 && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const observedActive = started.length;
    for (const release of releases) release();
    await Promise.all(pending);

    assert.equal(observedActive, 8);
    assert.ok(
      hooks
        .inspect()
        .history.some(
          ({ outcome }) => outcome === "global-concurrency-limited",
        ),
    );
  });
});

test("per-hook concurrency and deadline are enforced around injected command adapters", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: bounded
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: command, executable: fixture, args: [] }]
    concurrency: 1
    deadlineMs: 40
    outputCapBytes: 8
    failurePolicy: closed
`,
      "utf8",
    );
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let observedCap = 0;
    let aborted = false;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          run(request) {
            observedCap = request.outputCapBytes;
            start();
            return new Promise((resolve) => {
              request.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve(processResult());
                },
                { once: true },
              );
            });
          },
          async shutdown() {},
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    const invocation = {
      event: "tool_call" as const,
      payload: {},
      cwd: directory,
      unattended: false,
    };

    const firstPromise = hooks.handle(invocation);
    await started;
    const concurrent = await hooks.handle(invocation);
    assert.equal(concurrent.ok, true);
    if (concurrent.ok)
      assert.match(concurrent.value.block?.reason ?? "", /concurrency/i);

    const first = await firstPromise;
    assert.equal(first.ok, true);
    if (first.ok) assert.match(first.value.block?.reason ?? "", /deadline/i);
    assert.equal(observedCap, 8);
    assert.equal(aborted, true);
  });
});

test("apply generation-fences old actions and suppresses all late revision effects", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const oldConfig = `version: 2
hooks:
  - id: revisioned
    event: context
    priority: 0
    match: {}
    actions:
      - { type: command, executable: slow, args: [] }
      - { type: context, content: stale-context }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: closed
`;
    const newConfig = `version: 2
hooks:
  - id: revisioned
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: fresh-context }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: closed
`;
    await writeFile(path, oldConfig, "utf8");
    const late = deferred<HookProcessResult>();
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          run(request) {
            observedSignal = request.signal;
            commandStarted();
            return late.promise;
          },
          async shutdown() {},
        },
      },
    });
    const source = { scope: "global" as const, path };
    const initial = await hooks.configure({ type: "apply", sources: [source] });
    assert.equal(
      initial.ok,
      true,
      initial.ok ? "" : JSON.stringify(initial.error),
    );
    const oldHandle = hooks.handle({
      event: "context",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    await started;
    await writeFile(path, newConfig, "utf8");
    const applyStarted = Date.now();
    const applied = await hooks.configure({
      type: "apply",
      expectedRevision: 1,
      sources: [source],
    });
    const applyElapsed = Date.now() - applyStarted;
    const wasAborted = observedSignal?.aborted === true;

    assert.equal(applied.ok, true);
    assert.ok(applyElapsed < 1_000, `apply took ${applyElapsed}ms`);
    assert.equal(wasAborted, true);
    const blockedUntilSettlement = await hooks.handle({
      event: "context",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(blockedUntilSettlement.ok, true);
    if (blockedUntilSettlement.ok)
      assert.match(
        blockedUntilSettlement.value.block?.reason ?? "",
        /concurrency/i,
      );

    late.resolve(processResult());
    const stale = await oldHandle;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stale.ok, true);
    if (stale.ok) assert.deepEqual(stale.value, { context: [] });

    const fresh = await hooks.handle({
      event: "context",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(fresh.ok, true);
    if (fresh.ok) {
      assert.deepEqual(fresh.value, { context: ["fresh-context"] });
    }
  });
});

test("reload keeps abort-ignoring work in concurrency accounting until settlement", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const yaml = (executable: string) => `version: 2
hooks:
  - id: settlement-owner
    event: agent_end
    priority: 0
    match: {}
    actions: [{ type: command, executable: ${executable}, args: [] }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`;
    await writeFile(path, yaml("old"), "utf8");
    const oldSettlement = deferred<void>();
    let starts = 0;
    let running = 0;
    let maxRunning = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          run() {
            starts++;
            running++;
            maxRunning = Math.max(maxRunning, running);
            if (starts === 1) {
              return oldSettlement.promise.then(() => {
                running--;
                return processResult();
              });
            }
            running--;
            return Promise.resolve(processResult());
          },
          async shutdown() {},
        },
      },
    });
    const source = { scope: "global" as const, path };
    const initial = await hooks.configure({ type: "apply", sources: [source] });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    const oldHandle = hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    while (starts === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));

    await writeFile(path, yaml("new"), "utf8");
    const reloaded = await hooks.configure({
      type: "apply",
      expectedRevision: 1,
      sources: [source],
    });
    assert.equal(reloaded.ok, true);
    assert.ok(
      hooks
        .inspect()
        .history.some(({ outcome }) => outcome === "drain-unresolved"),
    );
    const overlapping = await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(overlapping.ok, true);
    assert.ok(
      hooks
        .inspect()
        .history.some(({ outcome }) => outcome === "concurrency-limited"),
    );
    assert.equal(starts, 1);
    assert.equal(maxRunning, 1);

    oldSettlement.resolve();
    await oldHandle;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterSettlement = await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(afterSettlement.ok, true);
    if (afterSettlement.ok)
      assert.equal(afterSettlement.value.block, undefined);
    assert.equal(starts, 2);
    assert.equal(maxRunning, 1);
  });
});

test("late trust checks from an old generation cannot suspend a newer applied source", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const yaml = (content: string) => `version: 2
hooks:
  - id: generation-trust
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: ${content} }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: closed
`;
    await writeFile(path, yaml("old"), "utf8");
    const lateTrust = deferred<boolean>();
    let trustStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      trustStarted = resolve;
    });
    let holdNextTrust = false;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: {
        isTrusted() {
          if (!holdNextTrust) return true;
          holdNextTrust = false;
          trustStarted();
          return lateTrust.promise;
        },
      },
    });
    const source = { scope: "global" as const, path };
    assert.equal(
      (await hooks.configure({ type: "apply", sources: [source] })).ok,
      true,
    );
    holdNextTrust = true;
    const old = hooks.handle({
      event: "context",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    await started;
    await writeFile(path, yaml("fresh"), "utf8");
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          expectedRevision: 1,
          sources: [source],
        })
      ).ok,
      true,
    );
    lateTrust.resolve(true);
    await old;

    assert.equal(hooks.inspect().revision, 2);
    assert.equal(hooks.inspect().sources[0]?.status, "active");
    const fresh = await hooks.handle({
      event: "context",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(fresh.ok, true);
    if (fresh.ok) assert.deepEqual(fresh.value.context, ["fresh"]);
  });
});

test("initially untrusted project config is skipped while global hooks apply", async () => {
  await fixture(async (directory) => {
    const globalPath = join(directory, "global-hooks.yaml");
    const projectPath = join(directory, "project-hooks.yaml");
    await writeFile(
      globalPath,
      `version: 2
hooks:
  - id: global-context
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: global-applied }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    await writeFile(
      projectPath,
      `version: 2
hooks:
  - id: project-context
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: project-must-not-apply }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: (source) => source.scope === "global" },
    });

    const configured = await hooks.configure({
      type: "apply",
      sources: [
        { scope: "global", path: globalPath },
        { scope: "project", path: projectPath, trusted: false },
      ],
    });
    assert.equal(configured.ok, true);
    if (configured.ok) assert.equal(configured.value.hookCount, 1);
    const handled = await hooks.handle({
      event: "context",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(handled.ok, true);
    if (handled.ok) assert.deepEqual(handled.value.context, ["global-applied"]);
  });
});

test("accepted canonical source aliases revalidate the applied digest", async () => {
  await fixture(async (directory) => {
    const project = join(directory, "project");
    const configDirectory = join(project, ".pi");
    const alias = join(directory, "project-alias");
    await mkdir(configDirectory, { recursive: true });
    await symlink(
      project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const realPath = join(configDirectory, "hooks.yaml");
    const sourceAlias =
      process.platform === "win32" ? alias.toUpperCase() : alias;
    const aliasPath = join(sourceAlias, ".pi", "hooks.yaml");
    const yaml = (content: string) => `version: 2
hooks:
  - id: aliased-context
    event: context
    priority: 0
    match: {}
    actions: [{ type: context, content: ${content} }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`;
    try {
      await writeFile(realPath, yaml("old"), "utf8");
      const hooks = createHooks({
        actor: () => "parent",
        mode: () => "normal",
        policy: allowEverything,
        trust: { isTrusted: () => true },
      });
      const applied = await hooks.configure({
        type: "apply",
        sources: [
          {
            scope: "project",
            path: aliasPath,
            root: sourceAlias,
            trusted: true,
          },
        ],
      });
      assert.equal(applied.ok, true);
      await writeFile(realPath, yaml("new"), "utf8");

      const handled = await hooks.handle({
        event: "context",
        payload: {},
        cwd: project,
        unattended: false,
      });
      assert.equal(handled.ok, true);
      if (handled.ok) {
        assert.deepEqual(handled.value.context, []);
        assert.match(handled.value.block?.reason ?? "", /changed|suspended/i);
      }
      assert.equal(hooks.inspect().sources[0]?.status, "suspended");
    } finally {
      if (process.platform === "win32") await rmdir(alias);
      else await unlink(alias);
    }
  });
});

test("trust suspension generation-fences and aborts older in-flight source actions", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: trust-fence
    event: agent_end
    priority: 0
    match: {}
    actions: [{ type: command, executable: slow, args: [] }]
    concurrency: 2
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    let trusted = true;
    const late = deferred<HookProcessResult>();
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => trusted },
      adapters: {
        command: {
          run(request) {
            signal = request.signal;
            started();
            return late.promise;
          },
          async shutdown() {},
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    const old = hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    await commandStarted;
    trusted = false;
    const detector = await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    const aborted = signal?.aborted === true;
    const historyAfterSuspension = hooks.inspect().history.length;
    late.resolve(processResult());
    await old;

    assert.equal(detector.ok, true);
    assert.equal(aborted, true);
    assert.equal(hooks.inspect().sources[0]?.status, "suspended");
    assert.equal(hooks.inspect().history.length, historyAfterSuspension);
  });
});

test("changed config suspends its source before execution and only atomic trusted apply resumes it", async () => {
  await fixture(async (directory) => {
    const project = join(directory, "project");
    const configDirectory = join(project, ".pi");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(configDirectory, { recursive: true });
    const path = join(configDirectory, "hooks.yaml");
    const yaml = (executable: string) => `version: 2
hooks:
  - id: mutable
    event: tool_call
    priority: 0
    match: {}
    actions: [{ type: command, executable: ${executable}, args: [] }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`;
    await writeFile(path, yaml("old-command"), "utf8");
    const executions: string[] = [];
    let trusted = true;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => trusted },
      adapters: {
        command: {
          async run(request) {
            executions.push(request.executable);
            return processResult();
          },
          async shutdown() {},
        },
      },
    });
    const source = {
      scope: "project" as const,
      path,
      root: project,
      trusted: true,
    };
    assert.equal(
      (await hooks.configure({ type: "apply", sources: [source] })).ok,
      true,
    );

    await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: project,
      unattended: false,
    });
    assert.deepEqual(executions, ["old-command"]);

    await writeFile(path, yaml("new-command"), "utf8");
    const changed = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: project,
      unattended: false,
    });
    assert.equal(changed.ok, true);
    if (changed.ok)
      assert.match(
        changed.value.block?.reason ?? "",
        /config.*changed|suspended/i,
      );
    assert.deepEqual(executions, ["old-command"]);
    assert.equal(hooks.inspect().sources[0]?.status, "suspended");
    assert.ok(
      hooks.inspect().history.some(({ type }) => type === "config-changed"),
    );

    await writeFile(
      path,
      "version: 2\nhooks: nope\nsecret: api_key=NEVER_LOG_THIS\n",
      "utf8",
    );
    const invalid = await hooks.configure({
      type: "apply",
      expectedRevision: 1,
      sources: [source],
    });
    assert.equal(invalid.ok, false);
    assert.equal(hooks.inspect().revision, 1);
    assert.equal(hooks.inspect().hooks[0]?.id, "mutable");
    assert.equal(
      JSON.stringify(hooks.inspect()).includes("NEVER_LOG_THIS"),
      false,
    );

    trusted = false;
    await writeFile(path, yaml("new-command"), "utf8");
    const untrusted = await hooks.configure({
      type: "apply",
      expectedRevision: 1,
      sources: [{ ...source, trusted }],
    });
    assert.equal(untrusted.ok, false);
    trusted = true;

    const reapplied = await hooks.configure({
      type: "apply",
      expectedRevision: 1,
      sources: [source],
    });
    assert.equal(reapplied.ok, true);
    if (reapplied.ok) assert.equal(reapplied.value.revision, 2);
    assert.equal(hooks.inspect().sources[0]?.status, "active");
    await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: project,
      unattended: false,
    });
    assert.deepEqual(executions, ["old-command", "new-command"]);
  });
});

test("close aborts and boundedly drains operations, clears status, and prevents late effects", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: closable
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: status, key: hook.busy, text: Running }
      - { type: command, executable: slow, args: [] }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const late = deferred<HookProcessResult>();
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    let shutdowns = 0;
    const statuses: Array<readonly [string, string | undefined]> = [];
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          run(request) {
            signal = request.signal;
            started();
            return late.promise;
          },
          async shutdown() {
            shutdowns++;
          },
        },
        ui: {
          notify() {},
          setStatus(key, text) {
            statuses.push([key, text]);
          },
          async confirm() {
            return true;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    const pending = hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    await commandStarted;
    const closeStarted = Date.now();
    await hooks.close();
    const closeElapsed = Date.now() - closeStarted;
    const historyAfterClose = hooks.inspect().history.length;
    assert.ok(
      hooks
        .inspect()
        .history.some(({ outcome }) => outcome === "drain-unresolved"),
    );
    const aborted = signal?.aborted === true;
    late.resolve(processResult());
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(closeElapsed < 1_000, `close took ${closeElapsed}ms`);
    assert.equal(aborted, true);
    assert.equal(shutdowns, 1);
    assert.deepEqual(statuses, [
      ["hook.busy", "Running"],
      ["hook.busy", undefined],
    ]);
    assert.equal(hooks.inspect().history.length, historyAfterClose);
    const afterClose = await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(afterClose.ok, false);
    if (!afterClose.ok) assert.equal(afterClose.error.code, "ACTION_BLOCKED");
    await hooks.close();
    assert.equal(shutdowns, 1);
  });
});

test("close fences a configuration already waiting on trust with no late commit", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 1
hooks:
  - id: too-late
    event: agent_end
    priority: 0
    match: {}
    action: { type: notify, message: late, level: info }
    timeoutMs: 500
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    const trust = deferred<boolean>();
    let trustStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      trustStarted = resolve;
    });
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: {
        isTrusted() {
          trustStarted();
          return trust.promise;
        },
      },
    });
    const configuring = hooks.configure({
      type: "apply",
      sources: [{ scope: "global", path }],
    });
    await started;
    await hooks.close();
    const historyAfterClose = hooks.inspect().history.length;
    trust.resolve(true);
    const configured = await configuring;

    assert.equal(configured.ok, false);
    if (!configured.ok) assert.equal(configured.error.code, "ACTION_BLOCKED");
    assert.equal(hooks.inspect().revision, 0);
    assert.deepEqual(hooks.inspect().hooks, []);
    assert.equal(hooks.inspect().history.length, historyAfterClose);
  });
});

test("close aborts HTTP, MCP, Agent, and confirmation waits without late authority", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: http-close
    event: agent_end
    priority: 0
    match: { kind: http }
    actions: [{ type: http, name: fixture }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
  - id: mcp-close
    event: agent_end
    priority: 0
    match: { kind: mcp }
    actions: [{ type: mcp, name: fixture }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
  - id: agent-close
    event: agent_end
    priority: 0
    match: { kind: agent }
    actions: [{ type: agent, profile: fixture, prompt: fixture }]
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
  - id: confirm-close
    event: tool_call
    priority: 0
    match: {}
    actions:
      - { type: policy, decision: require-user-confirmation, reason: approve }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const adapterLate = [
      deferred<{ output: string }>(),
      deferred<{ output: string }>(),
      deferred<{ output: string }>(),
    ];
    const confirmationLate = deferred<boolean>();
    const signals: AbortSignal[] = [];
    let starts = 0;
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const markStarted = (signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      starts++;
      if (starts === 4) allStarted();
    };
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        http: {
          classify: () => "network-read",
          invoke(request) {
            markStarted(request.signal);
            return adapterLate[0]!.promise;
          },
        },
        mcp: {
          invoke(request) {
            markStarted(request.signal);
            return adapterLate[1]!.promise;
          },
        },
        agent: {
          run(request) {
            markStarted(request.signal);
            return adapterLate[2]!.promise;
          },
        },
        ui: {
          notify() {},
          setStatus() {},
          confirm() {
            markStarted();
            return confirmationLate.promise;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    const pending = [
      hooks.handle({
        event: "agent_end",
        payload: { kind: "http" },
        cwd: directory,
        unattended: false,
      }),
      hooks.handle({
        event: "agent_end",
        payload: { kind: "mcp" },
        cwd: directory,
        unattended: false,
      }),
      hooks.handle({
        event: "agent_end",
        payload: { kind: "agent" },
        cwd: directory,
        unattended: false,
      }),
      hooks.handle({
        event: "tool_call",
        payload: {},
        cwd: directory,
        unattended: false,
      }),
    ];
    await started;
    await hooks.close();
    const historyAfterClose = hooks.inspect().history.length;
    assert.equal(signals.length, 3);
    assert.equal(
      signals.every(({ aborted }) => aborted),
      true,
    );
    for (const operation of adapterLate) operation.resolve({ output: "late" });
    confirmationLate.resolve(true);
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hooks.inspect().history.length, historyAfterClose);
  });
});

test("UI, history, block reasons, and configuration errors strip terminal controls", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const hostile = "\u001b[31mALERT\u001b[0m\u0007\nnext";
    await writeFile(
      path,
      `version: 2
hooks:
  - id: ui-safe
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: notify, message: ${JSON.stringify(hostile)}, level: warning }
      - { type: status, key: hook.safe, text: ${JSON.stringify(hostile)} }
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: open
  - id: policy-safe
    event: tool_call
    priority: 0
    match: {}
    actions:
      - type: policy
        decision: deny
        reason: ${JSON.stringify(hostile)}
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const uiText: string[] = [];
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        ui: {
          notify(message) {
            uiText.push(message);
          },
          setStatus(_key, text) {
            if (text) uiText.push(text);
          },
          async confirm() {
            return true;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    const blocked = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.deepEqual(uiText, ["ALERT next", "ALERT next"]);
    assert.equal(blocked.ok, true);
    if (blocked.ok) assert.equal(blocked.value.block?.reason, "ALERT next");
    const inspection = hooks.inspect();
    assert.equal(JSON.stringify(inspection).includes("\u001b"), false);
    assert.equal(JSON.stringify(inspection).includes("\u0007"), false);

    const invalid = await hooks.configure({
      type: "validate",
      sources: [
        {
          scope: "global",
          path: join(directory, "\u001b[31mmissing.yaml"),
          optional: false,
        },
      ],
    });
    assert.equal(invalid.ok, false);
    assert.equal(JSON.stringify(invalid).includes("\u001b"), false);
  });
});

test("inspection history is strictly bounded, redacted, and records capped adapter output", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: secret-NEVER_LOG_THIS
    event: agent_end
    priority: 0
    match: {}
    actions: [{ type: http, name: fixture }]
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 16
    failurePolicy: open
`,
      "utf8",
    );
    let observedCap = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      maxHistoryEntries: 3,
      maxHistoryBytes: 2048,
      adapters: {
        http: {
          classify: () => "network-read",
          async invoke(request) {
            observedCap = request.outputCapBytes;
            return {
              output: `Bearer NEVER_LOG_THIS ${"x".repeat(1024)}`,
            };
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    for (let index = 0; index < 6; index++) {
      await hooks.handle({
        event: "agent_end",
        payload: { index },
        cwd: directory,
        unattended: false,
      });
    }

    const inspection = hooks.inspect({ historyLimit: 2 });
    assert.ok(inspection.history.length <= 2);
    assert.equal(observedCap, 16);
    assert.ok(
      inspection.history.some(({ outcome }) => outcome === "output-truncated"),
    );
    assert.equal(JSON.stringify(inspection).includes("NEVER_LOG_THIS"), false);
  });
});

test("configuration and invocation reject accessors and proxies without executing caller code", async () => {
  const hooks = createHooks({
    actor: () => "parent",
    mode: () => "normal",
    policy: allowEverything,
    trust: { isTrusted: () => true },
  });
  let getterCalls = 0;
  const source = { scope: "global" };
  Object.defineProperty(source, "path", {
    enumerable: true,
    get() {
      getterCalls++;
      return "C:/never-read.yaml";
    },
  });
  const accessorConfig = await hooks.configure({
    type: "validate",
    sources: [source],
  } as unknown as Parameters<typeof hooks.configure>[0]);
  assert.equal(accessorConfig.ok, false);
  assert.equal(getterCalls, 0);

  let proxyReads = 0;
  const hostile = new Proxy(
    {
      type: "validate" as const,
      sources: [] as const,
    },
    {
      get() {
        proxyReads++;
        throw new Error("proxy get must not run");
      },
    },
  );
  const proxyConfig = await hooks.configure(hostile);
  assert.equal(proxyConfig.ok, false);
  const proxyInvocation = await hooks.handle(
    new Proxy(
      {
        event: "tool_call" as const,
        payload: {},
        cwd: "C:/fixture",
        unattended: false,
      },
      {
        get() {
          proxyReads++;
          throw new Error("proxy get must not run");
        },
      },
    ),
  );
  assert.equal(proxyInvocation.ok, false);
  assert.equal(proxyReads, 0);
});

test("handle rejects extra authority, accessors, and cyclic payloads without getter execution", async () => {
  const hooks = createHooks({
    actor: () => "parent",
    mode: () => "normal",
    policy: allowEverything,
    trust: { isTrusted: () => true },
  });
  let reads = 0;
  const accessor = {
    event: "tool_call",
    payload: {},
    unattended: false,
  };
  Object.defineProperty(accessor, "cwd", {
    enumerable: true,
    get() {
      reads++;
      return "C:/fixture";
    },
  });
  const accessorResult = await hooks.handle(
    accessor as Parameters<typeof hooks.handle>[0],
  );
  assert.equal(accessorResult.ok, false);
  assert.equal(reads, 0);

  const extra = await hooks.handle({
    event: "tool_call",
    payload: {},
    cwd: "C:/fixture",
    unattended: false,
    mode: "normal",
  } as Parameters<typeof hooks.handle>[0]);
  assert.equal(extra.ok, false);

  const payload: Record<string, unknown> = {};
  payload.self = payload;
  const cyclic = await hooks.handle({
    event: "tool_call",
    payload,
    cwd: "C:/fixture",
    unattended: false,
  } as Parameters<typeof hooks.handle>[0]);
  assert.equal(cyclic.ok, false);
});

test("policy and trust are rechecked after confirmation immediately before effect commit", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: recheck-confirmation
    event: tool_call
    priority: 0
    match: {}
    actions:
      - { type: policy, decision: require-user-confirmation, reason: approve-hook }
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    let allowed = true;
    let trusted = true;
    let trustChecks = 0;
    const policy: CapabilityPolicy = {
      decide() {
        return allowed
          ? {
              kind: "allow",
              operation: "read",
              capabilities: ["read"],
              sideEffecting: false,
              reason: "allowed",
              provenance: { source: "fixture", reference: "allow" },
            }
          : {
              kind: "deny",
              operation: "read",
              capabilities: ["read"],
              sideEffecting: false,
              reason: "host policy changed",
              provenance: { source: "fixture", reference: "deny" },
            };
      },
    };
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy,
      trust: {
        isTrusted() {
          trustChecks++;
          return trusted;
        },
      },
      adapters: {
        ui: {
          notify() {},
          setStatus() {},
          async confirm() {
            allowed = false;
            trusted = true;
            return true;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );
    trustChecks = 0;
    const handled = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(handled.ok, true);
    if (handled.ok) {
      assert.equal(handled.value.block?.reason, "host policy changed");
    }
    assert.equal(trustChecks, 2);
    assert.equal(
      hooks.inspect().history.some(({ outcome }) => outcome === "completed"),
      false,
    );
  });
});

test("policy confirmation actions block unattended invocation and require direct attended approval", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: approval
    event: tool_call
    priority: 0
    match: {}
    actions:
      - type: policy
        decision: require-user-confirmation
        reason: Confirm protected tool
    concurrency: 1
    deadlineMs: 500
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    let confirmations = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        ui: {
          notify() {},
          setStatus() {},
          async confirm() {
            confirmations++;
            return true;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );

    const unattended = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: true,
    });
    assert.equal(unattended.ok, true);
    if (unattended.ok)
      assert.match(unattended.value.block?.reason ?? "", /protected tool/);
    assert.equal(confirmations, 0);

    const attended = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(attended.ok, true);
    if (attended.ok) assert.equal(attended.value.block, undefined);
    assert.equal(confirmations, 1);
  });
});

test("open action failure continues later actions while closed gate failure stops and blocks", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    await writeFile(
      path,
      `version: 2
hooks:
  - id: open-observer
    event: agent_end
    priority: 0
    match: {}
    actions:
      - { type: command, executable: fail, args: [] }
      - { type: notify, message: open-continued, level: info }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: open
  - id: closed-gate
    event: tool_call
    priority: 0
    match: {}
    actions:
      - { type: command, executable: fail, args: [] }
      - { type: command, executable: should-not-run, args: [] }
    concurrency: 1
    deadlineMs: 5000
    outputCapBytes: 1024
    failurePolicy: closed
`,
      "utf8",
    );
    const notifications: string[] = [];
    const commands: string[] = [];
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: { isTrusted: () => true },
      adapters: {
        command: {
          async run(request) {
            commands.push(request.executable);
            return { ...processResult(), code: 1 };
          },
          async shutdown() {},
        },
        ui: {
          notify(message) {
            notifications.push(message);
          },
          setStatus() {},
          async confirm() {
            return true;
          },
        },
      },
    });
    assert.equal(
      (
        await hooks.configure({
          type: "apply",
          sources: [{ scope: "global", path }],
        })
      ).ok,
      true,
    );

    const open = await hooks.handle({
      event: "agent_end",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(open.ok, true);
    if (open.ok) assert.equal(open.value.block, undefined);
    assert.deepEqual(notifications, ["open-continued"]);
    assert.deepEqual(commands, ["fail"]);

    const closed = await hooks.handle({
      event: "tool_call",
      payload: {},
      cwd: directory,
      unattended: false,
    });
    assert.equal(closed.ok, true);
    if (closed.ok) assert.match(closed.value.block?.reason ?? "", /failed/i);
    assert.deepEqual(notifications, ["open-continued"]);
    assert.deepEqual(commands, ["fail", "fail"]);
  });
});

test("apply rejects config identity change between validation and atomic commit", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "hooks.yaml");
    const yaml = (message: string) => `version: 1
hooks:
  - id: atomic
    event: agent_end
    priority: 0
    match: {}
    action: { type: notify, message: ${message}, level: info }
    timeoutMs: 500
    outputCapBytes: 1024
    failurePolicy: open
`;
    await writeFile(path, yaml("before"), "utf8");
    let trustChecks = 0;
    const hooks = createHooks({
      actor: () => "parent",
      mode: () => "normal",
      policy: allowEverything,
      trust: {
        async isTrusted() {
          trustChecks++;
          if (trustChecks === 2) {
            await writeFile(path, yaml("after"), "utf8");
          }
          return true;
        },
      },
    });

    const applied = await hooks.configure({
      type: "apply",
      sources: [{ scope: "global", path }],
    });
    assert.equal(applied.ok, false);
    if (!applied.ok) assert.equal(applied.error.code, "CONFIG_CHANGED");
    assert.equal(trustChecks, 2);
    assert.equal(hooks.inspect().revision, 0);
    assert.deepEqual(hooks.inspect().hooks, []);
  });
});
