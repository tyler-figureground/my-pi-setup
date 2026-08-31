import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readArtifactImportFile } from "./src/artifacts/file-import.ts";

test("direct-user Artifact file import reads one bounded regular identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-import-"));
  try {
    const path = join(directory, "report.md");
    await writeFile(path, "# report", "utf8");
    const imported = await readArtifactImportFile(path);
    assert.equal(imported.filename, "report.md");
    assert.equal(imported.body.toString("utf8"), "# report");
    await assert.rejects(() => readArtifactImportFile(path, 1), /bounded/);

    const link = join(directory, "linked.md");
    try {
      await symlink(path, link, "file");
      await assert.rejects(() => readArtifactImportFile(link), /not a link/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
