import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStateStore } from "./src/core/persistence/index.ts";
import { createStateStorePublicationRepository } from "./src/artifacts/state-repository.ts";
import type { StoredPublication } from "./src/artifacts/index.ts";

const record: StoredPublication = {
  revision: 0,
  ownerId: "test-owner",
  adapterId: "local-loopback",
  providerReference: "provider-1",
  publication: {
    handle: "publication-1",
    sourceArtifactId: "a".repeat(64),
    outboundArtifactId: "b".repeat(64),
    target: "local",
    access: "private",
    interactive: false,
    live: false,
    state: "pending",
    createdAt: 1,
    expiresAt: 100,
    observedAt: 1,
    sensitivity: {
      verdict: "clear",
      scannerVersion: "phase-9-v1",
      digest: "c".repeat(64),
      findings: [],
    },
  },
};

test("StateStore publication repository persists bounded metadata without share capabilities", async () => {
  const state = createMemoryStateStore({ now: () => 1 });
  const repository = createStateStorePublicationRepository(
    state,
    "git:project",
  );
  const created = await repository.create(record);
  assert.equal(created.ok, true);
  const duplicate = await repository.create(record);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "publication_conflict");

  const page = await repository.list();
  assert.equal(page.ok, true);
  if (page.ok) assert.equal(page.value.length, 1);

  const loaded = await repository.get(record.publication.handle);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.value, { ...record, revision: 1 });

  const active: StoredPublication = {
    ...loaded.value,
    publication: {
      ...loaded.value.publication,
      state: "active",
      observedAt: 2,
    },
  };
  const updated = await repository.update(active);
  assert.equal(updated.ok, true);
  const stale = await repository.update({
    ...loaded.value,
    publication: {
      ...loaded.value.publication,
      state: "unknown",
      observedAt: 3,
    },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "persistence_error");
  assert.equal(
    JSON.stringify(await state.export({ format: "snapshot" })).includes(
      "shareUrl",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(await state.export({ format: "snapshot" })).includes(
      "capability",
    ),
    false,
  );
});
