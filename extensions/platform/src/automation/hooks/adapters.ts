import { createHash } from "node:crypto";
import type { ActorRole } from "../../core/policy/index.ts";
import type { JsonObject } from "../../core/result.ts";
import type { CredentialVault } from "../../external/credentials.ts";
import type {
  ExternalIntegrationControls,
  ExternalUserAuthorityToken,
} from "../../external/index.ts";
import { createPinnedFetch } from "../../external/pinned-fetch.ts";
import type { ToolFederation } from "../../mcp/index.ts";
import type {
  ProfileCatalog,
  ResolvedAgentProfile,
} from "../../profiles/index.ts";
import type {
  HookAdapterResult,
  HookAgentAdapter,
  HookHttpAdapter,
  HookHttpAdapterRequest,
  HookHttpAuthorityRequest,
  HookMcpAdapter,
  HookNamedAdapterRequest,
} from "./phase7.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface NamedHookHttpDefinition {
  readonly id: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly effect: "network-read" | "remote-write";
  readonly allowedOrigins: readonly string[];
  readonly allowLoopback: boolean;
  readonly credentialReference?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface NamedHookHttpAuthorityGrant {
  readonly scope: string;
  readonly deadlineMs: number;
}

export interface NamedHookHttpAdapterOptions {
  readonly definitions: readonly NamedHookHttpDefinition[];
  readonly controls: ExternalIntegrationControls;
  readonly credentials?: CredentialVault;
  readonly actor: () => ActorRole;
  readonly mode: () => "normal" | "plan";
  readonly issueAuthority?: (
    grant: NamedHookHttpAuthorityGrant,
  ) => ExternalUserAuthorityToken;
}

export interface NamedHookMcpDefinition {
  readonly id: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly federatedToolId: string;
}

export interface NamedHookMcpAdapterOptions {
  readonly definitions: readonly NamedHookMcpDefinition[];
  readonly federation: ToolFederation;
  readonly controls: ExternalIntegrationControls;
}

export interface NamedProfileExecutionPort {
  revalidateProfile(request: {
    readonly name: string;
    readonly contentDigest: string;
    readonly catalogGeneration: number;
    readonly source: ResolvedAgentProfile["identity"]["source"];
    readonly cwd: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly trusted: boolean;
    readonly contentDigest: string;
  }>;
  run(request: {
    readonly profile: ResolvedAgentProfile;
    readonly prompt: string;
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
    readonly outputCapBytes: number;
  }): Promise<HookAdapterResult>;
}

export interface NamedHookAgentAdapterOptions {
  readonly profiles: ProfileCatalog;
  readonly execution: NamedProfileExecutionPort;
  readonly controls: ExternalIntegrationControls;
  readonly maxPromptBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundUtf8(value: string, maximum: number) {
  if (Buffer.byteLength(value) <= maximum) return value;
  let result = Buffer.from(value).subarray(0, maximum).toString("utf8");
  while (Buffer.byteLength(result) > maximum) result = result.slice(0, -1);
  return result;
}

function sanitizedText(
  controls: ExternalIntegrationControls,
  value: unknown,
  maximum = 4_096,
  exactRedactions: readonly string[] = [],
) {
  const sanitized = controls.sanitize(
    value instanceof Error ? value.message : String(value),
    {
      maxStringBytes: maximum,
      maxNodes: 8,
      maxDepth: 2,
      exactRedactions,
    },
  ).value;
  return boundUtf8(
    typeof sanitized === "string" ? sanitized : "External operation failed.",
    maximum,
  );
}

function fail(
  controls: ExternalIntegrationControls,
  prefix: string,
  error: unknown,
  exactRedactions: readonly string[] = [],
): never {
  throw new Error(
    boundUtf8(
      `${prefix}: ${sanitizedText(controls, error, 4_096, exactRedactions)}`,
      4_096,
    ),
  );
}

function validateDirectRequest(
  request: HookNamedAdapterRequest,
  allowedKeys: readonly string[],
) {
  if (!isRecord(request))
    throw new TypeError("Hook adapter request is invalid.");
  const allowed = new Set(allowedKeys);
  if (
    ["name", "cwd", "signal", "deadlineMs", "outputCapBytes"].some(
      (key) => !Object.hasOwn(request, key),
    ) ||
    (allowed.has("prompt") && !Object.hasOwn(request, "prompt")) ||
    Object.keys(request).some((key) => !allowed.has(key))
  )
    throw new TypeError("Hook adapter request contains invalid fields.");
  if (!IDENTIFIER.test(request.name))
    throw new TypeError("Hook adapter action name is invalid.");
  if (
    typeof request.cwd !== "string" ||
    request.cwd.length === 0 ||
    request.cwd.length > 4_096 ||
    request.cwd.includes("\0") ||
    !(request.signal instanceof AbortSignal) ||
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs > Date.now() + 86_400_000 ||
    !Number.isSafeInteger(request.outputCapBytes) ||
    request.outputCapBytes < 1 ||
    request.outputCapBytes > MAX_OUTPUT_BYTES
  )
    throw new TypeError("Hook adapter request is invalid.");
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum)
    throw new TypeError(`${field} is invalid.`);
  return resolved;
}

function encodedJson(value: unknown, maximum: number, label: string) {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 10_000 || current.depth > 32)
      throw new TypeError(`${label} is too complex.`);
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    )
      continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value))
        throw new TypeError(`${label} contains an invalid number.`);
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value)
        stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, item] of Object.entries(current.value)) {
        if (key.length > 1_024 || key.includes("\0"))
          throw new TypeError(`${label} contains an invalid key.`);
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    throw new TypeError(`${label} must contain only JSON data.`);
  }
  const result = JSON.stringify(value);
  if (result === undefined || Buffer.byteLength(result) > maximum)
    throw new TypeError(`${label} exceeds ${maximum} bytes.`);
  return result;
}

function jsonObject(value: unknown, label: string) {
  if (!isRecord(value)) throw new TypeError(`${label} must be a JSON object.`);
  encodedJson(value, MAX_JSON_BYTES, label);
  return structuredClone(value) as JsonObject;
}

function linkedController(signal: AbortSignal, deadlineMs: number) {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const remaining = deadlineMs - Date.now();
  const timer = setTimeout(
    () => controller.abort(new Error("Hook adapter deadline exceeded.")),
    Math.max(0, remaining),
  );
  return {
    controller,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    },
  };
}

async function cancellable<T>(
  signal: AbortSignal,
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  if (deadlineMs <= Date.now())
    throw new Error("Hook adapter deadline exceeded.");
  const linked = linkedController(signal, deadlineMs);
  const pending = Promise.resolve().then(() =>
    operation(linked.controller.signal),
  );
  const cancelled = new Promise<never>((_resolve, reject) => {
    const rejectCancelled = () =>
      reject(
        linked.controller.signal.reason ??
          new DOMException("Aborted", "AbortError"),
      );
    if (linked.controller.signal.aborted) rejectCancelled();
    else
      linked.controller.signal.addEventListener("abort", rejectCancelled, {
        once: true,
      });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    linked.dispose();
    void pending.catch(() => undefined);
  }
}

function canonicalHttpDefinition(definition: NamedHookHttpDefinition) {
  if (!IDENTIFIER.test(definition.id))
    throw new TypeError("Named HTTP action id is invalid.");
  if (definition.method !== "GET" && definition.method !== "POST")
    throw new TypeError("Named HTTP action method is invalid.");
  if (
    definition.effect !== "network-read" &&
    definition.effect !== "remote-write"
  )
    throw new TypeError("Named HTTP action effect is invalid.");
  const effect = definition.method === "GET" ? "network-read" : "remote-write";
  if (definition.effect !== effect)
    throw new TypeError("Named HTTP action effect does not match its method.");
  let url: URL;
  try {
    url = new URL(definition.url);
  } catch {
    throw new TypeError("Named HTTP action URL must be canonical HTTP(S).");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== definition.url
  )
    throw new TypeError("Named HTTP action URL must be canonical HTTP(S).");
  if (
    definition.allowedOrigins.length === 0 ||
    !definition.allowedOrigins.every((origin) => {
      try {
        const candidate = new URL(origin);
        return (
          candidate.origin === origin &&
          (candidate.protocol === "http:" || candidate.protocol === "https:") &&
          !candidate.username &&
          !candidate.password
        );
      } catch {
        return false;
      }
    })
  )
    throw new TypeError("Named HTTP action allowed origins are invalid.");
  if (!definition.allowedOrigins.includes(url.origin))
    throw new TypeError("Named HTTP action origin is not allowlisted.");
  if (typeof definition.allowLoopback !== "boolean")
    throw new TypeError("Named HTTP action loopback policy is invalid.");
  if (
    definition.credentialReference !== undefined &&
    !/^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(
      definition.credentialReference,
    )
  )
    throw new TypeError("Named HTTP credential reference is invalid.");
  return Object.freeze({
    ...definition,
    effect,
    allowedOrigins: Object.freeze([...definition.allowedOrigins]),
    maxRequestBytes: positiveBoundedInteger(
      definition.maxRequestBytes,
      MAX_JSON_BYTES,
      4 * 1024 * 1024,
      "Named HTTP maxRequestBytes",
    ),
    maxResponseBytes: positiveBoundedInteger(
      definition.maxResponseBytes,
      1024 * 1024,
      MAX_OUTPUT_BYTES,
      "Named HTTP maxResponseBytes",
    ),
  });
}

function httpRequestBody(
  definition: ReturnType<typeof canonicalHttpDefinition>,
  request: HookHttpAuthorityRequest,
) {
  if (!Number.isSafeInteger(request.generation) || request.generation < 0)
    throw new TypeError("Hook HTTP generation is invalid.");
  if (definition.method === "GET" && request.input !== undefined)
    throw new TypeError("Named HTTP GET actions do not accept input.");
  return definition.method === "POST"
    ? encodedJson(
        request.input ?? null,
        definition.maxRequestBytes,
        "Named HTTP action input",
      )
    : undefined;
}

function httpAuthorityScope(
  definition: ReturnType<typeof canonicalHttpDefinition>,
  request: HookHttpAuthorityRequest,
  body: string | undefined,
  actor: ActorRole,
) {
  const binding = JSON.stringify({
    adapter: definition.id,
    method: definition.method,
    origin: new URL(definition.url).origin,
    inputDigest: createHash("sha256")
      .update(body ?? "")
      .digest("hex"),
    actor,
    generation: request.generation,
    deadlineMs: request.deadlineMs,
  });
  return `hook-http-v1:${createHash("sha256").update(binding).digest("hex")}`;
}

function validHttpAuthority(
  authority: ExternalUserAuthorityToken,
  expectedScope: string,
) {
  return (
    isRecord(authority) &&
    authority.kind === "external-user-authority" &&
    typeof authority.value === "string" &&
    authority.value.length > 0 &&
    authority.value.length <= 4_096 &&
    authority.scope === expectedScope &&
    Object.keys(authority).every((key) =>
      ["kind", "value", "scope"].includes(key),
    )
  );
}

async function boundedResponseBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted)
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const item = await reader.read();
      if (signal.aborted)
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error(`HTTP response exceeds ${maximum} bytes.`);
      }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

function outputJson(
  controls: ExternalIntegrationControls,
  value: unknown,
  maximum: number,
  exactRedactions: readonly string[] = [],
) {
  const sanitized = controls.sanitize(value, {
    maxStringBytes: maximum,
    maxNodes: 10_000,
    maxDepth: 32,
    exactRedactions,
  }).value;
  const encoded = JSON.stringify(sanitized);
  if (encoded !== undefined && Buffer.byteLength(encoded) <= maximum)
    return encoded;
  const marker = JSON.stringify({ truncated: true });
  if (Buffer.byteLength(marker) <= maximum) return marker;
  return maximum >= 4 ? "null" : "0";
}

export function createNamedHookHttpAdapter(
  options: NamedHookHttpAdapterOptions,
): HookHttpAdapter {
  const definitions = new Map<
    string,
    ReturnType<typeof canonicalHttpDefinition>
  >();
  for (const candidate of options.definitions) {
    const definition = canonicalHttpDefinition(candidate);
    if (definitions.has(definition.id))
      throw new TypeError(`Duplicate named HTTP action ${definition.id}.`);
    definitions.set(definition.id, definition);
  }
  const issueAuthority = options.issueAuthority;
  return {
    classify(name) {
      return definitions.get(name)?.effect;
    },
    ...(issueAuthority
      ? {
          authorize(request: HookHttpAuthorityRequest) {
            validateDirectRequest(request, [
              "name",
              "input",
              "cwd",
              "signal",
              "deadlineMs",
              "outputCapBytes",
              "generation",
            ]);
            const definition = definitions.get(request.name);
            if (!definition)
              throw new Error("Named HTTP action is not configured.");
            const body = httpRequestBody(definition, request);
            const scope = httpAuthorityScope(
              definition,
              request,
              body,
              options.actor(),
            );
            const authority = issueAuthority({
              scope,
              deadlineMs: request.deadlineMs,
            });
            if (!validHttpAuthority(authority, scope))
              throw new Error("Issued Hook HTTP authority is invalid.");
            return authority;
          },
        }
      : {}),
    async invoke(request: HookHttpAdapterRequest) {
      validateDirectRequest(request, [
        "name",
        "input",
        "cwd",
        "signal",
        "deadlineMs",
        "outputCapBytes",
        "generation",
        "authority",
      ]);
      const definition = definitions.get(request.name);
      if (!definition) throw new Error("Named HTTP action is not configured.");
      const body = httpRequestBody(definition, request);
      const actor = options.actor();
      const expectedScope = httpAuthorityScope(
        definition,
        request,
        body,
        actor,
      );
      if (
        request.authority !== undefined &&
        !validHttpAuthority(request.authority, expectedScope)
      )
        throw new Error("Hook HTTP authority does not match this operation.");
      let credential: string | undefined;
      try {
        return await cancellable(
          request.signal,
          request.deadlineMs,
          async (signal) => {
            const destination = {
              url: definition.url,
              allowedOrigins: definition.allowedOrigins,
              allowLoopback: definition.allowLoopback,
            };
            if (definition.credentialReference) {
              if (!options.credentials)
                throw new Error("Credential vault is unavailable.");
              const credentialDecision = await options.controls.assess({
                integration: "hook",
                operation: definition.id,
                effect: "credential-use",
                actor: options.actor(),
                mode: options.mode(),
                destination,
              });
              if (credentialDecision.kind !== "allow")
                throw new Error(credentialDecision.reason);
              credential = await options.credentials.resolve(
                definition.credentialReference,
                {
                  integration: "hook",
                  resourceId: `hook-http.${definition.id}`,
                  origin: new URL(definition.url).origin,
                },
              );
              if (credential === undefined)
                throw new Error("Configured HTTP credential is unavailable.");
            }
            const fetch = createPinnedFetch({
              maxRequestBytes: definition.maxRequestBytes,
              authorize: async (url) => {
                if (url !== definition.url) return { allowed: false };
                const current = await options.controls.assess(
                  {
                    integration: "hook",
                    operation: definition.id,
                    effect: definition.effect,
                    actor,
                    mode: options.mode(),
                    destination: { ...destination, url },
                  },
                  request.authority,
                );
                return current.kind === "allow"
                  ? {
                      allowed: true,
                      canonicalUrl: current.canonicalUrl,
                      resolvedAddresses: current.resolvedAddresses,
                    }
                  : { allowed: false };
              },
            });
            const response = await fetch(definition.url, {
              method: definition.method,
              redirect: "error",
              signal,
              headers: {
                accept: "application/json",
                ...(body === undefined
                  ? {}
                  : { "content-type": "application/json; charset=utf-8" }),
                ...(credential === undefined
                  ? {}
                  : { authorization: `Bearer ${credential}` }),
              },
              ...(body === undefined ? {} : { body }),
            });
            if (!response.ok)
              throw new Error(
                `HTTP endpoint returned status ${response.status}.`,
              );
            const contentType = response.headers.get("content-type") ?? "";
            if (!/^application\/json(?:\s*;|$)/i.test(contentType))
              throw new Error("HTTP endpoint did not return JSON.");
            const bytes = await boundedResponseBody(
              response,
              definition.maxResponseBytes,
              signal,
            );
            let decoded: unknown;
            try {
              decoded = JSON.parse(bytes.toString("utf8"));
            } catch {
              throw new Error("HTTP endpoint returned invalid JSON.");
            }
            return {
              output: outputJson(
                options.controls,
                decoded,
                request.outputCapBytes,
                credential === undefined ? [] : [credential],
              ),
            } satisfies HookAdapterResult;
          },
        );
      } catch (error) {
        fail(
          options.controls,
          "Named HTTP action failed",
          error,
          credential === undefined ? [] : [credential],
        );
      }
    },
  };
}

function canonicalMcpDefinition(definition: NamedHookMcpDefinition) {
  if (
    !IDENTIFIER.test(definition.id) ||
    !IDENTIFIER.test(definition.serverId) ||
    !IDENTIFIER.test(definition.toolName) ||
    !IDENTIFIER.test(definition.federatedToolId)
  )
    throw new TypeError("Named MCP action definition is invalid.");
  return Object.freeze({ ...definition });
}

export function createNamedHookMcpAdapter(
  options: NamedHookMcpAdapterOptions,
): HookMcpAdapter {
  const definitions = new Map<
    string,
    ReturnType<typeof canonicalMcpDefinition>
  >();
  for (const candidate of options.definitions) {
    const definition = canonicalMcpDefinition(candidate);
    if (definitions.has(definition.id))
      throw new TypeError(`Duplicate named MCP action ${definition.id}.`);
    definitions.set(definition.id, definition);
  }
  return {
    async invoke(request) {
      validateDirectRequest(request, [
        "name",
        "input",
        "cwd",
        "signal",
        "deadlineMs",
        "outputCapBytes",
      ]);
      const definition = definitions.get(request.name);
      if (!definition) throw new Error("Named MCP action is not configured.");
      const input = jsonObject(request.input ?? {}, "Named MCP action input");
      try {
        return await cancellable(
          request.signal,
          request.deadlineMs,
          async (signal) => {
            const activated = await options.federation.activate(
              [definition.federatedToolId],
              signal,
            );
            if (!activated.ok)
              throw new Error(
                `[${activated.error.code}] ${activated.error.message}`,
              );
            const tool = activated.value.tools[0];
            if (
              activated.value.tools.length !== 1 ||
              !tool ||
              tool.id !== definition.federatedToolId ||
              tool.serverId !== definition.serverId ||
              tool.name !== definition.toolName
            )
              throw new Error(
                "Configured federated MCP tool identity changed.",
              );
            const invoked = await options.federation.invoke(
              {
                toolId: definition.federatedToolId,
                arguments: input,
              },
              signal,
            );
            if (!invoked.ok)
              throw new Error(
                `[${invoked.error.code}] ${invoked.error.message}`,
              );
            return {
              output: outputJson(
                options.controls,
                {
                  content: invoked.value.content,
                  ...(invoked.value.structuredContent === undefined
                    ? {}
                    : { structuredContent: invoked.value.structuredContent }),
                  isError: invoked.value.isError,
                },
                request.outputCapBytes,
              ),
            } satisfies HookAdapterResult;
          },
        );
      } catch (error) {
        fail(options.controls, "Named MCP action failed", error);
      }
    },
  };
}

function sameProfileIdentity(
  left: ResolvedAgentProfile,
  right: ResolvedAgentProfile,
) {
  return (
    left.identity.name === right.identity.name &&
    left.identity.contentDigest === right.identity.contentDigest &&
    left.identity.catalogGeneration === right.identity.catalogGeneration &&
    left.identity.source.scope === right.identity.source.scope &&
    left.identity.source.path === right.identity.source.path &&
    left.policy.role === right.policy.role
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableProfile(profile: ResolvedAgentProfile) {
  return deepFreeze(structuredClone(profile));
}

export function createNamedHookAgentAdapter(
  options: NamedHookAgentAdapterOptions,
): HookAgentAdapter {
  const maxPromptBytes = positiveBoundedInteger(
    options.maxPromptBytes,
    64 * 1024,
    1024 * 1024,
    "Named agent maxPromptBytes",
  );
  return {
    async run(request) {
      validateDirectRequest(request, [
        "name",
        "prompt",
        "cwd",
        "signal",
        "deadlineMs",
        "outputCapBytes",
      ]);
      if (
        typeof request.prompt !== "string" ||
        request.prompt.includes("\0") ||
        Buffer.byteLength(request.prompt) > maxPromptBytes
      )
        throw new TypeError(
          "Named agent prompt is invalid or exceeds its cap.",
        );
      try {
        const resolution = options.profiles.resolve(request.name);
        if (!resolution.ok)
          throw new Error("Named Agent Profile is not configured.");
        const resolved = resolution.value;
        if (
          resolved.identity.name !== request.name ||
          (resolved.policy.role !== "subagent" &&
            resolved.policy.role !== "review")
        )
          throw new Error("Named Agent Profile role is not allowed for hooks.");
        const profile = immutableProfile(resolved);
        return await cancellable(
          request.signal,
          request.deadlineMs,
          async (signal) => {
            const revalidated = await options.execution.revalidateProfile({
              name: profile.identity.name,
              contentDigest: profile.identity.contentDigest,
              catalogGeneration: profile.identity.catalogGeneration,
              source: profile.identity.source,
              cwd: request.cwd,
              signal,
            });
            if (
              !revalidated.trusted ||
              revalidated.contentDigest !== profile.identity.contentDigest
            )
              throw new Error("Named Agent Profile revalidation failed.");
            const current = options.profiles.resolve(request.name);
            if (!current.ok || !sameProfileIdentity(profile, current.value))
              throw new Error("Named Agent Profile changed before execution.");
            const result = await options.execution.run({
              profile,
              prompt: request.prompt,
              cwd: request.cwd,
              signal,
              deadlineMs: request.deadlineMs,
              outputCapBytes: request.outputCapBytes,
            });
            if (!isRecord(result))
              throw new Error(
                "Named profile execution returned an invalid result.",
              );
            if (Object.keys(result).some((key) => key !== "output"))
              throw new Error(
                "Named profile execution returned invalid fields.",
              );
            if (result.output === undefined) return {};
            if (typeof result.output !== "string")
              throw new Error(
                "Named profile execution returned invalid output.",
              );
            const sanitized = options.controls.sanitize(result.output, {
              maxStringBytes: request.outputCapBytes,
              maxNodes: 8,
              maxDepth: 2,
            }).value;
            return {
              output: boundUtf8(
                typeof sanitized === "string" ? sanitized : "",
                request.outputCapBytes,
              ),
            };
          },
        );
      } catch (error) {
        fail(options.controls, "Named agent action failed", error);
      }
    },
  };
}
