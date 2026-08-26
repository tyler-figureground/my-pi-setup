import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLifecycleSupervisor } from "./src/core/lifecycle/supervisor.ts";
import { createProjectIdentity } from "./src/core/projects/index.ts";
import {
  createFixtureLanguageServerAdapter,
  createLanguageIntelligence,
  createStdioLanguageServerAdapter,
} from "./src/language/index.ts";

const execFileAsync = promisify(execFile);
const windowsTest = process.platform === "win32" ? test : test.skip;
const typescriptServerPath = fileURLToPath(
  new URL("./node_modules/typescript-v5/lib/tsserver.js", import.meta.url),
);
const typescriptServerTest = existsSync(typescriptServerPath)
  ? test
  : test.skip;
const liveServerTest =
  process.env.PI_LANGUAGE_REAL_SERVERS === "1" ? test : test.skip;

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`language fixture process ${pid} remained alive`);
}

test("linked-worktree diagnostics map to the current worktree's source-relative path", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-language-worktree-"));
  const repository = path.join(parent, "repository");
  const worktree = path.join(parent, "linked");
  await execFileAsync("git", ["init", repository]);
  await execFileAsync(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    { cwd: repository },
  );
  await execFileAsync("git", ["config", "user.name", "Fixture"], {
    cwd: repository,
  });
  await writeFile(path.join(repository, "value.ts"), "const value = 1;\n");
  await execFileAsync("git", ["add", "value.ts"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  await execFileAsync("git", ["worktree", "add", "--detach", worktree], {
    cwd: repository,
  });
  try {
    const identity = await createProjectIdentity().resolve(worktree);
    assert.equal(identity.ok, true);
    if (!identity.ok) return;
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
                  end: { line: 0, character: 5 },
                },
                severity: 1,
                message: "linked fixture",
              },
            ],
          });
        },
      },
    });
    const language = createLanguageIntelligence({
      lifecycle,
      project: identity.value,
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
    await language.synchronize([
      {
        kind: "open",
        path: path.join(worktree, "value.ts"),
        text: "const value = 1;\n",
      },
    ]);
    const result = await language.query({
      kind: "diagnostics",
      path: path.join(worktree, "value.ts"),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const diagnostic = result.value.items[0];
      assert.deepEqual(
        diagnostic && "path" in diagnostic ? diagnostic.path : undefined,
        { kind: "project", path: "value.ts" },
      );
    }
    await lifecycle.shutdown("quit");
  } finally {
    await execFileAsync("git", ["worktree", "remove", "--force", worktree], {
      cwd: repository,
    }).catch(() => undefined);
    await rm(parent, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("real stdio adapter persists one protocol server and lifecycle removes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-stdio-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const fixture = fileURLToPath(
    new URL("./test-fixtures/language-server.ts", import.meta.url),
  );
  const lifecycle = createLifecycleSupervisor();
  let childPid: number | undefined;
  const adapter = createStdioLanguageServerAdapter({
    spawn,
    onSpawn(pid) {
      childPid = pid;
    },
  });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:stdio-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "fixture",
        command: {
          executable: process.execPath,
          args: ["--experimental-strip-types", fixture],
        },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });

  try {
    await language.synchronize([
      { kind: "open", path: "src/example.ts", text: "const value = 1;" },
    ]);
    const first = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 6 },
    });
    const second = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 6 },
    });

    assert.equal(first.ok, true);
    assert.deepEqual(first, second);
    if (!first.ok) return;
    const item = first.value.items[0];
    assert.equal(item?.type, "hover");
    assert.equal(
      item?.type === "hover" && item.contents,
      `fixture-pid:${childPid}`,
    );
    assert.equal(Number.isSafeInteger(childPid), true);
  } finally {
    const report = await lifecycle.shutdown("reload");
    assert.equal(report.status, "clean");
    if (childPid) await waitForExit(childPid);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("real stdio adapter neither inherits parent secrets nor exposes stderr secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-secrets-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const fixture = fileURLToPath(
    new URL("./test-fixtures/language-server.ts", import.meta.url),
  );
  const canary = "F04_SECRET_CANARY_7f4a19";
  const prior = process.env.F04_PARENT_SECRET;
  process.env.F04_PARENT_SECRET = canary;
  try {
    const lifecycle = createLifecycleSupervisor();
    const language = createLanguageIntelligence({
      lifecycle,
      project: {
        kind: "non-git",
        projectId: "non-git:secret-fixture",
        requestedCwd: canonicalRoot,
        canonicalCwd: canonicalRoot,
        cwdWasAliased: false,
      },
      adapter: createStdioLanguageServerAdapter(),
      servers: [
        {
          id: "fixture",
          command: {
            executable: process.execPath,
            args: ["--experimental-strip-types", fixture],
          },
          initializationOptions: { environmentName: "F04_PARENT_SECRET" },
          selectors: [{ languageId: "typescript", extensions: [".ts"] }],
          queries: ["hover"],
        },
      ],
    });
    const result = await language.query({
      kind: "hover",
      path: "example.ts",
      position: { line: 0, character: 0 },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const hover = result.value.items[0];
      assert.equal(hover?.type === "hover" && hover.contents, "missing");
    }
    await lifecycle.shutdown("quit");

    const failingLifecycle = createLifecycleSupervisor();
    const failing = createLanguageIntelligence({
      lifecycle: failingLifecycle,
      project: {
        kind: "non-git",
        projectId: "non-git:stderr-fixture",
        requestedCwd: canonicalRoot,
        canonicalCwd: canonicalRoot,
        cwdWasAliased: false,
      },
      adapter: createStdioLanguageServerAdapter(),
      servers: [
        {
          id: "fixture",
          command: {
            executable: process.execPath,
            args: ["--experimental-strip-types", fixture],
            env: { F04_EXPLICIT_SECRET: canary },
          },
          initializationOptions: {
            stderrEnvironmentName: "F04_EXPLICIT_SECRET",
            failInitialization: true,
          },
          selectors: [{ languageId: "typescript", extensions: [".ts"] }],
          queries: ["hover"],
        },
      ],
    });
    const failed = await failing.query({
      kind: "hover",
      path: "example.ts",
      position: { line: 0, character: 0 },
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.doesNotMatch(failed.error.message, new RegExp(canary));
      assert.match(failed.error.message, /stderr omitted/);
    }
    await failingLifecycle.shutdown("quit");
  } finally {
    if (prior === undefined) delete process.env.F04_PARENT_SECRET;
    else process.env.F04_PARENT_SECRET = prior;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("real stdio adapter rejects oversized frames before buffering their bodies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-frame-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const fixture = fileURLToPath(
    new URL("./test-fixtures/language-server.ts", import.meta.url),
  );
  const lifecycle = createLifecycleSupervisor();
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:frame-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter: createStdioLanguageServerAdapter(),
    limits: { requestTimeoutMs: 3_000 },
    servers: [
      {
        id: "fixture",
        command: {
          executable: process.execPath,
          args: ["--experimental-strip-types", fixture],
        },
        initializationOptions: { oversizedOnHover: true },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });
  try {
    const startedAt = Date.now();
    const result = await language.query({
      kind: "hover",
      path: "example.ts",
      position: { line: 0, character: 0 },
    });
    assert.equal(result.ok, false);
    assert.equal(Date.now() - startedAt < 15_000, true);
  } finally {
    await lifecycle.shutdown("quit");
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

test("real stdio adapter removes the language server's complete process tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-language-tree-"));
  const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
  const fixture = fileURLToPath(
    new URL("./test-fixtures/language-server.ts", import.meta.url),
  );
  const lifecycle = createLifecycleSupervisor();
  const adapter = createStdioLanguageServerAdapter({ spawn });
  const language = createLanguageIntelligence({
    lifecycle,
    project: {
      kind: "non-git",
      projectId: "non-git:tree-fixture",
      requestedCwd: canonicalRoot,
      canonicalCwd: canonicalRoot,
      cwdWasAliased: false,
    },
    adapter,
    servers: [
      {
        id: "fixture",
        command: {
          executable: process.execPath,
          args: ["--experimental-strip-types", fixture],
        },
        initializationOptions: { spawnDescendant: true },
        selectors: [{ languageId: "typescript", extensions: [".ts"] }],
        queries: ["hover"],
      },
    ],
  });
  let grandchildPid: number | undefined;

  try {
    const result = await language.query({
      kind: "hover",
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const item = result.value.items[0];
    assert.equal(item?.type, "hover");
    if (item?.type === "hover") {
      grandchildPid = Number.parseInt(
        item.contents.replace("grandchild-pid:", ""),
        10,
      );
    }
    assert.equal(Number.isSafeInteger(grandchildPid), true);
    assert.equal(grandchildPid ? processExists(grandchildPid) : false, true);

    const report = await lifecycle.shutdown("quit");
    assert.equal(report.status, "clean");
    if (grandchildPid) await waitForExit(grandchildPid);
  } finally {
    await lifecycle.shutdown("quit");
    if (grandchildPid && processExists(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // Best-effort cleanup after failed process-tree assertion.
      }
    }
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

windowsTest(
  "real stdio adapter launches a cmd shim from a path with spaces",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi language cmd "));
    const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
    const fixture = fileURLToPath(
      new URL("./test-fixtures/language-server.ts", import.meta.url),
    );
    const command = path.join(root, "fixture server.cmd");
    await writeFile(command, '@echo off\r\n"%~1" %2 "%~3"\r\n', "utf8");
    const lifecycle = createLifecycleSupervisor();
    const language = createLanguageIntelligence({
      lifecycle,
      project: {
        kind: "non-git",
        projectId: "non-git:cmd-fixture",
        requestedCwd: canonicalRoot,
        canonicalCwd: canonicalRoot,
        cwdWasAliased: false,
      },
      adapter: createStdioLanguageServerAdapter(),
      servers: [
        {
          id: "fixture",
          command: {
            executable: command,
            args: [process.execPath, "--experimental-strip-types", fixture],
          },
          selectors: [{ languageId: "typescript", extensions: [".ts"] }],
          queries: ["hover"],
        },
      ],
    });

    try {
      const result = await language.query({
        kind: "hover",
        path: "example.ts",
        position: { line: 0, character: 0 },
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.value.items[0]?.type, "hover");
    } finally {
      const report = await lifecycle.shutdown("quit");
      assert.equal(report.status, "clean");
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  },
);

typescriptServerTest(
  "real TypeScript language server returns synchronized document symbols",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-language-typescript-"));
    const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
    const cli = fileURLToPath(
      new URL(
        "./node_modules/typescript-language-server/lib/cli.mjs",
        import.meta.url,
      ),
    );
    const source = "export function answer() { return 42; }\n";
    await Promise.all([
      writeFile(path.join(root, "example.ts"), source, "utf8"),
      writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true },
          include: ["*.ts"],
        }),
        "utf8",
      ),
    ]);
    const lifecycle = createLifecycleSupervisor();
    const language = createLanguageIntelligence({
      lifecycle,
      project: {
        kind: "non-git",
        projectId: "non-git:typescript-real",
        requestedCwd: canonicalRoot,
        canonicalCwd: canonicalRoot,
        cwdWasAliased: false,
      },
      adapter: createStdioLanguageServerAdapter(),
      servers: [
        {
          id: "typescript",
          command: {
            executable: process.execPath,
            args: [cli, "--stdio"],
          },
          selectors: [{ languageId: "typescript", extensions: [".ts"] }],
          queries: ["documentSymbols"],
          initializationOptions: {
            tsserver: { path: typescriptServerPath },
          },
        },
      ],
    });

    try {
      const synchronized = await language.synchronize([
        { kind: "open", path: "example.ts", text: source },
      ]);
      const result = await language.query({
        kind: "documentSymbols",
        path: "example.ts",
      });

      assert.equal(synchronized.ok, true, JSON.stringify(synchronized));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(
        result.value.items.some(
          (item) => item.type === "symbol" && item.name === "answer",
        ),
        true,
        JSON.stringify(result),
      );
    } finally {
      const report = await lifecycle.shutdown("quit");
      assert.equal(report.status, "clean");
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  },
);

liveServerTest(
  "real Ruff language server publishes synchronized diagnostics",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-language-ruff-"));
    const canonicalRoot = (await realpath(root)).replaceAll("\\", "/");
    const source = "def answer():\n    return missing_name\n";
    await writeFile(path.join(root, "example.py"), source, "utf8");
    const lifecycle = createLifecycleSupervisor();
    const language = createLanguageIntelligence({
      lifecycle,
      project: {
        kind: "non-git",
        projectId: "non-git:ruff-real",
        requestedCwd: canonicalRoot,
        canonicalCwd: canonicalRoot,
        cwdWasAliased: false,
      },
      adapter: createStdioLanguageServerAdapter(),
      servers: [
        {
          id: "ruff",
          command: { executable: "ruff", args: ["server"] },
          selectors: [{ languageId: "python", extensions: [".py"] }],
          queries: ["diagnostics"],
        },
      ],
    });

    try {
      const synchronized = await language.synchronize([
        { kind: "open", path: "example.py", text: source },
      ]);
      assert.equal(synchronized.ok, true, JSON.stringify(synchronized));
      let diagnostics = await language.query({
        kind: "diagnostics",
        path: "example.py",
      });
      const deadline = Date.now() + 3_000;
      while (
        diagnostics.ok &&
        diagnostics.value.items.length === 0 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        diagnostics = await language.query({
          kind: "diagnostics",
          path: "example.py",
        });
      }

      assert.equal(diagnostics.ok, true, JSON.stringify(diagnostics));
      if (!diagnostics.ok) return;
      assert.equal(
        diagnostics.value.items.some(
          (item) => "code" in item && item.code === "F821",
        ),
        true,
        JSON.stringify(diagnostics),
      );
    } finally {
      const report = await lifecycle.shutdown("quit");
      assert.equal(report.status, "clean");
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  },
);
