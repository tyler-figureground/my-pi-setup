import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const unit = [
  "extensions/background-terminals/observation-service.test.ts",
  "extensions/background-terminals/output.test.ts",
  "extensions/background-terminals/prompt.test.ts",
  "extensions/background-terminals/ps.test.ts",
  "extensions/background-terminals/result-delivery.test.ts",
  "extensions/firecrawl-search/index.test.ts",
  "extensions/git-info/changed-files-view.test.ts",
  "extensions/git-info/refresh-coordinator.test.ts",
  "extensions/platform/artifact-bundle.test.ts",
  "extensions/platform/artifact-config.test.ts",
  "extensions/platform/artifact-file-import.test.ts",
  "extensions/platform/artifact-materializer.test.ts",
  "extensions/platform/artifact-publication-repository.test.ts",
  "extensions/platform/artifact-publisher.test.ts",
  "extensions/platform/artifact-store.test.ts",
  "extensions/platform/artifact-wiring.test.ts",
  "extensions/platform/vercel-artifact-publisher.test.ts",
  "extensions/platform/vercel-rest-transport.test.ts",
  "extensions/platform/browser-control.test.ts",
  "extensions/platform/browser-wiring.test.ts",
  "extensions/platform/capability-policy.test.ts",
  "extensions/platform/credential-vault.test.ts",
  "extensions/platform/current-workspace-lease.test.ts",
  "extensions/platform/external-controls.test.ts",
  "extensions/platform/goal-budget.test.ts",
  "extensions/platform/goal-engine.test.ts",
  "extensions/platform/goal-evidence.test.ts",
  "extensions/platform/goal-recovery.test.ts",
  "extensions/platform/goal-scheduling.test.ts",
  "extensions/platform/goal-transitions.test.ts",
  "extensions/platform/goal-user-controls.test.ts",
  "extensions/platform/goal-validation.test.ts",
  "extensions/platform/goal-wiring.test.ts",
  "extensions/platform/goal-wiring-ports.test.ts",
  "extensions/platform/hooks.test.ts",
  "extensions/platform/hook-actions-config.test.ts",
  "extensions/platform/hooks-adapters.test.ts",
  "extensions/platform/hooks-phase7.test.ts",
  "extensions/platform/language-config.test.ts",
  "extensions/platform/language-intelligence.test.ts",
  "extensions/platform/language-stdio.test.ts",
  "extensions/platform/language-versionless.test.ts",
  "extensions/platform/language-wiring.test.ts",
  "extensions/platform/lifecycle-supervisor.test.ts",
  "extensions/platform/mcp-oauth-official.test.ts",
  "extensions/platform/mcp-oauth.test.ts",
  "extensions/platform/mcp-references.test.ts",
  "extensions/platform/mcp-wiring.test.ts",
  "extensions/platform/memory-store.test.ts",
  "extensions/platform/memory-wiring.test.ts",
  "extensions/platform/messaging-wiring.test.ts",
  "extensions/platform/monitor-wiring.test.ts",
  "extensions/platform/named-profile-execution-service.test.ts",
  "extensions/platform/phase5-config.test.ts",
  "extensions/platform/phase6-config.test.ts",
  "extensions/platform/phase7-config.test.ts",
  "extensions/platform/plan-mode.test.ts",
  "extensions/platform/platform-config.test.ts",
  "extensions/platform/platform-hook-event-sink.test.ts",
  "extensions/platform/platform.test.ts",
  "extensions/platform/review-evidence.test.ts",
  "extensions/platform/review-wiring.test.ts",
  "extensions/platform/reviewer-service.test.ts",
  "extensions/platform/rules.test.ts",
  "extensions/platform/scheduler-calendar.test.ts",
  "extensions/platform/scheduler-delivery.test.ts",
  "extensions/platform/scheduler-wiring.test.ts",
  "extensions/platform/state-store.test.ts",
  "extensions/platform/tool-federation.test.ts",
  "extensions/platform/trigger-engine-phase7.test.ts",
  "extensions/shared/context-utilization.test.ts",
  "extensions/shared/execution-role.test.ts",
  "extensions/shared/scheduled-agent.test.ts",
  "extensions/shared/tool-call-timeout.test.ts",
  "extensions/subagents/by-the-way.test.ts",
  "extensions/subagents/codex-process.test.ts",
  "extensions/subagents/context-usage.test.ts",
  "extensions/subagents/goal-worker-certainty.test.ts",
  "extensions/subagents/goal-worker-port.test.ts",
  "extensions/subagents/goal-worker-retention.test.ts",
  "extensions/subagents/goal-worker.test.ts",
  "extensions/subagents/local-review.test.ts",
  "extensions/subagents/metered-usage.test.ts",
  "extensions/subagents/named-profile-execution.test.ts",
  "extensions/subagents/profile-policy.test.ts",
  "extensions/subagents/result-delivery.test.ts",
  "extensions/subagents/scheduled-agent.test.ts",
  "extensions/subagents/takeover.test.ts",
  "extensions/summaries/config.test.ts",
  "extensions/summaries/index.test.ts",
  "extensions/summaries/summarizer.test.ts",
  "extensions/summaries/transcript.test.ts",
  "extensions/workflows/artifacts.test.ts",
  "extensions/workflows/controller.test.ts",
  "extensions/workflows/events.test.ts",
  "extensions/workflows/meta.test.ts",
  "extensions/workflows/platform-artifact.test.ts",
  "extensions/workflows/serialization.test.ts",
];
const integration = [
  "extensions/background-terminals/manager.test.ts",
  "extensions/git-info/process.test.ts",
  "extensions/platform/artifact-store.integration.test.ts",
  "extensions/platform/local-artifact-viewer.integration.test.ts",
  "extensions/platform/browser-playwright.integration.test.ts",
  "extensions/platform/credential-vault.integration.test.ts",
  "extensions/platform/goal-killed-parent.integration.test.ts",
  "extensions/platform/hook-process.integration.test.ts",
  "extensions/platform/hooks.integration.test.ts",
  "extensions/platform/hooks-wiring.test.ts",
  "extensions/platform/language-intelligence.integration.test.ts",
  "extensions/platform/lifecycle-supervisor.integration.test.ts",
  "extensions/platform/mcp-http.integration.test.ts",
  "extensions/platform/mcp-official.integration.test.ts",
  "extensions/platform/memory-quality.test.ts",
  "extensions/platform/memory-sqlite.integration.test.ts",
  "extensions/platform/messaging-pi-delivery.test.ts",
  "extensions/platform/monitor-registry.test.ts",
  "extensions/platform/phase2-composition.test.ts",
  "extensions/platform/phase5-composition.test.ts",
  "extensions/platform/phase4-composition.test.ts",
  "extensions/platform/phase6-composition.test.ts",
  "extensions/platform/phase7-composition.test.ts",
  "extensions/platform/phase8-composition.test.ts",
  "extensions/platform/phase7-headless.integration.test.ts",
  "extensions/platform/phase7-soak.integration.test.ts",
  "extensions/platform/goal-soak.integration.test.ts",
  "extensions/platform/pinned-fetch.integration.test.ts",
  "extensions/platform/plan-mode.integration.test.ts",
  "extensions/platform/private-protocol-loader.integration.test.ts",
  "extensions/platform/profiles.test.ts",
  "extensions/platform/project-identity.test.ts",
  "extensions/platform/review-test-evidence.test.ts",
  "extensions/platform/review.test.ts",
  "extensions/platform/rules.integration.test.ts",
  "extensions/platform/scheduler.test.ts",
  "extensions/platform/session-broker.test.ts",
  "extensions/platform/state-store.integration.test.ts",
  "extensions/platform/trigger-persistence.integration.test.ts",
  "extensions/platform/workspaces.test.ts",
  "extensions/shared/child-session.test.ts",
  "extensions/subagents/goal-worker-global-cap.test.ts",
  "extensions/subagents/manager.test.ts",
  "extensions/subagents/metered-usage-wiring.test.ts",
  "extensions/subagents/phase3-wiring.test.ts",
  "extensions/workflows/runner.test.ts",
  "extensions/workflows/sandbox.test.ts",
];
const live = [
  "extensions/subagents/claude.test.ts",
  "extensions/subagents/codex.test.ts",
  "extensions/subagents/pi.test.ts",
];
const delegated = ["extensions/file-search/index.spec.ts"];

function discoverTests(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...discoverTests(absolute));
    if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts"))
    ) {
      found.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return found;
}

const discovered = discoverTests(path.join(root, "extensions")).sort();
const classified = [...unit, ...integration, ...live, ...delegated].sort();
assert.deepEqual(
  classified,
  discovered,
  "Every extension test must be classified as unit, integration, live, or delegated",
);

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killed = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    if (killed.error || killed.status !== 0) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process already settled.
    }
  }
}

export function runChild(command, args, cwd = root, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let cleanupTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
      cleanupTimer = setTimeout(
        () => finish({ exitCode: 124, timedOut: true }),
        5_000,
      );
      cleanupTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (timedOut) finish({ exitCode: 124, timedOut: true });
      else if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("close", (code) => {
      finish({ exitCode: timedOut ? 124 : (code ?? 1), timedOut });
    });
  });
}

async function run(command, args, cwd = root, options = {}) {
  const result = await runChild(command, args, cwd, options);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

async function main() {
  const suite = process.argv[2];
  if (suite === "unit") {
    await run(process.execPath, [
      "--test",
      "--test-timeout=60000",
      "--test-concurrency=4",
      "--experimental-strip-types",
      ...unit,
      "tests/run-test-suite.test.mjs",
    ]);
  } else if (suite === "integration") {
    await run(
      process.execPath,
      [
        "--test",
        "--test-timeout=90000",
        "--test-concurrency=1",
        "--experimental-strip-types",
        ...integration,
      ],
      root,
      { timeoutMs: 20 * 60 * 1_000 },
    );
    const npmCli = process.env.npm_execpath;
    assert.ok(
      npmCli,
      "npm_execpath is required to run the delegated Vitest suite",
    );
    await run(
      process.execPath,
      [npmCli, "test"],
      path.join(root, "extensions", "file-search"),
    );
  } else {
    throw new Error(
      `Unknown suite ${JSON.stringify(suite)}. Use unit or integration.`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
