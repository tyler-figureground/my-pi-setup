import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { terminalObservationSourceFor } from "../../../extensions/background-terminals/src/observation-service.ts";
import { namedProfileExecutionPortFor } from "../../../extensions/platform/src/agents/named-profile-execution-service.ts";
import { platformAgentServices } from "../../../extensions/platform/src/agents/services.ts";
import { platformHookEventProducerFor } from "../../../extensions/platform/src/automation/platform-hook-event-sink.ts";
import { scheduledAgentExecutorFor } from "../../../extensions/shared/scheduled-agent.ts";

const PLATFORM_EVENT_CHANNEL = "platform:hook-event-sink:private";

function record(event: string, details: Record<string, unknown> = {}) {
  const logPath = process.env.PI_SMOKE_LOG;
  if (!logPath) throw new Error("PI_SMOKE_LOG is required");
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ event, pid: process.pid, ...details })}\n`,
    "utf8",
  );
}

export default function lifecycleSmoke(pi: ExtensionAPI) {
  record("extension_load");
  const platformEventId = `smoke-platform-event-${process.pid}-${Date.now()}`;
  const unobservePlatformEvents = pi.events.on(
    PLATFORM_EVENT_CHANNEL,
    (value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("kind" in value) ||
        value.kind !== "publish" ||
        !("request" in value) ||
        !value.request ||
        typeof value.request !== "object" ||
        !("payload" in value.request) ||
        !value.request.payload ||
        typeof value.request.payload !== "object" ||
        !("probeId" in value.request.payload) ||
        value.request.payload.probeId !== platformEventId
      ) {
        return;
      }
      queueMicrotask(() => {
        record("platform_event_flow", {
          claimed:
            "claimed" in value && typeof value.claimed === "boolean"
              ? value.claimed
              : false,
        });
      });
    },
  );

  const privateProtocols = () => {
    const services = platformAgentServices(pi.events);
    return {
      scheduledExecutor: scheduledAgentExecutorFor(pi.events) !== undefined,
      namedProfileExecution:
        namedProfileExecutionPortFor(pi.events) !== undefined,
      terminalObservation:
        terminalObservationSourceFor(pi.events) !== undefined,
      profiles: services?.profiles !== undefined,
    };
  };

  const recordPrivateProtocols = (phase: string) => {
    record("private_protocols", { phase, ...privateProtocols() });
  };

  pi.registerTool({
    name: "smoke_probe",
    label: "Smoke Probe",
    description: "No-op tool used to verify extension tool registration",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });

  pi.registerCommand("smoke-reload", {
    description: "Reload the smoke extension runtime",
    handler: async (_args, ctx) => {
      record("command_reload", { mode: ctx.mode });
      await ctx.reload();
      return;
    },
  });

  pi.registerCommand("smoke-exit", {
    description: "Request graceful smoke-process shutdown",
    handler: async (_args, ctx) => {
      record("command_exit", { mode: ctx.mode });
      ctx.shutdown();
    },
  });

  pi.on("session_start", (event, ctx) => {
    record("session_start", {
      reason: event.reason,
      mode: ctx.mode,
      tools: pi.getAllTools().map((tool) => tool.name),
      toolContracts: pi.getAllTools().map((tool) => ({
        name: tool.name,
        parameters: tool.parameters,
        source: tool.sourceInfo.source,
      })),
      commands: pi.getCommands().map((command) => command.name),
    });
    if (ctx.hasUI) {
      ctx.ui.setStatus("phase-0-smoke", "smoke-ready");
      ctx.ui.setWidget("phase-0-smoke", ["smoke-ready"]);
    }
  });

  pi.on("resources_discover", (event) => {
    recordPrivateProtocols(`resources_discover:${event.reason}`);
    platformHookEventProducerFor(pi.events, "workflows").publish(
      "task.started",
      { probeId: platformEventId },
    );
    record("resources_discover", {
      reason: event.reason,
      tools: pi.getAllTools().map((tool) => tool.name),
      toolContracts: pi.getAllTools().map((tool) => ({
        name: tool.name,
        parameters: tool.parameters,
        source: tool.sourceInfo.source,
      })),
      commands: pi.getCommands().map((command) => command.name),
    });
  });

  pi.on("session_shutdown", (event, ctx) => {
    unobservePlatformEvents();
    record("session_shutdown", { reason: event.reason, mode: ctx.mode });
  });
}
