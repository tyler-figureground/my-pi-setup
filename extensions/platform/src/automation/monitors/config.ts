import type { PlatformDiagnostic } from "../../flags.ts";

export interface PlatformMonitorConfiguration {
  readonly maxActive: number;
  readonly maxRemote: number;
  readonly batchWindowMs: number;
  readonly pollMinimumMs: number;
  readonly allowedWebSocketOrigins: readonly string[];
  readonly allowLoopback: boolean;
}

export const defaultPlatformMonitorConfiguration: PlatformMonitorConfiguration =
  Object.freeze({
    maxActive: 128,
    maxRemote: 16,
    batchWindowMs: 250,
    pollMinimumMs: 5_000,
    allowedWebSocketOrigins: Object.freeze([]),
    allowLoopback: false,
  });

function canonicalOrigin(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048)
    return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function decodeMonitorConfiguration(
  input: unknown,
  base: PlatformMonitorConfiguration = defaultPlatformMonitorConfiguration,
  scope: "user" | "project" = "user",
): {
  monitors: PlatformMonitorConfiguration;
  diagnostics: PlatformDiagnostic[];
} {
  if (input === undefined) return { monitors: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      monitors: base,
      diagnostics: [
        {
          path: "monitorSettings",
          message: "Monitor settings must be an object.",
        },
      ],
    };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  const allowed = new Set([
    "maxActive",
    "maxRemote",
    "batchWindowMs",
    "pollMinimumMs",
    "allowedWebSocketOrigins",
    "allowLoopback",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      diagnostics.push({
        path: `monitorSettings.${key}`,
        message: `Unknown monitor setting ${JSON.stringify(key)}.`,
      });
  }
  const integer = (
    field: string,
    minimum: number,
    maximum: number,
    fallback: number,
    projectAllows: (candidate: number) => boolean,
  ) => {
    const candidate = value[field];
    if (candidate === undefined) return fallback;
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < minimum ||
      (candidate as number) > maximum ||
      (scope === "project" && !projectAllows(candidate as number))
    ) {
      diagnostics.push({
        path: `monitorSettings.${field}`,
        message: `${field} is outside host safety bounds.`,
      });
      return fallback;
    }
    return candidate as number;
  };
  const maxActive = integer(
    "maxActive",
    1,
    128,
    base.maxActive,
    (candidate) => candidate <= base.maxActive,
  );
  const maxRemote = Math.min(
    maxActive,
    integer(
      "maxRemote",
      0,
      16,
      base.maxRemote,
      (candidate) => candidate <= base.maxRemote,
    ),
  );
  const batchWindowMs = integer(
    "batchWindowMs",
    50,
    10_000,
    base.batchWindowMs,
    (candidate) => candidate >= base.batchWindowMs,
  );
  const pollMinimumMs = integer(
    "pollMinimumMs",
    5_000,
    24 * 60 * 60 * 1_000,
    base.pollMinimumMs,
    (candidate) => candidate >= base.pollMinimumMs,
  );

  let allowedWebSocketOrigins = base.allowedWebSocketOrigins;
  if (value.allowedWebSocketOrigins !== undefined) {
    const candidates = Array.isArray(value.allowedWebSocketOrigins)
      ? value.allowedWebSocketOrigins.map(canonicalOrigin)
      : [];
    const valid =
      candidates.length <= 32 &&
      candidates.every((entry): entry is string => entry !== undefined) &&
      new Set(candidates).size === candidates.length;
    const subset =
      valid &&
      candidates.every((entry) => base.allowedWebSocketOrigins.includes(entry));
    if (!valid || (scope === "project" && !subset)) {
      diagnostics.push({
        path: "monitorSettings.allowedWebSocketOrigins",
        message:
          "WebSocket origins must be unique canonical ws/wss origins within the user allowlist.",
      });
    } else {
      allowedWebSocketOrigins = candidates;
    }
  }

  let allowLoopback = base.allowLoopback;
  if (value.allowLoopback !== undefined) {
    if (
      typeof value.allowLoopback !== "boolean" ||
      (scope === "project" && value.allowLoopback && !base.allowLoopback)
    ) {
      diagnostics.push({
        path: "monitorSettings.allowLoopback",
        message: "Project monitor settings cannot widen loopback access.",
      });
    } else {
      allowLoopback = value.allowLoopback;
    }
  }

  return {
    monitors: {
      maxActive,
      maxRemote,
      batchWindowMs,
      pollMinimumMs,
      allowedWebSocketOrigins: [...allowedWebSocketOrigins],
      allowLoopback,
    },
    diagnostics,
  };
}
