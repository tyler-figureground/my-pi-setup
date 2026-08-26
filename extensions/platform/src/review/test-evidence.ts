import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ReviewCapture, ReviewEvidenceAdapter } from "./index.ts";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function testEnvironment() {
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "LANG",
    "LC_ALL",
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && allowed.has(name.toUpperCase()),
    ),
  ) as NodeJS.ProcessEnv;
}

function boundedTail(value: string) {
  const body = Buffer.from(value);
  return body.length <= MAX_OUTPUT_BYTES
    ? value
    : body.subarray(body.length - MAX_OUTPUT_BYTES).toString("utf8");
}

export function createDisposableTestEvidence(
  projectRoot: string,
): ReviewEvidenceAdapter {
  const canonicalProject = path.resolve(projectRoot);
  return {
    source: "tests",
    async collect(capture: ReviewCapture, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const parent = await mkdtemp(
        path.join(os.tmpdir(), "pi-local-review-tests-"),
      );
      const snapshot = path.join(parent, "snapshot");
      const archive = path.join(parent, "snapshot.tar");
      try {
        await mkdir(snapshot);
        const revision = capture.resolved.to ?? capture.resolved.head ?? "HEAD";
        await execFileAsync(
          "git",
          [
            "-c",
            `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
            "--no-pager",
            "archive",
            "--format=tar",
            `--output=${archive}`,
            revision,
          ],
          {
            cwd: canonicalProject,
            env: testEnvironment(),
            windowsHide: true,
            timeout: 30_000,
            signal,
          },
        );
        await execFileAsync(
          process.platform === "win32"
            ? path.join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "tar.exe",
              )
            : "tar",
          ["-xf", path.basename(archive), "-C", path.basename(snapshot)],
          {
            cwd: parent,
            env: testEnvironment(),
            windowsHide: true,
            timeout: 30_000,
            signal,
          },
        );

        if (capture.requested.kind === "uncommitted") {
          for (const file of capture.files) {
            const target = path.resolve(snapshot, file.path);
            const relation = path.relative(snapshot, target);
            if (
              relation === ".." ||
              relation.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relation)
            )
              throw new Error(
                `Captured test path escapes snapshot: ${file.path}`,
              );
            if (file.worktreeExists === false) {
              await rm(target, { force: true });
              continue;
            }
            if (
              file.content?.worktree !== undefined ||
              file.content?.worktreeBase64 !== undefined
            ) {
              await mkdir(path.dirname(target), { recursive: true });
              await writeFile(
                target,
                file.content.worktreeBase64 !== undefined
                  ? Buffer.from(file.content.worktreeBase64, "base64")
                  : file.content.worktree!,
              );
            }
          }
        }

        const packagePath = path.join(snapshot, "package.json");
        let packageJson: {
          scripts?: Record<string, string>;
          packageManager?: string;
        };
        try {
          packageJson = JSON.parse(await readFile(packagePath, "utf8"));
        } catch {
          return {
            id: "tests:native",
            source: "tests",
            status: "unavailable",
            summary: "Disposable snapshot has no readable package.json.",
          };
        }
        if (!packageJson.scripts?.test) {
          return {
            id: "tests:native",
            source: "tests",
            status: "unavailable",
            summary: "Disposable snapshot declares no test script.",
          };
        }

        const packageManager = packageJson.packageManager?.startsWith("pnpm@")
          ? "pnpm"
          : "npm";
        let stdout = "";
        let stderr = "";
        let code = 0;
        try {
          const commandArgs =
            packageManager === "pnpm" ? ["run", "test"] : ["test"];
          const windowsCli =
            packageManager === "pnpm"
              ? path.join(
                  process.env.APPDATA ?? "",
                  "npm",
                  "node_modules",
                  "pnpm",
                  "bin",
                  "pnpm.cjs",
                )
              : path.join(
                  path.dirname(process.execPath),
                  "node_modules",
                  "npm",
                  "bin",
                  "npm-cli.js",
                );
          const executable =
            process.platform === "win32" ? process.execPath : packageManager;
          const args =
            process.platform === "win32"
              ? [windowsCli, ...commandArgs]
              : commandArgs;
          const result = await execFileAsync(executable, args, {
            cwd: snapshot,
            env: testEnvironment(),
            encoding: "utf8",
            windowsHide: true,
            timeout: TEST_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024,
            signal,
          });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (error) {
          const failure = error as {
            code?: number | string;
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          code = typeof failure.code === "number" ? failure.code : 1;
          stdout = failure.stdout ?? "";
          stderr = failure.stderr ?? failure.message ?? "Test command failed.";
        }
        const output = boundedTail(`${stdout}${stderr}`);
        return {
          id: "tests:native",
          source: "tests",
          status: "available",
          summary:
            code === 0
              ? "Native test script passed in disposable snapshot."
              : `Native test script failed in disposable snapshot with exit ${code}.`,
          data: { command: `${packageManager} test`, exitCode: code, output },
        };
      } finally {
        await rm(parent, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
      }
    },
  };
}
