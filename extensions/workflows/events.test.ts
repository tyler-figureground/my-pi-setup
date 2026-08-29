import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  process.env.PI_CODING_AGENT_DIR = directory;
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
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
