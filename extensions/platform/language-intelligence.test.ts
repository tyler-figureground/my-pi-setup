import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import {
  createFixtureLanguageServerAdapter,
  createLanguageIntelligence,
} from "./src/language/index.ts";

test("discover reports bounded routes without starting a language server", async () => {
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: { capabilities: {} },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:fixture",
      requestedCwd: "C:/fixture/project",
      canonicalCwd: "C:/fixture/project",
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics", "documentSymbols"],
      },
    ],
  });

  const discovered = await language.discover();

  assert.deepEqual(discovered, {
    ok: true,
    value: {
      advisory: true,
      authority: "repository-native-checks",
      servers: [
        {
          id: "typescript",
          languages: ["typescript"],
          extensions: [".ts"],
          queries: ["diagnostics", "documentSymbols"],
        },
      ],
    },
  });
  assert.equal(adapter.inspect().starts, 0);
  assert.equal((await lifecycle.shutdown("quit")).status, "clean");
});

test("synchronize keeps one server alive and returns latest mapped diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-sync-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: {},
      onNotification({ method, params, publish }) {
        if (method !== "textDocument/didChange") return;
        const change = params as {
          textDocument: { uri: string };
          contentChanges: readonly { text: string }[];
        };
        publish("textDocument/publishDiagnostics", {
          uri: change.textDocument.uri,
          version: (change.textDocument as { version?: number }).version,
          diagnostics: [
            {
              range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 5 },
              },
              severity: 1,
              code: "fixture-error",
              source: "fixture",
              message: change.contentChanges[0]?.text ?? "missing",
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
      projectId: "non-git:sync-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics"],
      },
    ],
  });

  try {
    const opened = await language.synchronize([
      { kind: "open", path: "src/example.ts", text: "const value = 1;" },
    ]);
    const changed = await language.synchronize([
      { kind: "change", path: "src/example.ts", text: "unknownName" },
    ]);
    const first = await language.query({
      kind: "diagnostics",
      path: "src/example.ts",
    });
    const second = await language.query({
      kind: "diagnostics",
      path: "src/example.ts",
    });
    const closed = await language.synchronize([
      { kind: "close", path: "src/example.ts" },
    ]);

    assert.deepEqual(opened, {
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        documents: [{ path: "src/example.ts", state: "open", version: 1 }],
      },
    });
    assert.equal(changed.ok, true);
    assert.deepEqual(first, second);
    assert.deepEqual(closed, {
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        documents: [{ path: "src/example.ts", state: "closed", version: 2 }],
      },
    });
    assert.deepEqual(first, {
      ok: true,
      value: {
        advisory: true,
        authority: "repository-native-checks",
        kind: "diagnostics",
        serverIds: ["typescript"],
        items: [
          {
            type: "diagnostic",
            path: { kind: "project", path: "src/example.ts" },
            range: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 5 },
            },
            severity: "error",
            code: "fixture-error",
            source: "fixture",
            message: "unknownName",
          },
        ],
        truncated: false,
      },
    });
    assert.equal(adapter.inspect().starts, 1);
    assert.deepEqual(
      adapter
        .inspect()
        .notifications.filter(({ method }) =>
          method.startsWith("textDocument/"),
        )
        .map(({ method, params }) => ({
          method,
          version:
            "textDocument" in params &&
            typeof params.textDocument === "object" &&
            params.textDocument !== null &&
            "version" in params.textDocument
              ? params.textDocument.version
              : undefined,
        })),
      [
        { method: "textDocument/didOpen", version: 1 },
        { method: "textDocument/didChange", version: 2 },
        { method: "textDocument/didClose", version: undefined },
      ],
    );
  } finally {
    assert.equal((await lifecycle.shutdown("quit")).status, "clean");
    assert.equal(adapter.inspect().closes, 1);
    await rm(root, { recursive: true, force: true });
  }
});

test("query normalizes every supported semantic navigation operation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-query-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const sourceUri = pathToFileURL(path.join(root, "src", "example.ts")).href;
  const targetUri = pathToFileURL(path.join(root, "src", "target.ts")).href;
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: {
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        hoverProvider: true,
        callHierarchyProvider: true,
      },
      onRequest({ method }) {
        const range = {
          start: { line: 2, character: 1 },
          end: { line: 2, character: 8 },
        };
        if (method === "textDocument/documentSymbol") {
          return [{ name: "Example", kind: 5, range, selectionRange: range }];
        }
        if (method === "workspace/symbol") {
          return [
            { name: "Target", kind: 12, location: { uri: targetUri, range } },
          ];
        }
        if (
          method === "textDocument/definition" ||
          method === "textDocument/references" ||
          method === "textDocument/implementation"
        ) {
          return [
            { uri: targetUri, range },
            { uri: targetUri, range },
          ];
        }
        if (method === "textDocument/hover") {
          return {
            contents: { kind: "markdown", value: "`Example`: fixture type" },
            range,
          };
        }
        if (method === "textDocument/prepareCallHierarchy") {
          return [
            {
              name: "Example",
              kind: 12,
              uri: sourceUri,
              range,
              selectionRange: range,
            },
          ];
        }
        if (method === "callHierarchy/incomingCalls") {
          return [
            {
              from: {
                name: "caller",
                kind: 12,
                uri: targetUri,
                range,
                selectionRange: range,
              },
              fromRanges: [range],
            },
          ];
        }
        if (method === "callHierarchy/outgoingCalls") {
          return [
            {
              to: {
                name: "callee",
                kind: 12,
                uri: targetUri,
                range,
                selectionRange: range,
              },
              fromRanges: [range],
            },
          ];
        }
        throw new Error(`Unexpected fixture method: ${method}`);
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:query-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: [
          "documentSymbols",
          "workspaceSymbols",
          "definition",
          "references",
          "implementations",
          "hover",
          "callHierarchy",
        ],
      },
    ],
  });
  const position = { line: 2, character: 3 };

  try {
    const documentSymbols = await language.query({
      kind: "documentSymbols",
      path: "src/example.ts",
    });
    const workspaceSymbols = await language.query({
      kind: "workspaceSymbols",
      query: "Target",
    });
    const definition = await language.query({
      kind: "definition",
      path: "src/example.ts",
      position,
    });
    const references = await language.query({
      kind: "references",
      path: "src/example.ts",
      position,
    });
    const implementations = await language.query({
      kind: "implementations",
      path: "src/example.ts",
      position,
    });
    const hover = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position,
    });
    const callHierarchy = await language.query({
      kind: "callHierarchy",
      path: "src/example.ts",
      position,
      direction: "incoming",
    });
    const outgoingCallHierarchy = await language.query({
      kind: "callHierarchy",
      path: "src/example.ts",
      position,
      direction: "outgoing",
    });

    for (const result of [
      documentSymbols,
      workspaceSymbols,
      definition,
      references,
      implementations,
      hover,
      callHierarchy,
      outgoingCallHierarchy,
    ]) {
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.equal(result.value.advisory, true);
      assert.equal(result.value.authority, "repository-native-checks");
      assert.deepEqual(result.value.serverIds, ["typescript"]);
      assert.equal(result.value.items.length, 1);
    }
    const documentSymbol = documentSymbols.ok
      ? documentSymbols.value.items[0]
      : undefined;
    const workspaceSymbol = workspaceSymbols.ok
      ? workspaceSymbols.value.items[0]
      : undefined;
    const definitionLocation = definition.ok
      ? definition.value.items[0]
      : undefined;
    const hoverItem = hover.ok ? hover.value.items[0] : undefined;
    const callItem = callHierarchy.ok
      ? callHierarchy.value.items[0]
      : undefined;
    const outgoingCallItem = outgoingCallHierarchy.ok
      ? outgoingCallHierarchy.value.items[0]
      : undefined;
    assert.equal(documentSymbol?.type, "symbol");
    assert.equal(
      workspaceSymbol?.type === "symbol" && workspaceSymbol.name,
      "Target",
    );
    assert.deepEqual(
      definitionLocation &&
        "path" in definitionLocation &&
        definitionLocation.path,
      {
        kind: "project",
        path: "src/target.ts",
      },
    );
    assert.equal(references.ok && references.value.items.length, 1);
    assert.equal(
      implementations.ok && implementations.value.items[0]?.type,
      "location",
    );
    assert.equal(
      hoverItem?.type === "hover" && hoverItem.contents,
      "`Example`: fixture type",
    );
    assert.equal(callItem?.type === "call" && callItem.name, "caller");
    assert.equal(
      outgoingCallItem?.type === "call" && outgoingCallItem.name,
      "callee",
    );
    assert.deepEqual(
      outgoingCallItem?.type === "call" && outgoingCallItem.callRanges,
      [
        {
          start: { line: 2, character: 1 },
          end: { line: 2, character: 8 },
        },
      ],
    );
    assert.deepEqual(
      adapter.inspect().requests.map(({ method }) => method),
      [
        "textDocument/documentSymbol",
        "workspace/symbol",
        "textDocument/definition",
        "textDocument/references",
        "textDocument/implementation",
        "textDocument/hover",
        "textDocument/prepareCallHierarchy",
        "callHierarchy/incomingCalls",
        "textDocument/prepareCallHierarchy",
        "callHierarchy/outgoingCalls",
      ],
    );
    assert.equal(adapter.inspect().starts, 1);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("query returns a clear error when the server lacks a declared capability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-unsupported-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: { capabilities: { hoverProvider: false } },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:unsupported-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });

  try {
    const result = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "unsupported_capability",
        message: "Configured language servers do not support hover",
        retryable: false,
        details: { kind: "hover", serverIds: ["typescript"] },
      },
    });
    assert.equal(adapter.inspect().requests.length, 0);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical containment rejects a junction escape before server startup", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-language-mapping-"));
  const root = path.join(parent, "worktree");
  const outside = path.join(parent, "outside");
  const linked = path.join(root, "linked");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(
    path.join(outside, "escape.ts"),
    "export const escape = true;\n",
  );
  await symlink(
    outside,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: { capabilities: { definitionProvider: true } },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:mapping-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["definition"],
      },
    ],
  });

  try {
    const result = await language.query({
      kind: "definition",
      path: "linked/escape.ts",
      position: { line: 0, character: 0 },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_input");
    assert.match(result.error.message, /outside current worktree/);
    assert.equal(adapter.inspect().starts, 0);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(parent, { recursive: true, force: true });
  }
});

test("a crashed server restarts once and reopens the current document generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-restart-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const targetUri = pathToFileURL(path.join(root, "src", "target.ts")).href;
  const lifecycle = createLifecycleSupervisor();
  let definitionRequests = 0;
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { definitionProvider: true },
      onRequest({ method, close }) {
        if (method !== "textDocument/definition") return undefined;
        definitionRequests++;
        if (definitionRequests === 1) {
          close();
          throw new Error("fixture server crashed");
        }
        return [
          {
            uri: targetUri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 6 },
            },
          },
        ];
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:restart-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["definition"],
      },
    ],
  });

  try {
    await language.synchronize([
      { kind: "open", path: "src/example.ts", text: "const first = 1;" },
      { kind: "change", path: "src/example.ts", text: "const current = 2;" },
    ]);
    const result = await language.query({
      kind: "definition",
      path: "src/example.ts",
      position: { line: 0, character: 6 },
    });

    assert.equal(result.ok, true);
    assert.equal(adapter.inspect().starts, 2);
    assert.equal(definitionRequests, 2);
    assert.deepEqual(
      adapter
        .inspect()
        .notifications.filter(({ method }) => method === "textDocument/didOpen")
        .map(({ params }) => {
          const document = params.textDocument as {
            version: number;
            text: string;
          };
          return { version: document.version, text: document.text };
        }),
      [
        { version: 1, text: "const first = 1;" },
        { version: 2, text: "const current = 2;" },
      ],
    );
  } finally {
    await lifecycle.shutdown("quit");
    assert.equal(adapter.inspect().closes, 2);
    await rm(root, { recursive: true, force: true });
  }
});

test("query cancels protocol work at the bounded request deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-timeout-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  let requestAborted = false;
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { hoverProvider: true },
      onRequest({ signal }) {
        return new Promise((resolve) => {
          const timer = setTimeout(
            () => resolve({ contents: "too late" }),
            200,
          );
          signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              clearTimeout(timer);
            },
            { once: true },
          );
        });
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:timeout-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    limits: { requestTimeoutMs: 25 },
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });

  try {
    const startedAt = Date.now();
    const result = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "request_timeout",
        message: "Language request timed out after 25ms",
        retryable: true,
        details: { timeoutMs: 25 },
      },
    });
    assert.equal(requestAborted, true);
    assert.equal(Date.now() - startedAt < 150, true);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated crashes open the per-server circuit at its bounded ceiling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-circuit-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { definitionProvider: true },
      onRequest({ close }) {
        close();
        throw new Error("fixture repeated crash");
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:circuit-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    limits: { maxCrashesPerWindow: 2 },
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["definition"],
      },
    ],
  });

  try {
    const result = await language.query({
      kind: "definition",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });
    const repeated = await language.query({
      kind: "definition",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "server_unavailable");
    assert.match(result.error.message, /crash circuit is open after 2 crashes/);
    assert.equal(result.error.retryable, true);
    assert.equal(repeated.ok, false);
    if (!repeated.ok) {
      assert.match(
        repeated.error.message,
        /crash circuit is open after 2 crashes/,
      );
    }
    assert.equal(adapter.inspect().starts, 2);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("query returns deterministic deduplicated results within configured bounds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-bounds-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const targetUri = pathToFileURL(path.join(root, "src", "target.ts")).href;
  const lifecycle = createLifecycleSupervisor();
  const artifacts = createInMemoryArtifactStore();
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { workspaceSymbolProvider: true },
      onRequest() {
        return ["Zulu", "Alpha", "Alpha", "Charlie", "Bravo"].map((name) => ({
          name,
          kind: 12,
          location: { uri: targetUri, range },
        }));
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:bounds-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    artifacts,
    limits: { maxResultItems: 2 },
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["workspaceSymbols"],
      },
    ],
  });

  try {
    const result = await language.query({
      kind: "workspaceSymbols",
      query: "",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.value.items.map((item) =>
        item.type === "symbol" ? item.name : "wrong",
      ),
      ["Alpha", "Bravo"],
    );
    assert.equal(result.value.truncated, true);
    assert.equal(result.value.artifact?.mediaType, "application/json");
    assert.equal(typeof result.value.artifact?.id, "string");
    const stored = await artifacts.get(result.value.artifact?.id ?? "missing");
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    const complete = JSON.parse(
      Buffer.from(stored.value.body).toString("utf8"),
    ) as {
      items: readonly { name: string }[];
    };
    assert.deepEqual(
      complete.items.map(({ name }) => name),
      ["Alpha", "Bravo", "Charlie", "Zulu"],
    );
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostics queries use the negotiated pull-diagnostics capability", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-language-pull-diagnostics-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: {
        diagnosticProvider: {
          interFileDependencies: false,
          workspaceDiagnostics: false,
        },
      },
      onRequest({ method }) {
        assert.equal(method, "textDocument/diagnostic");
        return {
          kind: "full",
          items: [
            {
              range: {
                start: { line: 4, character: 1 },
                end: { line: 4, character: 7 },
              },
              severity: 2,
              code: 7001,
              source: "pull-fixture",
              message: "pulled warning",
            },
          ],
        };
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:pull-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics"],
      },
    ],
  });

  try {
    const result = await language.query({
      kind: "diagnostics",
      path: "src/example.ts",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.items, [
      {
        type: "diagnostic",
        path: { kind: "project", path: "src/example.ts" },
        range: {
          start: { line: 4, character: 1 },
          end: { line: 4, character: 7 },
        },
        severity: "warning",
        code: "7001",
        source: "pull-fixture",
        message: "pulled warning",
      },
    ]);
    assert.deepEqual(
      adapter.inspect().requests.map(({ method }) => method),
      ["textDocument/diagnostic"],
    );
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("query bounds language-server startup before initialization completes", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-language-startup-timeout-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { hoverProvider: true },
      startupDelayMs: 200,
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:startup-timeout-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    limits: { startupTimeoutMs: 20 },
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });

  try {
    const result = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "startup_timeout",
        message: "Language startup timed out after 20ms",
        retryable: true,
        details: { timeoutMs: 20 },
      },
    });
    assert.equal(adapter.inspect().starts, 1);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("factory rejects oversized server definitions before any process activity", () => {
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: { capabilities: {} },
  });

  assert.throws(
    () =>
      createLanguageIntelligence({
        lifecycle,
        project: {
          kind: "non-git",
          projectId: "non-git:bounded-config-fixture",
          requestedCwd: "C:/fixture/project",
          canonicalCwd: "C:/fixture/project",
          cwdWasAliased: false,
        },
        adapter,
        servers: [
          {
            id: "typescript",
            command: {
              executable: "fixture-server",
              args: Array.from({ length: 65 }, (_, index) => `arg-${index}`),
            },
            selectors: [{ languageId: "typescript", extensions: [".ts"] }],
            queries: ["diagnostics"],
          },
        ],
      }),
    /at most 64 arguments/,
  );
  assert.equal(adapter.inspect().starts, 0);
});

test("restart reopens a changed snapshot without replaying its document version", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-language-change-restart-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  let changes = 0;
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: {},
      onNotification({ method, close }) {
        if (method !== "textDocument/didChange") return;
        changes++;
        if (changes === 1) {
          close();
          throw new Error("fixture crashed during didChange");
        }
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:change-restart-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics"],
      },
    ],
  });

  try {
    await language.synchronize([
      { kind: "open", path: "src/example.ts", text: "const first = 1;" },
    ]);
    const changed = await language.synchronize([
      { kind: "change", path: "src/example.ts", text: "const second = 2;" },
    ]);

    assert.equal(changed.ok, true);
    assert.equal(adapter.inspect().starts, 2);
    assert.deepEqual(
      adapter
        .inspect()
        .notifications.filter(({ method }) =>
          ["textDocument/didOpen", "textDocument/didChange"].includes(method),
        )
        .map(({ method, params }) => ({
          method,
          version: (params.textDocument as { version: number }).version,
        })),
      [
        { method: "textDocument/didOpen", version: 1 },
        { method: "textDocument/didChange", version: 2 },
        { method: "textDocument/didOpen", version: 2 },
      ],
    );
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("caller cancellation reaches an active protocol request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-cancel-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let requestAborted = false;
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { hoverProvider: true },
      onRequest({ signal }) {
        requestStarted();
        return new Promise(() => {
          signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
            },
            { once: true },
          );
        });
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:cancel-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });
  const controller = new AbortController();

  try {
    const querying = language.query(
      {
        kind: "hover",
        path: "src/example.ts",
        position: { line: 0, character: 0 },
      },
      controller.signal,
    );
    await started;
    controller.abort();
    const result = await querying;

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: "cancelled",
        message: "Language query cancelled",
        retryable: false,
      },
    });
    assert.equal(requestAborted, true);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle shutdown aborts a pending language-server startup", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-language-startup-shutdown-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { hoverProvider: true },
      startupDelayMs: 500,
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:startup-shutdown-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });

  try {
    const querying = language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });
    while (adapter.inspect().starts === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const startedAt = Date.now();
    const report = await lifecycle.shutdown("reload");
    const result = await querying;

    assert.equal(report.status, "clean");
    assert.equal(Date.now() - startedAt < 200, true);
    assert.equal(result.ok, false);
    assert.equal(adapter.inspect().closes, 0);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle shutdown cancels an active language request", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-language-request-shutdown-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let requestAborted = false;
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { hoverProvider: true },
      onRequest({ signal }) {
        requestStarted();
        return new Promise(() => {
          signal?.addEventListener(
            "abort",
            () => {
              requestAborted = true;
            },
            { once: true },
          );
        });
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:request-shutdown-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    limits: { requestTimeoutMs: 500 },
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });

  try {
    const querying = language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });
    await started;
    const startedAt = Date.now();
    const report = await lifecycle.shutdown("reload");
    const result = await querying;

    assert.equal(report.status, "clean");
    assert.equal(result.ok, false);
    assert.equal(requestAborted, true);
    assert.equal(Date.now() - startedAt < 200, true);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("request timeout bounds the complete multi-request query", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-language-aggregate-timeout-"),
  );
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const sourceUri = pathToFileURL(path.join(root, "src", "example.ts")).href;
  const lifecycle = createLifecycleSupervisor();
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: { callHierarchyProvider: true },
      async onRequest({ method }) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (method === "textDocument/prepareCallHierarchy") {
          return [
            {
              name: "example",
              kind: 12,
              uri: sourceUri,
              range,
              selectionRange: range,
            },
          ];
        }
        return [];
      },
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:aggregate-timeout-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    limits: { requestTimeoutMs: 30 },
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["callHierarchy"],
      },
    ],
  });

  try {
    const startedAt = Date.now();
    const result = await language.query({
      kind: "callHierarchy",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
      direction: "incoming",
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "request_timeout");
    assert.equal(Date.now() - startedAt < 250, true);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("document reopen remains monotonic and duplicate open is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-versions-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: { capabilities: {} },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:versions",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics"],
      },
    ],
  });
  try {
    const first = await language.synchronize([
      { kind: "open", path: "value.ts", text: "const value = 1;" },
    ]);
    const duplicate = await language.synchronize([
      { kind: "open", path: "value.ts", text: "const value = 1;" },
    ]);
    await language.synchronize([{ kind: "close", path: "value.ts" }]);
    const reopened = await language.synchronize([
      { kind: "open", path: "value.ts", text: "const value = 1;" },
    ]);
    assert.equal(first.ok && first.value.documents[0]?.version, 1);
    assert.equal(duplicate.ok && duplicate.value.documents[0]?.version, 1);
    assert.equal(reopened.ok && reopened.value.documents[0]?.version, 2);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed document never returns diagnostics from its prior version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-stale-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const lifecycle = createLifecycleSupervisor();
  const adapter = createFixtureLanguageServerAdapter({
    typescript: {
      capabilities: {},
      onNotification({ method, params, publish }) {
        if (method !== "textDocument/didOpen") return;
        const document = (params as any).textDocument;
        publish("textDocument/publishDiagnostics", {
          uri: document.uri,
          version: document.version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              severity: 1,
              message: "version one",
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
      projectId: "non-git:stale",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "typescript",
        command: { executable: "fixture-server" },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["diagnostics"],
      },
    ],
  });
  try {
    await language.synchronize([
      { kind: "open", path: "value.ts", text: "bad" },
    ]);
    const before = await language.query({
      kind: "diagnostics",
      path: "value.ts",
    });
    await language.synchronize([
      { kind: "change", path: "value.ts", text: "good" },
    ]);
    const after = await language.query({
      kind: "diagnostics",
      path: "value.ts",
    });
    assert.equal(before.ok && before.value.items.length, 1);
    assert.equal(after.ok && after.value.items.length, 0);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, { recursive: true, force: true });
  }
});
