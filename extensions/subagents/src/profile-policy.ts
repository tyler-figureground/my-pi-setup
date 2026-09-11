/**
 * Compiles an Agent Profile's `ResolvedExecutionPolicy` into each backend's
 * native restrictions: Pi child-loader tool lists and prompt, Claude Agent SDK
 * `tools`/`disallowedTools`/sandbox, Codex sandbox mode.
 *
 * Fail-closed: a restriction a backend cannot represent exactly is refused,
 * never approximated. Isolated Pi profiles need an explicit allowlist of
 * confinable tools and always lose `bash`/`powershell`; Claude throws on an
 * unmapped tool name and always denies `Agent`/`Task`; Codex returns
 * `ok: false` for any tool restriction. Used by `backends/{pi,claude,codex}.ts`
 * and, as a pre-spawn "can this profile run" check, by `scheduled-agent.ts`,
 * `goal-worker.ts`, and `named-profile-execution.ts`.
 * See docs/architecture/phase-3-profiles-workspaces.md.
 */

import type { ResolvedExecutionPolicy } from "../../shared/agent-profile.ts";

const CLAUDE_TOOL_MAP = new Map<string, string>([
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["bash", "Bash"],
  ["grep", "Grep"],
  ["rg", "Grep"],
  ["find", "Glob"],
  ["fd", "Glob"],
  ["glob", "Glob"],
  ["web-search", "WebSearch"],
  ["web_search", "WebSearch"],
  ["web-fetch", "WebFetch"],
  ["web_fetch", "WebFetch"],
  ["Read", "Read"],
  ["Write", "Write"],
  ["Edit", "Edit"],
  ["Bash", "Bash"],
  ["Grep", "Grep"],
  ["Glob", "Glob"],
  ["WebSearch", "WebSearch"],
  ["WebFetch", "WebFetch"],
]);

function instructions(policy: ResolvedExecutionPolicy) {
  return [
    ...policy.instructions,
    ...policy.skills.map((skill) => skill.content),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function claudeTool(name: string) {
  const mapped = CLAUDE_TOOL_MAP.get(name);
  if (!mapped) {
    throw new Error(
      `Claude backend cannot enforce unknown canonical tool ${JSON.stringify(name)}.`,
    );
  }
  return mapped;
}

const PI_ISOLATED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "rg",
  "fd",
]);

export function compilePiExecutionPolicy(policy: ResolvedExecutionPolicy) {
  if (policy.workspace === "isolated") {
    if (!policy.tools.allowed) {
      throw new Error(
        "Isolated Pi profiles require an explicit allowedTools list.",
      );
    }
    const unsupported = policy.tools.allowed.filter(
      (tool) => !PI_ISOLATED_TOOLS.has(tool),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Isolated Pi profile cannot confine tool ${JSON.stringify(unsupported[0])}.`,
      );
    }
  }
  return {
    allowedTools: policy.tools.allowed,
    disallowedTools: [
      ...new Set([
        ...policy.tools.denied,
        ...(policy.workspace === "isolated" ? ["bash", "powershell"] : []),
      ]),
    ],
    appendSystemPrompt: [
      ...policy.instructions,
      ...policy.skills.map((skill) => skill.content),
    ],
    ...(policy.resources
      ? {
          allowProjectResources: policy.resources.project,
          ...(policy.resources.contextFiles === undefined
            ? {}
            : { allowContextFiles: policy.resources.contextFiles }),
        }
      : {}),
    role: policy.role,
  };
}

export function compileClaudeExecutionPolicy(policy: ResolvedExecutionPolicy) {
  return {
    ...(policy.tools.allowed
      ? { tools: [...new Set(policy.tools.allowed.map(claudeTool))] }
      : {}),
    disallowedTools: [
      ...new Set(["Agent", "Task", ...policy.tools.denied.map(claudeTool)]),
    ],
    appendSystemPrompt: instructions(policy),
    ...(policy.workspace === "isolated"
      ? {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
          },
        }
      : {}),
  };
}

export function compileCodexExecutionPolicy(policy: ResolvedExecutionPolicy):
  | {
      readonly ok: true;
      readonly value: {
        readonly sandbox: "workspace-write" | "danger-full-access";
        readonly developerInstructions: string;
      };
    }
  | { readonly ok: false; readonly error: string } {
  if (policy.tools.allowed !== undefined || policy.tools.denied.length > 0) {
    return {
      ok: false,
      error:
        "Codex app-server cannot enforce tool restrictions for this profile.",
    };
  }
  return {
    ok: true,
    value: {
      sandbox:
        policy.workspace === "isolated"
          ? "workspace-write"
          : "danger-full-access",
      developerInstructions: instructions(policy),
    },
  };
}
