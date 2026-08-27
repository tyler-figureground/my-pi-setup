import type { PlatformDiagnostic } from "../flags.ts";

export interface PlatformMemoryConfiguration {
  readonly defaultScope: "user" | "project" | "workspace";
  readonly automaticRecall: false;
  readonly automaticExtraction: false;
}

export const defaultPlatformMemoryConfiguration: PlatformMemoryConfiguration =
  Object.freeze({
    defaultScope: "project",
    automaticRecall: false,
    automaticExtraction: false,
  });

export function decodeMemoryConfiguration(
  input: unknown,
  base: PlatformMemoryConfiguration,
): {
  readonly memory: PlatformMemoryConfiguration;
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  if (input === undefined) return { memory: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      memory: base,
      diagnostics: [
        {
          path: "memorySettings",
          message: "Memory settings must be an object.",
        },
      ],
    };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  for (const key of Object.keys(value)) {
    if (
      !["defaultScope", "automaticRecall", "automaticExtraction"].includes(key)
    ) {
      diagnostics.push({
        path: `memorySettings.${key}`,
        message: `Unknown memory setting ${JSON.stringify(key)}.`,
      });
    }
  }
  let defaultScope = base.defaultScope;
  if (value.defaultScope !== undefined) {
    if (
      value.defaultScope === "user" ||
      value.defaultScope === "project" ||
      value.defaultScope === "workspace"
    ) {
      defaultScope = value.defaultScope;
    } else {
      diagnostics.push({
        path: "memorySettings.defaultScope",
        message: "defaultScope must be user, project, or workspace.",
      });
    }
  }
  for (const field of ["automaticRecall", "automaticExtraction"] as const) {
    if (value[field] === undefined || value[field] === false) continue;
    diagnostics.push({
      path: `memorySettings.${field}`,
      message: `${field} is unavailable until its Phase 6 evaluation gate passes.`,
    });
  }
  return {
    memory: {
      defaultScope,
      automaticRecall: false,
      automaticExtraction: false,
    },
    diagnostics,
  };
}
