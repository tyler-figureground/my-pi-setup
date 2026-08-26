import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createReviewGitAdapter } from "./src/review/git.ts";
import { createLocalReview, type ReviewCapture } from "./src/review/index.ts";

const execFileAsync = promisify(execFile);

const capture: ReviewCapture = {
  requested: { kind: "uncommitted" },
  resolved: {
    kind: "uncommitted",
    head: "a".repeat(40),
    targetId: "snapshot:one",
  },
  projectId: "git:fixture",
  root: "C:\\fixture",
  diff: "diff --git a/src/value.ts b/src/value.ts\n+export const value = missing;\n",
  files: [
    {
      path: "src/value.ts",
      baseLineCount: 0,
      targetLineCount: 1,
      changed: [{ side: "target", startLine: 1, endLine: 1 }],
    },
  ],
  sourceFingerprint: "source:one",
  freshness: { kind: "not-applicable" },
  capturedAt: 10,
};

test("successful empty reviewer output is no-findings and persists a full artifact", async () => {
  const artifacts = createInMemoryArtifactStore();
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts,
    git: {
      capture: async () => capture,
      fingerprint: async () => capture.sourceFingerprint,
    },
    reviewer: {
      review: async () => ({ candidates: [], rawOutput: '{"findings":[]}' }),
    },
    clock: () => 20,
    id: () => "review-one",
  });

  const result = await review.run({ kind: "uncommitted" }, {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.conclusion, "no-findings");
  assert.deepEqual(result.value.findings, []);
  assert.equal(result.value.artifact.mediaType, "application/json");

  const stored = await artifacts.get(result.value.artifact.id);
  assert.equal(stored.ok, true);
  if (!stored.ok) return;
  const body = JSON.parse(new TextDecoder().decode(stored.value.body));
  assert.equal(body.runId, "review-one");
  assert.equal(body.status, "result");
  assert.equal(body.conclusion, "no-findings");
  assert.equal(body.capture.resolved.targetId, "snapshot:one");
});

test("validated overlapping findings merge deterministically", async () => {
  const artifacts = createInMemoryArtifactStore();
  const candidate = {
    severity: "medium",
    confidence: "medium",
    category: "correctness",
    file: "src/value.ts",
    range: { side: "target", startLine: 1, endLine: 1 },
    summary: "Missing identifier can throw",
    failureScenario: "Importing this module evaluates an undefined identifier.",
    evidence: ["git:diff"],
  };
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts,
    git: {
      capture: async () => capture,
      fingerprint: async () => capture.sourceFingerprint,
    },
    reviewer: {
      review: async () => ({
        candidates: [
          candidate,
          {
            ...candidate,
            severity: "high",
            confidence: "high",
            summary: "Undefined identifier fails module load",
            evidence: ["git:diff"],
          },
        ],
        rawOutput: "two candidates",
      }),
    },
    id: () => "review-findings",
  });

  const result = await review.run({ kind: "uncommitted" }, {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.conclusion, "findings");
  assert.equal(result.value.findings.length, 1);
  assert.equal(result.value.findings[0]?.severity, "high");
  assert.equal(result.value.findings[0]?.confidence, "high");
  assert.deepEqual(result.value.findings[0]?.evidence, ["git:diff"]);
  assert.match(result.value.findings[0]?.id ?? "", /^[a-f0-9]{64}$/);
});

test("a finding for a path outside the captured diff is rejected, not no-findings", async () => {
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts: createInMemoryArtifactStore(),
    git: {
      capture: async () => capture,
      fingerprint: async () => capture.sourceFingerprint,
    },
    reviewer: {
      review: async () => ({
        candidates: [
          {
            severity: "high",
            confidence: "high",
            category: "security",
            file: "../secret.txt",
            range: { side: "target", startLine: 1, endLine: 1 },
            summary: "False path",
            failureScenario: "This path was not reviewed.",
            evidence: ["invented"],
          },
        ],
        rawOutput: "invalid",
      }),
    },
  });

  const result = await review.run({ kind: "uncommitted" }, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "invalid_findings");
});

test("false lines and invented evidence are rejected by host validation", async () => {
  for (const patch of [
    { range: { side: "target", startLine: 2, endLine: 2 } },
    { evidence: ["tests:invented"] },
  ]) {
    const review = createLocalReview({
      projectId: capture.projectId,
      artifacts: createInMemoryArtifactStore(),
      git: {
        capture: async () => capture,
        fingerprint: async () => capture.sourceFingerprint,
      },
      reviewer: {
        review: async () => ({
          candidates: [
            {
              severity: "high",
              confidence: "high",
              category: "correctness",
              file: "src/value.ts",
              range: { side: "target", startLine: 1, endLine: 1 },
              summary: "Invalid candidate",
              failureScenario: "This candidate is not grounded.",
              evidence: ["git:diff"],
              ...patch,
            },
          ],
          rawOutput: "invalid",
        }),
      },
    });
    const result = await review.run({ kind: "uncommitted" }, {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "invalid_findings");
  }
});

test("optional independent reviewer candidates pass through the same validation and dedup", async () => {
  const baseCandidate = {
    severity: "medium",
    confidence: "medium",
    category: "reliability",
    file: "src/value.ts",
    range: { side: "target", startLine: 1, endLine: 1 },
    summary: "Missing value",
    failureScenario:
      "Reading the exported value fails during module evaluation.",
    evidence: ["git:diff"],
  };
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts: createInMemoryArtifactStore(),
    git: {
      capture: async () => capture,
      fingerprint: async () => capture.sourceFingerprint,
    },
    reviewer: {
      review: async () => ({
        candidates: [baseCandidate],
        rawOutput: "primary",
      }),
    },
    secondReviewer: {
      review: async () => ({
        candidates: [
          { ...baseCandidate, severity: "high", evidence: ["git:diff"] },
        ],
        rawOutput: "second",
      }),
    },
  });

  const result = await review.run(
    { kind: "uncommitted" },
    { secondPass: "independent" },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.findings.length, 1);
  assert.equal(result.value.findings[0]?.severity, "high");
  assert.deepEqual(result.value.findings[0]?.evidence, ["git:diff"]);
});

test("real uncommitted capture includes tracked and untracked changes without mutating source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-git-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(path.join(root, "tracked.ts"), "export const value = 1;\n");
    await git("add", "tracked.ts");
    await git("commit", "-m", "base");
    await writeFile(
      path.join(root, "tracked.ts"),
      "export const value = missing;\n",
    );
    await writeFile(
      path.join(root, "new.ts"),
      "export const other = unknownName;\n",
    );

    const adapter = createReviewGitAdapter({
      root,
      projectId: "git:fixture",
    });
    const beforeTracked = await readFile(path.join(root, "tracked.ts"), "utf8");
    const beforeNew = await readFile(path.join(root, "new.ts"), "utf8");
    const captured = await adapter.capture(
      { kind: "uncommitted" },
      { allowStaleBase: false },
    );

    assert.deepEqual(captured.files.map((file) => file.path).sort(), [
      "new.ts",
      "tracked.ts",
    ]);
    assert.match(captured.diff, /tracked\.ts/);
    assert.match(captured.diff, /new\.ts/);
    assert.equal(await adapter.fingerprint(), captured.sourceFingerprint);
    assert.equal(
      await readFile(path.join(root, "tracked.ts"), "utf8"),
      beforeTracked,
    );
    assert.equal(await readFile(path.join(root, "new.ts"), "utf8"), beforeNew);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core.autocrlf worktree bytes do not create false review changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-autocrlf-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await git("config", "core.autocrlf", "yes");
    const configPath = path.join(root, ".git", "config");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(/autocrlf\s*=\s*yes/i, "autocrlf"),
    );
    await writeFile(path.join(root, "normalized.txt"), "one\r\ntwo\r\n");
    await writeFile(path.join(root, "changed.txt"), "base\r\n");
    await git("add", "normalized.txt", "changed.txt");
    await git("commit", "-m", "base");
    await writeFile(path.join(root, "changed.txt"), "changed\r\n");

    const captured = await createReviewGitAdapter({
      root,
      projectId: "git:autocrlf",
    }).capture({ kind: "uncommitted" }, { allowStaleBase: false });

    assert.deepEqual(
      captured.files.map(({ path: file }) => file),
      ["changed.txt"],
    );
    assert.doesNotMatch(captured.diff, /normalized\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty committed repositories capture an empty uncommitted target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-empty-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await git("commit", "--allow-empty", "-m", "empty");

    const captured = await createReviewGitAdapter({
      root,
      projectId: "git:empty",
    }).capture({ kind: "uncommitted" }, { allowStaleBase: false });

    assert.deepEqual(captured.files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged tracked files larger than capture limits do not block a tiny review", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-large-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(
      path.join(root, "large.bin"),
      Buffer.alloc(3 * 1024 * 1024, 7),
    );
    await writeFile(path.join(root, "small.txt"), "base\n");
    await git("add", "large.bin", "small.txt");
    await git("commit", "-m", "base");
    await writeFile(path.join(root, "small.txt"), "changed\n");
    const captured = await createReviewGitAdapter({
      root,
      projectId: "git:large",
    }).capture({ kind: "uncommitted" }, { allowStaleBase: false });
    assert.deepEqual(
      captured.files.map(({ path: file }) => file),
      ["small.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uncommitted capture never executes repository-configured clean filters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-filter-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    const marker = path.join(root, "filter-ran.txt");
    const script = path.join(root, "evil-filter.cjs");
    await writeFile(
      script,
      `const fs=require('fs');let body='';process.stdin.on('data',c=>body+=c).on('end',()=>{fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(body)})`,
    );
    await writeFile(path.join(root, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(path.join(root, "value.txt"), "base\n");
    await git(
      "config",
      "filter.evil.clean",
      `\"${process.execPath}\" \"${script}\"`,
    );
    await git("add", ".gitattributes", "value.txt");
    await git("commit", "-m", "base");
    await rm(marker, { force: true });
    await writeFile(path.join(root, "value.txt"), "changed\n");

    const adapter = createReviewGitAdapter({ root, projectId: "git:filter" });
    const captured = await adapter.capture(
      { kind: "uncommitted" },
      { allowStaleBase: false },
    );
    assert.match(captured.diff, /changed/);
    await assert.rejects(() => readFile(marker), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uncommitted capture preserves staged changes even when worktree content reverts them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-mm-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    const file = path.join(root, "value.ts");
    await writeFile(file, "export const value = 1;\n");
    await git("add", "value.ts");
    await git("commit", "-m", "base");
    await writeFile(file, "export const value = missing;\n");
    await git("add", "value.ts");
    await writeFile(file, "export const value = 1;\n");

    const adapter = createReviewGitAdapter({ root, projectId: "git:mm" });
    const captured = await adapter.capture(
      { kind: "uncommitted" },
      { allowStaleBase: false },
    );
    assert.match(captured.diff, /STAGED CHANGES/);
    assert.match(captured.diff, /missing/);
    assert.match(captured.diff, /UNSTAGED CHANGES/);
    assert.equal(captured.files[0]?.path, "value.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleted tracked files remain capturable with base-side changed ranges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-delete-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(path.join(root, "deleted.ts"), "line one\nline two\n");
    await git("add", "deleted.ts");
    await git("commit", "-m", "base");
    await rm(path.join(root, "deleted.ts"));

    const adapter = createReviewGitAdapter({ root, projectId: "git:delete" });
    const captured = await adapter.capture(
      { kind: "uncommitted" },
      { allowStaleBase: false },
    );
    assert.equal(captured.files[0]?.path, "deleted.ts");
    assert.equal(captured.files[0]?.baseLineCount, 2);
    assert.equal(captured.files[0]?.targetLineCount, 2);
    assert.equal(captured.files[0]?.indexLineCount, 2);
    assert.equal(captured.files[0]?.worktreeLineCount, 0);
    assert.deepEqual(captured.files[0]?.changed, [
      { side: "index", startLine: 1, endLine: 2 },
    ]);
    const review = createLocalReview({
      projectId: "git:delete",
      artifacts: createInMemoryArtifactStore(),
      git: adapter,
      reviewer: {
        review: async () => ({
          candidates: [
            {
              severity: "high",
              confidence: "high",
              category: "correctness",
              file: "deleted.ts",
              range: { side: "worktree", startLine: 2, endLine: 2 },
              summary: "Nonexistent target line",
              failureScenario:
                "This line does not exist in the worktree layer.",
              evidence: ["git:diff"],
            },
          ],
          rawOutput: "invalid line",
        }),
      },
    });
    const invalid = await review.run({ kind: "uncommitted" }, {});
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "invalid_findings");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit and custom-range targets resolve moving revisions to exact object ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-targets-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(path.join(root, "value.ts"), "export const value = 1;\n");
    await writeFile(
      path.join(root, "value.bin"),
      Buffer.from([255, 254, 129, 66, 10]),
    );
    await git("add", "value.ts", "value.bin");
    await git("commit", "-m", "first");
    const first = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(root, "value.ts"), "export const value = 2;\n");
    await git("commit", "-am", "second");
    const second = (await git("rev-parse", "HEAD")).stdout.trim();
    const adapter = createReviewGitAdapter({ root, projectId: "git:targets" });

    const commit = await adapter.capture(
      { kind: "commit", revision: first.slice(0, 12) },
      { allowStaleBase: false },
    );
    assert.equal(commit.resolved.to, first);
    assert.match(commit.diff, /value\.ts/);
    assert.deepEqual(
      Buffer.from(
        commit.files.find(({ path: file }) => file === "value.bin")?.content
          ?.targetBase64 ?? "",
        "base64",
      ),
      Buffer.from([255, 254, 129, 66, 10]),
    );

    const range = await adapter.capture(
      { kind: "range", from: first.slice(0, 12), to: "HEAD" },
      { allowStaleBase: false },
    );
    assert.equal(range.resolved.from, first);
    assert.equal(range.resolved.to, second);
    assert.equal(range.resolved.targetId, `${first}..${second}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base capture fetches before assessment and reports explicit ahead/behind state", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-review-base-"));
  const bare = path.join(parent, "remote.git");
  const seed = path.join(parent, "seed");
  const root = path.join(parent, "review");
  const run = async (cwd: string, ...args: string[]) =>
    execFileAsync("git", args, { cwd, encoding: "utf8" });
  try {
    await execFileAsync("git", ["init", "--bare", bare]);
    await execFileAsync("git", ["clone", bare, seed]);
    await run(seed, "config", "user.email", "fixture@example.invalid");
    await run(seed, "config", "user.name", "Fixture");
    await writeFile(path.join(seed, "value.ts"), "export const value = 1;\n");
    await run(seed, "add", "value.ts");
    await run(seed, "commit", "-m", "base");
    await run(seed, "branch", "-M", "main");
    await run(seed, "push", "-u", "origin", "main");
    await execFileAsync("git", [
      "--git-dir",
      bare,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    await execFileAsync("git", ["clone", bare, root]);
    await run(root, "config", "user.email", "fixture@example.invalid");
    await run(root, "config", "user.name", "Fixture");
    await writeFile(path.join(root, "value.ts"), "export const value = 2;\n");
    await run(root, "add", "value.ts");
    await run(root, "commit", "-m", "local change");
    const uploadMarker = path.join(parent, "upload-pack-ran.txt");
    const uploadScript = path.join(parent, "evil-upload.cjs");
    await writeFile(
      uploadScript,
      `require('fs').writeFileSync(${JSON.stringify(uploadMarker)}, 'ran')`,
    );
    await run(
      root,
      "config",
      "remote.origin.uploadpack",
      `\"${process.execPath}\" \"${uploadScript}\"`,
    );
    await writeFile(
      path.join(seed, "remote.ts"),
      "export const remote = true;\n",
    );
    await run(seed, "add", "remote.ts");
    await run(seed, "commit", "-m", "remote change");
    await run(seed, "push", "origin", "main");

    const adapter = createReviewGitAdapter({ root, projectId: "git:base" });
    const captured = await adapter.capture(
      { kind: "base", remote: "origin", branch: "main" },
      { allowStaleBase: false },
    );
    assert.deepEqual(captured.freshness, {
      kind: "fresh",
      ahead: 1,
      behind: 1,
    });
    assert.equal(captured.resolved.kind, "base");
    assert.match(captured.diff, /value\.ts/);
    assert.doesNotMatch(captured.diff, /remote\.ts/);
    const remoteHead = (
      await run(root, "rev-parse", "origin/main")
    ).stdout.trim();
    const seedHead = (await run(seed, "rev-parse", "HEAD")).stdout.trim();
    assert.equal(remoteHead, seedHead);
    await assert.rejects(() => readFile(uploadMarker), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("moving HEAD during review is detected even when file bytes stay identical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-review-head-"));
  try {
    const git = async (...args: string[]) =>
      execFileAsync("git", args, { cwd: root, encoding: "utf8" });
    await git("init");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(path.join(root, "value.txt"), "same\n");
    await git("add", "value.txt");
    await git("commit", "-m", "first");
    await git("commit", "--allow-empty", "-m", "second");
    const adapter = createReviewGitAdapter({ root, projectId: "git:head" });
    const review = createLocalReview({
      projectId: "git:head",
      artifacts: createInMemoryArtifactStore(),
      git: adapter,
      reviewer: {
        review: async () => {
          await git("reset", "--soft", "HEAD^");
          return { candidates: [], rawOutput: '{"findings":[]}' };
        },
      },
    });
    const result = await review.run({ kind: "uncommitted" }, {});
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.error.code, "source_changed_during_review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source mutation during artifact persistence cannot return review success", async () => {
  let fingerprint = capture.sourceFingerprint;
  const backing = createInMemoryArtifactStore();
  const artifacts = {
    ...backing,
    async put(input: Parameters<typeof backing.put>[0]) {
      const stored = await backing.put(input);
      fingerprint = "changed-during-persistence";
      return stored;
    },
  };
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts,
    git: {
      capture: async () => capture,
      fingerprint: async () => fingerprint,
    },
    reviewer: {
      review: async () => ({ candidates: [], rawOutput: '{"findings":[]}' }),
    },
  });
  const result = await review.run({ kind: "uncommitted" }, {});
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.error.code, "source_changed_during_review");
});

test("source mutation during reviewer execution fails instead of publishing findings", async () => {
  let fingerprint = capture.sourceFingerprint;
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts: createInMemoryArtifactStore(),
    git: {
      capture: async () => capture,
      fingerprint: async () => fingerprint,
    },
    reviewer: {
      review: async () => {
        fingerprint = "changed";
        return { candidates: [], rawOutput: '{"findings":[]}' };
      },
    },
  });
  const result = await review.run({ kind: "uncommitted" }, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "source_changed_during_review");
});

test("post-review cancellation returns a cancelled Outcome and artifact instead of rejecting", async () => {
  const controller = new AbortController();
  let fingerprintCalls = 0;
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts: createInMemoryArtifactStore(),
    git: {
      capture: async () => capture,
      fingerprint: async () => {
        fingerprintCalls++;
        controller.abort(new Error("cancel"));
        throw controller.signal.reason;
      },
    },
    reviewer: {
      review: async () => ({ candidates: [], rawOutput: '{"findings":[]}' }),
    },
  });
  const result = await review.run(
    { kind: "uncommitted" },
    { signal: controller.signal },
  );
  assert.equal(fingerprintCalls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cancelled");
    assert.equal(typeof result.error.details?.artifactId, "string");
  }
});

test("reviewer failure is distinct from no-findings and persists failure after capture", async () => {
  const artifacts = createInMemoryArtifactStore();
  const review = createLocalReview({
    projectId: capture.projectId,
    artifacts,
    git: {
      capture: async () => capture,
      fingerprint: async () => capture.sourceFingerprint,
    },
    reviewer: {
      review: async () => {
        throw new Error("review backend unavailable");
      },
    },
    clock: () => 20,
    id: () => "review-failed",
  });

  const result = await review.run({ kind: "uncommitted" }, {});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "reviewer_failed");
  assert.match(result.error.message, /backend unavailable/);
});
