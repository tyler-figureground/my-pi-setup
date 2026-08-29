import type { PlatformDiagnostic } from "../../flags.ts";
import type {
  NamedHookHttpDefinition,
  NamedHookMcpDefinition,
} from "./adapters.ts";
import { isPlainData } from "../triggers/validation.ts";

export interface PlatformHookActionConfiguration {
  readonly http: readonly NamedHookHttpDefinition[];
  readonly mcp: readonly NamedHookMcpDefinition[];
}

export const defaultPlatformHookActionConfiguration: PlatformHookActionConfiguration =
  Object.freeze({ http: Object.freeze([]), mcp: Object.freeze([]) });

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const credential = /^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/;

function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function httpDefinition(value: unknown): NamedHookHttpDefinition | undefined {
  const record = exact(value, [
    "id",
    "url",
    "method",
    "effect",
    "allowedOrigins",
    "allowLoopback",
    "credentialReference",
    "maxRequestBytes",
    "maxResponseBytes",
  ]);
  if (
    !record ||
    typeof record.id !== "string" ||
    !identifier.test(record.id) ||
    typeof record.url !== "string" ||
    (record.method !== "GET" && record.method !== "POST") ||
    (record.effect !== "network-read" && record.effect !== "remote-write") ||
    record.effect !==
      (record.method === "GET" ? "network-read" : "remote-write") ||
    !Array.isArray(record.allowedOrigins) ||
    record.allowedOrigins.length < 1 ||
    record.allowedOrigins.length > 16 ||
    record.allowedOrigins.some((origin) => typeof origin !== "string") ||
    new Set(record.allowedOrigins).size !== record.allowedOrigins.length ||
    typeof record.allowLoopback !== "boolean" ||
    (record.credentialReference !== undefined &&
      (typeof record.credentialReference !== "string" ||
        !credential.test(record.credentialReference)))
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== record.url
  ) {
    return undefined;
  }
  const origins = record.allowedOrigins as string[];
  if (
    !origins.includes(url.origin) ||
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
  ) {
    return undefined;
  }
  const integer = (candidate: unknown, maximum: number) =>
    candidate === undefined ||
    (Number.isSafeInteger(candidate) &&
      Number(candidate) > 0 &&
      Number(candidate) <= maximum);
  if (
    !integer(record.maxRequestBytes, 4 * 1024 * 1024) ||
    !integer(record.maxResponseBytes, 16 * 1024 * 1024)
  ) {
    return undefined;
  }
  return {
    id: record.id,
    url: url.href,
    method: record.method,
    effect: record.method === "GET" ? "network-read" : "remote-write",
    allowedOrigins: [...origins],
    allowLoopback: record.allowLoopback,
    ...(record.credentialReference === undefined
      ? {}
      : { credentialReference: record.credentialReference as string }),
    ...(record.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: record.maxRequestBytes as number }),
    ...(record.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: record.maxResponseBytes as number }),
  };
}

function mcpDefinition(value: unknown): NamedHookMcpDefinition | undefined {
  const record = exact(value, [
    "id",
    "serverId",
    "toolName",
    "federatedToolId",
  ]);
  if (
    !record ||
    [record.id, record.serverId, record.toolName, record.federatedToolId].some(
      (candidate) =>
        typeof candidate !== "string" || !identifier.test(candidate),
    )
  ) {
    return undefined;
  }
  return {
    id: record.id as string,
    serverId: record.serverId as string,
    toolName: record.toolName as string,
    federatedToolId: record.federatedToolId as string,
  };
}

export function decodeHookActionConfiguration(
  input: unknown,
  base: PlatformHookActionConfiguration = defaultPlatformHookActionConfiguration,
  scope: "user" | "project" = "user",
): PlatformHookActionConfiguration & {
  readonly diagnostics: PlatformDiagnostic[];
} {
  if (input === undefined) return { ...base, diagnostics: [] };
  if (
    !isPlainData(input, { maxDepth: 12, maxNodes: 2_048 }) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return {
      ...base,
      diagnostics: [
        {
          path: "hookActions",
          message: "Hook action settings must be bounded plain data.",
        },
      ],
    };
  }
  const record = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "http" && key !== "mcp") {
      diagnostics.push({
        path: `hookActions.${key}`,
        message: "Unsupported Hook action configuration field.",
      });
    }
  }
  const decodeList = <T>(
    name: "http" | "mcp",
    decoder: (value: unknown) => T | undefined,
  ) => {
    const value = record[name];
    if (value === undefined) return [] as T[];
    if (!Array.isArray(value) || value.length > 32) {
      diagnostics.push({
        path: `hookActions.${name}`,
        message: `Named ${name.toUpperCase()} Hook actions must be an array of at most 32 entries.`,
      });
      return [] as T[];
    }
    const decoded = value.map(decoder);
    if (decoded.some((entry) => entry === undefined)) {
      diagnostics.push({
        path: `hookActions.${name}`,
        message: `Named ${name.toUpperCase()} Hook action definition is invalid.`,
      });
      return [] as T[];
    }
    const valid = decoded as T[];
    const ids = valid.map((entry) => (entry as { id: string }).id);
    if (new Set(ids).size !== ids.length) {
      diagnostics.push({
        path: `hookActions.${name}`,
        message: `Named ${name.toUpperCase()} Hook action IDs must be unique.`,
      });
      return [] as T[];
    }
    return valid;
  };
  const candidate = {
    http: decodeList("http", httpDefinition),
    mcp: decodeList("mcp", mcpDefinition),
  };
  if (scope === "project") {
    for (const name of ["http", "mcp"] as const) {
      if (
        candidate[name].length > 0 &&
        JSON.stringify(candidate[name]) !== JSON.stringify(base[name])
      ) {
        diagnostics.push({
          path: `hookActions.${name}`,
          message:
            "Project config cannot add or alter host-named Hook integrations.",
        });
      }
    }
    return { ...base, diagnostics };
  }
  return {
    http: candidate.http,
    mcp: candidate.mcp,
    diagnostics,
  };
}
