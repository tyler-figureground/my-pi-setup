import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const fixture = path.join(
  import.meta.dirname,
  "fixtures",
  "phase7-missing-messaging-extension.ts",
);

function runHeadless(args: readonly string[], agentDir: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--extension",
          fixture,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-approve",
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_TELEMETRY: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("headless Phase 7 fixture timed out"));
      }, 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );
}

for (const [mode, args] of [
  ["print", ["--print", "dependency probe"]],
  ["json", ["--mode", "json", "dependency probe"]],
  ["rpc", ["--mode", "rpc"]],
] as const) {
  test(`Phase 7 missing messaging fails closed in ${mode} process mode`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `pi-phase7-headless-${mode}-`),
    );
    try {
      const result = await runHeadless(args, directory);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.code, 0, output);
      assert.match(output, /Phase 7 requires messaging/i);
      assert.equal(output.includes(directory), false);
      assert.equal(output.includes("dependency probe"), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
