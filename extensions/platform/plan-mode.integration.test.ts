import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFilesystemPlanPersistence } from "./src/plan/filesystem.ts";

const withTempDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-mode-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("filesystem plan persistence publishes atomically without overwrite or abort debris", async () => {
  await withTempDirectory(async (directory) => {
    const persistence = createFilesystemPlanPersistence();
    const destination = {
      scope: "user" as const,
      root: directory,
      path: join(directory, "plans", "auth-refactor.md"),
    };

    const written = await persistence.writeAtomic({
      destination,
      content: "# Approved plan\n",
    });
    assert.deepEqual(written, { ok: true });
    assert.equal(await readFile(destination.path, "utf8"), "# Approved plan\n");
    const read = await persistence.readVerified({
      destination,
      expectedHash: createHash("sha256")
        .update("# Approved plan\n")
        .digest("hex"),
      maxBytes: 128 * 1024,
    });
    assert.deepEqual(read, { ok: true, content: "# Approved plan\n" });
    const tampered = await persistence.readVerified({
      destination,
      expectedHash: "0".repeat(64),
      maxBytes: 128 * 1024,
    });
    assert.equal(tampered.ok, false);

    const collision = await persistence.writeAtomic({
      destination,
      content: "overwritten",
    });
    assert.equal(collision.ok, false);
    assert.equal(await readFile(destination.path, "utf8"), "# Approved plan\n");

    const controller = new AbortController();
    controller.abort();
    const abortedPath = join(directory, "plans", "aborted.md");
    const aborted = await persistence.writeAtomic({
      destination: { scope: "user", root: directory, path: abortedPath },
      content: "must not appear",
      signal: controller.signal,
    });
    assert.equal(aborted.ok, false);
    assert.deepEqual(await readdir(directory), ["plans"]);
    assert.deepEqual(await readdir(join(directory, "plans")), [
      "auth-refactor.md",
    ]);
  });
});

test("filesystem plan persistence rejects a plan directory junction outside configured root", async () => {
  await withTempDirectory(async (directory) => {
    const root = join(directory, "project");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "plans"), "junction");

    const result = await createFilesystemPlanPersistence().writeAtomic({
      destination: {
        scope: "project",
        root,
        path: join(root, "plans", "escaped.md"),
      },
      content: "must stay inside project",
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /(link|outside.*root)/i);
    assert.deepEqual(await readdir(outside), []);
  });
});
