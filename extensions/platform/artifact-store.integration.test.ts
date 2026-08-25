import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileSystemArtifactStore } from "./src/core/artifacts/index.ts";

const HELLO_SHA256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

async function temporaryStore() {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-integration-"));
  return {
    root,
    store: createFileSystemArtifactStore({ root, clock: () => 1 }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("filesystem adapter stores restricted metadata and SHA-256 bodies separately", async () => {
  const { root, store, cleanup } = await temporaryStore();
  try {
    const put = await store.put({
      body: "hello",
      filename: "hello.txt",
      metadata: { kind: "fixture" },
    });
    assert.equal(put.ok, true);
    if (!put.ok) return;

    const bodyPath = join(root, "bodies", HELLO_SHA256);
    const metadataPath = join(root, "metadata", `${HELLO_SHA256}.json`);
    assert.equal(await readFile(bodyPath, "utf8"), "hello");
    const persisted = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(persisted.id, HELLO_SHA256);
    assert.equal("body" in persisted, false);

    if (process.platform !== "win32") {
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      assert.equal((await stat(bodyPath)).mode & 0o777, 0o600);
      assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
    }

    const reopened = createFileSystemArtifactStore({ root });
    assert.equal((await reopened.get(HELLO_SHA256)).ok, true);

    await writeFile(bodyPath, "HELLO");
    const corrupt = await reopened.get(HELLO_SHA256);
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.error.code, "corrupt_artifact");
  } finally {
    await cleanup();
  }
});

test("filesystem collect removes orphan bodies and interrupted-write debris", async () => {
  const { root, store, cleanup } = await temporaryStore();
  try {
    const retained = await store.put({ body: "retained" });
    assert.equal(retained.ok, true);
    if (!retained.ok) return;

    const orphanBody = Buffer.from("orphan");
    const orphanId = createHash("sha256").update(orphanBody).digest("hex");
    const orphanPath = join(root, "bodies", orphanId);
    const temporaryPath = join(root, "bodies", `${orphanId}.fixture.tmp`);
    const metadataTemporaryPath = join(
      root,
      "metadata",
      `${orphanId}.fixture.tmp`,
    );
    await writeFile(orphanPath, orphanBody);
    await writeFile(temporaryPath, "tmp");
    await writeFile(metadataTemporaryPath, "partial metadata");

    const collected = await store.collect();
    assert.equal(collected.ok, true);
    if (!collected.ok) return;
    assert.deepEqual(collected.value, {
      removedArtifacts: 0,
      reclaimedBytes: 9,
    });
    await assert.rejects(readFile(orphanPath), { code: "ENOENT" });
    await assert.rejects(readFile(temporaryPath), { code: "ENOENT" });
    await assert.rejects(readFile(metadataTemporaryPath), { code: "ENOENT" });
    assert.equal((await store.get(retained.value.id)).ok, true);
  } finally {
    await cleanup();
  }
});

test("filesystem adapter rejects junctions in its private layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-junction-"));
  const root = join(directory, "store");
  const external = join(directory, "external");
  const bodies = join(root, "bodies");
  await mkdir(root);
  await mkdir(external);
  await symlink(
    external,
    bodies,
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    const result = await createFileSystemArtifactStore({ root }).put({
      body: "must-not-escape",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "io_error");
    assert.deepEqual(await readdir(external), []);
  } finally {
    await unlink(bodies);
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem collect removes corrupt metadata and its body", async () => {
  const { root, store, cleanup } = await temporaryStore();
  try {
    const put = await store.put({ body: "hello" });
    assert.equal(put.ok, true);
    if (!put.ok) return;
    await writeFile(
      join(root, "metadata", `${put.value.id}.json`),
      "{malformed",
      "utf8",
    );

    const collected = await store.collect();
    assert.equal(collected.ok, true);
    if (!collected.ok) return;
    assert.deepEqual(collected.value, {
      removedArtifacts: 1,
      reclaimedBytes: 5,
    });
    await assert.rejects(readFile(join(root, "bodies", put.value.id)), {
      code: "ENOENT",
    });
  } finally {
    await cleanup();
  }
});

test("filesystem adapter serializes concurrent quota decisions atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-concurrency-"));
  const options = {
    root,
    limits: { maxArtifactBytes: 4, maxTotalBytes: 4 },
  } as const;
  const first = createFileSystemArtifactStore(options);
  const second = createFileSystemArtifactStore(options);
  try {
    const results = await Promise.all([
      first.put({ body: "aaaa" }),
      second.put({ body: "bbbb" }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const rejected = results.find((result) => !result.ok);
    assert.ok(rejected && !rejected.ok);
    assert.equal(rejected.error.code, "quota_exceeded");

    assert.equal((await readdir(join(root, "bodies"))).length, 1);
    assert.equal(
      (await readdir(root)).some(
        (name) => name.includes(".tmp") || name.includes(".lock"),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
