import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageIntelligence } from "./src/language/index.ts";
import type { ReviewCapture } from "./src/review/index.ts";
import { createLanguageReviewEvidence } from "./src/review/language-evidence.ts";

const capture: ReviewCapture = {
  requested: { kind: "uncommitted" },
  resolved: { kind: "uncommitted", head: "a".repeat(40), targetId: "snapshot" },
  projectId: "git:fixture",
  root: "C:\\fixture",
  diff: "diff",
  files: [
    {
      path: "src/value.ts",
      baseLineCount: 1,
      targetLineCount: 1,
      content: {
        index: "const value = missing;\n",
        worktree: "const value = missing;\n",
      },
      changed: [{ side: "target", startLine: 1, endLine: 1 }],
    },
    {
      path: "README.md",
      baseLineCount: 1,
      targetLineCount: 1,
      changed: [{ side: "target", startLine: 1, endLine: 1 }],
    },
  ],
  sourceFingerprint: "fingerprint",
  freshness: { kind: "not-applicable" },
  capturedAt: 1,
};

test("review evidence synchronizes supported changed files and collects bounded advisory diagnostics", async () => {
  const updates: unknown[] = [];
  const queries: unknown[] = [];
  const language: LanguageIntelligence = {
    discover: async () => ({
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        servers: [
          {
            id: "typescript",
            languages: ["typescript"],
            extensions: [".ts"],
            queries: ["diagnostics"],
          },
        ],
      },
    }),
    synchronize: async (value) => {
      updates.push(...value);
      return {
        ok: true,
        value: {
          advisory: true,
          authority: "repository-native-checks",
          documents: [],
        },
      };
    },
    query: async (request) => {
      queries.push(request);
      return {
        ok: true,
        value: {
          advisory: true,
          authority: "repository-native-checks",
          kind: "diagnostics",
          serverIds: ["typescript"],
          items: [
            {
              type: "diagnostic",
              path: { kind: "project", path: "src/value.ts" },
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              severity: "error",
              message: "fixture",
            },
          ],
          truncated: false,
        },
      };
    },
  };
  const evidence = createLanguageReviewEvidence(language);
  const result = await evidence.collect(capture);

  assert.equal(result.source, "lsp");
  assert.equal(result.status, "available");
  assert.match(result.summary, /1 diagnostic/i);
  assert.equal(updates.length, 1);
  assert.equal((updates[0] as any).kind, "open");
  assert.equal(queries.length, 1);
});
