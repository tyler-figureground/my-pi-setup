import type { PlatformDiagnostic } from "../../flags.ts";
import { isPlainData } from "../triggers/validation.ts";

export interface PlatformMonitorPollTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly allowedOrigins: readonly string[];
  readonly allowLoopback: boolean;
  readonly credentialReference?: string;
  readonly maxResponseBytes?: number;
}

export interface PlatformMonitorConfiguration {
  readonly maxActive: number;
  readonly maxRemote: number;
  readonly batchWindowMs: number;
  readonly pollMinimumMs: number;
  readonly allowedWebSocketOrigins: readonly string[];
  readonly allowLoopback: boolean;
  readonly pollTargets: readonly PlatformMonitorPollTarget[];
}

export const defaultPlatformMonitorConfiguration: PlatformMonitorConfiguration =
  Object.freeze({
    maxActive: 128,
    maxRemote: 16,
    batchWindowMs: 250,
    pollMinimumMs: 5_000,
    allowedWebSocketOrigins: Object.freeze([]),
    allowLoopback: false,
    pollTargets: Object.freeze([]),
  });

function decodePollTarget(
  value: unknown,
): PlatformMonitorPollTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "id",
          "endpoint",
          "allowedOrigins",
          "allowLoopback",
          "credentialReference",
          "maxResponseBytes",
        ].includes(key),
    ) ||
    typeof record.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.id) ||
    typeof record.endpoint !== "string" ||
    !Array.isArray(record.allowedOrigins) ||
    record.allowedOrigins.length < 1 ||
    record.allowedOrigins.length > 16 ||
    record.allowedOrigins.some((origin) => typeof origin !== "string") ||
    new Set(record.allowedOrigins).size !== record.allowedOrigins.length ||
    typeof record.allowLoopback !== "boolean" ||
    (record.credentialReference !== undefined &&
      (typeof record.credentialReference !== "string" ||
        !/^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(
          record.credentialReference,
        ))) ||
    (record.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(record.maxResponseBytes) ||
        Number(record.maxResponseBytes) < 1 ||
        Number(record.maxResponseBytes) > 1024 * 1024))
  )
    return;
  let endpoint: URL;
  try {
    endpoint = new URL(record.endpoint);
  } catch {
    return;
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.href !== record.endpoint ||
    [...endpoint.searchParams.keys()].some((key) =>
      /^(?:authorization|password|secret|token|api[-_]?key|credential)$/i.test(
        key,
      ),
    )
  )
    return;
  const origins = record.allowedOrigins as string[];
  if (
    !origins.includes(endpoint.origin) ||
    origins.some((origin) => {
      try {
        const candidate = new URL(origin);
        return (
          candidate.origin !== origin ||
          (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
          !!candidate.username ||
          !!candidate.password
        );
      } catch {
        return true;
      }
    })
  )
    return;
  return {
    id: record.id,
    endpoint: endpoint.href,
    allowedOrigins: [...origins],
    allowLoopback: record.allowLoopback,
    ...(record.credentialReference === undefined
      ? {}
      : { credentialReference: record.credentialReference as string }),
    ...(record.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: record.maxResponseBytes as number }),
  };
}

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
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !isPlainData(input, { maxDepth: 6, maxNodes: 512 })
  ) {
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
  const value = structuredClone(input) as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  const allowed = new Set([
    "maxActive",
    "maxRemote",
    "batchWindowMs",
    "pollMinimumMs",
    "allowedWebSocketOrigins",
    "allowLoopback",
    "pollTargets",
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

  let pollTargets = base.pollTargets;
  if (value.pollTargets !== undefined) {
    const candidates = Array.isArray(value.pollTargets)
      ? value.pollTargets.map(decodePollTarget)
      : [];
    const valid =
      candidates.length <= 32 &&
      candidates.every(
        (entry): entry is PlatformMonitorPollTarget => entry !== undefined,
      ) &&
      new Set(candidates.map(({ id }) => id)).size === candidates.length;
    const projectMatches =
      valid && JSON.stringify(candidates) === JSON.stringify(base.pollTargets);
    if (!valid || (scope === "project" && !projectMatches)) {
      diagnostics.push({
        path: "monitorSettings.pollTargets",
        message:
          "Poll targets must be unique host-named pinned HTTP definitions; project config cannot add or alter them.",
      });
    } else {
      pollTargets = candidates;
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
      pollTargets: pollTargets.map((target) => ({
        ...target,
        allowedOrigins: [...target.allowedOrigins],
      })),
    },
    diagnostics,
  };
}
