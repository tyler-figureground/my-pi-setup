import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryCredentialVault } from "./src/external/credentials.ts";
import { createMcpAuthorization } from "./src/mcp/oauth.ts";

test("MCP OAuth rejects mismatched and replayed state while keeping tokens out of results", async () => {
  const exchanged: unknown[] = [];
  const refreshed: unknown[] = [];
  const revoked: unknown[] = [];
  const references = new Map<string, string>();
  const authorization = createMcpAuthorization({
    vault: createInMemoryCredentialVault({
      createReference: () => "credential:mcp-fixture",
    }),
    references: {
      get: async (serverId) => references.get(serverId),
      set: async (serverId, reference) => references.set(serverId, reference),
      remove: async (serverId) => references.delete(serverId),
    },
    protocol: {
      async authorizationUrl(request) {
        const url = new URL("https://auth.example.test/authorize");
        url.searchParams.set("state", request.state);
        url.searchParams.set("code_challenge", request.codeChallenge);
        url.searchParams.set("redirect_uri", request.redirectUri);
        return url.href;
      },
      async exchange(request) {
        exchanged.push(request);
        return {
          accessToken: "secret-access",
          refreshToken: "secret-refresh",
          expiresAt: Date.now() + 60_000,
          scopes: ["tools.read"],
        };
      },
      async refresh(request) {
        refreshed.push(request);
        return {
          accessToken: "secret-rotated-access",
          refreshToken: "secret-rotated-refresh",
          expiresAt: Date.now() + 120_000,
          scopes: ["tools.read"],
        };
      },
      async revoke(request) {
        revoked.push(request);
      },
    },
  });
  const server = {
    id: "fixture",
    serverUrl: "https://mcp.example.test/mcp",
    authorizationServer: "https://auth.example.test",
    redirectUri: "http://127.0.0.1:3118/callback",
    clientId: "pi-phase5",
    scopes: ["tools.read"],
  };

  const started = await authorization.start(server);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const authUrl = new URL(started.value.authorizationUrl);
  const state = authUrl.searchParams.get("state");
  assert.equal(typeof state, "string");
  assert.equal(started.value.authorizationUrl.includes("verifier"), false);

  const mismatch = await authorization.complete({
    server,
    redirectUrl: `${server.redirectUri}?code=oauth-code&state=wrong`,
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "state_mismatch");
  assert.equal(exchanged.length, 0);

  const completed = await authorization.complete({
    server,
    redirectUrl: `${server.redirectUri}?code=oauth-code&state=${state}`,
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(JSON.stringify(completed).includes("secret-"), false);
  assert.equal(exchanged.length, 1);

  const replay = await authorization.complete({
    server,
    redirectUrl: `${server.redirectUri}?code=oauth-code&state=${state}`,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.error.code, "flow_not_found");

  const refresh = await authorization.refresh(server);
  assert.equal(refresh.ok, true, JSON.stringify(refresh));
  assert.equal(JSON.stringify(refresh).includes("secret-"), false);
  assert.equal(refreshed.length, 1);

  const logout = await authorization.logout(server);
  assert.equal(logout.ok, true, JSON.stringify(logout));
  assert.equal(revoked.length, 1);
  assert.equal(references.has(server.id), false);
});
