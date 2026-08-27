import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { minimatch } from "minimatch";
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
  readonly structuredContent?: JsonObject;
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
  | "call_failed";
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
      readonly structuredContent?: JsonObject;
      readonly isError: boolean;
      readonly redactions: number;
      readonly truncations: number;
    }>
  >;
  close(): Promise<void>;
}

export interface ToolFederationOptions {
  readonly servers: readonly McpServerDefinition[];
  readonly adapter: McpTransportAdapter;
  readonly controls?: ExternalIntegrationControls;
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
  tools: Map<string, McpToolDescriptor>;
  validators: Map<string, ValidateFunction>;
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
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return `${normalize(serverId)}__${normalize(toolName)}`;
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
    });
  }
  let closed = false;
  const controls = options.controls ?? createExternalIntegrationControls();
  const context = options.context ?? {
    actor: "parent" as const,
    mode: () => "normal" as const,
  };
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    $data: false,
    validateFormats: false,
  });

  const connect = async (slot: ServerSlot, signal?: AbortSignal) => {
    if (closed) throw new Error("Tool federation is closed.");
    if (slot.state === "disabled") throw new Error("MCP server is disabled.");
    if (slot.connection) return slot.connection;
    if (slot.connecting) return slot.connecting;
    slot.connecting = options.adapter
      .connect(slot.definition, signal)
      .then((connection) => {
        slot.connection = connection;
        slot.state = "connected";
        return connection;
      })
      .catch((error) => {
        slot.state = "failed";
        throw error;
      })
      .finally(() => {
        slot.connecting = undefined;
      });
    return slot.connecting;
  };

  const loadCatalog = async (slot: ServerSlot, signal?: AbortSignal) => {
    if (slot.tools.size > 0) return;
    const connection = await connect(slot, signal);
    const listed = await connection.listTools(signal);
    const next = new Map<string, McpToolDescriptor>();
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
      next.set(tool.name, structuredClone(tool));
    }
    slot.tools = next;
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
      try {
        await Promise.all(
          [...slots.values()]
            .filter((slot) => slot.state !== "disabled")
            .map((slot) => loadCatalog(slot, signal)),
        );
      } catch (error) {
        return federationError(
          "server_unavailable",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
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
            await loadCatalog(slot, signal);
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
          error instanceof Error ? error.message : String(error),
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
          await loadCatalog(slot, signal);
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
          error instanceof Error ? error.message : String(error),
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
          const compiled = ajv.compile(match.tool.inputSchema);
          match.slot.validators.set(match.tool.name, compiled);
          validator = compiled;
        } catch (error) {
          return federationError(
            "catalog_conflict",
            `Federated tool schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!validator)
        return federationError(
          "catalog_conflict",
          "Federated tool schema validator was unavailable.",
        );
      const callArguments = structuredClone(request.arguments);
      if (!validator(callArguments))
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
        const result = await connection.callTool(
          { name: match.tool.name, arguments: callArguments },
          signal,
        );
        const sanitized = controls.sanitize(result);
        const value = sanitized.value as McpCallResult;
        return {
          ok: true,
          value: {
            content: value.content ?? [],
            ...(value.structuredContent
              ? { structuredContent: value.structuredContent }
              : {}),
            isError: value.isError === true,
            redactions: sanitized.redactions,
            truncations: sanitized.truncations,
          },
        };
      } catch (error) {
        return federationError(
          "call_failed",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const slot of [...slots.values()].reverse()) {
        try {
          await slot.connection?.close();
        } catch (error) {
          failures.push(error);
        }
        slot.connection = undefined;
        slot.tools.clear();
        slot.validators.clear();
        slot.state = slot.definition.enabled ? "disconnected" : "disabled";
      }
      if (failures.length > 0)
        throw new AggregateError(failures, "Tool federation close failed.");
    },
  };
}
