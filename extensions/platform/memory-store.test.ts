import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  coreMemoryKinds,
  createMemoryStoreModule,
} from "./src/memory/index.ts";
import { createInMemoryMemoryPersistenceAdapter } from "./src/memory/memory-persistence.ts";

const project = {
  kind: "non-git" as const,
  projectId: "non-git:project-one",
  requestedCwd: "C:/project-one",
  canonicalCwd: "C:/project-one",
  cwdWasAliased: false,
};

function createFixture(
  options: { ingress?: "direct-user" | "model-proposal" } = {},
) {
  let nextId = 0;
  const module = createMemoryStoreModule({
    persistence: createInMemoryMemoryPersistenceAdapter(),
    artifacts: createInMemoryArtifactStore({ clock: () => 1_000 }),
    clock: () => 1_000,
    id: () => `memory-${++nextId}`,
  });
  return module.bind({
    executionRole: "parent",
    project,
    ingress: options.ingress ?? "direct-user",
    sessionId: "session-1",
    sourceEntryId: "entry-1",
  });
}

test("remember resolves project scope and host provenance before inspection", async () => {
  const memory = createFixture();
  const remembered = await memory.remember({
    requestId: "request-1",
    kind: coreMemoryKinds.decision,
    scope: "project",
    content: "Use SQLite FTS5 for persistent memory search.",
  });

  assert.equal(remembered.ok, true);
  if (!remembered.ok) return;
  assert.equal(remembered.value.state, "created");
  assert.deepEqual(remembered.value.memory.scope, {
    kind: "project",
    projectId: project.projectId,
  });
  assert.deepEqual(remembered.value.memory.provenance, {
    ingress: "direct-user",
    sessionId: "session-1",
    executionRole: "parent",
  });
  assert.equal(remembered.value.memory.confidence, 1);
  assert.equal(remembered.value.memory.trust, "untrusted");
  assert.equal(remembered.value.memory.authority, "none");
  assert.deepEqual(remembered.value.memory.citations[0], {
    id: "memory-2",
    kind: "session-entry",
    locator: { sessionId: "session-1", entryId: "entry-1" },
    recordedAt: 1_000,
    trust: "untrusted",
  });

  const inspected = await memory.inspect({ id: remembered.value.memory.id });
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;
  assert.deepEqual(inspected.value.memories, [remembered.value.memory]);
});

test("remember request IDs replay once and reject changed intent", async () => {
  const memory = createFixture();
  const request = {
    requestId: "request-idempotent",
    kind: coreMemoryKinds.projectFact,
    scope: "project" as const,
    content: "The platform uses one stable project identity.",
  };

  const first = await memory.remember(request);
  const replay = await memory.remember(request);
  const conflict = await memory.remember({
    ...request,
    content: "Changed content must not reuse the receipt.",
  });

  assert.equal(first.ok && first.value.replayed, false);
  assert.equal(replay.ok && replay.value.replayed, true);
  assert.equal(
    first.ok && replay.ok && first.value.memory.id,
    replay.ok && replay.value.memory.id,
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "invalid_request");
});

test("remember redacts likely secrets before persistence and returns ranges only", async () => {
  const memory = createFixture();
  const secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  const remembered = await memory.remember({
    requestId: "request-redaction",
    kind: coreMemoryKinds.ephemeralNote,
    scope: "user",
    content: `Temporary token ${secret} must not persist.`,
    expiresAt: 2_000,
  });

  assert.equal(remembered.ok, true);
  if (!remembered.ok) return;
  assert.equal(remembered.value.memory.content.includes(secret), false);
  assert.equal(remembered.value.memory.content.includes("[REDACTED]"), true);
  assert.deepEqual(remembered.value.redactions, [
    {
      kind: "github-token",
      start: 16,
      end: 56,
    },
  ]);

  const inspected = await memory.inspect({ id: remembered.value.memory.id });
  assert.equal(inspected.ok, true);
  if (inspected.ok)
    assert.equal(JSON.stringify(inspected.value).includes(secret), false);
});

test("remember deduplicates exact and conservatively near-identical content", async () => {
  const memory = createFixture();
  const first = await memory.remember({
    requestId: "request-dedupe-1",
    kind: coreMemoryKinds.procedure,
    scope: "project",
    content:
      "Run focused tests before running the complete verification suite.",
  });
  const exact = await memory.remember({
    requestId: "request-dedupe-2",
    kind: coreMemoryKinds.procedure,
    scope: "project",
    content:
      "  run focused tests before running the complete verification suite.  ",
  });
  const near = await memory.remember({
    requestId: "request-dedupe-3",
    kind: coreMemoryKinds.procedure,
    scope: "project",
    content: "Run focused tests before running the complete verifiction suite.",
  });

  assert.equal(first.ok && first.value.state, "created");
  assert.equal(exact.ok && exact.value.state, "duplicate");
  assert.equal(near.ok && near.value.state, "duplicate");
  if (
    first.ok &&
    exact.ok &&
    exact.value.state === "duplicate" &&
    near.ok &&
    near.value.state === "duplicate"
  ) {
    assert.equal(exact.value.duplicateOf, first.value.memory.id);
    assert.equal(near.value.duplicateOf, first.value.memory.id);
    assert.equal(exact.value.memory.id, first.value.memory.id);
    assert.equal(near.value.memory.id, first.value.memory.id);
  }
});

test("remember creates advisory symmetric contradiction links", async () => {
  const memory = createFixture();
  const first = await memory.remember({
    requestId: "request-contradiction-1",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Default formatter is Prettier.",
  });
  const second = await memory.remember({
    requestId: "request-contradiction-2",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Default formatter is Biome.",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.value.contradictionIds, [first.value.memory.id]);

  const left = await memory.inspect({ id: first.value.memory.id });
  const right = await memory.inspect({ id: second.value.memory.id });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok) {
    assert.deepEqual(left.value.memories[0]?.relationships, [
      { kind: "pi/contradicts", targetId: second.value.memory.id },
    ]);
    assert.deepEqual(right.value.memories[0]?.relationships, [
      { kind: "pi/contradicts", targetId: first.value.memory.id },
    ]);
  }
});

test("search enforces host scopes and excludes review and expired memories", async () => {
  let now = 1_000;
  let nextId = 0;
  const module = createMemoryStoreModule({
    persistence: createInMemoryMemoryPersistenceAdapter(),
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    clock: () => now,
    id: () => `search-${++nextId}`,
  });
  const otherProject = { ...project, projectId: "non-git:project-two" };
  const directOne = module.bind({
    executionRole: "parent",
    project,
    ingress: "direct-user",
    sessionId: "session-one",
  });
  const proposalOne = module.bind({
    executionRole: "parent",
    project,
    ingress: "model-proposal",
    sessionId: "session-one",
  });
  const directTwo = module.bind({
    executionRole: "parent",
    project: otherProject,
    ingress: "direct-user",
    sessionId: "session-two",
  });
  const first = await directOne.remember({
    requestId: "search-request-1",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Project one formatter is Prettier.",
  });
  await directTwo.remember({
    requestId: "search-request-2",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Project two formatter is Biome.",
  });
  await proposalOne.remember({
    requestId: "search-request-3",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Project one formatter proposal is dprint.",
  });
  await directOne.remember({
    requestId: "search-request-4",
    kind: coreMemoryKinds.ephemeralNote,
    scope: "project",
    content: "Expired formatter migration note.",
    expiresAt: 1_001,
  });
  now = 2_000;

  const oneHits = await directOne.search({ text: "formatter" });
  const twoHits = await directTwo.search({ text: "formatter" });

  assert.equal(oneHits.ok, true);
  assert.equal(twoHits.ok, true);
  if (oneHits.ok && twoHits.ok && first.ok) {
    assert.deepEqual(
      oneHits.value.map(({ memory }) => memory.id),
      [first.value.memory.id],
    );
    assert.deepEqual(
      twoHits.value.map(({ memory }) => memory.content),
      ["Project two formatter is Biome."],
    );
  }
});

test("change promotes only with direct-user ingress and replaces optimistically", async () => {
  let nextId = 0;
  const module = createMemoryStoreModule({
    persistence: createInMemoryMemoryPersistenceAdapter(),
    artifacts: createInMemoryArtifactStore({ clock: () => 1_000 }),
    clock: () => 1_000,
    id: () => `change-${++nextId}`,
  });
  const direct = module.bind({
    executionRole: "parent",
    project,
    ingress: "direct-user",
    sessionId: "session-direct",
  });
  const proposal = module.bind({
    executionRole: "parent",
    project,
    ingress: "model-proposal",
    sessionId: "session-model",
  });
  const proposed = await proposal.remember({
    requestId: "change-remember",
    kind: coreMemoryKinds.decision,
    scope: "project",
    content: "Use the candidate formatter after review.",
  });
  assert.equal(proposed.ok && proposed.value.state, "review-required");
  if (!proposed.ok) return;

  const denied = await proposal.change({
    type: "promote",
    requestId: "change-denied",
    id: proposed.value.memory.id,
    expectedRevision: 1,
  });
  const promoted = await direct.change({
    type: "promote",
    requestId: "change-promote",
    id: proposed.value.memory.id,
    expectedRevision: 1,
  });
  const stale = await direct.change({
    type: "replace",
    requestId: "change-stale",
    id: proposed.value.memory.id,
    expectedRevision: 1,
    content: "Use Biome after review.",
  });
  const replaced = await direct.change({
    type: "replace",
    requestId: "change-replace",
    id: proposed.value.memory.id,
    expectedRevision: 2,
    content: "Use Biome after review.",
  });

  assert.equal(denied.ok, false);
  if (!denied.ok)
    assert.equal(denied.error.code, "import_requires_direct_user");
  assert.equal(
    promoted.ok && promoted.value.type === "promote"
      ? promoted.value.memory.revision
      : undefined,
    2,
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "revision_conflict");
  assert.equal(
    replaced.ok && replaced.value.type === "replace"
      ? replaced.value.memory.revision
      : undefined,
    3,
  );

  const history = await direct.inspect({
    id: proposed.value.memory.id,
    includeRevisions: true,
  });
  assert.equal(history.ok, true);
  if (history.ok)
    assert.deepEqual(
      history.value.memories.map(({ revision, status, content }) => ({
        revision,
        status,
        content,
      })),
      [
        {
          revision: 1,
          status: "review",
          content: "Use the candidate formatter after review.",
        },
        {
          revision: 2,
          status: "active",
          content: "Use the candidate formatter after review.",
        },
        {
          revision: 3,
          status: "active",
          content: "Use Biome after review.",
        },
      ],
    );
});

test("forget removes managed bodies, search hits, history, and symmetric links", async () => {
  const memory = createFixture();
  const first = await memory.remember({
    requestId: "forget-remember-1",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Package manager is npm.",
  });
  const second = await memory.remember({
    requestId: "forget-remember-2",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Package manager is pnpm.",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  const forgotten = await memory.change({
    type: "forget",
    requestId: "forget-request",
    id: first.value.memory.id,
    expectedRevision: 2,
  });
  const replay = await memory.change({
    type: "forget",
    requestId: "forget-request",
    id: first.value.memory.id,
    expectedRevision: 2,
  });

  assert.deepEqual(forgotten, {
    ok: true,
    value: {
      type: "forget",
      id: first.value.memory.id,
      forgottenAt: 1_000,
      replayed: false,
    },
  });
  assert.equal(replay.ok && replay.value.replayed, true);

  const missing = await memory.inspect({
    id: first.value.memory.id,
    includeRevisions: true,
  });
  const hits = await memory.search({ text: "Package manager is npm" });
  const survivor = await memory.inspect({ id: second.value.memory.id });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "memory_not_found");
  assert.deepEqual(hits, { ok: true, value: [] });
  assert.equal(survivor.ok, true);
  if (survivor.ok)
    assert.deepEqual(survivor.value.memories[0]?.relationships, []);
});

test("transfer exports, previews, and commits a digest-bound memory bundle", async () => {
  let nextId = 0;
  const artifacts = createInMemoryArtifactStore({ clock: () => 1_000 });
  const module = createMemoryStoreModule({
    persistence: createInMemoryMemoryPersistenceAdapter(),
    artifacts,
    clock: () => 1_000,
    id: () => `transfer-${++nextId}`,
  });
  const memory = module.bind({
    executionRole: "parent",
    project,
    ingress: "direct-user",
    sessionId: "transfer-session",
  });
  await memory.remember({
    requestId: "transfer-remember",
    kind: coreMemoryKinds.preference,
    scope: "project",
    content: "Prefer focused verification before the full suite.",
  });

  const exported = await memory.transfer({
    type: "export",
    requestId: "transfer-export",
    format: { id: "pi.memory-bundle", version: 1 },
    scopes: ["project"],
  });
  assert.equal(exported.ok, true);
  if (!exported.ok || exported.value.type !== "export") return;
  assert.equal(exported.value.count, 1);
  assert.equal(
    exported.value.artifact.metadata?.warning,
    "Export is an independent copy; forgetting Memory cannot retract it.",
  );

  const preview = await memory.transfer({
    type: "preview-import",
    requestId: "transfer-preview",
    artifactId: exported.value.artifact.id,
    targetScope: "user",
  });
  assert.equal(preview.ok, true);
  if (!preview.ok || preview.value.type !== "preview-import") return;
  assert.deepEqual(
    {
      accepted: preview.value.accepted,
      duplicates: preview.value.duplicates,
      unsupportedKinds: preview.value.unsupportedKinds,
    },
    { accepted: 1, duplicates: 0, unsupportedKinds: 0 },
  );

  const committed = await memory.transfer({
    type: "commit-import",
    requestId: "transfer-commit",
    previewId: preview.value.previewId,
    expectedManifestSha256: preview.value.manifestSha256,
    collisions: "skip",
  });
  assert.deepEqual(committed, {
    ok: true,
    value: {
      type: "commit-import",
      imported: 1,
      reviewRequired: 0,
      skipped: 0,
      replayed: false,
    },
  });
  const hits = await memory.search({
    text: "focused verification",
    within: ["user"],
  });
  assert.equal(hits.ok, true);
  if (hits.ok) {
    assert.equal(hits.value.length, 1);
    assert.equal(hits.value[0]?.memory.provenance.ingress, "import");
    assert.deepEqual(hits.value[0]?.memory.scope, { kind: "user" });
  }
});

test("remember sanitizes secret-shaped citation fields and excerpts", async () => {
  const memory = createFixture();
  const locatorSecret = "locator-secret-value";
  const bearerSecret = "bearer-secret-value-123456";
  const remembered = await memory.remember({
    requestId: "citation-redaction",
    kind: coreMemoryKinds.decision,
    scope: "project",
    content: "Citations remain untrusted data.",
    citations: [
      {
        kind: "external",
        locator: { api_key: locatorSecret, url: "https://example.test/source" },
        excerpt: `Authorization: Bearer ${bearerSecret}`,
      },
    ],
  });

  assert.equal(remembered.ok, true);
  if (!remembered.ok) return;
  const serialized = JSON.stringify(remembered.value.memory.citations);
  assert.equal(serialized.includes(locatorSecret), false);
  assert.equal(serialized.includes(bearerSecret), false);
  assert.deepEqual(remembered.value.memory.citations[0]?.locator, {
    api_key: "[REDACTED]",
    url: "https://example.test/source",
  });
  assert.equal(
    remembered.value.memory.citations[0]?.excerpt,
    "Authorization: [REDACTED]",
  );
});

test("workspace scope rejects an expired host-bound Guarded Workspace lease", async () => {
  const persistence = createInMemoryMemoryPersistenceAdapter();
  const module = createMemoryStoreModule({
    persistence,
    artifacts: createInMemoryArtifactStore({ clock: () => 1_000 }),
    clock: () => 1_000,
  });
  const memory = module.bind({
    executionRole: "subagent",
    project,
    ingress: "direct-user",
    workspace: {
      workspaceId: "workspace-one",
      owner: { sessionId: "session-1", agentId: "agent-1" },
      fence: 1,
      expiresAt: 999,
      snapshot: {
        workspaceId: "workspace-one",
        projectId: project.projectId,
        projectRoot: "C:/project-one",
        path: "C:/workspace-one",
        branch: "agent/workspace-one",
        baseCommit: "a".repeat(40),
        currentCommit: "a".repeat(40),
        state: "leased",
        createdAt: 100,
        updatedAt: 100,
      },
    },
  });

  const remembered = await memory.remember({
    requestId: "workspace-expired",
    kind: coreMemoryKinds.decision,
    scope: "workspace",
    content: "This stale workspace write must fail.",
  });
  assert.equal(remembered.ok, false);
  if (!remembered.ok)
    assert.equal(remembered.error.code, "workspace_lease_lost");
});

test("replace sanitizes citations before writing a new revision", async () => {
  const memory = createFixture();
  const remembered = await memory.remember({
    requestId: "replace-citation-source",
    kind: coreMemoryKinds.decision,
    scope: "project",
    content: "Original cited decision.",
  });
  assert.equal(remembered.ok, true);
  if (!remembered.ok) return;
  const secret = "change-citation-secret";
  const replaced = await memory.change({
    type: "replace",
    requestId: "replace-citation-change",
    id: remembered.value.memory.id,
    expectedRevision: 1,
    content: "Updated cited decision.",
    citations: [
      {
        kind: "external",
        locator: { password: secret },
        excerpt: `Bearer ${secret}-123456789012`,
      },
    ],
  });
  assert.equal(replaced.ok, true);
  if (!replaced.ok || replaced.value.type !== "replace") return;
  assert.equal(JSON.stringify(replaced.value.memory).includes(secret), false);
});

test("import re-redacts citations and ignores archive authority fields", async () => {
  let nextId = 0;
  const artifacts = createInMemoryArtifactStore({ clock: () => 1_000 });
  const module = createMemoryStoreModule({
    persistence: createInMemoryMemoryPersistenceAdapter(),
    artifacts,
    clock: () => 1_000,
    id: () => `import-${++nextId}`,
  });
  const memory = module.bind({
    executionRole: "parent",
    project,
    ingress: "direct-user",
    sessionId: "host-session",
  });
  const secret = "archive-secret-value";
  const entry = JSON.stringify({
    type: "memory",
    kind: coreMemoryKinds.projectFact,
    content: "Imported content remains untrusted.",
    citations: [
      {
        kind: "external",
        locator: { client_secret: secret },
        excerpt: `Bearer ${secret}-123456789012`,
      },
    ],
    provenance: { ingress: "direct-user", executionRole: "parent" },
    confidence: 1,
    authority: "user-approved",
    trust: "trusted",
  });
  const manifestSha256 = createHash("sha256").update(entry).digest("hex");
  const artifact = await artifacts.put({
    body: `${JSON.stringify({
      type: "manifest",
      format: { id: "pi.memory-bundle", version: 1 },
      count: 1,
      manifestSha256,
    })}\n${entry}\n`,
    filename: "untrusted-memory.jsonl",
  });
  assert.equal(artifact.ok, true);
  if (!artifact.ok) return;
  const preview = await memory.transfer({
    type: "preview-import",
    requestId: "import-redaction-preview",
    artifactId: artifact.value.id,
    targetScope: "project",
  });
  assert.equal(preview.ok, true);
  if (!preview.ok || preview.value.type !== "preview-import") return;
  const committed = await memory.transfer({
    type: "commit-import",
    requestId: "import-redaction-commit",
    previewId: preview.value.previewId,
    expectedManifestSha256: preview.value.manifestSha256,
    collisions: "skip",
  });
  assert.equal(committed.ok, true);
  const hits = await memory.search({ text: "Imported content" });
  assert.equal(hits.ok, true);
  if (!hits.ok || !hits.value[0]) return;
  const imported = hits.value[0].memory;
  assert.equal(JSON.stringify(imported).includes(secret), false);
  assert.deepEqual(imported.provenance, {
    ingress: "import",
    executionRole: "parent",
    importedFrom: artifact.value.id,
    sessionId: "host-session",
  });
  assert.equal(imported.confidence, 0.75);
  assert.equal(imported.trust, "untrusted");
  assert.equal(imported.authority, "none");
});

test("replace recalculates symmetric contradiction links", async () => {
  const memory = createFixture();
  const first = await memory.remember({
    requestId: "replace-links-first",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Default formatter is Prettier.",
  });
  const second = await memory.remember({
    requestId: "replace-links-second",
    kind: coreMemoryKinds.projectFact,
    scope: "project",
    content: "Package manager is npm.",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const replaced = await memory.change({
    type: "replace",
    requestId: "replace-links-change",
    id: second.value.memory.id,
    expectedRevision: 1,
    content: "Default formatter is Biome.",
  });
  assert.equal(replaced.ok, true);
  const left = await memory.inspect({ id: first.value.memory.id });
  const right = await memory.inspect({ id: second.value.memory.id });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok) {
    assert.deepEqual(left.value.memories[0]?.relationships, [
      { kind: "pi/contradicts", targetId: second.value.memory.id },
    ]);
    assert.deepEqual(right.value.memories[0]?.relationships, [
      { kind: "pi/contradicts", targetId: first.value.memory.id },
    ]);
  }
});
