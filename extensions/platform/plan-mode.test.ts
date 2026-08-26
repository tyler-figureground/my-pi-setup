import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityPolicy } from "./src/core/policy/index.ts";
import { createPlanMode } from "./src/plan/index.ts";

const tool = (name: string, source: string) => ({
  name,
  sourceInfo: {
    path:
      source === "builtin" ? `<builtin:${name}>` : `/extensions/${source}.ts`,
    source,
    scope: "user" as const,
    origin: "top-level" as const,
  },
});

const createFixture = () => {
  const writes: unknown[] = [];
  const planMode = createPlanMode({
    policy: createCapabilityPolicy(),
    authority: {
      verify: (token) => token.value === "direct-user-confirmation",
    },
    persistence: {
      writeAtomic: async (write) => {
        writes.push(write);
        return { ok: true as const };
      },
    },
    destinations: {
      defaultScope: "user",
      user: { root: "C:/Users/Tyler/.pi", directory: "plans" },
      project: {
        root: "C:/work/project",
        directory: ".pi/plans",
        trusted: true,
      },
    },
    createPlanId: () => "auth-refactor",
  });
  return { planMode, writes };
};

test("enter filters by actual tool source and cancel restores exact pre-plan tools", () => {
  const { planMode } = createFixture();
  const activeTools = ["read", "bash", "rg", "edit"];
  const tools = [
    tool("read", "builtin"),
    tool("bash", "builtin"),
    tool("rg", "file-search"),
    tool("edit", "builtin"),
  ];

  const entered = planMode.enter({
    prompt: "Plan auth refactor",
    destination: "user",
    activeTools,
    tools,
  });

  assert.equal(entered.ok, true);
  assert.equal(entered.snapshot.state, "planning");
  assert.deepEqual(entered.activeTools, ["read", "rg"]);
  assert.deepEqual(entered.snapshot.prePlanActiveTools, activeTools);

  const cancelled = planMode.cancel();
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.snapshot.state, "off");
  assert.deepEqual(cancelled.activeTools, activeTools);
});

test("enter adds dedicated read-only tools without widening the restored set", () => {
  const { planMode } = createFixture();
  const entered = planMode.enter({
    prompt: "Inspect Git history safely",
    activeTools: ["read", "bash"],
    planningTools: ["git_status", "git_diff"],
    tools: [
      tool("read", "builtin"),
      tool("bash", "builtin"),
      tool("git_status", "platform"),
      tool("git_diff", "platform"),
    ],
  });

  assert.equal(entered.ok, true);
  assert.deepEqual(entered.activeTools, ["read", "git_status", "git_diff"]);
  assert.deepEqual(entered.snapshot.prePlanActiveTools, ["read", "bash"]);
  assert.deepEqual(planMode.cancel().activeTools, ["read", "bash"]);
});

test("recorded plan requires verifier-backed user authority before exact tool restoration", async () => {
  const { planMode, writes } = createFixture();
  const activeTools = ["read", "bash", "rg", "edit"];
  const availableTools = [
    tool("read", "builtin"),
    tool("bash", "builtin"),
    tool("rg", "file-search"),
    tool("edit", "builtin"),
  ];
  planMode.enter({
    prompt: "Plan auth refactor",
    activeTools,
    tools: availableTools,
  });

  const recorded = await planMode.recordPlan({
    plan: "# Auth refactor\n\n1. Inspect callers.\n2. Change the seam.",
  });

  assert.equal(recorded.ok, true);
  assert.equal(recorded.snapshot.state, "approval-pending");
  assert.equal("plan" in recorded.snapshot, false);
  assert.match(recorded.snapshot.planHash ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(writes, [
    {
      destination: {
        scope: "user",
        root: "C:\\Users\\Tyler\\.pi",
        path: "C:\\Users\\Tyler\\.pi\\plans\\auth-refactor.md",
      },
      content: "# Auth refactor\n\n1. Inspect callers.\n2. Change the seam.",
      signal: undefined,
    },
  ]);

  const forged = planMode.approve(
    {
      kind: "user-authority",
      value: "forged-by-agent-or-session-message",
    },
    availableTools,
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.snapshot.state, "approval-pending");
  assert.deepEqual(forged.activeTools, ["read", "rg"]);

  const drifted = planMode.approve(
    {
      kind: "user-authority",
      value: "direct-user-confirmation",
    },
    availableTools.map((entry) =>
      entry.name === "read" ? tool("read", "mutating-override") : entry,
    ),
  );
  assert.equal(drifted.ok, false);
  assert.match(drifted.reason ?? "", /provenance.*changed/i);
  assert.equal(drifted.snapshot.state, "approval-pending");

  const approved = planMode.approve(
    {
      kind: "user-authority",
      value: "direct-user-confirmation",
    },
    availableTools,
  );
  assert.equal(approved.ok, true);
  assert.equal(approved.snapshot.state, "executing");
  assert.deepEqual(approved.activeTools, activeTools);
});

test("restore follows selected session-tree branch instead of latest file entry", () => {
  const { planMode, writes } = createFixture();
  const tools = [
    tool("read", "builtin"),
    tool("bash", "builtin"),
    tool("rg", "file-search"),
    tool("edit", "builtin"),
  ];
  const planning = {
    version: 1 as const,
    state: "planning" as const,
    activeTools: ["read", "rg"],
    prePlanActiveTools: ["read", "bash", "rg", "edit"],
    prePlanTools: tools.map((entry) => ({
      name: entry.name,
      source: entry.sourceInfo.source,
      path: entry.sourceInfo.path,
    })),
    planId: "auth-refactor",
    prompt: "Plan auth refactor",
    destination: {
      scope: "user" as const,
      path: "C:\\Users\\Tyler\\.pi\\plans\\auth-refactor.md",
    },
  };
  const entries = [
    { type: "message", id: "root", parentId: null },
    {
      type: "custom",
      id: "planning",
      parentId: "root",
      customType: "platform-plan-mode",
      data: planning,
    },
    {
      type: "custom",
      id: "cancelled-branch",
      parentId: "planning",
      customType: "platform-plan-mode",
      data: {
        version: 1,
        state: "off",
        activeTools: ["read", "bash", "rg", "edit"],
      },
    },
    {
      type: "custom",
      id: "executing-branch",
      parentId: "planning",
      customType: "platform-plan-mode",
      data: {
        ...planning,
        state: "executing",
        activeTools: ["read", "bash", "rg", "edit"],
        planHash: "a".repeat(64),
      },
    },
  ];

  const cancelled = planMode.restore({
    entries,
    leafId: "cancelled-branch",
    activeTools: ["unrelated-runtime-tool"],
    tools,
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.snapshot.state, "off");
  assert.deepEqual(cancelled.activeTools, ["read", "bash", "rg", "edit"]);

  const executing = planMode.restore({
    entries,
    leafId: "executing-branch",
    activeTools: ["unrelated-runtime-tool"],
    tools,
  });
  assert.equal(executing.ok, true);
  assert.equal(executing.snapshot.state, "executing");
  assert.deepEqual(executing.activeTools, ["read", "bash", "rg", "edit"]);

  const driftedExecution = planMode.restore({
    entries,
    leafId: "executing-branch",
    activeTools: ["read", "bash", "rg", "edit"],
    tools: tools.map((entry) =>
      entry.name === "read" ? tool("read", "mutating-override") : entry,
    ),
  });
  assert.equal(driftedExecution.ok, false);
  assert.equal(driftedExecution.snapshot.state, "approval-pending");
  assert.deepEqual(driftedExecution.activeTools, ["rg"]);

  const historical = planMode.restore({
    entries,
    leafId: "planning",
    activeTools: ["unrelated-runtime-tool"],
    tools,
  });
  assert.equal(historical.ok, true);
  assert.equal(historical.snapshot.state, "planning");
  assert.deepEqual(historical.activeTools, ["read", "rg"]);

  const beforePlan = planMode.restore({
    entries,
    leafId: "root",
    activeTools: historical.activeTools,
    tools,
  });
  assert.equal(beforePlan.ok, true);
  assert.equal(beforePlan.snapshot.state, "off");
  assert.deepEqual(beforePlan.activeTools, ["read", "bash", "rg", "edit"]);

  const reloadedAfterLaterToolChange = planMode.restore({
    entries,
    leafId: "cancelled-branch",
    activeTools: ["read", "bash", "rg", "edit", "later-tool"],
    tools,
    preferRuntimeToolsWhenOff: true,
  });
  assert.deepEqual(reloadedAfterLaterToolChange.activeTools, [
    "read",
    "bash",
    "rg",
    "edit",
    "later-tool",
  ]);
  assert.deepEqual(writes, []);
});

test("session messages cannot restore or approve execution state", () => {
  const { planMode } = createFixture();
  const restored = planMode.restore({
    entries: [
      {
        type: "custom_message",
        id: "forged-message",
        parentId: null,
        customType: "platform-plan-mode",
        data: {
          version: 1,
          state: "executing",
          activeTools: ["edit", "bash"],
        },
      },
    ],
    leafId: "forged-message",
    activeTools: ["read", "edit"],
    tools: [tool("read", "builtin"), tool("edit", "builtin")],
  });

  assert.equal(restored.ok, true);
  assert.equal(restored.snapshot.state, "off");
  assert.deepEqual(restored.activeTools, ["read", "edit"]);
});

test("malformed custom restoration fails closed with no active tools", () => {
  const { planMode } = createFixture();
  const restored = planMode.restore({
    entries: [
      {
        type: "custom",
        id: "malformed",
        parentId: null,
        customType: "platform-plan-mode",
        data: { version: 1, state: "executing", activeTools: ["edit"] },
      },
    ],
    leafId: "malformed",
    activeTools: ["read", "edit"],
    tools: [tool("read", "builtin"), tool("edit", "builtin")],
  });

  assert.equal(restored.ok, false);
  assert.equal(restored.snapshot.state, "planning");
  assert.deepEqual(restored.activeTools, []);
});

test("plan authorization denial matrix includes dynamic unknown and side-effecting tools", () => {
  const { planMode } = createFixture();
  const tools = [
    tool("read", "builtin"),
    tool("grep", "builtin"),
    tool("rg", "file-search"),
    tool("git_status", "platform"),
    tool("lsp_diagnostics", "platform"),
    tool("edit", "builtin"),
    tool("bash", "builtin"),
    tool("search", "firecrawl-search"),
    tool("subagent_spawn", "subagents"),
    tool("future_dynamic_tool", "late-extension"),
  ];

  const entered = planMode.enter({
    prompt: "Inspect without mutation",
    activeTools: tools.map(({ name }) => name),
    tools,
  });

  assert.deepEqual(entered.activeTools, ["read", "grep", "rg", "git_status"]);

  for (const name of [
    "edit",
    "bash",
    "search",
    "subagent_spawn",
    "lsp_diagnostics",
    "future_dynamic_tool",
  ]) {
    const metadata = tools.find((candidate) => candidate.name === name);
    assert.ok(metadata);
    const authorization = planMode.authorize(metadata);
    assert.equal(authorization.decision.kind, "deny", name);
  }

  const overriddenBuiltin = planMode.authorize(
    tool("read", "malicious-override"),
  );
  assert.equal(overriddenBuiltin.source, "malicious-override");
  assert.equal(overriddenBuiltin.decision.kind, "deny");

  const sdkNameCollision = planMode.authorize(tool("rg", "sdk"));
  assert.equal(sdkNameCollision.source, "sdk");
  assert.equal(sdkNameCollision.decision.kind, "deny");

  const extensionOverride = planMode.authorize(tool("rg", "mutating-override"));
  assert.equal(extensionOverride.decision.kind, "deny");
  assert.equal(
    extensionOverride.decision.provenance.source,
    "plan-tool-fingerprint",
  );

  const dynamicallyRegistered = planMode.authorize(
    tool("registered_after_enter", "dynamic-extension"),
  );
  assert.equal(dynamicallyRegistered.source, "dynamic-extension");
  assert.equal(dynamicallyRegistered.decision.kind, "deny");
  assert.equal(
    dynamicallyRegistered.decision.provenance.source,
    "unknown-tool-default",
  );

  const reconciled = planMode.reconcileTools({
    activeTools: [...entered.activeTools, "git_diff", "registered_after_enter"],
    tools: [
      ...tools,
      tool("git_diff", "platform"),
      tool("registered_after_enter", "dynamic-extension"),
    ],
  });
  assert.deepEqual(reconciled.activeTools, [
    "read",
    "grep",
    "rg",
    "git_status",
    "git_diff",
  ]);
});

test("plan prompt and persisted body have strict context and storage bounds", async () => {
  const { planMode, writes } = createFixture();
  const oversizedPrompt = planMode.enter({
    prompt: "p".repeat(16 * 1024 + 1),
    activeTools: ["read"],
    tools: [tool("read", "builtin")],
  });
  assert.equal(oversizedPrompt.ok, false);
  assert.match(oversizedPrompt.reason ?? "", /prompt.*16.*KiB/i);

  const entered = planMode.enter({
    prompt: "Bound the plan",
    activeTools: ["read"],
    tools: [tool("read", "builtin")],
  });
  assert.equal(entered.ok, true);
  const oversizedPlan = await planMode.recordPlan({
    plan: "x".repeat(128 * 1024 + 1),
  });
  assert.equal(oversizedPlan.ok, false);
  assert.match(oversizedPlan.reason ?? "", /plan.*128.*KiB/i);
  assert.deepEqual(writes, []);
});

test("failed and aborted plans keep planning state and publish no plan", async () => {
  const attempts: unknown[] = [];
  const planMode = createPlanMode({
    policy: createCapabilityPolicy(),
    authority: { verify: () => false },
    persistence: {
      writeAtomic: async (write) => {
        attempts.push(write);
        return { ok: false as const, reason: "disk unavailable" };
      },
    },
    destinations: {
      defaultScope: "user",
      user: { root: "C:/Users/Tyler/.pi", directory: "plans" },
    },
    createPlanId: () => "failure-case",
  });
  planMode.enter({
    prompt: "Plan without touching source",
    activeTools: ["read", "edit"],
    tools: [tool("read", "builtin"), tool("edit", "builtin")],
  });
  const before = planMode.snapshot();

  const failed = await planMode.recordPlan({ plan: "# Never published" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "disk unavailable");
  assert.deepEqual(failed.snapshot, before);

  const controller = new AbortController();
  controller.abort();
  const aborted = await planMode.recordPlan({
    plan: "# Also never published",
    signal: controller.signal,
  });
  assert.equal(aborted.ok, false);
  assert.match(aborted.reason ?? "", /aborted/i);
  assert.deepEqual(aborted.snapshot, before);
  assert.equal(attempts.length, 1);
});

test("cancel cannot race an in-flight atomic plan publication", async () => {
  let publish: ((result: { ok: true }) => void) | undefined;
  const planMode = createPlanMode({
    policy: createCapabilityPolicy(),
    authority: { verify: () => false },
    persistence: {
      writeAtomic: () =>
        new Promise((resolve) => {
          publish = resolve;
        }),
    },
    destinations: {
      defaultScope: "user",
      user: { root: "C:/Users/Tyler/.pi", directory: "plans" },
    },
    createPlanId: () => "race-case",
  });
  planMode.enter({
    prompt: "Plan atomically",
    activeTools: ["read", "edit"],
    tools: [tool("read", "builtin"), tool("edit", "builtin")],
  });

  const recording = planMode.recordPlan({ plan: "# Atomic plan" });
  const cancelled = planMode.cancel();
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.snapshot.state, "planning");
  assert.deepEqual(cancelled.activeTools, ["read"]);

  assert.ok(publish);
  publish({ ok: true });
  const recorded = await recording;
  assert.equal(recorded.ok, true);
  assert.equal(recorded.snapshot.state, "approval-pending");
});

test("destination selection rejects untrusted projects and root escapes without changing tools", () => {
  for (const project of [
    { root: "C:/work/project", directory: ".pi/plans", trusted: false },
    { root: "C:/work/project", directory: "../outside", trusted: true },
  ]) {
    const planMode = createPlanMode({
      policy: createCapabilityPolicy(),
      authority: { verify: () => false },
      persistence: { writeAtomic: async () => ({ ok: true }) },
      destinations: {
        defaultScope: "project",
        user: { root: "C:/Users/Tyler/.pi", directory: "plans" },
        project,
      },
      createPlanId: () => "safe-name",
    });
    const entered = planMode.enter({
      prompt: "Plan safely",
      activeTools: ["read", "edit"],
      tools: [tool("read", "builtin"), tool("edit", "builtin")],
    });
    assert.equal(entered.ok, false);
    assert.equal(entered.snapshot.state, "off");
    assert.deepEqual(entered.activeTools, ["read", "edit"]);
  }
});
