import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import type { JsonObject, JsonValue } from "../core/result.ts";
import type {
  McpCallResult,
  McpConnection,
  McpServerDefinition,
  McpToolDescriptor,
  McpTransportAdapter,
} from "./index.ts";

const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface OfficialMcpAdapterOptions {
  readonly authorizeUrl?: (
    server: McpServerDefinition,
    url: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly tokenFor?: (
    server: McpServerDefinition,
  ) => Promise<string | undefined>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function boundedSchema(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP tool input schema must be an object.");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 64 * 1024)
    throw new Error("MCP tool input schema exceeds 65536 bytes.");
  return structuredClone(value) as JsonObject;
}

function safeFetch(
  options: OfficialMcpAdapterOptions,
  server: McpServerDefinition,
): FetchLike {
  return async (input, init) => {
    const request = new Request(input, init);
    if (
      !options.authorizeUrl ||
      !(await options.authorizeUrl(
        server,
        request.url,
        init?.signal ?? undefined,
      ))
    )
      throw new Error(
        `MCP HTTP destination is not authorized: ${new URL(request.url).origin}`,
      );
    return fetch(request, { redirect: "error" });
  };
}

function resolveConfiguredEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
) {
  const resolved: Record<string, string> = {};
  for (const [name, reference] of Object.entries(configured ?? {})) {
    const environmentName = /^\$\{([A-Z_][A-Z0-9_]{0,127})\}$/.exec(
      reference,
    )?.[1];
    const value = environmentName ? process.env[environmentName] : undefined;
    if (value === undefined)
      throw new Error(`MCP environment reference for ${name} is unavailable.`);
    resolved[name] = value;
  }
  return resolved;
}

function clientConnection(
  client: Client,
  transport: { close(): Promise<void> },
): McpConnection {
  let closed = false;
  return {
    async listTools(signal) {
      const result = await client.listTools(undefined, {
        signal,
        timeout: REQUEST_TIMEOUT_MS,
      });
      if (result.tools.length > 1_000)
        throw new Error("MCP server returned more than 1000 tools.");
      return result.tools.map((tool): McpToolDescriptor => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: boundedSchema(tool.inputSchema),
        ...(tool.annotations
          ? { annotations: structuredClone(tool.annotations) as JsonObject }
          : {}),
      }));
    },
    async callTool(request, signal) {
      const result = await client.callTool(
        { name: request.name, arguments: request.arguments },
        { signal, timeout: REQUEST_TIMEOUT_MS },
      );
      const content = structuredClone(result.content) as JsonValue[];
      const structuredContent = result.structuredContent;
      return {
        content,
        ...(structuredContent && typeof structuredContent === "object"
          ? {
              structuredContent: structuredClone(
                structuredContent,
              ) as JsonObject,
            }
          : {}),
        ...(result.isError === true ? { isError: true } : {}),
      } satisfies McpCallResult;
    },
    async close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      try {
        await client.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await transport.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "MCP connection close failed.");
    },
  };
}

export function createOfficialMcpAdapter(
  options: OfficialMcpAdapterOptions = {},
): McpTransportAdapter {
  return {
    async connect(definition, signal) {
      signal?.throwIfAborted();
      const client = new Client(
        { name: "pi-tool-federation", version: "1.0.0" },
        { listMaxPages: 20, versionNegotiation: { mode: "legacy" } },
      );
      if (definition.transport.kind === "stdio") {
        const transport = new StdioClientTransport({
          command: definition.transport.command,
          args: [...definition.transport.args],
          ...(definition.transport.cwd
            ? { cwd: definition.transport.cwd }
            : {}),
          env: {
            ...getDefaultEnvironment(),
            ...resolveConfiguredEnvironment(definition.transport.env),
          },
          stderr: "pipe",
          maxBufferSize: 4 * 1024 * 1024,
        });
        try {
          await client.connect(transport, {
            signal,
            timeout: CONNECT_TIMEOUT_MS,
          });
          return clientConnection(client, transport);
        } catch (error) {
          await transport.close().catch(() => undefined);
          throw new Error(
            `Could not connect MCP STDIO server ${definition.id}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      }

      const token = await options.tokenFor?.(definition);
      const transport = new StreamableHTTPClientTransport(
        new URL(definition.transport.url),
        {
          fetch: safeFetch(options, definition),
          ...(token ? { authProvider: { token: async () => token } } : {}),
          reconnectionOptions: {
            maxReconnectionDelay: 5_000,
            initialReconnectionDelay: 250,
            reconnectionDelayGrowFactor: 2,
            maxRetries: 3,
          },
        },
      );
      try {
        await client.connect(transport, {
          signal,
          timeout: CONNECT_TIMEOUT_MS,
        });
        return clientConnection(client, transport);
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw new Error(
          `Could not connect MCP HTTP server ${definition.id}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    },
  };
}
