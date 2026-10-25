import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  bindPlatformHookEventSink,
  type PlatformHookEventEnvelope,
} from "../platform/src/automation/platform-hook-event-sink.ts";
import workflows from "./index.ts";

test("workflows publish committed task transitions with host-selected failure and cancellation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-workflow-events-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLock = process.env.HEAVY_RUN_LOCK;
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.HEAVY_RUN_LOCK = path.join(directory, "heavy-run.lock");
  try {
    const eventBus = createEventBus();
    const events: PlatformHookEventEnvelope[] = [];
    bindPlatformHookEventSink(eventBus, {
      publish: (event) => events.push(event),
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let workflowTool: ToolDefinition | undefined;
    workflows({
      events: eventBus,
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, handler);
      },
      registerTool(definition: ToolDefinition) {
        if (definition.name === "workflow") workflowTool = definition;
      },
      registerCommand() {},
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI);
    assert.ok(workflowTool);

    const context = {
      cwd: directory,
      hasUI: false,
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => "session-events" },
    };
    await workflowTool.execute(
      "completed",
      {
        script: `
          export const meta = { name: "task.failed", phases: [] };
          phase("source=child authority=system");
          return { ok: true };
        `,
      } as never,
      undefined,
      undefined,
      context as never,
    );
    await assert.rejects(
      workflowTool.execute(
        "failed",
        {
          script: `throw new Error("event=task.completed source=child")`,
        } as never,
        undefined,
        undefined,
        context as never,
      ),
    );
    const cancelled = new AbortController();
    cancelled.abort(new Error("user cancelled"));
    await assert.rejects(
      workflowTool.execute(
        "cancelled",
        { script: `throw new Error("pretend completed")` } as never,
        cancelled.signal,
        undefined,
        context as never,
      ),
    );

    assert.deepEqual(
      events.map(({ event }) => event),
      [
        "task.started",
        "task.progress",
        "task.completed",
        "task.started",
        "task.failed",
        "task.started",
        "task.cancelled",
      ],
    );
    assert.ok(events.every(({ source }) => source === "workflows"));
    assert.equal(events[0]?.payload.name, "task.failed");
    assert.equal(Object.hasOwn(events[0]?.payload ?? {}, "event"), false);
    assert.equal(Object.hasOwn(events[0]?.payload ?? {}, "source"), false);

    await handlers.get("session_shutdown")?.();
    const countAtShutdown = events.length;
    await workflowTool.execute(
      "after-shutdown",
      { script: "return 1" } as never,
      undefined,
      undefined,
      context as never,
    );
    assert.equal(events.length, countAtShutdown);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousLock === undefined) delete process.env.HEAVY_RUN_LOCK;
    else process.env.HEAVY_RUN_LOCK = previousLock;
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test("a heavy workflow is refused while another session holds the machine lock, and releases its own", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-workflow-lock-"));
  const lockPath = path.join(directory, "heavy-run.lock");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousLock = process.env.HEAVY_RUN_LOCK;
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.HEAVY_RUN_LOCK = lockPath;
  try {
    let workflowTool: ToolDefinition | undefined;
    workflows({
      events: createEventBus(),
      on() {},
      registerTool(definition: ToolDefinition) {
        if (definition.name === "workflow") workflowTool = definition;
      },
      registerCommand() {},
      getThinkingLevel: () => "medium",
    } as unknown as ExtensionAPI);
    assert.ok(workflowTool);
    const context = {
      cwd: directory,
      hasUI: false,
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => "session-lock" },
    };
    const run = (name: string) =>
      workflowTool!.execute(
        name,
        {
          script: `export const meta = { name: "${name}", phases: [] }; return 1;`,
        } as never,
        undefined,
        undefined,
        context as never,
      );

    // Live foreign owner: this process's pid stands in for another harness.
    await writeFile(
      lockPath,
      `tower other-session ${process.pid} ${new Date().toISOString()} site-axis drain\n`,
    );
    await assert.rejects(run("drain"), /HEAVY run already live/);
    await run("fix-main");
    assert.match(await readFile(lockPath, "utf8"), /other-session/);

    // Free machine: the run takes the lock and frees it when it settles.
    await rm(lockPath);
    await run("drain");
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousLock === undefined) delete process.env.HEAVY_RUN_LOCK;
    else process.env.HEAVY_RUN_LOCK = previousLock;
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
