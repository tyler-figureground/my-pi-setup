import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import {
  exportArtifactBundle,
  importArtifactBundle,
} from "./src/artifacts/bundle.ts";

test("Artifact bundle export/import verifies manifest and body hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-bundle-"));
  try {
    const source = createInMemoryArtifactStore({ clock: () => 1 });
    const first = await source.put({
      body: "# One",
      filename: "one.md",
      mediaType: "text/markdown",
      metadata: { title: "One" },
    });
    const second = await source.put({
      body: JSON.stringify({ two: true }),
      filename: "two.json",
      mediaType: "application/json",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    const path = join(directory, "artifacts.pi-artifacts.json");
    const exported = await exportArtifactBundle(
      source,
      [first.value.id, second.value.id],
      path,
      { clock: () => 10 },
    );
    assert.equal(exported.ok, true);

    const target = createInMemoryArtifactStore({ clock: () => 20 });
    const imported = await importArtifactBundle(target, path);
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.deepEqual(
      new Set(imported.value.artifactIds),
      new Set([first.value.id, second.value.id]),
    );
    assert.equal((await target.get(first.value.id)).ok, true);
    assert.equal((await target.get(second.value.id)).ok, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Artifact bundle import rolls back earlier entries when a later store write fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-artifact-bundle-rollback-"),
  );
  try {
    const source = createInMemoryArtifactStore();
    const first = await source.put({ body: "1234", mediaType: "text/plain" });
    const second = await source.put({ body: "5678", mediaType: "text/plain" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    const path = join(directory, "bundle.json");
    assert.equal(
      (
        await exportArtifactBundle(
          source,
          [first.value.id, second.value.id],
          path,
        )
      ).ok,
      true,
    );
    const target = createInMemoryArtifactStore({
      limits: { maxArtifactBytes: 4, maxTotalBytes: 4 },
    });
    const imported = await importArtifactBundle(target, path);
    assert.equal(imported.ok, false);
    const listed = await target.list();
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.value.artifacts.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Artifact bundle tampering is rejected before any body becomes visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-bundle-tamper-"));
  try {
    const source = createInMemoryArtifactStore({ clock: () => 1 });
    const artifact = await source.put({
      body: "safe",
      mediaType: "text/plain",
    });
    assert.equal(artifact.ok, true);
    if (!artifact.ok) return;
    const path = join(directory, "bundle.json");
    assert.equal(
      (await exportArtifactBundle(source, [artifact.value.id], path)).ok,
      true,
    );
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.manifest.entries[0].body =
      Buffer.from("tampered").toString("base64");
    await writeFile(path, JSON.stringify(parsed), "utf8");

    const target = createInMemoryArtifactStore();
    const imported = await importArtifactBundle(target, path);
    assert.equal(imported.ok, false);
    const listed = await target.list();
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.value.artifacts.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
