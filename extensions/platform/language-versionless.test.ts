import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import {
  createFixtureLanguageServerAdapter,
  createLanguageIntelligence,
} from "./src/language/index.ts";

test("changed and reopened documents reject unversioned diagnostics for path and aggregate queries", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pi-language-versionless-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    fixture: {
      capabilities: {},
      onNotification({ method, params, publish }) {
        if (method !== "textDocument/didOpen") return;
        publish("textDocument/publishDiagnostics", {
          uri: (params as any).textDocument.uri,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              severity: 1,
              message: "unversioned",
            },
          ],
        });
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:versionless",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "fixture",
        command: { executable: "fixture" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics"],
      },
    ],
  });
  try {
    await language.synchronize([
      { kind: "open", path: "value.ts", text: "bad" },
      { kind: "change", path: "value.ts", text: "good" },
    ]);
    const targeted = await language.query({
      kind: "diagnostics",
      path: "value.ts",
    });
    const aggregate = await language.query({ kind: "diagnostics" });
    assert.equal(targeted.ok, false);
    assert.equal(aggregate.ok, false);
    if (!targeted.ok)
      assert.equal(targeted.error.code, "unsupported_capability");
    if (!aggregate.ok)
      assert.equal(aggregate.error.code, "unsupported_capability");

    await language.synchronize([{ kind: "close", path: "value.ts" }]);
    await language.synchronize([
      { kind: "open", path: "value.ts", text: "new generation" },
    ]);
    const reopened = await language.query({
      kind: "diagnostics",
      path: "value.ts",
    });
    assert.equal(reopened.ok, false);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});
