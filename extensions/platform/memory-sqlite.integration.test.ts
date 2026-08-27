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
  const clock = () => 1_000;
  const persistence = createSqliteMemoryPersistenceAdapter({
    path,
    busyTimeoutMs,
    clock,
  });
  if (!persistence.ok) assert.fail(persistence.error.message);
  return createMemoryStoreModule({
    persistence: persistence.value,
    artifacts: createInMemoryArtifactStore({ clock }),
    clock,
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
  const clock = options.clock ?? (() => 1_000);
  const persistence = createSqliteMemoryPersistenceAdapter({
    path,
    clock,
  });
  if (!persistence.ok) assert.fail(persistence.error.message);
  return createMemoryStoreModule({
    persistence: persistence.value,
    artifacts: createInMemoryArtifactStore({ clock }),
    clock,
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
  const npmToken = `npm_${"A7b9C2d4E6f8G1h3J5k7L9m2N4p6Q8r1S3t5"}`;
  const randomCredential = "q7Wm2_Kp9Vx4Nc8Rz1Ht6Yb3Ld5Sf0Gj";
  const lowerCredential = "7q2m9x4n8v1c6b3z5k0j4h8s2d9f6a1w";
  try {
    const memory = openConfiguredMemory(path, { secretCanaries: [canary] });
    const remembered = await memory.remember({
      requestId: "sqlite-secret-safe-request",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: `Redact ${canary}, ${jwt}, ${npmToken}, and https://user:${password}@example.test/path.`,
      citations: [
        {
          kind: "external",
          locator: {
            api_key: canary,
            opaque: randomCredential,
            nested: { lowerCredential },
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
    const entropyRejected = await memory.remember({
      requestId: randomCredential,
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Entropy-shaped request identifiers are rejected.",
    });
    assert.equal(entropyRejected.ok, false);
    const bytes = databaseBytes(path);
    for (const secret of [
      canary,
      jwt,
      password,
      npmToken,
      randomCredential,
      lowerCredential,
    ])
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

test("node:sqlite import commit rejects and purges a preview expiring at transaction boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-preview-boundary-"));
  const path = join(directory, "memory.sqlite");
  let now = 1_000;
  let expiresAt = Number.MAX_SAFE_INTEGER;
  const marker = "BOUNDARY-EXPIRED-PREVIEW-07d31";
  try {
    const artifacts = createInMemoryArtifactStore({ clock: () => now });
    const opened = createSqliteMemoryPersistenceAdapter({
      path,
      clock: () => now,
    });
    if (!opened.ok) assert.fail(opened.error.message);
    const persistence = {
      ...opened.value,
      async commitImport(
        ...args: Parameters<typeof opened.value.commitImport>
      ) {
        now = expiresAt;
        return opened.value.commitImport(...args);
      },
    };
    const memory = createMemoryStoreModule({
      persistence,
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
      filename: "boundary-preview.jsonl",
    });
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const preview = await memory.transfer({
      type: "preview-import",
      requestId: "boundary-preview-create",
      artifactId: artifact.value.id,
      targetScope: "project",
    });
    assert.equal(preview.ok, true);
    if (!preview.ok || preview.value.type !== "preview-import") return;
    expiresAt = preview.value.expiresAt;
    const committed = await memory.transfer({
      type: "commit-import",
      requestId: "boundary-preview-commit",
      previewId: preview.value.previewId,
      expectedManifestSha256: preview.value.manifestSha256,
      collisions: "skip",
    });
    assert.equal(committed.ok, false);
    if (!committed.ok)
      assert.equal(committed.error.code, "import_preview_expired");
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

test("node:sqlite activation atomically reconciles symmetric contradiction links", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-activation-links-"));
  const path = join(directory, "memory.sqlite");
  try {
    const opened = createSqliteMemoryPersistenceAdapter({ path });
    if (!opened.ok) assert.fail(opened.error.message);
    const module = createMemoryStoreModule({
      persistence: opened.value,
      artifacts: createInMemoryArtifactStore({ clock: () => 1_000 }),
      clock: () => 1_000,
    });
    const bindings = createHostMemoryBindingFactory();
    const direct = module.bind(
      bindings.issue({
        executionRole: "parent",
        project: projectOne,
        ingress: "direct-user",
      }),
    );
    const proposal = module.bind(
      bindings.issue({
        executionRole: "parent",
        project: projectOne,
        ingress: "model-proposal",
      }),
    );
    const formatter = await direct.remember({
      requestId: "sqlite-activation-formatter-active",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Default formatter is Prettier.",
    });
    const formatterReview = await proposal.remember({
      requestId: "sqlite-activation-formatter-review",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Default formatter is Biome.",
    });
    const packageManager = await direct.remember({
      requestId: "sqlite-activation-package-active",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Package manager is npm.",
    });
    const packageReview = await proposal.remember({
      requestId: "sqlite-activation-package-review",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Package manager is pnpm.",
    });
    assert.equal(formatter.ok, true);
    assert.equal(formatterReview.ok, true);
    assert.equal(packageManager.ok, true);
    assert.equal(packageReview.ok, true);
    if (
      !formatter.ok ||
      !formatterReview.ok ||
      !packageManager.ok ||
      !packageReview.ok
    )
      return;

    const takeover = await direct.remember({
      requestId: "sqlite-activation-formatter-takeover",
      kind: coreMemoryKinds.projectFact,
      scope: "project",
      content: "Default formatter is Biome.",
    });
    const promoted = await direct.change({
      type: "promote",
      requestId: "sqlite-activation-package-promote",
      id: packageReview.value.memory.id,
      expectedRevision: 1,
    });
    assert.equal(takeover.ok, true);
    assert.equal(promoted.ok, true);
    if (takeover.ok)
      assert.deepEqual(takeover.value.memory.relationships, [
        { kind: "pi/contradicts", targetId: formatter.value.memory.id },
      ]);
    if (promoted.ok && promoted.value.type === "promote")
      assert.deepEqual(promoted.value.memory.relationships, [
        { kind: "pi/contradicts", targetId: packageManager.value.memory.id },
      ]);

    const inspected = await direct.inspect({ scope: "project", limit: 10 });
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    const records = new Map(
      inspected.value.memories.map((memory) => [memory.id, memory]),
    );
    for (const [leftId, rightId] of [
      [formatter.value.memory.id, formatterReview.value.memory.id],
      [packageManager.value.memory.id, packageReview.value.memory.id],
    ]) {
      assert.deepEqual(records.get(leftId)?.relationships, [
        { kind: "pi/contradicts", targetId: rightId },
      ]);
      assert.deepEqual(records.get(rightId)?.relationships, [
        { kind: "pi/contradicts", targetId: leftId },
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("node:sqlite converges concurrent near-identical remembers across repeated native races", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-memory-near-races-"));
  try {
    for (let run = 0; run < 24; run += 1) {
      const path = join(directory, `memory-${run}.sqlite`);
      openMemory(path);
      const results = await runRememberRace(path, [
        {
          requestId: `process-near-left-${run}`,
          content:
            "Run focused tests before running complete verification suite.",
        },
        {
          requestId: `process-near-right-${run}`,
          content:
            "Run focused tests before running complete verifiction suite.",
        },
      ]);
      const successful = results.filter(
        (
          result,
        ): result is {
          ok: true;
          value: { state: string; memory: { id: string } };
        } =>
          !!result &&
          typeof result === "object" &&
          "ok" in result &&
          result.ok === true,
      );
      assert.equal(
        successful.length,
        2,
        `run ${run}: ${JSON.stringify(results)}`,
      );
      assert.deepEqual(
        successful.map(({ value }) => value.state).sort(),
        ["created", "duplicate"],
        `run ${run}`,
      );
      assert.equal(
        successful[0]?.value.memory.id,
        successful[1]?.value.memory.id,
        `run ${run}`,
      );
    }
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
