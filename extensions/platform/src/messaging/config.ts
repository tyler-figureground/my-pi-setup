import type { PlatformDiagnostic } from "../flags.ts";

export interface PlatformMessagingConfiguration {
  readonly discoverableBy: "none" | "same-project" | "local-user";
  readonly acceptsFrom: "none" | "same-project" | "local-user";
}

export const defaultPlatformMessagingConfiguration: PlatformMessagingConfiguration =
  Object.freeze({ discoverableBy: "none", acceptsFrom: "none" });

export function decodeMessagingConfiguration(
  input: unknown,
  base: PlatformMessagingConfiguration,
  scope: "user" | "project",
): {
  readonly messaging: PlatformMessagingConfiguration;
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  if (input === undefined) return { messaging: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      messaging: base,
      diagnostics: [
        {
          path: "messagingSettings",
          message: "Messaging settings must be an object.",
        },
      ],
    };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  for (const key of Object.keys(value)) {
    if (!["discoverableBy", "acceptsFrom"].includes(key)) {
      diagnostics.push({
        path: `messagingSettings.${key}`,
        message: `Unknown messaging setting ${JSON.stringify(key)}.`,
      });
    }
  }
  const decodeExposure = (
    field: "discoverableBy" | "acceptsFrom",
    fallback: PlatformMessagingConfiguration[typeof field],
  ) => {
    const candidate = value[field];
    if (candidate === undefined) return fallback;
    if (
      candidate !== "none" &&
      candidate !== "same-project" &&
      candidate !== "local-user"
    ) {
      diagnostics.push({
        path: `messagingSettings.${field}`,
        message: `${field} must be none, same-project, or local-user.`,
      });
      return fallback;
    }
    if (scope === "project" && candidate === "local-user") {
      diagnostics.push({
        path: `messagingSettings.${field}`,
        message: `${field}=local-user may be configured only by user settings.`,
      });
      return fallback;
    }
    return candidate;
  };
  return {
    messaging: {
      discoverableBy: decodeExposure("discoverableBy", base.discoverableBy),
      acceptsFrom: decodeExposure("acceptsFrom", base.acceptsFrom),
    },
    diagnostics,
  };
}
