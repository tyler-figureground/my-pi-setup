import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createReviewGitAdapter } from "./src/review/git.ts";
import { createDisposableTestEvidence } from "./src/review/test-evidence.ts";

const execFileAsync = promisify(execFile);

test("native tests run against disposable text and binary content without exposing parent dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-tests-"));
  try {
    const git = (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node test.cjs" } }),
    );
    await writeFile(
      path.join(root, "test.cjs"),
      "const fs=require('fs');if(fs.readFileSync('value.txt','utf8')!=='changed\\n')process.exit(2);if(fs.readFileSync('value.bin')[1]!==2)process.exit(3);fs.writeFileSync('snapshot-ran.txt','yes')",
    );
    await writeFile(path.join(root, "value.txt"), "base\n");
    await writeFile(path.join(root, "value.bin"), Buffer.from([0, 1]));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(
      path.join(root, "node_modules", "sentinel.txt"),
      "survives",
    );
    await git("add", "package.json", "test.cjs", "value.txt", "value.bin");
    await git("commit", "-m", "base");
    await writeFile(path.join(root, "value.txt"), "changed\n");
    await writeFile(path.join(root, "value.bin"), Buffer.from([0, 2]));

    const capture = await createReviewGitAdapter({
      root,
      projectId: "git:test-evidence",
    }).capture({ kind: "uncommitted" }, { allowStaleBase: false });
    const evidence = await createDisposableTestEvidence(root).collect(capture);

    assert.equal(evidence.id, "tests:native");
    assert.equal(evidence.status, "available");
    assert.match(evidence.summary, /passed/i, JSON.stringify(evidence));
    assert.equal(
      await readFile(path.join(root, "node_modules", "sentinel.txt"), "utf8"),
      "survives",
    );
    await assert.rejects(
      () => readFile(path.join(root, "snapshot-ran.txt")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
