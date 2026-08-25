import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFileSystemArtifactStore,
  createInMemoryArtifactStore,
  type ArtifactStore,
  type ArtifactStoreOptions,
} from "./src/core/artifacts/index.ts";

const HELLO_SHA256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

interface StoreFixture {
  readonly store: ArtifactStore;
  readonly cleanup: () => Promise<void>;
}

const fixtures: ReadonlyArray<{
  readonly name: string;
  readonly create: (options?: ArtifactStoreOptions) => Promise<StoreFixture>;
}> = [
  {
    name: "in-memory adapter",
    async create(options) {
      return {
        store: createInMemoryArtifactStore(options),
        cleanup: async () => {},
      };
    },
  },
  {
    name: "filesystem adapter",
    async create(options) {
      const root = await mkdtemp(join(tmpdir(), "pi-artifact-contract-"));
      return {
        store: createFileSystemArtifactStore({ root, ...options }),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
];

for (const fixture of fixtures) {
  test(`${fixture.name}: put/get uses a SHA-256 id and preserves metadata separately from body`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const put = await store.put({
        body: "hello",
        filename: "greeting.txt",
        mediaType: "text/plain",
        metadata: { source: "contract" },
      });

      assert.equal(put.ok, true);
      if (!put.ok) return;
      assert.equal(put.value.id, HELLO_SHA256);
      assert.equal(put.value.sha256, HELLO_SHA256);
      assert.equal(put.value.size, 5);
      assert.equal(put.value.filename, "greeting.txt");

      const get = await store.get(put.value.id);
      assert.equal(get.ok, true);
      if (!get.ok) return;
      assert.equal(Buffer.from(get.value.body).toString("utf8"), "hello");
      assert.deepEqual(get.value.metadata, put.value);
    } finally {
      await cleanup();
    }
  });

  test(`${fixture.name}: duplicate bodies reject conflicting logical metadata`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      const first = await store.put({
        body: "same-body",
        filename: "first.txt",
        expiresAt: 100,
      });
      assert.equal(first.ok, true);
      const conflict = await store.put({
        body: "same-body",
        filename: "second.txt",
        expiresAt: 200,
      });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, "metadata_conflict");
    } finally {
      await cleanup();
    }
  });

  test(`${fixture.name}: put snapshots caller-owned body and metadata`, async () => {
    const body = new Uint8Array([65]);
    const metadata = { state: "before" };
    const { store, cleanup } = await fixture.create();
    try {
      const put = await store.put({ body, metadata });
      assert.equal(put.ok, true);
      if (!put.ok) return;

      body[0] = 66;
      metadata.state = "after";
      const stored = await store.get(put.value.id);
      assert.equal(stored.ok, true);
      if (!stored.ok) return;
      assert.equal(Buffer.from(stored.value.body).toString("utf8"), "A");
      assert.deepEqual(stored.value.metadata.metadata, { state: "before" });
    } finally {
      await cleanup();
    }
  });

  test(`${fixture.name}: rejects malformed ids and retention timestamps`, async () => {
    const { store, cleanup } = await fixture.create();
    const output = await mkdtemp(join(tmpdir(), "pi-artifact-invalid-"));
    try {
      for (const id of ["../metadata/secret", "A".repeat(64), "short"]) {
        const get = await store.get(id);
        assert.equal(get.ok, false);
        if (!get.ok) assert.equal(get.error.code, "invalid_artifact_id");

        const exported = await store.export(id, { directory: output });
        assert.equal(exported.ok, false);
        if (!exported.ok) {
          assert.equal(exported.error.code, "invalid_artifact_id");
        }
      }

      const invalidRetention = await store.put({
        body: "body",
        expiresAt: Number.NaN,
      });
      assert.equal(invalidRetention.ok, false);
      if (!invalidRetention.ok) {
        assert.equal(invalidRetention.error.code, "invalid_input");
      }

      const invalidCollection = await store.collect({ now: Number.NaN });
      assert.equal(invalidCollection.ok, false);
      if (!invalidCollection.ok) {
        assert.equal(invalidCollection.error.code, "invalid_input");
      }
    } finally {
      await Promise.all([
        cleanup(),
        rm(output, { recursive: true, force: true }),
      ]);
    }
  });

  test(`${fixture.name}: rejects traversal and Windows device filenames`, async () => {
    const { store, cleanup } = await fixture.create();
    try {
      for (const filename of [
        "../secret.txt",
        "..\\secret.txt",
        "nested/file.txt",
        "CON",
        "con.txt",
        "CON .txt",
        "CONIN$.txt",
        "LPT9.log",
        "trailing.",
        "trailing ",
      ]) {
        const result = await store.put({ body: "body", filename });
        assert.equal(result.ok, false, filename);
        if (!result.ok) assert.equal(result.error.code, "invalid_filename");
      }

      const safe = await store.put({
        body: "body",
        filename: "report 2026.txt",
      });
      assert.equal(safe.ok, true);
    } finally {
      await cleanup();
    }
  });

  test(`${fixture.name}: export is safe and never overwrites`, async () => {
    const { store, cleanup } = await fixture.create();
    const output = await mkdtemp(join(tmpdir(), "pi-artifact-export-"));
    try {
      const put = await store.put({ body: "exported", filename: "report.txt" });
      assert.equal(put.ok, true);
      if (!put.ok) return;

      const exported = await store.export(put.value.id, { directory: output });
      assert.equal(exported.ok, true);
      if (!exported.ok) return;
      assert.equal(exported.value.path, join(output, "report.txt"));
      assert.equal(await readFile(exported.value.path, "utf8"), "exported");

      const collision = await store.export(put.value.id, { directory: output });
      assert.equal(collision.ok, false);
      if (!collision.ok) {
        assert.equal(collision.error.code, "destination_exists");
      }
      assert.equal(await readFile(exported.value.path, "utf8"), "exported");

      const traversal = await store.export(put.value.id, {
        directory: output,
        filename: "../escaped.txt",
      });
      assert.equal(traversal.ok, false);
      if (!traversal.ok) {
        assert.equal(traversal.error.code, "invalid_filename");
      }
    } finally {
      await Promise.all([
        cleanup(),
        rm(output, { recursive: true, force: true }),
      ]);
    }
  });

  test(`${fixture.name}: retention expires exactly on time and collect reclaims quota`, async () => {
    let now = 99;
    const { store, cleanup } = await fixture.create({
      clock: () => now,
      limits: { maxArtifactBytes: 4, maxTotalBytes: 4 },
    });
    try {
      const put = await store.put({ body: "full", expiresAt: 100 });
      assert.equal(put.ok, true);
      if (!put.ok) return;

      assert.equal((await store.get(put.value.id)).ok, true);
      now = 100;
      const expired = await store.get(put.value.id);
      assert.equal(expired.ok, false);
      if (!expired.ok) assert.equal(expired.error.code, "artifact_expired");

      const collected = await store.collect();
      assert.equal(collected.ok, true);
      if (!collected.ok) return;
      assert.deepEqual(collected.value, {
        removedArtifacts: 1,
        reclaimedBytes: 4,
      });

      const second = await store.collect();
      assert.equal(second.ok, true);
      if (second.ok) {
        assert.deepEqual(second.value, {
          removedArtifacts: 0,
          reclaimedBytes: 0,
        });
      }
      assert.equal((await store.put({ body: "next" })).ok, true);
    } finally {
      await cleanup();
    }
  });

  test(`${fixture.name}: metadata persistence accepts its exact byte limit`, async () => {
    const input = {
      body: "hello",
      filename: "x.txt",
      metadata: { note: "ok" },
    } as const;
    const atLimit = await fixture.create({
      clock: () => 1,
      limits: { maxMetadataBytes: 216 },
    });
    const overLimit = await fixture.create({
      clock: () => 1,
      limits: { maxMetadataBytes: 215 },
    });
    try {
      assert.equal((await atLimit.store.put(input)).ok, true);
      const rejected = await overLimit.store.put(input);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) {
        assert.equal(rejected.error.code, "metadata_too_large");
      }
    } finally {
      await Promise.all([atLimit.cleanup(), overLimit.cleanup()]);
    }
  });

  test(`${fixture.name}: limits are inclusive and quota counts each SHA-256 body once`, async () => {
    const { store, cleanup } = await fixture.create({
      limits: {
        maxArtifactBytes: 5,
        maxTotalBytes: 8,
      },
    });
    try {
      const atArtifactLimit = await store.put({ body: "hello" });
      assert.equal(atArtifactLimit.ok, true);

      const duplicate = await store.put({ body: "hello" });
      assert.equal(duplicate.ok, true);

      const atQuota = await store.put({ body: "abc" });
      assert.equal(atQuota.ok, true);

      const overArtifactLimit = await store.put({ body: "123456" });
      assert.equal(overArtifactLimit.ok, false);
      if (!overArtifactLimit.ok) {
        assert.equal(overArtifactLimit.error.code, "artifact_too_large");
      }

      const overQuota = await store.put({ body: "z" });
      assert.equal(overQuota.ok, false);
      if (!overQuota.ok) {
        assert.equal(overQuota.error.code, "quota_exceeded");
      }
    } finally {
      await cleanup();
    }
  });
}
