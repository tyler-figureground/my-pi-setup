# Plan mode, lazy rules, and declarative hooks

Phase 2 is enabled by `~/.pi/agent/platform.json`:

```json
{
  "planMode": true,
  "hooks": true,
  "rules": true,
  "plan": {
    "defaultScope": "user",
    "userDirectory": "plans",
    "projectDirectory": ".pi/plans"
  }
}
```

Run `/reload` after changing flags or configuration.

## Plan mode

```text
/plan Plan the authentication refactor
/plan user Plan changes without writing into the project
/plan project Plan and store the plan under this trusted project
/plan status
/plan approve
/plan cancel
```

Planning disables agent and hook access to shell, write, edit, orchestration, publishing, credential use, remote writes, and unknown tools. Local reads plus dedicated `git_status`, `git_diff`, `git_log`, `git_show`, and `git_list_files` tools remain available. Explicit extension commands and direct RPC administrative commands are operator actions outside agent tool policy; do not invoke mutating operator commands while reviewing a plan.

Approval always opens a direct user confirmation. Agent output, hook actions, and messages from another session cannot approve a plan. Approved plans restore exactly the tool set active before planning.

Plans use create-new writes and never overwrite an existing plan. `plan.userDirectory` and `plan.projectDirectory` are bounded relative paths beneath their roots. `plan.defaultScope` chooses `user` or `project`:

- default user plans: `~/.pi/agent/plans/`
- default project plans: `<project>/.pi/plans/`, trusted projects only

## Lazy rules

Put Markdown rules in:

- user: `~/.pi/agent/rules/`
- project: `<project>/.pi/rules/`, trusted projects only

Example:

```markdown
---
id: frontend-tests
include:
  - "src/frontend/**/*.test.ts"
exclude:
  - "src/frontend/generated/**"
priority: 20
---

Test behavior through public module interfaces.
```

Fields:

| Field | Required | Limits |
|---|---|---|
| `id` | yes | 1-128 letters, digits, dots, underscores, or hyphens |
| `include` | no | String patterns; defaults to `**/*` |
| `exclude` | no | String patterns; defaults to none |
| `priority` | no | Integer from -1000 through 1000; defaults to 0 |

Rules use forward-slash Git-style patterns. Absolute paths, `..`, backslashes, negated patterns, aliases, unknown fields, duplicate IDs, and oversized content are rejected.

Commands:

```text
/rules
/rules reload
```

`/rules` shows source, active state, and activation reason. Rule bodies are absent from startup context and load only after a matching canonical project path appears. One activation injects at most 16 rules and 256 KiB.

## Declarative hooks

Put YAML configuration in:

- global: `~/.pi/agent/hooks.yaml`
- project: `<project>/.pi/hooks.yaml`, trusted projects only

See [`docs/examples/phase-2-hooks.yaml`](examples/phase-2-hooks.yaml).

Each hook requires:

```yaml
- id: unique-id
  event: tool_call
  priority: 0
  match:
    toolName: write
  action:
    type: policy
    decision: deny
    reason: "Direct writes are disabled."
  timeoutMs: 500
  outputCapBytes: 1024
  failurePolicy: closed
```

Action types:

- `command`: `executable` plus `args`; no implicit shell
- `notify`: static `message` and `level`
- `status`: namespaced `key` and nullable `text`
- `context`: static trusted content on supported context events
- `policy`: `allow`, `deny`, or `require-user-confirmation` on supported policy events

Commands:

```text
/hooks
/hooks validate
/hooks reload
/hooks logs
```

Invalid reloads keep the last known-good hook set. Logs are bounded and redact likely credentials. Command stdout and stderr never enter logs or model context. Commands run without a shell through a minimal environment and bounded process-tree runner. Nonsensitive truncated output streams to a restrictive temporary directory with a 16 MiB hard cap; exceeding the cap terminates the process. Likely-sensitive spills are deleted.

## Security limits

- Project rules and hooks are ignored until Pi reports that project trusted.
- Symlink, junction, and traversal escapes are rejected.
- YAML aliases are disabled. Document bytes, depth, nodes, matchers, hooks, time, and outputs are bounded.
- Hook commands run with user privileges. This is policy enforcement, not an operating-system sandbox.
- `before_agent_start` supports fail-open context, notification, and status effects only because Pi cannot block that event before provider execution.
- Hook `allow` never overrides plan-mode denial.
- Plan mode prevents mutation, not disclosure through allowed reads.

## Rollback

Set flags to `false` and run `/reload`:

```json
{
  "planMode": false,
  "hooks": false,
  "rules": false
}
```

Disabling capabilities does not delete plan files, rule files, hook configuration, or stored artifacts.
