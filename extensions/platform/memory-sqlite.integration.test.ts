import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  coreMemoryKinds,
  createMemoryStoreModule,
  type MemoryStore,
} from "./src/memory/index.ts";
import { createSqliteMemoryPersistenceAdapter } from "./src/memory/sqlite-memory-persistence.ts";

const projectOne = {
  kind: "non-git" as const,
  projectId: "non-git:sqlite-project-one",
  requestedCwd: "C:/sqlite-project-one",
  canonicalCwd: "C:/sqlite-project-one",
  cwdWasAliased: false,
};

function openMemory(path: string, project = projectOne, busyTimeoutMs = 5_000) {
  const persistence = createSqliteMemoryPersistenceAdapter({
    path,
    busyTimeoutMs,
  });
  if (!persistence.ok) assert.fail(persistence.error.message);
  return createMemoryStoreModule({
    persistence: persistence.value,
    artifacts: createInMemoryArtifactStore({ clock: () => 1_000 }),
    clock: () => 1_000,
  }).bind({
    executionRole: "parent",
    project,
    ingress: "direct-user",
    sessionId: "sqlite-session",
  }) as MemoryStore;
}

test("node:sqlite persists Memory and searches FTS5 within SQL scope predicates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-sqlite-"));
  const path = join(directory, "memory.sqlite");
  try {
    const first = openMemory(path);
    const remembered = await first.remember({
      requestId: "sqlite-remember",
      kind: coreMemoryKinds.decision,
      scope: "project",
      content: "SQLite lexical retrieval uses FTS5 ranking.",
    });
    assert.equal(remembered.ok, true);

    const restarted = openMemory(path);
    const hits = await restarted.search({
      text: "lexical retrieval",
      within: ["project"],
    });
    assert.equal(hits.ok, true);
    if (hits.ok)
      assert.deepEqual(
        hits.value.map(({ memory }) => memory.content),
        ["SQLite lexical retrieval uses FTS5 ranking."],
      );

    const unrelated = openMemory(path, {
      ...projectOne,
      projectId: "non-git:sqlite-project-two",
    });
    assert.deepEqual(await unrelated.search({ text: "lexical retrieval" }), {
      ok: true,
      value: [],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite atomically imports and checkpoint-gates complete forget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-delete-"));
  const path = join(directory, "memory.sqlite");
  try {
    const memory = openMemory(path);
    await memory.remember({
      requestId: "sqlite-transfer-source",
      kind: coreMemoryKinds.procedure,
      scope: "project",
      content: "Delete the managed body and lexical index together.",
    });
    const exported = await memory.transfer({
      type: "export",
      requestId: "sqlite-export",
      format: { id: "pi.memory-bundle", version: 1 },
      scopes: ["project"],
    });
    assert.equal(exported.ok, true);
    if (!exported.ok || exported.value.type !== "export") return;
    const preview = await memory.transfer({
      type: "preview-import",
      requestId: "sqlite-preview",
      artifactId: exported.value.artifact.id,
      targetScope: "user",
    });
    assert.equal(preview.ok, true);
    if (!preview.ok || preview.value.type !== "preview-import") return;
    const committed = await memory.transfer({
      type: "commit-import",
      requestId: "sqlite-commit",
      previewId: preview.value.previewId,
      expectedManifestSha256: preview.value.manifestSha256,
      collisions: "skip",
    });
    assert.equal(committed.ok, true);

    const restarted = openMemory(path);
    const imported = await restarted.search({
      text: "managed body lexical index",
      within: ["user"],
    });
    assert.equal(imported.ok, true);
    if (!imported.ok || !imported.value[0]) return;
    const forgotten = await restarted.change({
      type: "forget",
      requestId: "sqlite-forget",
      id: imported.value[0].memory.id,
      expectedRevision: 1,
    });
    assert.equal(forgotten.ok, true);

    const afterRestart = openMemory(path);
    assert.deepEqual(
      await afterRestart.search({
        text: "managed body lexical index",
        within: ["user"],
      }),
      { ok: true, value: [] },
    );
    const missing = await afterRestart.inspect({
      id: imported.value[0].memory.id,
      includeRevisions: true,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "memory_not_found");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite bounds write contention and reports retryable storage failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-busy-"));
  const path = join(directory, "memory.sqlite");
  let blocker: DatabaseSync | undefined;
  try {
    openMemory(path);
    blocker = new DatabaseSync(path);
    blocker.exec("BEGIN IMMEDIATE");
    const memory = openMemory(path, projectOne, 10);
    const startedAt = Date.now();
    const remembered = await memory.remember({
      requestId: "sqlite-busy",
      kind: coreMemoryKinds.decision,
      scope: "project",
      content: "This write must respect the configured busy bound.",
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(remembered.ok, false);
    if (!remembered.ok) {
      assert.equal(remembered.error.code, "storage_failed");
      assert.equal(remembered.error.retryable, true);
    }
    assert.equal(elapsed < 2_000, true);
  } finally {
    try {
      blocker?.exec("ROLLBACK");
    } catch {}
    blocker?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite converges concurrent exact remembers on one canonical Memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-dedupe-race-"));
  const path = join(directory, "memory.sqlite");
  try {
    const left = openMemory(path);
    const right = openMemory(path);
    const [first, second] = await Promise.all([
      left.remember({
        requestId: "sqlite-race-left",
        kind: coreMemoryKinds.projectFact,
        scope: "project",
        content: "Concurrent exact dedupe has one canonical body.",
      }),
      right.remember({
        requestId: "sqlite-race-right",
        kind: coreMemoryKinds.projectFact,
        scope: "project",
        content: "Concurrent exact dedupe has one canonical body.",
      }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual([first.value.state, second.value.state].sort(), [
      "created",
      "duplicate",
    ]);
    assert.equal(first.value.memory.id, second.value.memory.id);

    const inspected = await left.inspect({ scope: "project", limit: 10 });
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.value.memories.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
