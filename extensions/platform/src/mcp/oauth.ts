import { createHash, randomBytes } from "node:crypto";
import type {
  CredentialBinding,
  CredentialVault,
} from "../external/credentials.ts";
import type { ModuleError, Outcome } from "../core/result.ts";

export interface McpOAuthServer {
  readonly id: string;
  readonly serverUrl: string;
  readonly authorizationServer: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
}

export interface McpOAuthProtocol {
  authorizationUrl(request: {
    readonly server: McpOAuthServer;
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): Promise<string>;
  exchange(request: {
    readonly server: McpOAuthServer;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<McpOAuthTokens>;
  refresh(request: {
    readonly server: McpOAuthServer;
    readonly tokens: McpOAuthTokens;
  }): Promise<McpOAuthTokens>;
  revoke(request: {
    readonly server: McpOAuthServer;
    readonly tokens: McpOAuthTokens;
  }): Promise<void>;
}

export interface McpCredentialReferences {
  get(serverId: string): Promise<string | undefined>;
  set(serverId: string, reference: string): Promise<unknown>;
  remove(serverId: string): Promise<unknown>;
}

export type McpAuthorizationErrorCode =
  | "invalid_request"
  | "flow_not_found"
  | "state_mismatch"
  | "credential_unavailable"
  | "protocol_error";
export type McpAuthorizationError = ModuleError<McpAuthorizationErrorCode>;
export type McpAuthorizationOutcome<T> = Outcome<T, McpAuthorizationError>;

export interface McpAuthorization {
  start(server: McpOAuthServer): Promise<
    McpAuthorizationOutcome<{
      readonly serverId: string;
      readonly authorizationUrl: string;
      readonly expiresAt: number;
    }>
  >;
  complete(request: {
    readonly server: McpOAuthServer;
    readonly redirectUrl: string;
  }): Promise<
    McpAuthorizationOutcome<{
      readonly serverId: string;
      readonly status: "authorized";
      readonly expiresAt?: number;
      readonly scopes: readonly string[];
    }>
  >;
  refresh(server: McpOAuthServer): Promise<
    McpAuthorizationOutcome<{
      readonly serverId: string;
      readonly status: "authorized";
      readonly expiresAt?: number;
      readonly scopes: readonly string[];
    }>
  >;
  logout(server: McpOAuthServer): Promise<
    McpAuthorizationOutcome<{
      readonly serverId: string;
      readonly status: "logged-out";
    }>
  >;
  token(server: McpOAuthServer): Promise<string | undefined>;
}

export interface McpAuthorizationOptions {
  readonly vault: CredentialVault;
  readonly references: McpCredentialReferences;
  readonly protocol: McpOAuthProtocol;
  readonly clock?: () => number;
  readonly flowTimeoutMs?: number;
}

interface PendingFlow {
  readonly serverId: string;
  readonly serverFingerprint: string;
  readonly state: string;
  readonly verifier: string;
  readonly expiresAt: number;
}

function authorizationError(
  code: McpAuthorizationErrorCode,
  message: string,
  retryable = false,
): McpAuthorizationOutcome<never> {
  return { ok: false, error: { code, message, retryable } };
}

function base64url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

function serverFingerprint(server: McpOAuthServer) {
  return createHash("sha256")
    .update(JSON.stringify(server), "utf8")
    .digest("hex");
}

function validateServer(server: McpOAuthServer) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(server.id))
    throw new Error("OAuth server id is invalid.");
  const serverUrl = new URL(server.serverUrl);
  const authorization = new URL(server.authorizationServer);
  const redirect = new URL(server.redirectUri);
  if (serverUrl.protocol !== "https:" || authorization.protocol !== "https:")
    throw new Error("MCP and authorization servers must use HTTPS.");
  if (
    serverUrl.username ||
    serverUrl.password ||
    authorization.username ||
    authorization.password
  )
    throw new Error("OAuth URLs cannot contain credentials.");
  if (
    redirect.protocol !== "http:" ||
    (redirect.hostname !== "127.0.0.1" &&
      redirect.hostname !== "[::1]" &&
      redirect.hostname !== "localhost") ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  )
    throw new Error("OAuth redirect must be one exact loopback HTTP URL.");
  if (
    !server.clientId ||
    Buffer.byteLength(server.clientId) > 512 ||
    server.scopes.length > 64 ||
    server.scopes.some(
      (scope) =>
        !scope ||
        Buffer.byteLength(scope) > 256 ||
        /[\u0000-\u001f\u007f]/.test(scope),
    )
  )
    throw new Error("OAuth client or scopes are invalid.");
}

function binding(server: McpOAuthServer): CredentialBinding {
  return {
    integration: "mcp",
    resourceId: server.id,
    origin: new URL(server.serverUrl).origin,
  };
}

function validateTokens(tokens: McpOAuthTokens) {
  const encoded = JSON.stringify(tokens);
  if (
    typeof tokens.accessToken !== "string" ||
    !tokens.accessToken ||
    Buffer.byteLength(encoded) > 64 * 1024 ||
    (tokens.refreshToken !== undefined &&
      (typeof tokens.refreshToken !== "string" || !tokens.refreshToken)) ||
    (tokens.expiresAt !== undefined &&
      (!Number.isSafeInteger(tokens.expiresAt) || tokens.expiresAt <= 0)) ||
    !Array.isArray(tokens.scopes) ||
    tokens.scopes.some((scope) => typeof scope !== "string")
  )
    throw new Error("OAuth server returned invalid tokens.");
  return encoded;
}

function publicStatus(server: McpOAuthServer, tokens: McpOAuthTokens) {
  return {
    serverId: server.id,
    status: "authorized" as const,
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    scopes: [...tokens.scopes],
  };
}

export function createMcpAuthorization(
  options: McpAuthorizationOptions,
): McpAuthorization {
  const clock = options.clock ?? Date.now;
  const flowTimeoutMs = options.flowTimeoutMs ?? 10 * 60_000;
  if (
    !Number.isFinite(flowTimeoutMs) ||
    flowTimeoutMs < 1_000 ||
    flowTimeoutMs > 60 * 60_000
  )
    throw new TypeError("OAuth flow timeout is invalid.");
  const pending = new Map<string, PendingFlow>();

  const prune = () => {
    const now = clock();
    for (const [state, flow] of pending)
      if (flow.expiresAt <= now) pending.delete(state);
  };
  const loadTokens = async (server: McpOAuthServer) => {
    const reference = await options.references.get(server.id);
    if (!reference) return undefined;
    const encoded = await options.vault.resolve(reference, binding(server));
    if (!encoded) return undefined;
    try {
      const tokens = JSON.parse(encoded) as McpOAuthTokens;
      validateTokens(tokens);
      return { reference, tokens };
    } catch {
      return undefined;
    }
  };
  const persistTokens = async (
    server: McpOAuthServer,
    tokens: McpOAuthTokens,
  ) => {
    const encoded = validateTokens(tokens);
    const current = await options.references.get(server.id);
    if (current) {
      const replaced = await options.vault.replace(
        current,
        binding(server),
        encoded,
      );
      if (!replaced) throw new Error("Credential replacement failed.");
      return current;
    }
    const stored = await options.vault.store({
      binding: binding(server),
      secret: encoded,
    });
    if (!stored.ok) throw new Error(stored.error.message);
    await options.references.set(server.id, stored.value.reference);
    return stored.value.reference;
  };

  return {
    async start(server) {
      try {
        validateServer(server);
        prune();
        if (pending.size >= 16)
          return authorizationError(
            "invalid_request",
            "Too many OAuth flows are pending.",
          );
        const state = base64url(randomBytes(32));
        const verifier = base64url(randomBytes(32));
        const codeChallenge = base64url(
          createHash("sha256").update(verifier, "ascii").digest(),
        );
        const expiresAt = clock() + flowTimeoutMs;
        const authorizationUrl = await options.protocol.authorizationUrl({
          server,
          state,
          codeChallenge,
          redirectUri: server.redirectUri,
        });
        const authorization = new URL(authorizationUrl);
        if (
          authorization.origin !== new URL(server.authorizationServer).origin ||
          authorization.protocol !== "https:"
        )
          throw new Error(
            "Authorization URL origin does not match configuration.",
          );
        pending.set(state, {
          serverId: server.id,
          serverFingerprint: serverFingerprint(server),
          state,
          verifier,
          expiresAt,
        });
        return {
          ok: true,
          value: { serverId: server.id, authorizationUrl, expiresAt },
        };
      } catch (error) {
        return authorizationError(
          "protocol_error",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async complete({ server, redirectUrl }) {
      try {
        validateServer(server);
        prune();
        const callback = new URL(redirectUrl);
        const expected = new URL(server.redirectUri);
        if (
          callback.origin !== expected.origin ||
          callback.pathname !== expected.pathname ||
          callback.hash
        )
          return authorizationError(
            "invalid_request",
            "OAuth callback URL does not match the configured redirect.",
          );
        const state = callback.searchParams.get("state");
        const code = callback.searchParams.get("code");
        if (!state || !code || Buffer.byteLength(code) > 8 * 1024)
          return authorizationError(
            "invalid_request",
            "OAuth callback is missing bounded code or state values.",
          );
        const flow = pending.get(state);
        if (!flow) {
          const hasServerFlow = [...pending.values()].some(
            (candidate) => candidate.serverId === server.id,
          );
          return authorizationError(
            hasServerFlow ? "state_mismatch" : "flow_not_found",
            hasServerFlow
              ? "OAuth state does not match the pending flow."
              : "OAuth flow is missing, expired, or already consumed.",
          );
        }
        if (
          flow.serverId !== server.id ||
          flow.serverFingerprint !== serverFingerprint(server)
        )
          return authorizationError(
            "state_mismatch",
            "OAuth flow is bound to a different server configuration.",
          );
        pending.delete(state);
        const tokens = await options.protocol.exchange({
          server,
          code,
          codeVerifier: flow.verifier,
          redirectUri: server.redirectUri,
        });
        await persistTokens(server, tokens);
        return { ok: true, value: publicStatus(server, tokens) };
      } catch (error) {
        return authorizationError(
          "protocol_error",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async refresh(server) {
      try {
        validateServer(server);
        const loaded = await loadTokens(server);
        if (!loaded)
          return authorizationError(
            "credential_unavailable",
            "No bound MCP OAuth credential is available.",
          );
        const tokens = await options.protocol.refresh({
          server,
          tokens: loaded.tokens,
        });
        await persistTokens(server, tokens);
        return { ok: true, value: publicStatus(server, tokens) };
      } catch (error) {
        return authorizationError(
          "protocol_error",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async logout(server) {
      try {
        validateServer(server);
        const loaded = await loadTokens(server);
        if (loaded) {
          await options.protocol.revoke({ server, tokens: loaded.tokens });
          const removed = await options.vault.remove(
            loaded.reference,
            binding(server),
          );
          if (!removed) throw new Error("Credential removal failed.");
        }
        await options.references.remove(server.id);
        return {
          ok: true,
          value: { serverId: server.id, status: "logged-out" },
        };
      } catch (error) {
        return authorizationError(
          "protocol_error",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
    async token(server) {
      try {
        validateServer(server);
        return (await loadTokens(server))?.tokens.accessToken;
      } catch {
        return undefined;
      }
    },
  };
}
