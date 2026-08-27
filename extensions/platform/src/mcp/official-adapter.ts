import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import type { JsonObject, JsonValue } from "../core/result.ts";
import {
  createPinnedFetch,
  type PinnedFetchAuthorization,
} from "../external/pinned-fetch.ts";
import {
  snapshotWindowsProcessTree,
  terminateWindowsProcessTreeSnapshot,
  type WindowsProcessIdentity,
  type WindowsProcessTreeSnapshot,
} from "../core/processes/windows-tree.ts";
import type {
  McpCallResult,
  McpConnection,
  McpServerDefinition,
  McpToolDescriptor,
  McpTransportAdapter,
} from "./index.ts";

const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

class OwnedStdioClientTransport extends StdioClientTransport {
  spawnedPid?: number;
  rootIdentity?: Promise<WindowsProcessIdentity | undefined>;
  private retained?: WindowsProcessTreeSnapshot;
  private tracker?: NodeJS.Timeout;
  private capturing = false;

  private async capture(pid: number, expected?: WindowsProcessIdentity) {
    if (this.capturing) return;
    this.capturing = true;
    try {
      const snapshot = await snapshotWindowsProcessTree(pid);
      if (
        expected &&
        snapshot.root &&
        snapshot.root.startedAt !== expected.startedAt
      )
        return;
      if (!snapshot.root && !this.retained) return;
      const root = this.retained?.root ?? snapshot.root;
      const descendants = new Map<string, WindowsProcessIdentity>();
      for (const identity of [
        ...(this.retained?.descendants ?? []),
        ...snapshot.descendants,
      ])
        descendants.set(`${identity.pid}:${identity.startedAt}`, identity);
      this.retained = {
        ...(root ? { root } : {}),
        descendants: [...descendants.values()],
      };
    } finally {
      this.capturing = false;
    }
  }

  async takeRetainedSnapshot() {
    const root = await this.rootIdentity;
    if (this.tracker) clearInterval(this.tracker);
    this.tracker = undefined;
    while (this.capturing)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (root) await this.capture(root.pid, root);
    return this.retained ?? { descendants: [] };
  }

  override async start() {
    await super.start();
    const pid = this.pid;
    if (pid) this.spawnedPid = pid;
    if (process.platform === "win32" && pid)
      this.rootIdentity = (async () => {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          const snapshot = await snapshotWindowsProcessTree(pid);
          if (snapshot.root) {
            this.retained = snapshot;
            this.tracker = setInterval(
              () => void this.capture(pid, snapshot.root),
              25,
            );
            this.tracker.unref();
            return snapshot.root;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return undefined;
      })();
  }
}

export interface OfficialMcpAdapterOptions {
  readonly authorizeUrl?: (
    server: McpServerDefinition,
    url: string,
    signal?: AbortSignal,
  ) => Promise<PinnedFetchAuthorization>;
  readonly tokenFor?: (
    server: McpServerDefinition,
  ) => Promise<string | undefined>;
  readonly refreshTokenFor?: (server: McpServerDefinition) => Promise<void>;
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
) {
  return createPinnedFetch({
    authorize: (url, signal) => {
      if (!options.authorizeUrl) return Promise.resolve({ allowed: false });
      return options.authorizeUrl(server, url, signal);
    },
  });
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

async function settleWithin(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP close timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clientConnection(
  client: Client,
  transport: { close(): Promise<void> },
  processTree?: () => Promise<WindowsProcessTreeSnapshot>,
  terminateRemote?: () => Promise<void>,
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
      return {
        content,
        ...(result.structuredContent !== undefined
          ? {
              structuredContent: structuredClone(
                result.structuredContent,
              ) as JsonValue,
            }
          : {}),
        ...(result.isError === true ? { isError: true } : {}),
      } satisfies McpCallResult;
    },
    async close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      let snapshot: WindowsProcessTreeSnapshot | undefined;
      if (processTree) {
        try {
          snapshot = await processTree();
        } catch (error) {
          failures.push(error);
        }
      }
      if (terminateRemote) {
        try {
          await settleWithin(terminateRemote(), 5_000);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await settleWithin(client.close(), 5_000);
      } catch (error) {
        failures.push(error);
      }
      try {
        await settleWithin(transport.close(), 5_000);
      } catch (error) {
        failures.push(error);
      }
      if (snapshot) {
        try {
          await terminateWindowsProcessTreeSnapshot(snapshot);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `MCP connection close failed: ${failures.map(errorMessage).join("; ")}`,
        );
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
        {
          listMaxPages: 20,
          versionNegotiation:
            definition.protocol === "2026-07-28"
              ? { mode: { pin: "2026-07-28" } }
              : { mode: definition.protocol ?? "auto" },
        },
      );
      if (definition.transport.kind === "stdio") {
        const transport = new OwnedStdioClientTransport({
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
        const spawnedRoot = () =>
          transport.rootIdentity ?? Promise.resolve(undefined);
        try {
          await client.connect(transport, {
            signal,
            timeout: CONNECT_TIMEOUT_MS,
          });
          if (process.platform === "win32") {
            const root = await spawnedRoot();
            if (!root)
              throw new Error(
                "MCP STDIO root creation identity is unavailable.",
              );
          }
          return clientConnection(
            client,
            transport,
            process.platform === "win32"
              ? () => transport.takeRetainedSnapshot()
              : undefined,
          );
        } catch (error) {
          const retained =
            process.platform === "win32"
              ? await transport.takeRetainedSnapshot().catch(() => undefined)
              : undefined;
          if (retained)
            await terminateWindowsProcessTreeSnapshot(retained).catch(
              () => undefined,
            );
          await settleWithin(transport.close(), 5_000).catch(() => undefined);
          throw new Error(
            `Could not connect MCP STDIO server ${definition.id}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      }

      const transport = new StreamableHTTPClientTransport(
        new URL(definition.transport.url),
        {
          fetch: safeFetch(options, definition),
          ...(options.tokenFor
            ? {
                authProvider: {
                  // Never install onUnauthorized: the official client retries the
                  // same JSON-RPC POST after it refreshes, which can duplicate a
                  // mutation whose first outcome was ambiguous.
                  token: () => options.tokenFor!(definition),
                },
              }
            : {}),
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
        return clientConnection(client, transport, undefined, () =>
          transport.terminateSession(),
        );
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
