import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityPolicy } from "./src/core/policy/index.ts";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  createArtifactPublisher,
  createInMemoryPublicationRepository,
  type ArtifactPublicationAdapter,
  type ArtifactUserAuthorityToken,
} from "./src/artifacts/index.ts";

function fixture() {
  const artifacts = createInMemoryArtifactStore({ clock: () => 1 });
  const calls: string[] = [];
  const adapter: ArtifactPublicationAdapter = {
    id: "local",
    target: "local",
    maxBytes: 1024 * 1024,
    async publish(input) {
      calls.push(`publish:${input.handle}`);
      return {
        ok: true,
        value: {
          providerReference: `provider:${input.handle}`,
          shareUrl: `http://127.0.0.1:1234/open#secret-${input.handle}`,
        },
      };
    },
    async status() {
      calls.push("status");
      return { ok: true, value: { state: "active" } };
    },
    async revoke() {
      calls.push("revoke");
      return { ok: true, value: { state: "revoked" } };
    },
  };
  const consumed = new Set<string>();
  const publications = createInMemoryPublicationRepository();
  let nextHandle = 0;
  let refreshedBody = "";
  const issue = (scope: string): ArtifactUserAuthorityToken => ({
    kind: "artifact-user-authority",
    value: `authority:${scope}`,
    scope,
  });
  const publisher = createArtifactPublisher({
    artifacts,
    adapters: [adapter],
    publications,
    policy: createCapabilityPolicy(),
    actor: "parent",
    mode: () => "normal",
    authority: {
      verify(token, scope) {
        const key = `${token.value}:${scope}`;
        if (
          token.kind !== "artifact-user-authority" ||
          token.scope !== scope ||
          token.value !== `authority:${scope}` ||
          consumed.has(key)
        )
          return false;
        consumed.add(key);
        return true;
      },
    },
    refreshLocal: async (_handle, input) => {
      refreshedBody = Buffer.from(input.body).toString("utf8");
      return true;
    },
    clock: () => 10,
    createHandle: () => `publication-${++nextHandle}`,
  });
  return {
    artifacts,
    publisher,
    calls,
    issue,
    refreshedBody: () => refreshedBody,
    publications,
    adapter,
  };
}

test("publish scans exact bytes and requires one-shot authority bound to immutable intent", async () => {
  const { artifacts, publisher, calls, issue } = fixture();
  const stored = await artifacts.put({
    body: "# Safe report",
    filename: "report.md",
    mediaType: "text/markdown",
    sensitivity: "public",
    metadata: { title: "Safe report", projectId: "git:project" },
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const intent = {
    artifactId: stored.value.id,
    target: "local" as const,
    expiresAt: 1_000,
  };
  const approval = await publisher.publish(intent);
  assert.equal(approval.ok, false);
  if (
    approval.ok ||
    approval.error.code !== "approval_required" ||
    !approval.error.approval
  )
    return;
  const exactApproval = approval.error.approval;
  assert.equal(exactApproval.operation, "publish");
  assert.equal(exactApproval.sensitivity.verdict, "clear");
  assert.deepEqual(calls, []);
  const beforeApproval = await artifacts.list();
  assert.equal(beforeApproval.ok, true);
  if (beforeApproval.ok) assert.equal(beforeApproval.value.artifacts.length, 1);

  const published = await publisher.publish({
    ...intent,
    authority: issue(exactApproval.scope),
  });
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.value.publication.state, "active");
  assert.equal(published.value.publication.sourceArtifactId, stored.value.id);
  assert.match(published.value.shareUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.equal("body" in published.value.publication, false);
  assert.equal("shareUrl" in published.value.publication, false);
  assert.equal(calls.length, 1);

  const replay = await publisher.publish({
    ...intent,
    authority: issue(exactApproval.scope),
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.error.code, "approval_required");
  assert.equal(calls.length, 1);
});

test("same materialized body can be published repeatedly with different expiry", async () => {
  const { artifacts, publisher, issue } = fixture();
  const stored = await artifacts.put({
    body: "# Repeatable",
    mediaType: "text/markdown",
    sensitivity: "public",
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  for (const expiresAt of [1_000, 2_000]) {
    const intent = {
      artifactId: stored.value.id,
      target: "local" as const,
      expiresAt,
    };
    const approval = await publisher.publish(intent);
    assert.equal(approval.ok, false);
    if (approval.ok || !approval.error.approval) return;
    const result = await publisher.publish({
      ...intent,
      authority: issue(approval.error.approval.scope),
    });
    assert.equal(result.ok, true);
  }
});

test("live refresh is scanned, exactly confirmed, and revisioned through publisher state", async () => {
  const { artifacts, publisher, issue, refreshedBody, publications, adapter } =
    fixture();
  const source = await artifacts.put({
    body: "<!doctype html><h1>First</h1>",
    mediaType: "text/html",
    sensitivity: "public",
    metadata: { live: true },
  });
  assert.equal(source.ok, true);
  if (!source.ok) return;
  const intent = {
    artifactId: source.value.id,
    target: "local" as const,
    expiresAt: 1_000,
  };
  const openApproval = await publisher.publish(intent);
  assert.equal(openApproval.ok, false);
  if (openApproval.ok || !openApproval.error.approval) return;
  const opened = await publisher.publish({
    ...intent,
    authority: issue(openApproval.error.approval.scope),
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.value.publication.live, true);

  const next = await artifacts.put({
    body: "<!doctype html><h1>Second</h1>",
    mediaType: "text/html",
    sensitivity: "public",
  });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  const refreshIntent = {
    handle: opened.value.publication.handle,
    artifactId: next.value.id,
  };
  const foreign = createArtifactPublisher({
    artifacts,
    adapters: [adapter],
    publications,
    policy: createCapabilityPolicy(),
    actor: "parent",
    mode: () => "normal",
    authority: { verify: () => false },
    ownerId: "different-owner",
    refreshLocal: async () => true,
    clock: () => 10,
  });
  const foreignRefresh = await foreign.refresh(refreshIntent);
  assert.equal(foreignRefresh.ok, false);
  if (!foreignRefresh.ok)
    assert.equal(foreignRefresh.error.code, "invalid_request");

  const refreshApproval = await publisher.refresh(refreshIntent);
  assert.equal(refreshApproval.ok, false);
  if (refreshApproval.ok || !refreshApproval.error.approval) return;
  const refreshed = await publisher.refresh({
    ...refreshIntent,
    authority: issue(refreshApproval.error.approval.scope),
  });
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(refreshed.value.sourceArtifactId, next.value.id);
  assert.match(refreshedBody(), /Second/);
  assert.equal((await publisher.status(refreshed.value.handle)).ok, true);
});

test("blocking sensitivity findings cannot be overridden by authority", async () => {
  const { artifacts, publisher, calls } = fixture();
  const stored = await artifacts.put({
    body: "-----BEGIN PRIVATE KEY-----\nseeded-canary",
    filename: "leak.txt",
    mediaType: "text/plain",
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;

  const result = await publisher.publish({
    artifactId: stored.value.id,
    target: "local",
    expiresAt: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "sensitivity_blocked");
    assert.equal(result.error.sensitivity?.verdict, "blocked");
    assert.equal(JSON.stringify(result.error).includes("seeded-canary"), false);
  }
  assert.deepEqual(calls, []);
});

test("known provider credentials block publication without disclosing matched values", async () => {
  const { artifacts, publisher: _unused, calls } = fixture();
  const stored = await artifacts.put({
    body: "provider-credential-canary",
    mediaType: "text/plain",
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const publisher = createArtifactPublisher({
    artifacts,
    adapters: [
      {
        id: "local",
        target: "local",
        maxBytes: 1024 * 1024,
        async publish() {
          calls.push("dispatch");
          throw new Error("must not dispatch");
        },
        async status() {
          throw new Error("unused");
        },
        async revoke() {
          throw new Error("unused");
        },
      },
    ],
    publications: createInMemoryPublicationRepository(),
    policy: createCapabilityPolicy(),
    actor: "parent",
    mode: () => "normal",
    authority: { verify: () => false },
    sensitivityCanaries: async () => ["provider-credential-canary"],
    clock: () => 10,
  });
  const result = await publisher.publish({
    artifactId: stored.value.id,
    target: "local",
    expiresAt: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "sensitivity_blocked");
    assert.equal(
      JSON.stringify(result.error).includes("provider-credential-canary"),
      false,
    );
  }
  assert.deepEqual(calls, []);
});

test("remote publication blocks seeded local filesystem paths", async () => {
  const artifacts = createInMemoryArtifactStore();
  const stored = await artifacts.put({
    body: "Evidence: C:/Users/Tyler/private/file.ts",
    mediaType: "text/plain",
    sensitivity: "public",
  });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  let dispatched = false;
  const publisher = createArtifactPublisher({
    artifacts,
    adapters: [
      {
        id: "remote",
        target: "remote",
        maxBytes: 1024 * 1024,
        async publish() {
          dispatched = true;
          throw new Error("must not dispatch");
        },
        async status() {
          throw new Error("unused");
        },
        async revoke() {
          throw new Error("unused");
        },
      },
    ],
    publications: createInMemoryPublicationRepository(),
    policy: createCapabilityPolicy(),
    actor: "parent",
    mode: () => "normal",
    authority: { verify: () => false },
  });
  const result = await publisher.publish({
    artifactId: stored.value.id,
    target: "remote",
    access: "link",
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "sensitivity_blocked");
  assert.equal(dispatched, false);
});

test("plan mode denies publication before adapter dispatch", async () => {
  const { artifacts } = fixture();
  const stored = await artifacts.put({ body: "safe", mediaType: "text/plain" });
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  let dispatched = false;
  const publisher = createArtifactPublisher({
    artifacts,
    adapters: [
      {
        id: "local",
        target: "local",
        maxBytes: 1024,
        async publish() {
          dispatched = true;
          throw new Error("must not dispatch");
        },
        async status() {
          throw new Error("must not dispatch");
        },
        async revoke() {
          throw new Error("must not dispatch");
        },
      },
    ],
    publications: createInMemoryPublicationRepository(),
    policy: createCapabilityPolicy(),
    actor: "parent",
    mode: () => "plan",
    authority: { verify: () => false },
  });
  const result = await publisher.publish({
    artifactId: stored.value.id,
    target: "local",
    expiresAt: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "policy_denied");
  assert.equal(dispatched, false);
});
