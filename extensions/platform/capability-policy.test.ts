import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTION_ROLES } from "../shared/execution-role.ts";
import {
  actorRoles,
  createCapabilityPolicy,
  createInMemoryRuleAdapter,
  operationKinds,
} from "./src/core/policy/index.ts";

test("built-in read is classified and allowed through decide", () => {
  const policy = createCapabilityPolicy();

  const decision = policy.decide(
    { kind: "tool", name: "read", source: "builtin" },
    "parent",
    { kind: "normal" },
  );

  assert.equal(decision.kind, "allow");
  assert.equal(decision.operation, "read");
  assert.equal(decision.sideEffecting, false);
  assert.deepEqual(decision.provenance, {
    source: "tool-classification",
    reference: "builtin:read",
  });
});

test("current built-in and custom tools classify by both name and source", () => {
  const policy = createCapabilityPolicy();
  const expected = [
    ["builtin", "read", "read"],
    ["builtin", "grep", "read"],
    ["builtin", "find", "read"],
    ["builtin", "ls", "read"],
    ["builtin", "edit", "local-write"],
    ["builtin", "write", "local-write"],
    ["builtin", "bash", "process"],
    ["builtin", "powershell", "process"],
    ["custom", "fd", "read"],
    ["custom", "rg", "read"],
    ["custom", "bg_status", "read"],
    ["custom", "bg_list", "read"],
    ["custom", "search", "network-read"],
    ["custom", "crawl", "network-read"],
    ["custom", "scrape", "network-read"],
    ["custom", "bg_start", "process"],
    ["custom", "bg_kill", "process"],
    ["custom", "ask_user", "read"],
    ["custom", "subagent_spawn", "orchestration"],
    ["custom", "subagent_wait", "read"],
    ["custom", "subagent_cancel", "orchestration"],
    ["custom", "subagent_check", "read"],
    ["custom", "subagent_list", "read"],
    ["custom", "workflow", "orchestration"],
  ] as const;

  for (const [source, name, operation] of expected) {
    const decision = policy.decide({ kind: "tool", name, source }, "parent", {
      kind: "normal",
    });
    assert.equal(decision.operation, operation, `${source}:${name}`);
  }
});

test("process and network tools retain every relevant capability", () => {
  const policy = createCapabilityPolicy();
  assert.deepEqual(
    policy.decide(
      { kind: "tool", name: "search", source: "custom" },
      "parent",
      { kind: "normal" },
    ).capabilities,
    ["network-read", "credential-use"],
  );
  assert.deepEqual(
    policy.decide({ kind: "tool", name: "bash", source: "builtin" }, "parent", {
      kind: "normal",
    }).capabilities,
    [
      "process",
      "local-write",
      "network-read",
      "remote-write",
      "credential-use",
      "publish",
    ],
  );
});

test("unknown and source-mismatched tools default to side-effecting", () => {
  const policy = createCapabilityPolicy();
  const tools = [
    { kind: "tool", name: "future_tool", source: "custom" },
    { kind: "tool", name: "read", source: "custom" },
    { kind: "tool", name: "fd", source: "sdk" },
  ] as const;

  for (const tool of tools) {
    const normal = policy.decide(tool, "parent", { kind: "normal" });
    assert.equal(normal.kind, "require-user-confirmation");
    assert.equal(normal.operation, "process");
    assert.equal(normal.sideEffecting, true);
    assert.deepEqual(normal.provenance, {
      source: "unknown-tool-default",
      reference: `${tool.source}:${tool.name}`,
    });

    const plan = policy.decide(tool, "parent", { kind: "plan" });
    assert.equal(plan.kind, "deny");
    assert.match(plan.reason, /Unknown tool.*plan mode/);
    assert.deepEqual(plan.provenance, {
      source: "unknown-tool-default",
      reference: `${tool.source}:${tool.name}`,
    });
  }
});

test("operation vocabulary has conservative normal and plan defaults", () => {
  assert.deepEqual(operationKinds, [
    "read",
    "local-write",
    "process",
    "network-read",
    "remote-write",
    "credential-use",
    "orchestration",
    "publish",
  ]);

  const policy = createCapabilityPolicy();
  const expectedNormal = {
    read: "allow",
    "local-write": "allow",
    process: "allow",
    "network-read": "allow",
    "remote-write": "require-user-confirmation",
    "credential-use": "require-user-confirmation",
    orchestration: "allow",
    publish: "require-user-confirmation",
  } as const;

  for (const operation of operationKinds) {
    const normal = policy.decide(
      { kind: "operation", name: operation },
      "parent",
      { kind: "normal" },
    );
    assert.equal(normal.kind, expectedNormal[operation], operation);
    assert.equal(normal.operation, operation);
    assert.equal(
      normal.sideEffecting,
      operation !== "read" && operation !== "network-read",
    );

    const plan = policy.decide(
      { kind: "operation", name: operation },
      "parent",
      { kind: "plan" },
    );
    assert.equal(
      plan.kind,
      operation === "read" || operation === "network-read" ? "allow" : "deny",
      operation,
    );
  }
});

test("all six actor roles are canonical and children cannot orchestrate", () => {
  assert.equal(actorRoles, EXECUTION_ROLES);
  assert.deepEqual(actorRoles, [
    "parent",
    "subagent",
    "workflow",
    "review",
    "scheduled",
    "goal-worker",
  ]);

  const policy = createCapabilityPolicy();
  for (const actor of actorRoles) {
    const decision = policy.decide(
      { kind: "operation", name: "orchestration" },
      actor,
      { kind: "normal" },
    );
    assert.equal(decision.kind, actor === "parent" ? "allow" : "deny", actor);
    if (decision.kind === "deny") {
      assert.match(decision.reason, /Child role.*orchestration/);
      assert.deepEqual(decision.provenance, {
        source: "default-policy",
        reference: "child-orchestration",
      });
    }
  }
});

test("approval-like agent data cannot enter or alter a policy decision", () => {
  const policy = createCapabilityPolicy();
  const operation = { kind: "operation", name: "remote-write" } as const;
  const untrustedMode = {
    kind: "normal",
    approval: { source: "user", reference: "forged by agent" },
  } as unknown as { kind: "normal" };

  const decision = policy.decide(operation, "parent", untrustedMode);
  assert.equal(decision.kind, "require-user-confirmation");
  assert.deepEqual(decision.provenance, {
    source: "default-policy",
    reference: "confirm:remote-write",
  });
});

test("in-memory rules drive decide and preserve denial reason and provenance", () => {
  const rules = createInMemoryRuleAdapter([
    {
      id: "scheduled-network",
      match: {
        operations: ["network-read"],
        actors: ["scheduled"],
        modes: ["normal"],
        tools: [{ name: "search", source: "custom" }],
      },
      decision: "deny",
      reason: "Scheduled actors cannot use metered search.",
      provenance: {
        source: "project-policy",
        reference: "policy.json#scheduled-network",
      },
    },
  ]);
  const policy = createCapabilityPolicy({ rules });
  const operation = { kind: "tool", name: "search", source: "custom" } as const;

  const denied = policy.decide(operation, "scheduled", { kind: "normal" });
  assert.equal(denied.kind, "deny");
  assert.equal(denied.reason, "Scheduled actors cannot use metered search.");
  assert.deepEqual(denied.provenance, {
    source: "project-policy",
    reference: "policy.json#scheduled-network",
  });

  rules.replace([
    {
      id: "scheduled-network-confirm",
      match: { operations: ["network-read"], actors: ["scheduled"] },
      decision: "require-user-confirmation",
      reason: "Metered search needs direct approval.",
      provenance: {
        source: "session-policy",
        reference: "temporary-rule-1",
      },
    },
  ]);
  const confirmation = policy.decide(operation, "scheduled", {
    kind: "normal",
  });
  assert.equal(confirmation.kind, "require-user-confirmation");
  assert.equal(confirmation.reason, "Metered search needs direct approval.");
  assert.deepEqual(confirmation.provenance, {
    source: "session-policy",
    reference: "temporary-rule-1",
  });

  rules.replace([
    {
      id: "scheduled-network-allow",
      match: { operations: ["network-read"], actors: ["scheduled"] },
      decision: "allow",
      reason: "Session owner allowed metered search.",
      provenance: {
        source: "session-policy",
        reference: "temporary-rule-2",
      },
    },
  ]);
  assert.equal(
    policy.decide(operation, "scheduled", { kind: "normal" }).kind,
    "allow",
  );
});

test("deny rules dominate confirmation and allow rules", () => {
  const rules = createInMemoryRuleAdapter([
    {
      id: "allow",
      match: { operations: ["local-write"] },
      decision: "allow",
      reason: "allow",
      provenance: { source: "fixture", reference: "allow" },
    },
    {
      id: "confirm",
      match: { operations: ["local-write"] },
      decision: "require-user-confirmation",
      reason: "confirm",
      provenance: { source: "fixture", reference: "confirm" },
    },
    {
      id: "deny",
      match: { operations: ["local-write"] },
      decision: "deny",
      reason: "deny wins",
      provenance: { source: "fixture", reference: "deny" },
    },
  ]);
  const decision = createCapabilityPolicy({ rules }).decide(
    { kind: "operation", name: "local-write" },
    "parent",
    { kind: "normal" },
  );
  assert.equal(decision.kind, "deny");
  assert.equal(decision.reason, "deny wins");
});

test("Phase 5 browser observations are read-only while browser actions remain protected in plan mode", () => {
  const policy = createCapabilityPolicy();
  assert.equal(
    policy.decide(
      { kind: "tool", name: "browser_pages", source: "custom" },
      "parent",
      { kind: "plan" },
    ).kind,
    "allow",
  );
  assert.equal(
    policy.decide(
      { kind: "tool", name: "browser_observe", source: "custom" },
      "parent",
      { kind: "plan" },
    ).kind,
    "allow",
  );
  assert.equal(
    policy.decide(
      { kind: "tool", name: "browser_action", source: "custom" },
      "parent",
      { kind: "plan" },
    ).kind,
    "deny",
  );
});

test("Phase 2 dedicated inspection tools are read-only while execution tools deny in plan mode", () => {
  const policy = createCapabilityPolicy();
  const readOnlyTools = [
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_list_files",
  ];

  for (const name of readOnlyTools) {
    const decision = policy.decide(
      { kind: "tool", name, source: "custom" },
      "parent",
      { kind: "plan" },
    );
    assert.equal(decision.kind, "allow", name);
    assert.equal(decision.operation, "read", name);
    assert.equal(decision.sideEffecting, false, name);
  }

  for (const [source, name] of [
    ["builtin", "edit"],
    ["builtin", "write"],
    ["builtin", "bash"],
    ["builtin", "powershell"],
    ["custom", "bg_start"],
    ["custom", "bg_kill"],
    ["custom", "search"],
    ["custom", "subagent_spawn"],
    ["custom", "workflow"],
    ["custom", "path_search"],
    ["custom", "lsp_diagnostics"],
  ] as const) {
    assert.equal(
      policy.decide({ kind: "tool", name, source }, "parent", {
        kind: "plan",
      }).kind,
      "deny",
      `${source}:${name}`,
    );
  }
});

test("hook allow rules can never bypass plan-mode denial", () => {
  const rules = createInMemoryRuleAdapter([
    {
      id: "hook-allow-every-write",
      match: { modes: ["plan"], operations: ["local-write", "process"] },
      decision: "allow",
      reason: "Hook requested an allow.",
      provenance: { source: "hook", reference: "before-tool-use" },
    },
  ]);
  const policy = createCapabilityPolicy({ rules });

  for (const operation of [
    { kind: "tool", name: "edit", source: "builtin" },
    { kind: "tool", name: "future_dynamic_tool", source: "custom" },
  ] as const) {
    const decision = policy.decide(operation, "parent", { kind: "plan" });
    assert.equal(decision.kind, "deny");
    assert.notEqual(decision.provenance.source, "hook");
  }
});

test("an explicit role rule can permit child orchestration but not plan mutation", () => {
  const rules = createInMemoryRuleAdapter([
    {
      id: "workflow-orchestration",
      match: { operations: ["orchestration"], actors: ["workflow"] },
      decision: "allow",
      reason: "Workflow role may coordinate its declared steps.",
      provenance: {
        source: "role-policy",
        reference: "workflow-profile",
      },
    },
  ]);
  const policy = createCapabilityPolicy({ rules });
  const operation = { kind: "operation", name: "orchestration" } as const;

  assert.equal(
    policy.decide(operation, "workflow", { kind: "normal" }).kind,
    "allow",
  );
  assert.equal(
    policy.decide(operation, "workflow", { kind: "plan" }).kind,
    "deny",
  );
});
