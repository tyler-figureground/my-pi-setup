import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
    record("session_shutdown", { reason: event.reason, mode: ctx.mode });
  });
}
