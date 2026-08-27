import assert from "node:assert/strict";
import test from "node:test";
import { createOfficialMcpOAuthProtocol } from "./src/mcp/official-oauth.ts";

const server = {
  id: "fixture",
  serverUrl: "https://mcp.example.test/mcp",
  authorizationServer: "https://auth.example.test",
  redirectUri: "http://127.0.0.1:3118/callback",
  clientId: "pi-phase5",
  scopes: ["tools.read"],
};

test("official MCP OAuth protocol uses discovered endpoints for exchange, refresh, and revoke", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const protocol = createOfficialMcpOAuthProtocol({
    authorizeUrl: async (url) => ({
      allowed: new URL(url).origin === "https://auth.example.test",
      canonicalUrl: url,
      resolvedAddresses: ["93.184.216.34"],
    }),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.text();
      requests.push({ url: request.url, method: request.method, body });
      if (request.method === "GET")
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          revocation_endpoint: "https://auth.example.test/revoke",
          jwks_uri: "https://auth.example.test/jwks",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      const params = new URLSearchParams(body);
      if (request.url.endsWith("/revoke"))
        return new Response(null, { status: 200 });
      if (params.get("grant_type") === "refresh_token")
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 120,
          scope: "tools.read",
          token_type: "Bearer",
        });
      return Response.json({
        access_token: "initial-access",
        refresh_token: "initial-refresh",
        expires_in: 60,
        scope: "tools.read",
        token_type: "Bearer",
      });
    },
  });

  const authorizationUrl = await protocol.authorizationUrl({
    server,
    state: "state-value",
    codeChallenge: "challenge-value",
    redirectUri: server.redirectUri,
  });
  const parsed = new URL(authorizationUrl);
  assert.equal(parsed.searchParams.get("state"), "state-value");
  assert.equal(parsed.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");

  const exchanged = await protocol.exchange({
    server,
    code: "authorization-code",
    codeVerifier: "verifier-value",
    redirectUri: server.redirectUri,
  });
  assert.equal(exchanged.accessToken, "initial-access");
  assert.equal(exchanged.refreshToken, "initial-refresh");

  const refreshed = await protocol.refresh({ server, tokens: exchanged });
  assert.equal(refreshed.accessToken, "rotated-access");
  assert.equal(refreshed.refreshToken, "rotated-refresh");
  await protocol.revoke({ server, tokens: refreshed });

  assert.equal(
    requests.some(({ url }) => url.endsWith("/token")),
    true,
  );
  assert.equal(
    requests.some(({ url }) => url.endsWith("/revoke")),
    true,
  );
  assert.equal(JSON.stringify(requests).includes("challenge-value"), false);
});
