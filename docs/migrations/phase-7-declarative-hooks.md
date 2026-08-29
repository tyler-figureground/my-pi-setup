# Migrate one-off TypeScript hooks to declarative hooks

Phase 7 declarative hooks cover bounded event matching and allowlisted actions without loading project TypeScript. Keep TypeScript extensions for custom algorithms, custom UI, or integrations that do not fit named adapters.

## Locations

- User hooks: `~/.pi/agent/hooks.yaml`
- Trusted-project hooks: `<project>/.pi/hooks.yaml`

Project hooks are ignored until the project is trusted. Any file identity, content digest, or trust change suspends that source before another action. Inspect and apply the new generation with `/hooks inspect` and `/hooks reload`.

## Version 1 compatibility

Version 1 remains accepted for one action per hook:

```yaml
version: 1
hooks:
  - id: block-direct-main-push
    event: tool_call
    priority: 0
    match:
      toolName: bash
      input.command:
        contains: "git push origin main"
    action:
      type: policy
      decision: deny
      reason: Direct pushes to main are blocked.
    timeoutMs: 1000
    outputCapBytes: 4096
    failurePolicy: closed
```

No migration is required unless a hook needs multiple ordered actions or named HTTP, MCP, or Agent Profile execution.

## Version 2

Version 2 replaces `action` with `actions`, `timeoutMs` with `deadlineMs`, and adds a per-hook concurrency limit.

```yaml
version: 2
hooks:
  - id: explain-direct-main-push
    event: tool_call
    priority: 0
    match:
      toolName: bash
      input.command:
        contains: "git push origin main"
    actions:
      - type: policy
        decision: deny
        reason: Direct pushes to main are blocked.
      - type: notify
        level: warning
        message: Use a reviewed branch and pull request.
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 4096
    failurePolicy: closed
```

Actions execute in declaration order. Hooks execute by priority, canonical source, then hook ID.

## TypeScript mapping

### Event handler

Before:

```ts
pi.on("agent_end", async (event, ctx) => {
  ctx.ui.notify("Agent settled", "info");
});
```

After:

```yaml
version: 2
hooks:
  - id: agent-ended
    event: agent_end
    priority: 0
    match: {}
    actions:
      - type: notify
        level: info
        message: Agent settled
    concurrency: 1
    deadlineMs: 1000
    outputCapBytes: 4096
    failurePolicy: open
```

### Structured process

Before:

```ts
await pi.exec("git", ["status", "--short"], { timeout: 5000 });
```

After:

```yaml
- id: inspect-status
  event: agent_end
  priority: 0
  match: {}
  actions:
    - type: command
      executable: git
      args: [status, --short]
  concurrency: 1
  deadlineMs: 5000
  outputCapBytes: 16384
  failurePolicy: open
```

Command actions use an exact executable and argument array. Shell strings, environment overrides, stdin, and implicit command interpolation are not supported.

### Named integrations

```yaml
- id: inspect-build
  event: agent_end
  priority: 0
  match: {}
  actions:
    - type: http
      name: build-status
      input:
        build: 42
    - type: mcp
      name: github.get_pull
      input:
        number: 7
    - type: agent
      profile: reviewer
      prompt: Review the completed change.
  concurrency: 1
  deadlineMs: 30000
  outputCapBytes: 32768
  failurePolicy: open
```

Names resolve through host configuration. Hook YAML cannot provide URLs, headers, credentials, model names, tool policy, role, or trust. Missing adapters fail safely.

## Failure policy

- `open`: record failure and continue later actions. Use for observe-only events.
- `closed`: stop the hook and block the host operation. Accepted only for gate events that Pi can actually cancel.

Gate events include tool calls, input, user bash, context, and session switch/fork/compaction/tree preflight.

Plan Mode and CapabilityPolicy remain authoritative. An `allow` action cannot override either one. Actions needing direct confirmation are blocked on unattended events.

## Supported platform events

Phase 7 adds typed worktree, subagent, task, monitor, and Schedule events. Goal Engine events are not available before Phase 8.

Use `/hooks validate` before applying a changed file. Use `/hooks logs` for bounded sanitized execution history.

## Keep TypeScript when

Keep a trusted extension when behavior requires:

- custom event transformation or branching logic
- custom TUI components
- an integration that has no reviewed named adapter
- large data processing better stored as an Artifact
- dynamic monitor or Schedule creation

Declarative hooks intentionally cannot create Reactive Monitors or Schedules. This prevents recursive daemon creation.
