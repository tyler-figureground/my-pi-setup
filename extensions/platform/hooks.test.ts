import assert from "node:assert/strict";
import test from "node:test";
import { createTriggerEngine } from "./src/automation/hooks/index.ts";

const trustedRuntime = {
  scope: "runtime",
  source: "test-suite",
  trusted: true,
} as const;

function notifyHook(id: string, priority: number, source = "test-suite") {
  return {
    hook: {
      id,
      event: "tool_call",
      priority,
      match: { toolName: "bash" },
      action: {
        type: "notify",
        message: `ran ${id}`,
        level: "info",
      },
      timeoutMs: 100,
      outputCapBytes: 1024,
      failurePolicy: "open",
    },
    provenance: { ...trustedRuntime, source },
  } as const;
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    hook: {
      id: "valid-hook",
      event: "tool_call",
      priority: 0,
      match: { "input.command": { startsWith: "git " } },
      action: {
        type: "command",
        executable: "git",
        args: ["status", "--short"],
      },
      timeoutMs: 500,
      outputCapBytes: 2048,
      failurePolicy: "closed",
      ...overrides,
    },
    provenance: trustedRuntime,
  };
}

test("registered hooks dispatch as effects in priority, source, and id order only while running", async () => {
  const engine = createTriggerEngine();
  assert.equal(engine.register(notifyHook("z-last", 20)).accepted, true);
  assert.equal(
    engine.register(notifyHook("b-source", 10, "z-source")).accepted,
    true,
  );
  assert.equal(
    engine.register(notifyHook("b-id", 10, "a-source")).accepted,
    true,
  );
  assert.equal(
    engine.register(notifyHook("a-id", 10, "a-source")).accepted,
    true,
  );

  const event = {
    event: "tool_call",
    mode: "normal",
    payload: { toolName: "bash", input: { command: "git status" } },
  } as const;

  const stopped = await engine.dispatch(event);
  assert.equal(stopped.status, "not-running");
  assert.deepEqual(stopped.effects, []);

  await engine.start();
  const dispatched = await engine.dispatch(event);
  assert.equal(dispatched.status, "completed");
  assert.deepEqual(
    dispatched.effects.map(({ hookId, type }) => [hookId, type]),
    [
      ["a-id", "notify"],
      ["b-id", "notify"],
      ["b-source", "notify"],
      ["z-last", "notify"],
    ],
  );
  assert.deepEqual(dispatched.effects[0], {
    effectId: "dispatch-2:a-id",
    hookId: "a-id",
    event: "tool_call",
    type: "notify",
    message: "ran a-id",
    level: "info",
    timeoutMs: 100,
    outputCapBytes: 1024,
    failurePolicy: "open",
    provenance: { ...trustedRuntime, source: "a-source" },
    trace: [engine.instanceId],
  });

  const stop = await engine.stop("reload");
  assert.equal(stop.status, "stopped");
  assert.equal((await engine.dispatch(event)).status, "not-running");
});

test("registration validates event, matcher, structured action, limits, failure policy, and provenance", async () => {
  const engine = createTriggerEngine({
    maxHookTimeoutMs: 1_000,
    maxHookOutputBytes: 4_096,
  });
  assert.equal(
    engine.register(registration() as Parameters<typeof engine.register>[0])
      .accepted,
    true,
  );

  const invalid = [
    registration({ id: "bad-event", event: "made_up" }),
    registration({
      id: "bad-match",
      match: { "input command": { regex: ".*" } },
    }),
    registration({
      id: "implicit-shell",
      action: { type: "command", command: "git status", shell: true },
    }),
    registration({
      id: "oversized-executable",
      action: { type: "command", executable: "x".repeat(1025), args: [] },
    }),
    registration({
      id: "oversized-argument",
      action: {
        type: "command",
        executable: "git",
        args: ["x".repeat(8193)],
      },
    }),
    registration({ id: "timeout", timeoutMs: 1_001 }),
    registration({ id: "output", outputCapBytes: 4_097 }),
    registration({
      id: "closed-notify",
      action: { type: "notify", message: "hello", level: "info" },
      failurePolicy: "closed",
    }),
    registration({
      id: "wrong-context-event",
      action: { type: "context", content: "context" },
    }),
    registration({
      id: "open-policy",
      action: { type: "policy", decision: "deny", reason: "blocked" },
      failurePolicy: "open",
    }),
  ];

  const codes = invalid.flatMap((candidate) => {
    const result = engine.register(
      candidate as Parameters<typeof engine.register>[0],
    );
    assert.equal(result.accepted, false);
    return result.diagnostics.map(({ code }) => code);
  });
  assert.ok(codes.includes("invalid-event"));
  assert.ok(codes.includes("invalid-matcher"));
  assert.ok(codes.includes("invalid-command"));
  assert.ok(codes.includes("invalid-action-field"));
  assert.ok(codes.includes("invalid-timeout"));
  assert.ok(codes.includes("invalid-output-cap"));
  assert.ok(codes.includes("invalid-failure-policy"));
  assert.ok(codes.includes("invalid-action-event"));

  const untrusted = {
    ...registration({ id: "project-owned" }),
    provenance: {
      scope: "project",
      source: "C:/repo/.pi/hooks.yaml",
      trusted: false,
    },
  };
  const rejected = engine.register(
    untrusted as Parameters<typeof engine.register>[0],
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.diagnostics[0]?.code, "untrusted-source");

  await engine.start();
  const dispatched = await engine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: { input: { command: "git status" } },
  });
  assert.deepEqual(dispatched.effects[0], {
    effectId: "dispatch-1:valid-hook",
    hookId: "valid-hook",
    event: "tool_call",
    type: "command",
    executable: "git",
    args: ["status", "--short"],
    timeoutMs: 500,
    outputCapBytes: 2048,
    failurePolicy: "closed",
    provenance: trustedRuntime,
    trace: [engine.instanceId],
  });
});

test("notify, status, context, and policy actions remain plain host effects", async () => {
  const engine = createTriggerEngine();
  const hooks = [
    notifyHook("notify", 0),
    registration({
      id: "status",
      event: "agent_start",
      match: {},
      action: { type: "status", key: "hooks", text: "running" },
      failurePolicy: "open",
    }),
    registration({
      id: "context",
      event: "before_agent_start",
      match: {},
      action: { type: "context", content: "Trusted global context" },
      failurePolicy: "open",
    }),
    registration({
      id: "policy",
      match: {},
      action: {
        type: "policy",
        decision: "require-user-confirmation",
        reason: "Confirm protected tool",
      },
      failurePolicy: "closed",
    }),
  ];
  for (const hook of hooks) {
    assert.equal(
      engine.register(hook as Parameters<typeof engine.register>[0]).accepted,
      true,
    );
  }
  await engine.start();

  const status = await engine.dispatch({
    event: "agent_start",
    mode: "normal",
    payload: {},
  });
  assert.deepEqual(
    status.effects.map(({ type }) => type),
    ["status"],
  );
  assert.equal(
    status.effects[0]?.type === "status" && status.effects[0].text,
    "running",
  );

  const context = await engine.dispatch({
    event: "before_agent_start",
    mode: "plan",
    payload: {},
  });
  assert.deepEqual(
    context.effects.map(({ type }) => type),
    ["context"],
  );

  const policy = await engine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: { toolName: "read" },
  });
  assert.deepEqual(
    policy.effects.map(({ type }) => type),
    ["policy"],
  );
  assert.equal(
    policy.effects[0]?.type === "policy" && policy.effects[0].decision,
    "require-user-confirmation",
  );
});

test("plan mode replaces command and permissive policy actions with authoritative denials", async () => {
  const engine = createTriggerEngine();
  assert.equal(
    engine.register(registration() as Parameters<typeof engine.register>[0])
      .accepted,
    true,
  );
  assert.equal(
    engine.register(
      registration({
        id: "allow-hook",
        match: {},
        action: {
          type: "policy",
          decision: "allow",
          reason: "Hook attempted allow",
        },
        failurePolicy: "closed",
      }) as Parameters<typeof engine.register>[0],
    ).accepted,
    true,
  );
  await engine.start();

  const result = await engine.dispatch({
    event: "tool_call",
    mode: "plan",
    payload: { input: { command: "git status" } },
  });
  assert.equal(result.effects.length, 2);
  for (const effect of result.effects) {
    assert.equal(effect.type, "policy");
    assert.equal(effect.type === "policy" && effect.decision, "deny");
    assert.equal(effect.failurePolicy, "closed");
  }
  assert.equal(
    result.effects.some((effect) => effect.type === "command"),
    false,
  );

  const forgedMode = await engine.dispatch({
    event: "tool_call",
    mode: "planning",
    payload: { input: { command: "git status" } },
  } as unknown as Parameters<typeof engine.dispatch>[0]);
  assert.equal(forgedMode.status, "invalid-event");
  assert.deepEqual(forgedMode.effects, []);
});

test("dispatch blocks recursive traces, rejects non-plain input, enforces whole bounds, and keeps bounded redacted logs", async () => {
  const engine = createTriggerEngine({
    instanceId: "fixture-engine",
    maxHooksPerDispatch: 2,
    maxEffectsPerDispatch: 2,
    maxLogEntries: 3,
    maxLogBytes: 2_048,
  });
  for (const id of ["one", "two", "three"]) {
    assert.equal(engine.register(notifyHook(id, 0)).accepted, true);
  }
  await engine.start();

  const recursive = await engine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: {},
    trace: [engine.instanceId],
  });
  assert.equal(recursive.status, "recursion-blocked");

  let accessorReads = 0;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, "toolName", {
    enumerable: true,
    get() {
      accessorReads++;
      return "bash";
    },
  });
  const accessorResult = await engine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: accessorPayload as Parameters<
      typeof engine.dispatch
    >[0]["payload"],
  });
  assert.equal(accessorResult.status, "invalid-event");
  assert.equal(accessorReads, 0);

  const cyclic: Record<string, unknown> = { canary: "api_key=NEVER_LOG_THIS" };
  cyclic.self = cyclic;
  const invalid = await engine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: cyclic as Parameters<typeof engine.dispatch>[0]["payload"],
  });
  assert.equal(invalid.status, "invalid-event");

  const bounded = await engine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: { toolName: "bash", canary: "Bearer NEVER_LOG_THIS" },
  });
  assert.equal(bounded.status, "bounded");
  assert.deepEqual(
    bounded.effects.map(({ hookId }) => hookId),
    ["one", "three"],
  );
  assert.equal(bounded.diagnostics[0]?.code, "dispatch-bounded");

  const inspection = engine.inspect();
  assert.ok(inspection.logs.length <= 3);
  assert.equal(
    JSON.stringify(inspection.logs).includes("NEVER_LOG_THIS"),
    false,
  );

  const redactedEngine = createTriggerEngine();
  assert.equal(
    redactedEngine.register(notifyHook("secret-NEVER_LOG_THIS", 0)).accepted,
    true,
  );
  await redactedEngine.start();
  await redactedEngine.dispatch({
    event: "tool_call",
    mode: "normal",
    payload: { toolName: "bash" },
  });
  assert.equal(
    JSON.stringify(redactedEngine.inspect().logs).includes("NEVER_LOG_THIS"),
    false,
  );
});
