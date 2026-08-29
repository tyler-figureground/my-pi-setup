import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionContext,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { terminalObservationSourceFor } from "../background-terminals/src/observation-service.ts";
import { scheduledAgentExecutorFor } from "../shared/scheduled-agent.ts";
import { namedProfileExecutionPortFor } from "./src/agents/named-profile-execution-service.ts";
import { platformAgentServices } from "./src/agents/services.ts";
import { platformHookEventProducerFor } from "./src/automation/platform-hook-event-sink.ts";

function bindRuntime(result: LoadExtensionsResult) {
  let activeTools = result.extensions.flatMap((extension) => [
    ...extension.tools.keys(),
  ]);
  result.runtime.sendMessage = () => {};
  result.runtime.sendUserMessage = () => {};
  result.runtime.appendEntry = () => {};
  result.runtime.setSessionName = () => {};
  result.runtime.getSessionName = () => "private-protocol-loader";
  result.runtime.setLabel = () => {};
  result.runtime.getActiveTools = () => [...activeTools];
  result.runtime.getAllTools = () =>
    result.extensions.flatMap((extension) =>
      [...extension.tools.values()].map(({ definition, sourceInfo }) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        promptGuidelines: definition.promptGuidelines,
        sourceInfo,
      })),
    );
  result.runtime.setActiveTools = (names) => {
    activeTools = [...names];
  };
  result.runtime.refreshTools = () => {};
  result.runtime.getCommands = () =>
    result.extensions.flatMap((extension) =>
      [...extension.commands.values()].map(
        ({ name, description, sourceInfo }) => ({
          name,
          description,
          source: "extension" as const,
          sourceInfo,
        }),
      ),
    );
  result.runtime.setModel = async () => true;
  result.runtime.getThinkingLevel = () => "medium";
  result.runtime.setThinkingLevel = () => {};
}

async function emit(
  result: LoadExtensionsResult,
  type: string,
  event: unknown,
  context: ExtensionContext,
) {
  for (const extension of result.extensions) {
    for (const handler of extension.handlers.get(type) ?? []) {
      await handler(event, context);
    }
  }
}

function availability(eventBus: ReturnType<typeof createEventBus>) {
  const hookSink = { kind: "query", version: 1, claimed: false };
  eventBus.emit("platform:hook-event-sink:private", hookSink);
  return {
    scheduled: scheduledAgentExecutorFor(eventBus) !== undefined,
    namedProfile: namedProfileExecutionPortFor(eventBus) !== undefined,
    terminal: terminalObservationSourceFor(eventBus) !== undefined,
    profiles: platformAgentServices(eventBus)?.profiles !== undefined,
    hookSink: hookSink.claimed,
  };
}

test("real loader bridges private protocols across isolated extension modules and releases them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-private-protocols-"));
  const agentDir = path.join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const notifications: string[] = [];
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "platform.json"),
      JSON.stringify({ hooks: true, profiles: true }),
      "utf8",
    );
    await writeFile(
      path.join(agentDir, "hooks.yaml"),
      `version: 2
hooks:
  - id: isolated-platform-event
    event: task.started
    priority: 0
    match: { producerSource: workflows, probe: isolated-loader }
    actions: [{ type: notify, message: isolated-platform-event, level: info }]
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 1024
    failurePolicy: open
`,
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const eventBus = createEventBus();
    const publications: Array<{ claimed: boolean }> = [];
    eventBus.on("platform:hook-event-sink:private", (value) => {
      if (
        value &&
        typeof value === "object" &&
        "kind" in value &&
        value.kind === "publish" &&
        "claimed" in value &&
        typeof value.claimed === "boolean"
      ) {
        publications.push(value as { claimed: boolean });
      }
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      eventBus,
      additionalExtensionPaths: [
        path.resolve("extensions/platform/index.ts"),
        path.resolve("extensions/subagents/index.ts"),
        path.resolve("extensions/background-terminals/index.ts"),
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    const context = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      model: undefined,
      scopedModels: [],
      thinkingLevel: "medium",
      signal: undefined,
      isIdle: () => true,
      isProjectTrusted: () => true,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
      modelRegistry: {},
      sessionManager: {
        getSessionId: () => "private-protocol-loader",
        getSessionName: () => "Private protocol loader",
        getSessionFile: () => undefined,
        getEntries: () => [],
        getBranch: () => [],
        getLeafId: () => null,
      },
      ui: {
        notify: (message: string) => notifications.push(message),
        confirm: async () => false,
        select: async () => undefined,
        input: async () => undefined,
        setStatus() {},
        setWidget() {},
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;

    const start = async (reason: "startup" | "reload") => {
      await loader.reload();
      const result = loader.getExtensions();
      assert.deepEqual(result.errors, []);
      bindRuntime(result);
      assert.deepEqual(availability(eventBus), {
        scheduled: true,
        namedProfile: true,
        terminal: true,
        profiles: false,
        hookSink: false,
      });
      await emit(
        result,
        "session_start",
        { type: "session_start", reason },
        context,
      );
      assert.deepEqual(availability(eventBus), {
        scheduled: true,
        namedProfile: true,
        terminal: true,
        profiles: true,
        hookSink: true,
      });
      return result;
    };
    const shutdown = async (
      result: LoadExtensionsResult,
      reason: "reload" | "quit",
    ) => {
      await emit(
        result,
        "session_shutdown",
        { type: "session_shutdown", reason },
        context,
      );
      assert.deepEqual(availability(eventBus), {
        scheduled: false,
        namedProfile: false,
        terminal: false,
        profiles: false,
        hookSink: false,
      });
    };

    const first = await start("startup");
    platformHookEventProducerFor(eventBus, "workflows").publish(
      "task.started",
      { probe: "isolated-loader" },
    );
    assert.equal(publications.at(-1)?.claimed, true);

    await shutdown(first, "reload");
    const second = await start("reload");
    await shutdown(second, "quit");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
