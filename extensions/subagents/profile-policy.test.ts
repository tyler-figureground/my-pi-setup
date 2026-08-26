import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedExecutionPolicy } from "../shared/agent-profile.ts";
import { claudeReasoningOptions } from "./src/backends/claude.ts";
import {
  compileClaudeExecutionPolicy,
  compileCodexExecutionPolicy,
  compilePiExecutionPolicy,
} from "./src/profile-policy.ts";

function policy(
  patch: Partial<ResolvedExecutionPolicy> = {},
): ResolvedExecutionPolicy {
  return {
    role: "review",
    instructions: ["Review trust boundaries."],
    skills: [{ path: "skill.md", content: "Use adversarial tests." }],
    tools: { allowed: ["read", "rg"], denied: ["bash"] },
    limits: { maxTurns: 8, timeoutMs: 60_000 },
    workspace: "isolated",
    ...patch,
  };
}

test("Pi compiler rejects unconfined isolated tools and forces shell denial", () => {
  assert.deepEqual(compilePiExecutionPolicy(policy()), {
    allowedTools: ["read", "rg"],
    disallowedTools: ["bash", "powershell"],
    appendSystemPrompt: ["Review trust boundaries.", "Use adversarial tests."],
    role: "review",
  });
  assert.throws(
    () =>
      compilePiExecutionPolicy(
        policy({ tools: { allowed: ["custom-mutation"], denied: [] } }),
      ),
    /cannot confine tool/,
  );
});

test("Claude reasoning uses current adaptive effort options", () => {
  assert.deepEqual(claudeReasoningOptions(undefined), {});
  assert.deepEqual(claudeReasoningOptions("off"), {
    thinking: { type: "disabled" },
  });
  assert.deepEqual(claudeReasoningOptions("minimal"), {
    thinking: { type: "adaptive" },
    effort: "low",
  });
  assert.deepEqual(claudeReasoningOptions("max"), {
    thinking: { type: "adaptive" },
    effort: "max",
  });
});

test("Claude compiler maps canonical restrictions to actual tool availability", () => {
  assert.deepEqual(compileClaudeExecutionPolicy(policy()), {
    tools: ["Read", "Grep"],
    disallowedTools: ["Agent", "Task", "Bash"],
    appendSystemPrompt: "Review trust boundaries.\n\nUse adversarial tests.",
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
    },
  });
});

test("Codex compiler uses workspace-write and rejects unrepresentable tool restrictions", () => {
  const rejected = compileCodexExecutionPolicy(policy());
  assert.equal(rejected.ok, false);
  if (!rejected.ok)
    assert.match(rejected.error, /cannot enforce tool restrictions/i);
  assert.equal(
    compileCodexExecutionPolicy(policy({ tools: { allowed: [], denied: [] } }))
      .ok,
    false,
  );

  assert.deepEqual(
    compileCodexExecutionPolicy(policy({ tools: { denied: [] } })),
    {
      ok: true,
      value: {
        sandbox: "workspace-write",
        developerInstructions:
          "Review trust boundaries.\n\nUse adversarial tests.",
      },
    },
  );
});
