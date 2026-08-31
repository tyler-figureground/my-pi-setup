import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryPublicationSecretStore,
  createVercelArtifactPublicationAdapter,
  type VercelArtifactTransport,
} from "./src/artifacts/vercel.ts";

function fixture(protection: "all" | "none" = "all") {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const transport: VercelArtifactTransport = {
    async projectProtection() {
      calls.push({ operation: "protection" });
      return { ok: true, value: { preview: protection } };
    },
    async deploy(input) {
      calls.push({ operation: "deploy", value: input });
      return {
        ok: true,
        value: {
          id: "dpl_123",
          url: "artifact-preview.vercel.app",
          target: null,
          readyState: "READY",
        },
      };
    },
    async findDeployment(intentId) {
      calls.push({ operation: "find", value: intentId });
      return { ok: true, value: { deploymentId: "dpl_123" } };
    },
    async createShareLink(deploymentId, ttlSeconds) {
      calls.push({ operation: "share", value: { deploymentId, ttlSeconds } });
      return {
        ok: true,
        value: {
          url: "https://artifact-preview.vercel.app/?_vercel_share=one-time-secret",
          secret: "one-time-secret",
        },
      };
    },
    async status(deploymentId) {
      calls.push({ operation: "status", value: deploymentId });
      return { ok: true, value: { state: "active" } };
    },
    async revokeShareLink(deploymentId, secret) {
      calls.push({ operation: "revoke-link", value: { deploymentId, secret } });
      return { ok: true, value: undefined };
    },
    async deleteDeployment(deploymentId) {
      calls.push({ operation: "delete", value: deploymentId });
      return { ok: true, value: undefined };
    },
  };
  const adapter = createVercelArtifactPublicationAdapter({
    project: "pi-artifacts",
    transport,
    secrets: createInMemoryPublicationSecretStore(),
    clock: () => 1_000,
  });
  return { adapter, calls };
}

test("Vercel adapter verifies private preview protection and uploads generated files only", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.publish({
    handle: "publication-1",
    body: Buffer.from("<!doctype html><h1>Artifact</h1>"),
    mediaType: "text/html",
    kind: "html",
    interactive: false,
    live: false,
    access: "link",
    expiresAt: 61_000,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.providerReference, "dpl_123");
  assert.equal(
    result.value.shareUrl,
    "https://artifact-preview.vercel.app/?_vercel_share=one-time-secret",
  );
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["protection", "deploy", "share"],
  );
  const deployment = calls[1]?.value as {
    target?: string;
    files: Array<{ file: string; data: string; encoding: "base64" }>;
  };
  assert.equal(deployment.target, undefined);
  assert.deepEqual(deployment.files.map(({ file }) => file).sort(), [
    "index.html",
    "vercel.json",
  ]);
  const serializedFiles = JSON.stringify(deployment.files);
  assert.equal(serializedFiles.includes("C:/Users"), false);
  assert.equal(serializedFiles.includes("publication-1"), false);
});

test("Vercel link publication binds provider TTL and revokes link before deployment", async () => {
  const { adapter, calls } = fixture();
  const published = await adapter.publish({
    handle: "publication-2",
    body: Buffer.from("<!doctype html><h1>Artifact</h1>"),
    mediaType: "text/html",
    kind: "html",
    interactive: false,
    live: false,
    access: "link",
    expiresAt: 61_000,
  });
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.value.shareUrl.includes("one-time-secret"), true);
  const share = calls.find(({ operation }) => operation === "share")?.value;
  assert.deepEqual(share, { deploymentId: "dpl_123", ttlSeconds: 60 });

  const revoked = await adapter.revoke(published.value.providerReference);
  assert.equal(revoked.ok, true);
  assert.deepEqual(
    calls.slice(-2).map(({ operation }) => operation),
    ["revoke-link", "delete"],
  );
  assert.deepEqual(calls.at(-2)?.value, {
    deploymentId: "dpl_123",
    secret: "one-time-secret",
  });
});

test("Vercel ambiguous deployment intent remains discoverable and revocable", async () => {
  const calls: string[] = [];
  const adapter = createVercelArtifactPublicationAdapter({
    project: "pi-artifacts",
    secrets: createInMemoryPublicationSecretStore(),
    transport: {
      async projectProtection() {
        return { ok: true, value: { preview: "all" } };
      },
      async deploy() {
        return {
          ok: false,
          error: {
            code: "ambiguous_outcome",
            message: "response lost",
            retryable: false,
          },
        };
      },
      async findDeployment(intentId) {
        calls.push(`find:${intentId}`);
        return { ok: true, value: { deploymentId: "dpl_recovered" } };
      },
      async createShareLink() {
        throw new Error("unused");
      },
      async status(id) {
        calls.push(`status:${id}`);
        return { ok: true, value: { state: "active" } };
      },
      async revokeShareLink() {
        throw new Error("unused");
      },
      async deleteDeployment(id) {
        calls.push(`delete:${id}`);
        return { ok: true, value: undefined };
      },
    },
  });
  const published = await adapter.publish({
    handle: "publication-ambiguous",
    body: Buffer.from("<!doctype html><h1>Artifact</h1>"),
    mediaType: "text/html",
    kind: "html",
    interactive: false,
    live: false,
    access: "link",
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(published.ok, false);
  if (published.ok) return;
  assert.equal(
    published.error.details?.providerReference,
    "intent:publication-ambiguous",
  );
  assert.equal((await adapter.status("intent:publication-ambiguous")).ok, true);
  assert.equal((await adapter.revoke("intent:publication-ambiguous")).ok, true);
  assert.deepEqual(calls, [
    "find:publication-ambiguous",
    "status:dpl_recovered",
    "find:publication-ambiguous",
    "delete:dpl_recovered",
  ]);
});

test("Vercel adapter refuses interactive HTML instead of exposing top-level navigation", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.publish({
    handle: "publication-interactive",
    body: Buffer.from("<script>location='https://attacker.example'</script>"),
    mediaType: "text/html",
    kind: "html",
    interactive: true,
    live: false,
    access: "link",
    expiresAt: 61_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "provider_rejected");
  assert.deepEqual(calls, []);
});

test("Vercel adapter fails closed before upload when preview protection is absent", async () => {
  const { adapter, calls } = fixture("none");
  const result = await adapter.publish({
    handle: "publication-3",
    body: Buffer.from("<!doctype html><h1>Artifact</h1>"),
    mediaType: "text/html",
    kind: "html",
    interactive: false,
    live: false,
    access: "link",
    expiresAt: 61_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "provider_rejected");
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["protection"],
  );
});
