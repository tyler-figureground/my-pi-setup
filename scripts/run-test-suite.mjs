import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
  "extensions/platform/artifact-store.test.ts",
  "extensions/platform/browser-control.test.ts",
  "extensions/platform/browser-wiring.test.ts",
  "extensions/platform/capability-policy.test.ts",
  "extensions/platform/credential-vault.test.ts",
  "extensions/platform/current-workspace-lease.test.ts",
  "extensions/platform/external-controls.test.ts",
  "extensions/platform/hooks.test.ts",
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
  "extensions/platform/phase5-config.test.ts",
  "extensions/platform/phase6-config.test.ts",
  "extensions/platform/phase7-config.test.ts",
  "extensions/platform/plan-mode.test.ts",
  "extensions/platform/platform-config.test.ts",
  "extensions/platform/platform.test.ts",
  "extensions/platform/review-evidence.test.ts",
  "extensions/platform/review-wiring.test.ts",
  "extensions/platform/reviewer-service.test.ts",
  "extensions/platform/rules.test.ts",
  "extensions/platform/scheduler-calendar.test.ts",
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
  "extensions/subagents/local-review.test.ts",
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
  "extensions/workflows/meta.test.ts",
  "extensions/workflows/serialization.test.ts",
];
const integration = [
  "extensions/background-terminals/manager.test.ts",
  "extensions/git-info/process.test.ts",
  "extensions/platform/artifact-store.integration.test.ts",
  "extensions/platform/browser-playwright.integration.test.ts",
  "extensions/platform/credential-vault.integration.test.ts",
  "extensions/platform/hook-process.integration.test.ts",
  "extensions/platform/hooks.integration.test.ts",
  "extensions/platform/language-intelligence.integration.test.ts",
  "extensions/platform/lifecycle-supervisor.integration.test.ts",
  "extensions/platform/mcp-http.integration.test.ts",
  "extensions/platform/mcp-official.integration.test.ts",
  "extensions/platform/memory-quality.test.ts",
  "extensions/platform/memory-sqlite.integration.test.ts",
  "extensions/platform/messaging-pi-delivery.test.ts",
  "extensions/platform/phase2-composition.test.ts",
  "extensions/platform/phase5-composition.test.ts",
  "extensions/platform/phase4-composition.test.ts",
  "extensions/platform/phase6-composition.test.ts",
  "extensions/platform/pinned-fetch.integration.test.ts",
  "extensions/platform/plan-mode.integration.test.ts",
  "extensions/platform/profiles.test.ts",
  "extensions/platform/project-identity.test.ts",
  "extensions/platform/review-test-evidence.test.ts",
  "extensions/platform/review.test.ts",
  "extensions/platform/rules.integration.test.ts",
  "extensions/platform/session-broker.test.ts",
  "extensions/platform/state-store.integration.test.ts",
  "extensions/platform/workspaces.test.ts",
  "extensions/shared/child-session.test.ts",
  "extensions/subagents/manager.test.ts",
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

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const suite = process.argv[2];
if (suite === "unit") {
  run(process.execPath, [
    "--test",
    "--test-timeout=20000",
    "--experimental-strip-types",
    ...unit,
  ]);
} else if (suite === "integration") {
  run(process.execPath, [
    "--test",
    "--test-timeout=60000",
    "--test-concurrency=1",
    "--experimental-strip-types",
    ...integration,
  ]);
  const npmCli = process.env.npm_execpath;
  assert.ok(
    npmCli,
    "npm_execpath is required to run the delegated Vitest suite",
  );
  run(
    process.execPath,
    [npmCli, "test"],
    path.join(root, "extensions", "file-search"),
  );
} else {
  throw new Error(
    `Unknown suite ${JSON.stringify(suite)}. Use unit or integration.`,
  );
}
