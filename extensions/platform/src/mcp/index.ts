import { createHash } from "node:crypto";
import {
  fromJsonSchema,
  type JsonSchemaType,
} from "@modelcontextprotocol/client";
import { minimatch } from "minimatch";
import type { ArtifactStore } from "../core/artifacts/model.ts";
import type {
  JsonObject,
  JsonValue,
  ModuleError,
  Outcome,
} from "../core/result.ts";
import {
  createExternalIntegrationControls,
  type ExternalIntegrationControls,
  type ExternalUserAuthorityToken,
} from "../external/index.ts";
import type { ActorRole, OperationKind } from "../core/policy/index.ts";
import type { McpOAuthServer } from "./oauth.ts";

export interface McpStdioTransportDefinition {
  readonly kind: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpHttpTransportDefinition {
  readonly kind: "http";
  readonly url: string;
  readonly allowedOrigins: readonly string[];
  readonly allowLoopback?: boolean;
}

export interface McpServerDefinition {
  readonly id: string;
  readonly transport: McpStdioTransportDefinition | McpHttpTransportDefinition;
  readonly enabled: boolean;
  readonly tools: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
    readonly effects?: Readonly<Record<string, OperationKind>>;
  };
  readonly protocol?: "legacy" | "auto" | "2026-07-28";
  readonly credentialReference?: string;
  readonly oauth?: McpOAuthServer;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly annotations?: JsonObject;
}

export interface McpCallResult {
  readonly content: readonly JsonValue[];
  readonly structuredContent?: JsonValue;
  readonly isError?: boolean;
}

export interface McpConnection {
  listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(
    request: { readonly name: string; readonly arguments: JsonObject },
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  close(): void | Promise<void>;
}

export interface McpTransportAdapter {
  connect(
    definition: McpServerDefinition,
    signal?: AbortSignal,
  ): Promise<McpConnection>;
}

export interface FederatedToolSummary {
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
}

export interface ActivatedFederatedTool extends FederatedToolSummary {
  readonly inputSchema: JsonObject;
}

export interface ToolFederationStatus {
  readonly servers: readonly {
    readonly id: string;
    readonly state: "disabled" | "disconnected" | "connected" | "failed";
    readonly toolCount: number;
  }[];
}

export type ToolFederationErrorCode =
  | "invalid_request"
  | "server_unavailable"
  | "tool_not_found"
  | "catalog_conflict"
  | "invalid_arguments"
  | "approval_required"
  | "policy_denied"
  | "call_failed"
  | "ambiguous_outcome";
export type ToolFederationError = ModuleError<ToolFederationErrorCode>;
export type ToolFederationOutcome<T> = Outcome<T, ToolFederationError>;

export interface ToolFederation {
  status(): ToolFederationStatus;
  search(
    request: { readonly query: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<
    ToolFederationOutcome<{ readonly tools: readonly FederatedToolSummary[] }>
  >;
  activate(
    toolIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<
    ToolFederationOutcome<{ readonly tools: readonly ActivatedFederatedTool[] }>
  >;
  invoke(
    request: {
      readonly toolId: string;
      readonly arguments: JsonObject;
      readonly authority?: ExternalUserAuthorityToken;
    },
    signal?: AbortSignal,
  ): Promise<
    ToolFederationOutcome<{
      readonly content: readonly JsonValue[];
      readonly structuredContent?: JsonValue;
      readonly isError: boolean;
      readonly redactions: number;
      readonly truncations: number;
      readonly artifactId?: string;
    }>
  >;
  close(): Promise<void>;
}

export interface ToolFederationOptions {
  readonly servers: readonly McpServerDefinition[];
  readonly adapter: McpTransportAdapter;
  readonly controls?: ExternalIntegrationControls;
  readonly artifacts?: ArtifactStore;
  readonly projectId?: string;
  readonly context?: {
    readonly actor: ActorRole;
    readonly mode: () => "normal" | "plan";
  };
}

interface ServerSlot {
  readonly definition: McpServerDefinition;
  state: "disabled" | "disconnected" | "connected" | "failed";
  connection?: McpConnection;
  connecting?: Promise<McpConnection>;
  connectController?: AbortController;
  generation: number;
  tools: Map<string, McpToolDescriptor>;
  validators: Map<string, ReturnType<typeof fromJsonSchema>>;
  catalogLoaded: boolean;
}

function federationError(
  code: ToolFederationErrorCode,
  message: string,
  retryable = false,
): ToolFederationOutcome<never> {
  return { ok: false, error: { code, message, retryable } };
}

function validIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function federatedId(serverId: string, toolName: string) {
  const component = (value: string) => {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (value === normalized) return normalized;
    const suffix = createHash("sha256")
      .update(value, "utf8")
      .digest("hex")
      .slice(0, 12);
    return `${normalized.slice(0, 64)}_${suffix}`;
  };
  const raw = `${component(serverId)}__${component(toolName)}`;
  if (raw.length <= 60) return raw;
  const suffix = createHash("sha256")
    .update(raw, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${raw.slice(0, 47)}_${suffix}`;
}

const SCHEMA_ANNOTATIONS = new Set([
  "description",
  "title",
  "$comment",
  "examples",
  "default",
]);

function schemaForPublication(value: JsonObject): JsonObject {
  const schemaMaps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ]);
  const copy = (
    current: JsonValue,
    depth: number,
    preserveEntryNames = false,
  ): JsonValue => {
    if (depth > 32) throw new Error("MCP schema exceeds publication depth.");
    if (Array.isArray(current))
      return current.map((item) => copy(item, depth + 1));
    if (current && typeof current === "object") {
      const output: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(current)) {
        if (!preserveEntryNames && SCHEMA_ANNOTATIONS.has(key)) continue;
        output[key] = copy(item, depth + 1, schemaMaps.has(key));
      }
      return output;
    }
    return current;
  };
  return copy(value, 0) as JsonObject;
}

function assertBoundedJson(value: unknown, label: string) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be acyclic JSON.`);
  }
  if (Buffer.byteLength(encoded) > 1024 * 1024)
    throw new Error(`${label} exceeds 1048576 bytes.`);
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 5_000 || current.depth > 32)
      throw new Error(`${label} exceeds structural limits.`);
    if (Array.isArray(current.value))
      for (const item of current.value)
        pending.push({ value: item, depth: current.depth + 1 });
    else if (current.value && typeof current.value === "object")
      for (const item of Object.values(current.value))
        pending.push({ value: item, depth: current.depth + 1 });
  }
}

function toolSummary(serverId: string, tool: McpToolDescriptor) {
  return {
    id: federatedId(serverId, tool.name),
    serverId,
    name: tool.name,
    description: tool.description ?? "",
    readOnly: tool.annotations?.readOnlyHint === true,
  } satisfies FederatedToolSummary;
}

export function createToolFederation(
  options: ToolFederationOptions,
): ToolFederation {
  const slots = new Map<string, ServerSlot>();
  for (const definition of options.servers) {
    if (!validIdentifier(definition.id))
      throw new TypeError(
        `Invalid MCP server id ${JSON.stringify(definition.id)}.`,
      );
    if (slots.has(definition.id))
      throw new TypeError(
        `Duplicate MCP server id ${JSON.stringify(definition.id)}.`,
      );
    slots.set(definition.id, {
      definition,
      state: definition.enabled ? "disconnected" : "disabled",
      tools: new Map(),
      validators: new Map(),
      catalogLoaded: false,
      generation: 0,
    });
  }
  let closed = false;
  const controls = options.controls ?? createExternalIntegrationControls();
  const externalError = (error: unknown) => {
    const value = controls.sanitize(
      error instanceof Error ? error.message : String(error),
      { maxStringBytes: 4_096, maxNodes: 8, maxDepth: 2 },
    ).value;
    return typeof value === "string" ? value : "External MCP error.";
  };
  const context = options.context ?? {
    actor: "parent" as const,
    mode: () => "normal" as const,
  };
  const connect = async (slot: ServerSlot, signal?: AbortSignal) => {
    if (closed) throw new Error("Tool federation is closed.");
    if (slot.state === "disabled") throw new Error("MCP server is disabled.");
    if (slot.connection) return slot.connection;
    if (slot.connecting) return slot.connecting;
    const generation = ++slot.generation;
    const controller = new AbortController();
    slot.connectController = controller;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    slot.connecting = options.adapter
      .connect(slot.definition, controller.signal)
      .then(async (connection) => {
        if (closed || slot.generation !== generation) {
          await Promise.resolve(connection.close()).catch(() => undefined);
          throw new Error("MCP connection settled after federation shutdown.");
        }
        slot.connection = connection;
        slot.state = "connected";
        return connection;
      })
      .catch((error) => {
        if (!closed && slot.generation === generation) slot.state = "failed";
        throw error;
      })
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        if (slot.generation === generation) {
          slot.connecting = undefined;
          slot.connectController = undefined;
        }
      });
    return slot.connecting;
  };

  const loadCatalog = async (slot: ServerSlot, signal?: AbortSignal) => {
    if (slot.catalogLoaded) return;
    const transport = slot.definition.transport;
    const decision = await controls.assess({
      integration: "mcp",
      operation: `catalog:${slot.definition.id}`,
      effect: transport.kind === "stdio" ? "process" : "network-read",
      actor: context.actor,
      mode: context.mode(),
      ...(transport.kind === "http"
        ? {
            destination: {
              url: transport.url,
              allowedOrigins: transport.allowedOrigins,
              allowLoopback: transport.allowLoopback ?? false,
            },
          }
        : {}),
    });
    if (decision.kind !== "allow")
      throw new Error(`MCP catalog denied: ${decision.reason}`);
    const connection = await connect(slot, signal);
    const listed = await connection.listTools(signal);
    const next = new Map<string, McpToolDescriptor>();
    const nextValidators = new Map<string, ReturnType<typeof fromJsonSchema>>();
    const generated = new Set<string>();
    for (const tool of listed) {
      const included = slot.definition.tools.include.some((pattern) =>
        minimatch(tool.name, pattern, { dot: true, nocase: false }),
      );
      const excluded = slot.definition.tools.exclude.some((pattern) =>
        minimatch(tool.name, pattern, { dot: true, nocase: false }),
      );
      if (!included || excluded) continue;
      if (!validIdentifier(tool.name))
        throw new Error(
          `MCP server ${slot.definition.id} returned an invalid tool name.`,
        );
      const id = federatedId(slot.definition.id, tool.name);
      if (generated.has(id))
        throw new Error(
          `MCP server ${slot.definition.id} returned colliding tool names.`,
        );
      generated.add(id);
      const description = controls.sanitize(tool.description ?? "", {
        maxStringBytes: 4_096,
        maxNodes: 8,
        maxDepth: 2,
      }).value;
      let validator: ReturnType<typeof fromJsonSchema>;
      try {
        validator = fromJsonSchema(tool.inputSchema as JsonSchemaType);
      } catch (error) {
        throw new Error(
          `MCP server ${slot.definition.id} returned an invalid schema for ${tool.name}: ${externalError(error)}`,
        );
      }
      next.set(tool.name, {
        ...structuredClone(tool),
        inputSchema: schemaForPublication(tool.inputSchema),
        description: typeof description === "string" ? description : "",
      });
      nextValidators.set(tool.name, validator);
    }
    slot.tools = next;
    slot.validators = nextValidators;
    slot.catalogLoaded = true;
  };

  return {
    status() {
      return {
        servers: [...slots.values()]
          .sort((left, right) =>
            left.definition.id.localeCompare(right.definition.id),
          )
          .map((slot) => ({
            id: slot.definition.id,
            state: slot.state,
            toolCount: slot.tools.size,
          })),
      };
    },
    async search(request, signal) {
      const query = request.query.trim().toLowerCase();
      const limit = request.limit ?? 10;
      if (
        !query ||
        Buffer.byteLength(query) > 1_024 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        return federationError(
          "invalid_request",
          "MCP search request is invalid.",
        );
      const enabled = [...slots.values()].filter(
        (slot) => slot.state !== "disabled",
      );
      const settlements = await Promise.allSettled(
        enabled.map((slot) => loadCatalog(slot, signal)),
      );
      if (
        enabled.length > 0 &&
        settlements.every((settlement) => settlement.status === "rejected")
      )
        return federationError(
          "server_unavailable",
          externalError(
            (settlements[0] as PromiseRejectedResult | undefined)?.reason,
          ),
          true,
        );
      const terms = query.split(/[^a-z0-9]+/).filter(Boolean);
      const tools = [...slots.values()]
        .flatMap((slot) =>
          [...slot.tools.values()].map((tool) => ({
            summary: toolSummary(slot.definition.id, tool),
            score: terms.reduce(
              (score, term) =>
                score +
                (`${tool.name} ${tool.description ?? ""}`
                  .toLowerCase()
                  .includes(term)
                  ? 1
                  : 0),
              0,
            ),
          })),
        )
        .filter(({ score }) => score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.summary.id.localeCompare(right.summary.id),
        )
        .slice(0, limit)
        .map(({ summary }) => summary);
      return { ok: true, value: { tools } };
    },
    async activate(toolIds, signal) {
      if (
        toolIds.length === 0 ||
        toolIds.length > 50 ||
        new Set(toolIds).size !== toolIds.length
      )
        return federationError(
          "invalid_request",
          "MCP activation request is invalid.",
        );
      const activated: ActivatedFederatedTool[] = [];
      try {
        for (const toolId of toolIds) {
          let match: { slot: ServerSlot; tool: McpToolDescriptor } | undefined;
          for (const slot of slots.values()) {
            if (slot.state === "disabled") continue;
            try {
              await loadCatalog(slot, signal);
            } catch {
              continue;
            }
            const tool = [...slot.tools.values()].find(
              (candidate) =>
                federatedId(slot.definition.id, candidate.name) === toolId,
            );
            if (tool) {
              match = { slot, tool };
              break;
            }
          }
          if (!match)
            return federationError(
              "tool_not_found",
              `Federated tool ${JSON.stringify(toolId)} was not found.`,
            );
          activated.push({
            ...toolSummary(match.slot.definition.id, match.tool),
            inputSchema: structuredClone(match.tool.inputSchema),
          });
        }
      } catch (error) {
        return federationError(
          "server_unavailable",
          externalError(error),
          true,
        );
      }
      return { ok: true, value: { tools: activated } };
    },
    async invoke(request, signal) {
      if (
        !validIdentifier(request.toolId) &&
        !/^[a-z0-9_]+__[a-z0-9_]+$/.test(request.toolId)
      )
        return federationError(
          "invalid_request",
          "Federated tool id is invalid.",
        );
      let match: { slot: ServerSlot; tool: McpToolDescriptor } | undefined;
      try {
        for (const slot of slots.values()) {
          if (slot.state === "disabled") continue;
          try {
            await loadCatalog(slot, signal);
          } catch {
            continue;
          }
          const tool = [...slot.tools.values()].find(
            (candidate) =>
              federatedId(slot.definition.id, candidate.name) ===
              request.toolId,
          );
          if (tool) {
            match = { slot, tool };
            break;
          }
        }
      } catch (error) {
        return federationError(
          "server_unavailable",
          externalError(error),
          true,
        );
      }
      if (!match)
        return federationError(
          "tool_not_found",
          `Federated tool ${JSON.stringify(request.toolId)} was not found.`,
        );
      let validator = match.slot.validators.get(match.tool.name);
      if (!validator) {
        try {
          if (
            Buffer.byteLength(JSON.stringify(match.tool.inputSchema)) >
            64 * 1024
          )
            throw new Error("Tool schema exceeds 65536 bytes.");
          const compiled = fromJsonSchema(
            match.tool.inputSchema as JsonSchemaType,
          );
          match.slot.validators.set(match.tool.name, compiled);
          validator = compiled;
        } catch (error) {
          return federationError(
            "catalog_conflict",
            `Federated tool schema is invalid: ${externalError(error)}`,
          );
        }
      }
      if (!validator)
        return federationError(
          "catalog_conflict",
          "Federated tool schema validator was unavailable.",
        );
      try {
        assertBoundedJson(request.arguments, "Federated tool arguments");
      } catch (error) {
        return federationError("invalid_arguments", externalError(error));
      }
      const callArguments = structuredClone(request.arguments);
      const validation = await validator["~standard"].validate(callArguments);
      if (validation.issues)
        return federationError(
          "invalid_arguments",
          "Federated tool arguments do not match the advertised schema.",
        );
      const effect =
        match.slot.definition.tools.effects?.[match.tool.name] ??
        "remote-write";
      const destination =
        match.slot.definition.transport.kind === "http"
          ? {
              url: match.slot.definition.transport.url,
              allowedOrigins: match.slot.definition.transport.allowedOrigins,
              allowLoopback:
                match.slot.definition.transport.allowLoopback ?? false,
            }
          : undefined;
      const decision = await controls.assess(
        {
          integration: "mcp",
          operation: request.toolId,
          effect,
          actor: context.actor,
          mode: context.mode(),
          ...(destination ? { destination } : {}),
        },
        request.authority,
      );
      if (decision.kind !== "allow")
        return federationError(
          decision.kind === "require-user-confirmation"
            ? "approval_required"
            : "policy_denied",
          decision.reason,
        );
      try {
        const connection = await connect(match.slot, signal);
        let result: McpCallResult;
        try {
          result = await connection.callTool(
            { name: match.tool.name, arguments: callArguments },
            signal,
          );
        } catch (error) {
          await Promise.resolve(connection.close()).catch(() => undefined);
          match.slot.connection = undefined;
          match.slot.state = "disconnected";
          match.slot.catalogLoaded = false;
          match.slot.tools.clear();
          match.slot.validators.clear();
          const sanitizedError = controls.sanitize(
            error instanceof Error ? error.message : String(error),
            { maxStringBytes: 4_096, maxNodes: 8, maxDepth: 2 },
          ).value;
          return federationError(
            "ambiguous_outcome",
            `MCP tool outcome is unknown after transport failure: ${typeof sanitizedError === "string" ? sanitizedError : "external error"}`,
          );
        }
        const complete = controls.sanitize(result, {
          maxStringBytes: 16 * 1024 * 1024,
          maxNodes: 10_000,
          maxDepth: 32,
        });
        const completeBody = JSON.stringify(complete.value);
        if (Buffer.byteLength(completeBody) > 16 * 1024 * 1024)
          return federationError(
            "call_failed",
            "MCP result exceeds the 16777216-byte artifact limit.",
          );
        let artifactId: string | undefined;
        if (Buffer.byteLength(completeBody) > 50 * 1024 && options.artifacts) {
          const stored = await options.artifacts.put({
            body: completeBody,
            filename: "mcp-result.json",
            mediaType: "application/json",
            metadata: {
              source: "mcp",
              ...(options.projectId ? { projectId: options.projectId } : {}),
            },
          });
          if (!stored.ok)
            return federationError("call_failed", stored.error.message);
          artifactId = stored.value.id;
        }
        const sanitized = controls.sanitize(result, {
          maxStringBytes: 45 * 1024,
          maxNodes: 2_000,
          maxDepth: 16,
        });
        let value = sanitized.value as McpCallResult;
        if (Buffer.byteLength(JSON.stringify(value)) > 50 * 1024) {
          value = {
            content: [
              {
                type: "text",
                text: artifactId
                  ? `MCP output truncated. Bounded sanitized result artifact: ${artifactId}`
                  : "MCP output truncated at the inline result limit.",
              },
            ],
            isError: result.isError,
          };
        }
        return {
          ok: true,
          value: {
            content: value.content ?? [],
            ...(value.structuredContent !== undefined
              ? { structuredContent: value.structuredContent }
              : {}),
            isError: value.isError === true,
            redactions: complete.redactions,
            truncations: sanitized.truncations,
            ...(artifactId ? { artifactId } : {}),
          },
        };
      } catch (error) {
        return federationError("call_failed", externalError(error), true);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const slot of [...slots.values()].reverse()) {
        slot.generation += 1;
        slot.connectController?.abort(
          new Error("Tool federation is shutting down."),
        );
        if (slot.connecting) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              slot.connecting.catch(() => undefined),
              new Promise<void>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("MCP connect cleanup timed out.")),
                  5_000,
                );
              }),
            ]);
          } catch (error) {
            failures.push(error);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        try {
          await Promise.resolve(slot.connection?.close());
        } catch (error) {
          failures.push(error);
        }
        slot.connection = undefined;
        slot.connecting = undefined;
        slot.connectController = undefined;
        slot.tools.clear();
        slot.validators.clear();
        slot.catalogLoaded = false;
        slot.state = slot.definition.enabled ? "disconnected" : "disabled";
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Tool federation close failed.");
    },
  };
}
