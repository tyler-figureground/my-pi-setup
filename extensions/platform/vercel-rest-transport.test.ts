import assert from "node:assert/strict";
import test from "node:test";
import { createVercelRestTransport } from "./src/artifacts/vercel-rest.ts";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Vercel REST transport uses fixed API origin, bearer credential, preview deployment, TTL, and revoke APIs", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const responses = [
    json({
      id: "prj_123",
      ssoProtection: { deploymentType: "all" },
    }),
    json({
      id: "dpl_123",
      url: "artifact-preview.vercel.app",
      target: null,
      readyState: "READY",
      projectId: "prj_123",
      meta: { piArtifactIntent: "publication-1" },
    }),
    json("share-secret"),
    json({ id: "dpl_123", readyState: "READY" }),
    json("revoked"),
    json({ uid: "dpl_123", state: "DELETED" }),
  ];
  const transport = createVercelRestTransport({
    project: "pi-artifacts",
    teamId: "team_123",
    token: async () => "provider-token-canary",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return responses.shift()!;
    },
    wait: async () => {},
  });

  assert.equal((await transport.projectProtection()).ok, true);
  const deployed = await transport.deploy({
    name: "pi-artifacts",
    project: "pi-artifacts",
    intentId: "publication-1",
    files: [{ file: "index.html", data: "aGk=", encoding: "base64" }],
  });
  assert.equal(deployed.ok, true);
  const shared = await transport.createShareLink("dpl_123", 60);
  assert.equal(shared.ok, true);
  if (shared.ok) {
    assert.equal(
      shared.value.url,
      "https://artifact-preview.vercel.app/?_vercel_share=share-secret",
    );
  }
  assert.equal((await transport.status("dpl_123")).ok, true);
  assert.equal(
    (await transport.revokeShareLink("dpl_123", "share-secret")).ok,
    true,
  );
  assert.equal((await transport.deleteDeployment("dpl_123")).ok, true);

  assert.ok(
    requests.every(({ url }) => url.startsWith("https://api.vercel.com/")),
  );
  assert.ok(requests.every(({ url }) => url.includes("teamId=team_123")));
  assert.ok(
    requests.every(
      ({ init }) =>
        (init.headers as Record<string, string>).Authorization ===
        "Bearer provider-token-canary",
    ),
  );
  const deploymentBody = JSON.parse(String(requests[1]?.init.body));
  assert.equal("target" in deploymentBody, false);
  assert.equal(JSON.stringify(requests).includes("C:/Users"), false);
});

test("Vercel transport deletes a returned non-preview or mismatched deployment", async () => {
  const methods: string[] = [];
  const responses = [
    json({
      id: "prj_123",
      ssoProtection: { deploymentType: "all" },
    }),
    json({
      id: "dpl_wrong",
      url: "wrong.vercel.app",
      target: "production",
      readyState: "READY",
      projectId: "prj_other",
      meta: { piArtifactIntent: "wrong-intent" },
    }),
    json({ uid: "dpl_wrong", state: "DELETED" }),
  ];
  const transport = createVercelRestTransport({
    project: "pi-artifacts",
    token: async () => "provider-token-canary",
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return responses.shift()!;
    },
  });
  assert.equal((await transport.projectProtection()).ok, true);
  const result = await transport.deploy({
    name: "pi-artifacts",
    project: "pi-artifacts",
    intentId: "publication-safe",
    files: [{ file: "index.html", data: "aGk=", encoding: "base64" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "provider_rejected");
  assert.deepEqual(methods, ["GET", "POST", "DELETE"]);
});

test("fresh Vercel transport re-verifies project before intent recovery", async () => {
  const responses = [
    json({
      id: "prj_123",
      ssoProtection: { deploymentType: "all" },
    }),
    json({
      deployments: [
        {
          uid: "dpl_recovered",
          projectId: "prj_123",
          target: null,
          meta: { piArtifactIntent: "publication-restart" },
        },
      ],
    }),
  ];
  const transport = createVercelRestTransport({
    project: "pi-artifacts",
    token: async () => "provider-token-canary",
    fetch: async () => responses.shift()!,
  });
  const found = await transport.findDeployment("publication-restart");
  assert.deepEqual(found, {
    ok: true,
    value: { deploymentId: "dpl_recovered" },
  });
});

test("malformed post-dispatch Vercel response remains ambiguous and intent-recoverable", async () => {
  const responses = [
    json({
      id: "prj_123",
      ssoProtection: { deploymentType: "all" },
    }),
    new Response("not-json", { status: 200 }),
  ];
  const transport = createVercelRestTransport({
    project: "pi-artifacts",
    token: async () => "provider-token-canary",
    fetch: async () => responses.shift()!,
  });
  assert.equal((await transport.projectProtection()).ok, true);
  const result = await transport.deploy({
    name: "pi-artifacts",
    project: "pi-artifacts",
    intentId: "publication-malformed",
    files: [{ file: "index.html", data: "aGk=", encoding: "base64" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "ambiguous_outcome");
});

test("Vercel REST transport distinguishes pre-dispatch reads from ambiguous mutations", async () => {
  const transport = createVercelRestTransport({
    project: "pi-artifacts",
    token: async () => "provider-token-canary",
    fetch: async () => {
      throw new Error("network reset");
    },
  });
  const read = await transport.projectProtection();
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error.code, "provider_unavailable");
  const mutation = await transport.deploy({
    name: "pi-artifacts",
    project: "pi-artifacts",
    intentId: "publication-2",
    files: [{ file: "index.html", data: "aGk=", encoding: "base64" }],
  });
  assert.equal(mutation.ok, false);
  if (!mutation.ok) assert.equal(mutation.error.code, "ambiguous_outcome");
});

test("Vercel REST transport bounds responses and never includes provider errors or tokens", async () => {
  const transport = createVercelRestTransport({
    project: "pi-artifacts",
    token: async () => "provider-token-canary",
    fetch: async () =>
      new Response("sensitive provider-token-canary ".repeat(100_000), {
        status: 500,
      }),
  });
  const result = await transport.projectProtection();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.message.includes("provider-token-canary"), false);
    assert.ok(Buffer.byteLength(result.error.message) < 1_000);
  }
});
