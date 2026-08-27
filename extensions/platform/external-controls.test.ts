import assert from "node:assert/strict";
import test from "node:test";
import { createExternalIntegrationControls } from "./src/external/index.ts";

const request = {
  integration: "browser" as const,
  operation: "navigate",
  effect: "network-read" as const,
  actor: "parent" as const,
  mode: "normal" as const,
};

test("external controls allow only canonical configured origins and block private network targets", async () => {
  const controls = createExternalIntegrationControls({
    resolveHost: async (hostname) =>
      hostname === "internal.example.test"
        ? ["10.20.30.40"]
        : ["93.184.216.34"],
  });

  const allowed = await controls.assess({
    ...request,
    destination: {
      url: "https://EXAMPLE.test:443/path#fragment",
      allowedOrigins: ["https://example.test"],
      allowLoopback: false,
    },
  });
  assert.equal(allowed.kind, "allow");
  assert.equal(allowed.canonicalUrl, "https://example.test/path");

  const metadata = await controls.assess({
    ...request,
    destination: {
      url: "http://169.254.169.254/latest/meta-data",
      allowedOrigins: ["http://169.254.169.254"],
      allowLoopback: false,
    },
  });
  assert.equal(metadata.kind, "deny");
  assert.equal(metadata.reasonCode, "private-network-target");

  const privateDns = await controls.assess({
    ...request,
    destination: {
      url: "https://internal.example.test/resource",
      allowedOrigins: ["https://internal.example.test"],
      allowLoopback: false,
    },
  });
  assert.equal(privateDns.kind, "deny");
  assert.equal(privateDns.reasonCode, "private-network-target");

  const local = await controls.assess({
    ...request,
    destination: {
      url: "http://127.0.0.1:5173/fixture",
      allowedOrigins: ["http://127.0.0.1:5173"],
      allowLoopback: true,
    },
  });
  assert.equal(local.kind, "allow");
});

test("external controls redact secrets and OAuth codes from nested external data", () => {
  const controls = createExternalIntegrationControls();
  const sanitized = controls.sanitize({
    headers: {
      Authorization: "Bearer secret-access-token",
      Cookie: "session=secret-cookie",
      "Content-Type": "application/json",
    },
    redirectUrl: "http://127.0.0.1/callback?code=oauth-code&state=public-state",
    form: { username: "person@example.test", password: "secret-password" },
    nested: [{ refresh_token: "secret-refresh", value: "visible" }],
  });

  assert.deepEqual(sanitized.value, {
    headers: {
      Authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      "Content-Type": "application/json",
    },
    redirectUrl:
      "http://127.0.0.1/callback?code=%5BREDACTED%5D&state=public-state",
    form: { username: "person@example.test", password: "[REDACTED]" },
    nested: [{ refresh_token: "[REDACTED]", value: "visible" }],
  });
  assert.equal(sanitized.redactions, 5);
  assert.equal(JSON.stringify(sanitized).includes("secret-"), false);
  const prose = controls.sanitize(
    "request failed Authorization: Bearer secret-bearer Cookie: session=secret-cookie",
  );
  assert.equal(JSON.stringify(prose).includes("secret-bearer"), false);
  assert.equal(JSON.stringify(prose).includes("secret-cookie"), false);
  const embedded = controls.sanitize(
    'HTTP 500: {"accessToken":"secret-canary","api_key":"api-canary","sessionToken":"session-canary","bearerToken":"bearer-canary","oauth_code":"oauth-canary"}',
  );
  assert.equal(JSON.stringify(embedded).includes("secret-canary"), false);
  assert.equal(JSON.stringify(embedded).includes("api-canary"), false);
  assert.equal(JSON.stringify(embedded).includes("session-canary"), false);
  assert.equal(JSON.stringify(embedded).includes("bearer-canary"), false);
  assert.equal(JSON.stringify(embedded).includes("oauth-canary"), false);
  const literalFields = controls.sanitize({
    session: "session-canary",
    bearer: "bearer-canary",
    oauth: "oauth-canary",
    passwd: "passwd-canary",
  });
  assert.deepEqual(literalFields.value, {
    session: "[REDACTED]",
    bearer: "[REDACTED]",
    oauth: "[REDACTED]",
    passwd: "[REDACTED]",
  });
});

test("external controls deny side effects in plan mode and require direct user authority otherwise", async () => {
  const controls = createExternalIntegrationControls({
    authority: {
      verify: (token) =>
        token.kind === "external-user-authority" &&
        token.value === "host-secret",
    },
  });
  const protectedRequest = {
    integration: "browser" as const,
    operation: "submit-form",
    effect: "remote-write" as const,
    actor: "parent" as const,
    mode: "normal" as const,
  };

  assert.equal(
    (await controls.assess(protectedRequest)).kind,
    "require-user-confirmation",
  );
  assert.equal(
    (
      await controls.assess(protectedRequest, {
        kind: "external-user-authority",
        value: "forged",
      })
    ).kind,
    "require-user-confirmation",
  );
  assert.equal(
    (
      await controls.assess(protectedRequest, {
        kind: "external-user-authority",
        value: "host-secret",
      })
    ).kind,
    "allow",
  );
  assert.equal(
    (
      await controls.assess(
        { ...protectedRequest, mode: "plan" },
        { kind: "external-user-authority", value: "host-secret" },
      )
    ).kind,
    "deny",
  );
});

test("external controls fail closed for network operations while offline", async () => {
  const controls = createExternalIntegrationControls({ offline: () => true });
  const decision = await controls.assess({
    ...request,
    destination: {
      url: "https://example.test/data",
      allowedOrigins: ["https://example.test"],
      allowLoopback: false,
    },
  });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.reasonCode, "offline");
});
