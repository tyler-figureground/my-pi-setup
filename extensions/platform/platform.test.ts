import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import {
  canOwnPlatformDaemons,
  createPlatformExtension,
  decodePlatformFlags,
  defaultPlatformFlags,
} from "./index.ts";
function recordingApi() {
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const api = new Proxy(
    {
      events: createEventBus(),
      on(event: string, handler: (...args: unknown[]) => unknown) {
        events.set(event, handler);
      },
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property))
          return Reflect.get(target, property, receiver);
        return (..._args: unknown[]) => calls.push(String(property));
      },
    },
  ) as unknown as ExtensionAPI;
  return { api, events, calls };
}

test("all platform feature flags default off", () => {
  assert.ok(Object.keys(defaultPlatformFlags).length > 0);
  assert.ok(Object.values(defaultPlatformFlags).every((enabled) => !enabled));
});

test("flags off register only inert lifecycle hooks and no public surface", async () => {
  const { api, events, calls } = recordingApi();
  createPlatformExtension({ flags: defaultPlatformFlags })(api);

  assert.deepEqual([...events.keys()], ["session_start", "session_shutdown"]);
  assert.deepEqual(calls, []);

  const context = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => false,
  };
  await events.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );
  await events.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
  assert.deepEqual(calls, []);
});

test("composition root owns one lifecycle supervisor per session runtime", async () => {
  const { api, events } = recordingApi();
  const reasons: string[] = [];
  let supervisors = 0;
  createPlatformExtension({
    flags: defaultPlatformFlags,
    createLifecycleSupervisor: () => {
      supervisors++;
      return {
        acquire: async <T>() => undefined as T,
        shutdown: async (
          reason: "quit" | "reload" | "new" | "resume" | "fork",
        ) => {
          reasons.push(reason);
          return { reason, status: "clean", closed: [], failures: [] };
        },
      };
    },
  })(api);

  await events.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    { cwd: process.cwd(), isProjectTrusted: () => false },
  );
  for (const reason of ["reload", "new", "resume", "fork", "quit"] as const) {
    await events.get("session_shutdown")?.(
      { type: "session_shutdown", reason },
      {},
    );
    if (reason !== "quit") {
      await events.get("session_start")?.(
        { type: "session_start", reason },
        { cwd: process.cwd(), isProjectTrusted: () => false },
      );
    }
  }

  assert.equal(supervisors, 5);
  assert.deepEqual(reasons, ["reload", "new", "resume", "fork", "quit"]);
});

test("only parent execution role can own platform daemons", () => {
  assert.equal(canOwnPlatformDaemons("parent"), true);
  for (const role of [
    "subagent",
    "workflow",
    "review",
    "scheduled",
    "goal-worker",
  ] as const) {
    assert.equal(canOwnPlatformDaemons(role), false, role);
  }
});

test("Artifact flag composes trusted local capability and tears its lifecycle down", async () => {
  const { api, events, calls } = recordingApi();
  const closes: string[] = [];
  let artifactRoot = "";
  createPlatformExtension({
    flags: { ...defaultPlatformFlags, artifacts: true },
    createProjectIdentity: () =>
      ({
        async resolve(cwd: string) {
          return {
            ok: true,
            value: {
              kind: "directory",
              projectId: "directory:artifact-test",
              canonicalCwd: cwd,
            },
          };
        },
      }) as never,
    createStateStore: () => ({
      ok: true,
      value: createMemoryStateStore({ now: () => 1 }),
    }),
    createArtifactStore: (options) => {
      artifactRoot = options.root;
      return createInMemoryArtifactStore();
    },
    createLifecycleSupervisor: () => ({
      async acquire(resource) {
        const lease = await resource.start(new AbortController().signal);
        return lease.value;
      },
      async shutdown(reason) {
        closes.push(reason);
        return { reason, status: "clean", closed: [], failures: [] };
      },
    }),
  })(api);
  const context = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "artifact-session" },
    ui: { notify() {} },
  };
  await events.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );
  assert.ok(calls.includes("registerCommand"));
  assert.ok(calls.includes("registerTool"));
  assert.ok(calls.includes("registerEntryRenderer"));
  assert.match(
    artifactRoot.replaceAll("\\", "/"),
    /\/artifacts\/projects\/[a-f0-9]{32}$/u,
  );
  await events.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
  assert.deepEqual(closes, ["quit"]);
});

test("available Phase 2 flags enable while invalid and unavailable flags diagnose independently", async () => {
  const decoded = decodePlatformFlags({
    planMode: true,
    rules: true,
    browser: "yes",
    futureCapability: false,
    hooks: false,
  });
  assert.deepEqual(decoded.flags, {
    ...defaultPlatformFlags,
    planMode: true,
    rules: true,
  });
  assert.deepEqual(
    decoded.diagnostics.map((diagnostic) => diagnostic.path),
    ["browser", "futureCapability"],
  );

  const { api, events } = recordingApi();
  const notifications: string[] = [];
  createPlatformExtension({
    flags: {
      planMode: false,
      browser: "yes",
      futureCapability: false,
      hooks: false,
    } as never,
  })(api);
  await events.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    {
      cwd: process.cwd(),
      hasUI: true,
      isProjectTrusted: () => false,
      ui: { notify: (message: string) => notifications.push(message) },
    },
  );
  assert.equal(notifications.length, 2);
  assert.match(notifications[0], /browser/);
});
