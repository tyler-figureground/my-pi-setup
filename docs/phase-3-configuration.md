# Phase 3 configuration

## Enable capabilities

Global `platform.json` or trusted-project `.pi/platform.json`:

```json
{
  "profiles": true,
  "workspaces": true
}
```

Project configuration is ignored when project trust is false.

## Profile locations

| Scope | Location | Authority |
|---|---|---|
| Managed | host-supplied catalog source | highest |
| User | `<agentDir>/agents/*.yaml` | always trusted user config |
| Project | `<project>/.pi/agents/*.yaml` | trusted projects only |

Precedence: managed, then project, then user. Same-name files in one scope are all rejected. `/agents` browses resolved profiles and diagnostics; `/agents reload` publishes a new generation.

## Profile schema

```yaml
name: security-reviewer
description: Review trust boundaries and unsafe filesystem behavior
backend: pi
model: openai-codex/gpt-5.6-sol
effort: high
instructions:
  inline: Review public behavior and reproduce every security finding.
  files:
    - review-notes.md
skills:
  - skills/security/SKILL.md
allowedTools: [read, rg, fd, write, edit]
disallowedTools: [bash]
maxTurns: 8
timeoutMs: 600000
workspacePolicy: isolated
role: review
```

Fields:

- `name`: lowercase letters, digits, and hyphens; maximum 64 characters
- `backend`: `pi`, `claude`, or `codex`
- `effort`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`
- `instructions.inline`: inline host instructions
- `instructions.files`: files resolved inside profile source directory
- `skills`: `SKILL.md` paths resolved inside profile source directory
- `allowedTools`/`disallowedTools`: canonical tool names; overlap rejected
- `maxTurns`: finalized assistant turns across tool loops; supervisor interrupts at the limit
- `timeoutMs`: host deadline per active run
- `workspacePolicy`: `isolated` or `current`
- `role`: `subagent`, `workflow`, `review`, `scheduled`, or `goal-worker`

Backend limits:

- Isolated Pi profiles require explicit `allowedTools`; shell/process tools are rejected.
- Claude canonical tools map to native names. Unknown names fail spawn.
- Codex profiles with tool restrictions fail spawn because current app-server cannot enforce them. Use an unrestricted isolated Codex profile when `workspace-write` is sufficient.

## Spawning

Named profile:

```json
{
  "prompt": "Review the current change and report findings.",
  "name": "security review",
  "profile": "security-reviewer"
}
```

Ad hoc compatibility:

```json
{
  "prompt": "Inspect this directory.",
  "name": "inspection",
  "harness": "pi",
  "working_dir": "./fixture"
}
```

Ad hoc `working_dir` is unisolated. An isolated profile rejects `working_dir`.

## Guarded workspace storage

- Windows: `%LOCALAPPDATA%/pi-agent/workspaces/<project-id-prefix>/`
- Other platforms: `<agentDir>/workspaces/<project-id-prefix>/`
- State: `<agentDir>/state/platform.sqlite`

`/workspaces` opens interactive review/integrate/abandon actions. `workspace_list` is read-only and model-callable.

## `.worktreeinclude`

Optional repository-root file, one relative path per line. Comments begin with `#`.

```text
# Local generated configuration
.dev/config.json
.env.test
```

Limits: 64 entries, 10,000 copied filesystem entries, 64MB total, regular files/directories only. Links, junctions, escapes, and overwrites fail creation. Secret-like names generate warnings.
