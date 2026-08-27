import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  coreMemoryKinds,
  createHostMemoryBindingFactory,
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
  }).bind(
    createHostMemoryBindingFactory().issue({
      executionRole: "parent",
      project,
      ingress: "direct-user",
      sessionId: "sqlite-session",
    }),
  ) as MemoryStore;
}

function openConfiguredMemory(
  path: string,
  options: {
    readonly clock?: () => number;
    readonly secretCanaries?: readonly string[];
    readonly limits?: Parameters<typeof createMemoryStoreModule>[0]["limits"];
  } = {},
) {
  const persistence = createSqliteMemoryPersistenceAdapter({
    path,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  if (!persistence.ok) assert.fail(persistence.error.message);
  return createMemoryStoreModule({
    persistence: persistence.value,
    artifacts: createInMemoryArtifactStore({
      clock: options.clock ?? (() => 1_000),
    }),
    clock: options.clock ?? (() => 1_000),
    ...(options.secretCanaries
      ? { secretCanaries: options.secretCanaries }
      : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  }).bind(
    createHostMemoryBindingFactory().issue({
      executionRole: "parent",
      project: projectOne,
      ingress: "direct-user",
      sessionId: "sqlite-configured",
    }),
  );
}

function databaseBytes(path: string) {
  return [path, `${path}-wal`, `${path}-shm`]
    .filter(existsSync)
    .map((candidate) => readFileSync(candidate));
}

function spawnRememberWorker(
  path: string,
  gate: string,
  requestId: string,
  content: string,
) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(import.meta.dirname, "memory-sqlite-worker.ts"),
      path,
      gate,
      requestId,
      content,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Memory worker did not become ready: ${stderr}`)),
      10_000,
    );
    const inspect = () => {
      if (!stdout.includes("READY\n")) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.once("close", (code) => {
      if (!stdout.includes("READY\n")) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Memory worker exited ${code}: stdout=${JSON.stringify(stdout)} stderr=${stderr}`,
          ),
        );
      }
    });
  });
  const result = new Promise<unknown>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Memory worker exited ${code}: ${stderr}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        reject(new Error(`Memory worker returned invalid output: ${stdout}`));
      }
    });
  });
  return {
    ready,
    result,
    cancel() {
      if (child.exitCode === null) child.kill();
    },
  };
}

async function runRememberRace(
  path: string,
  requests: readonly [
    { readonly requestId: string; readonly content: string },
    { readonly requestId: string; readonly content: string },
  ],
) {
  const gate = join(`${path}.race-gate`);
  const workers = requests.map(({ requestId, content }) =>
    spawnRememberWorker(path, gate, requestId, content),
  );
  try {
    await Promise.all(workers.map(({ ready }) => ready));
  } catch (error) {
    for (const worker of workers) worker.cancel();
    await Promise.allSettled(workers.map(({ result }) => result));
    throw error;
  }
  writeFileSync(gate, "go", { flag: "wx" });
  return Promise.all(workers.map(({ result }) => result));
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

test("node:sqlite never returns false empty when FTS rows drift", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-fts-drift-"));
  const path = join(directory, "memory.sqlite");
  try {
    const memory = openMemory(path);
    await memory.remember({
      requestId: "fts-drift-source",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "FTS reconciliation restores lexical retrieval.",
    });
    const database = new DatabaseSync(path);
    database.exec("DELETE FROM memory_fts");
    database.close();
    const result = await memory.search({ text: "lexical retrieval" });
    if (!result.ok) {
      assert.equal(result.error.code, "index_unavailable");
      return;
    }
    assert.deepEqual(
      result.value.map(({ memory: hit }) => hit.content),
      ["FTS reconciliation restores lexical retrieval."],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite byte scans exclude secret fields from content, FTS, citations, request IDs, and receipts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-secrets-"));
  const path = join(directory, "memory.sqlite");
  const canary = "SQLITE-EXACT-CANARY-41b7";
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmMTEifQ.abcdefghijklmnopqrstuvwxyz012345";
  const password = "sqlite-url-password";
  try {
    const memory = openConfiguredMemory(path, { secretCanaries: [canary] });
    const remembered = await memory.remember({
      requestId: "sqlite-secret-safe-request",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: `Redact ${canary}, ${jwt}, and https://user:${password}@example.test/path.`,
      citations: [
        {
          kind: "external",
          locator: {
            api_key: canary,
            url: `https://user:${password}@example.test`,
          },
          excerpt: jwt,
        },
      ],
    });
    assert.equal(remembered.ok, true);
    const rejected = await memory.remember({
      requestId: canary,
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Secret request identifiers are rejected.",
    });
    assert.equal(rejected.ok, false);
    const bytes = databaseBytes(path);
    for (const secret of [canary, jwt, password])
      assert.equal(
        bytes.some((body) => body.includes(Buffer.from(secret))),
        false,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite access cleanup erases expired preview bodies from database and WAL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-preview-expiry-"));
  const path = join(directory, "memory.sqlite");
  let now = 1_000;
  const marker = "EXPIRED-PREVIEW-BODY-6c205";
  try {
    const artifacts = createInMemoryArtifactStore({ clock: () => now });
    const persistence = createSqliteMemoryPersistenceAdapter({
      path,
      clock: () => now,
    });
    if (!persistence.ok) assert.fail(persistence.error.message);
    const memory = createMemoryStoreModule({
      persistence: persistence.value,
      artifacts,
      clock: () => now,
    }).bind(
      createHostMemoryBindingFactory().issue({
        executionRole: "parent",
        project: projectOne,
        ingress: "direct-user",
      }),
    );
    const entry = JSON.stringify({
      type: "memory",
      kind: coreMemoryKinds.projectFact,
      content: marker,
    });
    const artifact = await artifacts.put({
      body: `${JSON.stringify({
        type: "manifest",
        format: { id: "pi.memory-bundle", version: 1 },
        count: 1,
        manifestSha256: createHash("sha256").update(entry).digest("hex"),
      })}\n${entry}\n`,
      filename: "expiring-preview.jsonl",
    });
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const preview = await memory.transfer({
      type: "preview-import",
      requestId: "expiring-preview-create",
      artifactId: artifact.value.id,
      targetScope: "project",
    });
    assert.equal(preview.ok, true);
    if (!preview.ok || preview.value.type !== "preview-import") return;
    assert.equal(
      databaseBytes(path).some((body) => body.includes(Buffer.from(marker))),
      true,
    );
    now = preview.value.expiresAt;
    const expired = await memory.transfer({
      type: "commit-import",
      requestId: "expiring-preview-access",
      previewId: preview.value.previewId,
      expectedManifestSha256: preview.value.manifestSha256,
      collisions: "skip",
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.error.code, "import_preview_expired");
    assert.equal(
      databaseBytes(path).some((body) => body.includes(Buffer.from(marker))),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite startup cleanup erases expired preview bodies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-preview-startup-"));
  const path = join(directory, "memory.sqlite");
  let now = 1_000;
  const marker = "STARTUP-EXPIRED-PREVIEW-c804";
  try {
    const artifacts = createInMemoryArtifactStore({ clock: () => now });
    const persistence = createSqliteMemoryPersistenceAdapter({
      path,
      clock: () => now,
    });
    if (!persistence.ok) assert.fail(persistence.error.message);
    const memory = createMemoryStoreModule({
      persistence: persistence.value,
      artifacts,
      clock: () => now,
    }).bind(
      createHostMemoryBindingFactory().issue({
        executionRole: "parent",
        project: projectOne,
        ingress: "direct-user",
      }),
    );
    const entry = JSON.stringify({
      type: "memory",
      kind: coreMemoryKinds.projectFact,
      content: marker,
    });
    const artifact = await artifacts.put({
      body: `${JSON.stringify({
        type: "manifest",
        format: { id: "pi.memory-bundle", version: 1 },
        count: 1,
        manifestSha256: createHash("sha256").update(entry).digest("hex"),
      })}\n${entry}\n`,
      filename: "startup-preview.jsonl",
    });
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const preview = await memory.transfer({
      type: "preview-import",
      requestId: "startup-preview-create",
      artifactId: artifact.value.id,
      targetScope: "project",
    });
    assert.equal(preview.ok, true);
    if (!preview.ok || preview.value.type !== "preview-import") return;
    now = preview.value.expiresAt;
    const restarted = createSqliteMemoryPersistenceAdapter({
      path,
      clock: () => now,
    });
    assert.equal(restarted.ok, true);
    assert.equal(
      databaseBytes(path).some((body) => body.includes(Buffer.from(marker))),
      false,
    );
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

test("node:sqlite rejects Windows junction database paths and later path replacement", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows junction regression");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-junction-"));
  const external = mkdtempSync(join(tmpdir(), "pi-memory-external-"));
  const directJunction = join(directory, "direct-junction");
  const state = join(directory, "state");
  const savedState = join(directory, "saved-state");
  let directJunctionLive = false;
  let replacementJunctionLive = false;
  try {
    symlinkSync(external, directJunction, "junction");
    directJunctionLive = true;
    const rejected = createSqliteMemoryPersistenceAdapter({
      path: join(directJunction, "memory.sqlite"),
    });
    assert.equal(rejected.ok, false);

    const memory = openMemory(join(state, "memory.sqlite"));
    renameSync(state, savedState);
    symlinkSync(external, state, "junction");
    replacementJunctionLive = true;
    const result = await memory.remember({
      requestId: "junction-replacement",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Replacement junction must fail closed.",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "storage_failed");
  } finally {
    if (replacementJunctionLive) rmSync(state, { force: true });
    if (directJunctionLive) rmSync(directJunction, { force: true });
    rmSync(directory, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
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

test("node:sqlite reconciles contradiction links across real processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-process-links-"));
  const path = join(directory, "memory.sqlite");
  try {
    openMemory(path);
    const results = await runRememberRace(path, [
      {
        requestId: "process-contradiction-left",
        content: "Default formatter is Prettier.",
      },
      {
        requestId: "process-contradiction-right",
        content: "Default formatter is Biome.",
      },
    ]);
    assert.equal(
      results.every(
        (result) =>
          !!result &&
          typeof result === "object" &&
          "ok" in result &&
          result.ok === true,
      ),
      true,
      JSON.stringify(results),
    );
    const memory = openMemory(path);
    const inspected = await memory.inspect({ scope: "project", limit: 10 });
    assert.equal(inspected.ok, true);
    if (inspected.ok) {
      assert.equal(inspected.value.memories.length, 2);
      assert.equal(
        inspected.value.memories.every(
          ({ relationships }) => relationships.length === 1,
        ),
        true,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite recovers same-request races as replay or deterministic conflict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-process-request-"));
  const path = join(directory, "memory.sqlite");
  try {
    openMemory(path);
    const same = await runRememberRace(path, [
      {
        requestId: "process-same-request",
        content: "Same request converges on one Memory.",
      },
      {
        requestId: "process-same-request",
        content: "Same request converges on one Memory.",
      },
    ]);
    const sameResults = same.filter(
      (
        result,
      ): result is {
        ok: true;
        value: { memory: { id: string }; replayed: boolean };
      } =>
        !!result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === true,
    );
    assert.equal(sameResults.length, 2, JSON.stringify(same));
    assert.equal(
      sameResults[0]?.value.memory.id,
      sameResults[1]?.value.memory.id,
    );
    assert.deepEqual(sameResults.map(({ value }) => value.replayed).sort(), [
      false,
      true,
    ]);

    const conflictPath = join(directory, "conflict.sqlite");
    openMemory(conflictPath);
    const conflict = await runRememberRace(conflictPath, [
      {
        requestId: "process-conflicting-request",
        content: "Winning request intent.",
      },
      {
        requestId: "process-conflicting-request",
        content: "Conflicting request intent.",
      },
    ]);
    assert.deepEqual(
      conflict
        .map((result) =>
          result && typeof result === "object" && "ok" in result && result.ok
            ? "ok"
            : result &&
                typeof result === "object" &&
                "error" in result &&
                result.error &&
                typeof result.error === "object" &&
                "code" in result.error
              ? result.error.code
              : "unknown",
        )
        .sort(),
      ["invalid_request", "ok"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
