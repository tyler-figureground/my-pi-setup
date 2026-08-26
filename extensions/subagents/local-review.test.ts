import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewCapture } from "../platform/src/review/index.ts";
import { createManagedLocalReviewer } from "./src/local-review.ts";

const capture: ReviewCapture = {
  requested: { kind: "uncommitted" },
  resolved: {
    kind: "uncommitted",
    head: "a".repeat(40),
    targetId: "snapshot:one",
  },
  projectId: "git:fixture",
  root: "C:\\fixture",
  diff: "diff --git a/value.ts b/value.ts\n+const value = missing;\n",
  files: [
    {
      path: "value.ts",
      baseLineCount: 0,
      targetLineCount: 1,
      changed: [{ side: "target", startLine: 1, endLine: 1 }],
    },
  ],
  sourceFingerprint: "fingerprint",
  freshness: { kind: "not-applicable" },
  capturedAt: 1,
};

test("managed local reviewer spawns a tool-free review role and parses strict findings", async () => {
  let observed:
    | Parameters<Parameters<typeof createManagedLocalReviewer>[0]["run"]>[0]
    | undefined;
  const reviewer = createManagedLocalReviewer({
    parent: () => ({
      parentCwd: capture.root,
      projectTrusted: true,
      inheritedThinkingLevel: "high",
    }),
    run: async (task) => {
      observed = task;
      return {
        finalText: JSON.stringify({
          findings: [
            {
              severity: "high",
              confidence: "high",
              category: "correctness",
              file: "value.ts",
              range: { side: "target", startLine: 1, endLine: 1 },
              summary: "Undefined identifier",
              failureScenario: "Module evaluation reads a missing identifier.",
              evidence: ["diff"],
            },
          ],
        }),
      };
    },
  });

  const output = await reviewer.review({
    runId: "review-one",
    capture,
    evidence: [],
    pass: "primary",
  });
  assert.equal(output.candidates.length, 1);
  assert.equal(observed?.execution?.role, "review");
  assert.deepEqual(observed?.execution?.tools.allowed, []);
  assert.equal(observed?.execution?.workspace, "current");
  assert.deepEqual(observed?.execution?.resources, {
    project: false,
    contextFiles: false,
  });
  assert.match(observed?.prompt ?? "", /untrusted source data/i);
  assert.match(observed?.prompt ?? "", /diff --git/);
});

test("managed local reviewer bounds large diffs and strips full bodies from manifest", async () => {
  let prompt = "";
  const largeCapture: ReviewCapture = {
    ...capture,
    diff: "d".repeat(512 * 1024),
    files: [
      {
        ...capture.files[0]!,
        content: {
          base: "b".repeat(100 * 1024),
          index: "i".repeat(100 * 1024),
          worktree: "w".repeat(100 * 1024),
        },
      },
    ],
  };
  const reviewer = createManagedLocalReviewer({
    parent: () => ({
      parentCwd: capture.root,
      projectTrusted: true,
      inheritedThinkingLevel: "high",
    }),
    run: async (task) => {
      prompt = task.prompt;
      return { finalText: '{"findings":[]}' };
    },
  });
  await reviewer.review({
    runId: "large",
    capture: largeCapture,
    evidence: [],
    pass: "primary",
  });
  assert.equal(Buffer.byteLength(prompt) <= 256 * 1024, true);
  assert.match(prompt, /DIFF TRUNCATED/);
  assert.doesNotMatch(prompt, /b{100000}/);
});

test("managed local reviewer rejects prose and oversized output", async () => {
  const make = (finalText: string) =>
    createManagedLocalReviewer({
      parent: () => ({
        parentCwd: capture.root,
        projectTrusted: true,
        inheritedThinkingLevel: "high",
      }),
      run: async () => ({ finalText }),
    });
  await assert.rejects(
    () =>
      make("Looks good").review({
        runId: "bad",
        capture,
        evidence: [],
        pass: "primary",
      }),
    /strict JSON/i,
  );
  await assert.rejects(
    () =>
      make("x".repeat(1024 * 1024 + 1)).review({
        runId: "huge",
        capture,
        evidence: [],
        pass: "primary",
      }),
    /exceeded/i,
  );
});
