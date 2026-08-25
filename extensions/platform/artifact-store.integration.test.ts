import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileSystemArtifactStore } from "./src/core/artifacts/index.ts";
import { withStoreLock } from "./src/core/artifacts/persistence.ts";

const HELLO_SHA256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

/** junction on Windows, plain symlink elsewhere; matches fixture convention below. */
function directoryLinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function assertPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(settled, false);
}

/** A pid guaranteed dead: spawn a helper process and wait for it to exit. */
async function spawnDeadPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new Error("Failed to spawn helper process for a dead pid");
  }
  await new Promise((resolveExit) =>
    child.once("exit", () => resolveExit(undefined)),
  );
  return pid;
}

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

test("filesystem adapter re-validates its layout on get/export and rejects a junction swapped in after put", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-junction-read-"));
  const root = join(directory, "store");
  const external = join(directory, "external");
  const output = join(directory, "output");
  const bodies = join(root, "bodies");
  await mkdir(external, { recursive: true });
  await mkdir(output, { recursive: true });
  const store = createFileSystemArtifactStore({ root });
  try {
    const put = await store.put({ body: "must-not-leak" });
    assert.equal(put.ok, true);
    if (!put.ok) return;

    // Swap the private bodies directory for a junction after a successful
    // put: get/export must re-validate the layout every call, not just once.
    await rm(bodies, { recursive: true, force: true });
    await symlink(external, bodies, directoryLinkType());

    const get = await store.get(put.value.id);
    assert.equal(get.ok, false);
    if (!get.ok) assert.equal(get.error.code, "io_error");

    const exported = await store.export(put.value.id, { directory: output });
    assert.equal(exported.ok, false);
    if (!exported.ok) assert.equal(exported.error.code, "io_error");

    assert.deepEqual(await readdir(external), []);
  } finally {
    await unlink(bodies).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem export rejects private store destinations without poisoning locks", async () => {
  const { root, store, cleanup } = await temporaryStore();
  try {
    const put = await store.put({ body: "safe", filename: "safe.txt" });
    assert.equal(put.ok, true);
    if (!put.ok) return;

    for (const privateDirectory of [
      join(root, ".artifact-store.lock"),
      join(root, ".artifact-store.reclamation"),
      join(root, "bodies", "nested"),
    ]) {
      const exported = await store.export(put.value.id, {
        directory: privateDirectory,
      });
      assert.equal(exported.ok, false);
      if (!exported.ok) assert.equal(exported.error.code, "invalid_input");
    }

    const read = await store.get(put.value.id);
    assert.equal(read.ok, true);
    await assert.rejects(lstat(join(root, ".artifact-store.lock")), {
      code: "ENOENT",
    });
    await assert.rejects(lstat(join(root, ".artifact-store.reclamation")), {
      code: "ENOENT",
    });
  } finally {
    await cleanup();
  }
});

test("filesystem operations validate and access the layout under the store lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-layout-lock-"));
  const root = join(directory, "store");
  const external = join(directory, "external");
  const output = join(directory, "output");
  const bodies = join(root, "bodies");
  await mkdir(external, { recursive: true });
  await mkdir(output, { recursive: true });
  const store = createFileSystemArtifactStore({ root });
  const put = await store.put({ body: "must-not-leak", filename: "safe.txt" });
  assert.equal(put.ok, true);
  if (!put.ok) return;

  const holderEntered = deferred();
  const releaseHolder = deferred();
  const holder = withStoreLock(root, async () => {
    holderEntered.resolve();
    await releaseHolder.promise;
  });

  try {
    await holderEntered.promise;
    const get = store.get(put.value.id);
    const exported = store.export(put.value.id, { directory: output });
    await Promise.all([assertPending(get), assertPending(exported)]);

    await rm(bodies, { recursive: true, force: true });
    await symlink(external, bodies, directoryLinkType());
    releaseHolder.resolve();

    const [getResult, exportResult] = await Promise.all([get, exported]);
    assert.equal(getResult.ok, false);
    if (!getResult.ok) assert.equal(getResult.error.code, "io_error");
    assert.equal(exportResult.ok, false);
    if (!exportResult.ok) assert.equal(exportResult.error.code, "io_error");
    assert.deepEqual(await readdir(external), []);
    assert.deepEqual(await readdir(output), []);
  } finally {
    releaseHolder.resolve();
    await holder;
    await unlink(bodies).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem put validates the layout after entering the store lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-put-lock-"));
  const root = join(directory, "store");
  const external = join(directory, "external");
  const bodies = join(root, "bodies");
  await mkdir(external, { recursive: true });
  const store = createFileSystemArtifactStore({ root });
  const initialized = await store.put({ body: "initial" });
  assert.equal(initialized.ok, true);

  const holderEntered = deferred();
  const releaseHolder = deferred();
  const holder = withStoreLock(root, async () => {
    holderEntered.resolve();
    await releaseHolder.promise;
  });

  try {
    await holderEntered.promise;
    const put = store.put({ body: "must-not-leak" });
    await assertPending(put);

    await rm(bodies, { recursive: true, force: true });
    await symlink(external, bodies, directoryLinkType());
    releaseHolder.resolve();

    const result = await put;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "io_error");
    assert.deepEqual(await readdir(external), []);
  } finally {
    releaseHolder.resolve();
    await holder;
    await unlink(bodies).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem collect validates the layout after entering the store lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-collect-lock-"));
  const root = join(directory, "store");
  const external = join(directory, "external");
  const bodies = join(root, "bodies");
  await mkdir(external, { recursive: true });
  let now = 1;
  const store = createFileSystemArtifactStore({ root, clock: () => now });
  const put = await store.put({ body: "expired", expiresAt: 10 });
  assert.equal(put.ok, true);
  if (!put.ok) return;
  now = 10;

  const holderEntered = deferred();
  const releaseHolder = deferred();
  const holder = withStoreLock(root, async () => {
    holderEntered.resolve();
    await releaseHolder.promise;
  });

  try {
    await holderEntered.promise;
    const collected = store.collect();
    await assertPending(collected);

    await rm(bodies, { recursive: true, force: true });
    await symlink(external, bodies, directoryLinkType());
    releaseHolder.resolve();

    const result = await collected;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "io_error");
    await stat(join(root, "metadata", `${put.value.id}.json`));
    assert.deepEqual(await readdir(external), []);
  } finally {
    releaseHolder.resolve();
    await holder;
    await unlink(bodies).catch(() => {});
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

test("filesystem collect propagates a shrunk maxArtifactBytes limit instead of deleting the artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-shrink-"));
  try {
    const generous = createFileSystemArtifactStore({ root, clock: () => 1 });
    const body = "x".repeat(64);
    const put = await generous.put({ body });
    assert.equal(put.ok, true);
    if (!put.ok) return;

    const shrunk = createFileSystemArtifactStore({
      root,
      clock: () => 1,
      limits: { maxArtifactBytes: 16 },
    });
    const collected = await shrunk.collect();
    assert.equal(collected.ok, false);
    if (!collected.ok) {
      assert.equal(collected.error.code, "io_error");
      assert.equal(collected.error.retryable, true);
    }

    // Neither the metadata nor the body was deleted...
    await stat(join(root, "bodies", put.value.id));
    await stat(join(root, "metadata", `${put.value.id}.json`));
    // ...and a store with a sufficient limit still reads it back intact.
    const stillThere = await generous.get(put.value.id);
    assert.equal(stillThere.ok, true);
    if (stillThere.ok) {
      assert.equal(Buffer.from(stillThere.value.body).toString("utf8"), body);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem collect validates the whole pass before deleting an expired artifact that sorts before an oversized artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-shrink-mixed-"));
  try {
    let now = 1;
    const generous = createFileSystemArtifactStore({ root, clock: () => now });
    const expiring = await generous.put({ body: "b", expiresAt: 10 });
    const oversized = await generous.put({ body: "x".repeat(64) });
    assert.equal(expiring.ok, true);
    assert.equal(oversized.ok, true);
    if (!oversized.ok || !expiring.ok) return;
    assert.ok(expiring.value.id < oversized.value.id);
    now = 10;

    const shrunk = createFileSystemArtifactStore({
      root,
      clock: () => now,
      limits: { maxArtifactBytes: 16 },
    });
    const collected = await shrunk.collect();
    // The ambiguous (config-shrunk) artifact aborts the whole collection
    // pass rather than guessing at a partial result: nothing is removed,
    // not even the unrelated artifact that is genuinely expired.
    assert.equal(collected.ok, false);
    if (!collected.ok) {
      assert.equal(collected.error.code, "io_error");
      assert.equal(collected.error.retryable, true);
    }
    await stat(join(root, "bodies", oversized.value.id));
    await stat(join(root, "bodies", expiring.value.id));
    await stat(join(root, "metadata", `${expiring.value.id}.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem lock refuses to delete through a junction planted as owner.json inside its own lock directory", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-artifact-lock-owner-symlink-"),
  );
  const root = join(directory, "store");
  const secretDirectory = join(directory, "secret");
  const secretMarker = join(secretDirectory, "marker.txt");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(secretDirectory, { recursive: true });
  await writeFile(secretMarker, "do-not-delete", "utf8");

  const lockPath = join(root, ".artifact-store.lock");
  await mkdir(lockPath, { mode: 0o700 });
  // A plain file symlink needs elevated privilege on Windows; a directory
  // junction does not, and equally exercises "never follow a link planted
  // where owner.json should be" — readLockOwner rejects anything that
  // isn't a real, non-symlink file at that path.
  await symlink(
    secretDirectory,
    join(lockPath, "owner.json"),
    directoryLinkType(),
  );
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);

  try {
    const result = await withStoreLock(root, async () => "acquired");
    assert.equal(result, "acquired");
    // The stale lock was reclaimed: the owner.json junction was unlinked as
    // a leaf entry (never followed)...
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
    // ...and the external directory it pointed at survives untouched.
    assert.equal(await readFile(secretMarker, "utf8"), "do-not-delete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem lock never follows a symlinked/junctioned lock path and fails safe instead of deleting external content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-lock-symlink-"));
  const root = join(directory, "store");
  const external = join(directory, "external");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(external, { recursive: true });
  await writeFile(
    join(external, "owner.json"),
    JSON.stringify({ pid: 999999999, token: "not-ours" }),
    "utf8",
  );
  await writeFile(join(external, "do-not-delete.txt"), "important", "utf8");

  const lockPath = join(root, ".artifact-store.lock");
  await symlink(external, lockPath, directoryLinkType());

  try {
    await assert.rejects(
      withStoreLock(root, async () => "unreachable"),
      {
        code: "ELOCKTIMEOUT",
      },
    );
    assert.deepEqual((await readdir(external)).sort(), [
      "do-not-delete.txt",
      "owner.json",
    ]);
  } finally {
    await unlink(lockPath).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem lock reclaims a dead stale lock before admitting a fresh waiter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-lock-race-"));
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lockPath = join(root, ".artifact-store.lock");
    await mkdir(lockPath, { mode: 0o700 });
    const deadPid = await spawnDeadPid();
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: deadPid,
        token: "dead-owner",
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    const staleReclaimerEntered = deferred();
    const releaseStaleReclaimer = deferred();
    const staleReclaimer = withStoreLock(root, async () => {
      staleReclaimerEntered.resolve();
      await releaseStaleReclaimer.promise;
      return "stale-reclaimer";
    });
    await staleReclaimerEntered.promise;

    let freshWaiterEntered = false;
    const freshWaiter = withStoreLock(root, async () => {
      freshWaiterEntered = true;
      return "fresh-waiter";
    });
    await assertPending(freshWaiter);
    assert.equal(freshWaiterEntered, false);

    releaseStaleReclaimer.resolve();
    assert.deepEqual(await Promise.all([staleReclaimer, freshWaiter]), [
      "stale-reclaimer",
      "fresh-waiter",
    ]);
    assert.equal(freshWaiterEntered, true);
    // No lock leaked behind.
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem lock reclaims a stale empty reclamation guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-lock-stale-guard-"));
  const guardPath = join(root, ".artifact-store.reclamation");
  await mkdir(guardPath, { mode: 0o700 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(guardPath, stale, stale);

  try {
    assert.equal(await withStoreLock(root, async () => "acquired"), "acquired");
    await assert.rejects(lstat(guardPath), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem lock never reclaims a junctioned reclamation guard", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pi-artifact-lock-junction-guard-"),
  );
  const root = join(directory, "store");
  const external = join(directory, "external");
  const guardPath = join(root, ".artifact-store.reclamation");
  const markerPath = join(external, "do-not-delete.txt");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(external, { recursive: true });
  await writeFile(markerPath, "important", "utf8");
  await symlink(external, guardPath, directoryLinkType());

  try {
    await assert.rejects(
      withStoreLock(root, async () => "unreachable"),
      /reclamation guard is not a real directory/,
    );
    assert.equal((await lstat(guardPath)).isSymbolicLink(), true);
    assert.equal(await readFile(markerPath, "utf8"), "important");
    assert.deepEqual(await readdir(external), ["do-not-delete.txt"]);
  } finally {
    await unlink(guardPath).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem lock waits for the exclusive reclamation guard before entering", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-lock-guard-"));
  const guardPath = join(root, ".artifact-store.reclamation");
  await mkdir(guardPath, { mode: 0o700 });
  try {
    let entered = false;
    const waiter = withStoreLock(root, async () => {
      entered = true;
      return "acquired";
    });
    await assertPending(waiter);
    assert.equal(entered, false);

    await rmdir(guardPath);
    assert.equal(await waiter, "acquired");
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem lock release leaves a replacement lock untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-artifact-lock-release-"));
  const lockPath = join(root, ".artifact-store.lock");
  const displacedPath = join(root, ".artifact-store.displaced");
  try {
    await withStoreLock(root, async () => {
      await rename(lockPath, displacedPath);
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          token: "replacement-owner",
          createdAt: Date.now(),
        }),
        { mode: 0o600 },
      );
    });

    assert.equal(
      JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token,
      "replacement-owner",
    );
    await stat(displacedPath);
  } finally {
    await rm(root, { recursive: true, force: true });
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
