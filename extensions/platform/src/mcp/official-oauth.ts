import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import type {
  McpOAuthProtocol,
  McpOAuthServer,
  McpOAuthTokens,
} from "./oauth.ts";

export interface OfficialMcpOAuthProtocolOptions {
  readonly authorizeUrl: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly fetch?: FetchLike;
  readonly clock?: () => number;
}

function tokenSet(tokens: OAuthTokens, clock: () => number): McpOAuthTokens {
  if (!tokens.access_token)
    throw new Error("OAuth token response has no access token.");
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.expires_in !== undefined
      ? { expiresAt: clock() + tokens.expires_in * 1_000 }
      : {}),
    scopes:
      typeof tokens.scope === "string"
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : [],
  };
}

export function createOfficialMcpOAuthProtocol(
  options: OfficialMcpOAuthProtocolOptions,
): McpOAuthProtocol {
  const clock = options.clock ?? Date.now;
  const underlying = options.fetch ?? fetch;
  const guardedFetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    if (!(await options.authorizeUrl(request.url, init?.signal ?? undefined)))
      throw new Error(
        `OAuth destination is not authorized: ${new URL(request.url).origin}`,
      );
    return underlying(request.url, { ...init, redirect: "error" });
  };
  const metadata = new Map<string, Promise<AuthorizationServerMetadata>>();
  const metadataFor = (server: McpOAuthServer) => {
    let pending = metadata.get(server.authorizationServer);
    if (!pending) {
      pending = discoverAuthorizationServerMetadata(
        server.authorizationServer,
        { fetchFn: guardedFetch, skipIssuerValidation: false },
      ).then((value) => {
        if (!value)
          throw new Error("OAuth authorization metadata is unavailable.");
        return value;
      });
      metadata.set(server.authorizationServer, pending);
    }
    return pending;
  };
  const clientInformation = (server: McpOAuthServer) => ({
    client_id: server.clientId,
  });

  return {
    async authorizationUrl(request) {
      const discovered = await metadataFor(request.server);
      if (!discovered.authorization_endpoint)
        throw new Error("OAuth metadata has no authorization endpoint.");
      if (
        discovered.code_challenge_methods_supported &&
        !discovered.code_challenge_methods_supported.includes("S256")
      )
        throw new Error(
          "OAuth authorization server does not support PKCE S256.",
        );
      const url = new URL(discovered.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", request.server.clientId);
      url.searchParams.set("redirect_uri", request.redirectUri);
      url.searchParams.set("state", request.state);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (request.server.scopes.length > 0)
        url.searchParams.set("scope", request.server.scopes.join(" "));
      url.searchParams.set("resource", request.server.serverUrl);
      if (!(await options.authorizeUrl(url.href)))
        throw new Error("OAuth authorization endpoint is not allowed.");
      return url.href;
    },
    async exchange(request) {
      const discovered = await metadataFor(request.server);
      const tokens = await exchangeAuthorization(
        request.server.authorizationServer,
        {
          metadata: discovered,
          clientInformation: clientInformation(request.server),
          authorizationCode: request.code,
          codeVerifier: request.codeVerifier,
          redirectUri: request.redirectUri,
          resource: new URL(request.server.serverUrl),
          fetchFn: guardedFetch,
        },
      );
      return tokenSet(tokens, clock);
    },
    async refresh(request) {
      if (!request.tokens.refreshToken)
        throw new Error("OAuth credential has no refresh token.");
      const discovered = await metadataFor(request.server);
      const tokens = await refreshAuthorization(
        request.server.authorizationServer,
        {
          metadata: discovered,
          clientInformation: clientInformation(request.server),
          refreshToken: request.tokens.refreshToken,
          resource: new URL(request.server.serverUrl),
          fetchFn: guardedFetch,
        },
      );
      const mapped = tokenSet(tokens, clock);
      return {
        ...mapped,
        refreshToken: mapped.refreshToken ?? request.tokens.refreshToken,
      };
    },
    async revoke(request) {
      const discovered = await metadataFor(request.server);
      const revocationEndpoint = (
        discovered as AuthorizationServerMetadata & {
          revocation_endpoint?: unknown;
        }
      ).revocation_endpoint;
      if (typeof revocationEndpoint !== "string") return;
      const body = new URLSearchParams({
        token: request.tokens.refreshToken ?? request.tokens.accessToken,
        client_id: request.server.clientId,
      });
      const response = await guardedFetch(revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok)
        throw new Error(
          `OAuth revocation failed with HTTP ${response.status}.`,
        );
    },
  };
}
