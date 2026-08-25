import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CHILD_EXECUTION_ROLES,
  EXECUTION_ROLES,
  bindExecutionRole,
  executionRoleFor,
} from "./execution-role.ts";

test("defines the complete execution-role vocabulary", () => {
  assert.deepEqual(EXECUTION_ROLES, [
    "parent",
    "subagent",
    "workflow",
    "review",
    "scheduled",
    "goal-worker",
  ]);
  assert.deepEqual(CHILD_EXECUTION_ROLES, [
    "subagent",
    "workflow",
    "review",
    "scheduled",
    "goal-worker",
  ]);
});

test("unbound event buses default to parent", () => {
  assert.equal(executionRoleFor(createEventBus()), "parent");
});

test("every child role reaches the extension-visible event facade", async () => {
  for (const role of CHILD_EXECUTION_ROLES) {
    const eventBus = createEventBus();
    bindExecutionRole(eventBus, role);
    let observed: string | undefined;
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: path.join(process.cwd(), ".execution-role-test-agent"),
      settingsManager: SettingsManager.inMemory(),
      eventBus,
      extensionFactories: [
        (pi) => {
          observed = executionRoleFor(pi.events);
        },
      ],
    });
    await loader.reload();
    assert.equal(observed, role);
  }
});

test("role binding is loader-local and cannot leak between concurrent children", () => {
  const subagent = createEventBus();
  const workflow = createEventBus();
  bindExecutionRole(subagent, "subagent");
  bindExecutionRole(workflow, "workflow");

  assert.equal(executionRoleFor(subagent), "subagent");
  assert.equal(executionRoleFor(workflow), "workflow");
  assert.equal(executionRoleFor(createEventBus()), "parent");
});

test("an event bus cannot be rebound to a different role", () => {
  const events = createEventBus();
  bindExecutionRole(events, "review");
  bindExecutionRole(events, "review");
  assert.throws(
    () => bindExecutionRole(events, "goal-worker"),
    /already bound/,
  );
});
