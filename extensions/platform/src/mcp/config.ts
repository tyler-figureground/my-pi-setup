import type { OperationKind } from "../core/policy/index.ts";
import type { PlatformDiagnostic } from "../flags.ts";
import type { McpServerDefinition } from "./index.ts";
import type { McpOAuthServer } from "./oauth.ts";

export interface ConfiguredMcpServer extends McpServerDefinition {
  readonly credentialReference?: string;
  readonly oauth?: McpOAuthServer;
  readonly source: {
    readonly path: string;
    readonly scope: "user" | "project";
  };
}

const effects = new Set<OperationKind>([
  "read",
  "local-write",
  "process",
  "network-read",
  "remote-write",
  "credential-use",
  "orchestration",
  "publish",
]);

function stringArray(value: unknown, maximum: number, label: string) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        Buffer.byteLength(item) > 4_096 ||
        /[\u0000-\u001f\u007f]/.test(item),
    )
  )
    throw new Error(`${label} must be a bounded string array.`);
  return [...value] as string[];
}

function decodeOne(
  value: unknown,
  source: { path: string; scope: "user" | "project" },
): ConfiguredMcpServer {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP server must be an object.");
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).filter(
    (key) =>
      ![
        "id",
        "transport",
        "enabled",
        "tools",
        "credentialReference",
        "oauth",
      ].includes(key),
  );
  if (unknown.length > 0)
    throw new Error(`Unknown MCP server field ${JSON.stringify(unknown[0])}.`);
  if (
    typeof object.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(object.id)
  )
    throw new Error("MCP server id is invalid.");
  if (
    !object.transport ||
    typeof object.transport !== "object" ||
    Array.isArray(object.transport)
  )
    throw new Error("MCP server transport must be an object.");
  const transport = object.transport as Record<string, unknown>;
  let decodedTransport: McpServerDefinition["transport"];
  if (transport.kind === "stdio") {
    const transportUnknown = Object.keys(transport).filter(
      (key) => !["kind", "command", "args", "cwd", "env"].includes(key),
    );
    if (transportUnknown.length > 0)
      throw new Error(
        `Unknown MCP STDIO field ${JSON.stringify(transportUnknown[0])}.`,
      );
    if (
      typeof transport.command !== "string" ||
      !transport.command ||
      Buffer.byteLength(transport.command) > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(transport.command)
    )
      throw new Error("MCP STDIO command is invalid.");
    const args = stringArray(transport.args ?? [], 128, "MCP STDIO args");
    let env: Record<string, string> | undefined;
    if (transport.env !== undefined) {
      if (
        !transport.env ||
        typeof transport.env !== "object" ||
        Array.isArray(transport.env) ||
        Object.keys(transport.env).length > 128
      )
        throw new Error("MCP STDIO env must be a bounded object.");
      env = {};
      for (const [name, setting] of Object.entries(transport.env)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
          typeof setting !== "string" ||
          !/^\$\{[A-Z_][A-Z0-9_]{0,127}\}$/.test(setting)
        )
          throw new Error("MCP STDIO env entry is invalid.");
        env[name] = setting;
      }
    }
    if (
      transport.cwd !== undefined &&
      (typeof transport.cwd !== "string" ||
        !transport.cwd ||
        Buffer.byteLength(transport.cwd) > 4_096 ||
        transport.cwd.includes("\0"))
    )
      throw new Error("MCP STDIO cwd is invalid.");
    decodedTransport = {
      kind: "stdio",
      command: transport.command,
      args,
      ...(typeof transport.cwd === "string" ? { cwd: transport.cwd } : {}),
      ...(env ? { env } : {}),
    };
  } else if (transport.kind === "http") {
    const transportUnknown = Object.keys(transport).filter(
      (key) =>
        !["kind", "url", "allowedOrigins", "allowLoopback"].includes(key),
    );
    if (transportUnknown.length > 0)
      throw new Error(
        `Unknown MCP HTTP field ${JSON.stringify(transportUnknown[0])}.`,
      );
    if (typeof transport.url !== "string")
      throw new Error("MCP HTTP URL is invalid.");
    const url = new URL(transport.url);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("MCP HTTP URL is invalid.");
    decodedTransport = {
      kind: "http",
      url: url.href,
      allowedOrigins: stringArray(
        transport.allowedOrigins,
        64,
        "MCP HTTP allowedOrigins",
      ),
      ...(transport.allowLoopback === true ? { allowLoopback: true } : {}),
    };
    if (
      transport.allowLoopback !== undefined &&
      typeof transport.allowLoopback !== "boolean"
    )
      throw new Error("MCP HTTP allowLoopback must be boolean.");
  } else {
    throw new Error("MCP transport kind must be stdio or http.");
  }

  let include = ["*"];
  let exclude: string[] = [];
  let decodedEffects: Record<string, OperationKind> | undefined;
  if (object.tools !== undefined) {
    if (
      !object.tools ||
      typeof object.tools !== "object" ||
      Array.isArray(object.tools)
    )
      throw new Error("MCP tools config must be an object.");
    const tools = object.tools as Record<string, unknown>;
    const toolsUnknown = Object.keys(tools).filter(
      (key) => !["include", "exclude", "effects"].includes(key),
    );
    if (toolsUnknown.length > 0)
      throw new Error(
        `Unknown MCP tools field ${JSON.stringify(toolsUnknown[0])}.`,
      );
    if (tools.include !== undefined)
      include = stringArray(tools.include, 256, "MCP include patterns");
    if (tools.exclude !== undefined)
      exclude = stringArray(tools.exclude, 256, "MCP exclude patterns");
    if (tools.effects !== undefined) {
      if (
        !tools.effects ||
        typeof tools.effects !== "object" ||
        Array.isArray(tools.effects) ||
        Object.keys(tools.effects).length > 256
      )
        throw new Error("MCP tool effects must be a bounded object.");
      decodedEffects = {};
      for (const [name, effect] of Object.entries(tools.effects)) {
        if (!name || name.length > 256 || !effects.has(effect as OperationKind))
          throw new Error("MCP tool effect is invalid.");
        decodedEffects[name] = effect as OperationKind;
      }
    }
  }
  let oauth: McpOAuthServer | undefined;
  if (object.oauth !== undefined) {
    if (
      decodedTransport.kind !== "http" ||
      !object.oauth ||
      typeof object.oauth !== "object" ||
      Array.isArray(object.oauth)
    )
      throw new Error("MCP oauth is valid only for HTTP server objects.");
    const auth = object.oauth as Record<string, unknown>;
    const authUnknown = Object.keys(auth).filter(
      (key) =>
        !["authorizationServer", "redirectUri", "clientId", "scopes"].includes(
          key,
        ),
    );
    if (authUnknown.length > 0)
      throw new Error(
        `Unknown MCP oauth field ${JSON.stringify(authUnknown[0])}.`,
      );
    if (
      typeof auth.authorizationServer !== "string" ||
      typeof auth.redirectUri !== "string" ||
      typeof auth.clientId !== "string"
    )
      throw new Error("MCP oauth endpoints and clientId are required strings.");
    oauth = {
      id: object.id,
      serverUrl: decodedTransport.url,
      authorizationServer: auth.authorizationServer,
      redirectUri: auth.redirectUri,
      clientId: auth.clientId,
      scopes: stringArray(auth.scopes ?? [], 64, "MCP oauth scopes"),
    };
  }
  if (
    object.credentialReference !== undefined &&
    (typeof object.credentialReference !== "string" ||
      !/^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(
        object.credentialReference,
      ))
  )
    throw new Error("MCP credentialReference is invalid.");
  if (oauth && object.credentialReference !== undefined)
    throw new Error(
      "MCP server cannot configure bearer and OAuth credentials together.",
    );
  return {
    id: object.id,
    transport: decodedTransport,
    enabled: object.enabled === undefined ? true : object.enabled === true,
    tools: {
      include,
      exclude,
      ...(decodedEffects ? { effects: decodedEffects } : {}),
    },
    ...(typeof object.credentialReference === "string"
      ? { credentialReference: object.credentialReference }
      : {}),
    ...(oauth ? { oauth } : {}),
    source,
  };
}

export function decodeMcpServers(
  input: unknown,
  base: readonly ConfiguredMcpServer[],
  source: { path: string; scope: "user" | "project" },
): {
  readonly servers: readonly ConfiguredMcpServer[];
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  if (input === undefined) return { servers: base, diagnostics: [] };
  if (!Array.isArray(input) || input.length > 32)
    return {
      servers: base,
      diagnostics: [
        { path: "mcpServers", message: "mcpServers must be a bounded array." },
      ],
    };
  const servers = [...base];
  const diagnostics: PlatformDiagnostic[] = [];
  for (let index = 0; index < input.length; index += 1) {
    try {
      const decoded = decodeOne(input[index], source);
      if (servers.some((server) => server.id === decoded.id))
        throw new Error(
          `Duplicate MCP server id ${JSON.stringify(decoded.id)}.`,
        );
      servers.push(decoded);
    } catch (error) {
      diagnostics.push({
        path: `mcpServers[${index}]`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { servers, diagnostics };
}
