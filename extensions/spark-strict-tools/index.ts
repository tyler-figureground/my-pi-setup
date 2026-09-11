/**
 * spark-strict-tools extension: registers no tools or commands. Its
 * `before_provider_request` hook rewrites the outgoing payload, only when the
 * active model's provider is `spark-deepseek`, so every OpenAI-style function
 * tool carries `strict: true`.
 *
 * `strictifyOpenAIFunctionTools` is pure: it returns a new payload when any
 * tool changed and the original object otherwise; non-function tools pass
 * through untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function strictifyOpenAIFunctionTools(payload: unknown) {
  if (!isObject(payload) || !Array.isArray(payload.tools)) return payload;

  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (
      !isObject(tool) ||
      tool.type !== "function" ||
      !isObject(tool.function)
    ) {
      return tool;
    }

    changed = true;
    return {
      ...tool,
      function: {
        ...tool.function,
        strict: true,
      },
    };
  });

  return changed ? { ...payload, tools } : payload;
}

export default function sparkStrictTools(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "spark-deepseek") return;
    return strictifyOpenAIFunctionTools(event.payload);
  });
}
