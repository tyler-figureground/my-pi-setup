# Phase 7 TUI smoke checklist

Automated RPC and fixture checks run in repository verification. Real terminal keystrokes remain a manual acceptance gate.

## Preparation

1. Confirm `hooks`, `monitors`, and `scheduler` are enabled in `~/.pi/agent/platform.json`.
2. Confirm messaging accepts same-project delivery.
3. Create a read-only Agent Profile with role `scheduled`.
4. Run `/reload`.

## Hooks

- [ ] `/hooks inspect` lists user and trusted-project sources with revision and action types.
- [ ] `/hooks validate` reports valid configuration without applying it.
- [ ] Change a Hook file. Confirm source becomes visibly suspended before another action.
- [ ] `/hooks reload` applies one complete generation or retains the prior generation with a visible error.
- [ ] `/hooks logs` shows bounded sanitized history.
- [ ] Enter Plan Mode. Confirm command, HTTP, MCP, and agent actions remain denied.

## Terminal monitor

1. Start a background terminal that prints a known line after a short delay.
2. Create a session terminal Monitor for that terminal ID and literal line.
3. Confirm exact mutation dialog shows source/matcher digest, ID, scope, and revision without secret content.
4. Confirm one bounded untrusted Monitor result appears after the line.
5. Pause the Monitor and produce another matching line. Confirm no delivery after pause acknowledgement.
6. Resume, inspect, stop, and delete by exact revision.

- [ ] Existing `/ps`, `bg_status`, settlement notification, and kill behavior remain unchanged.
- [ ] Monitor stop never kills the observed terminal.

## File monitor

- [ ] Create a temporary directory under the current project.
- [ ] Start a session file Monitor.
- [ ] Create, update, rename, and delete a file. Confirm burst coalescing and bounded evidence.
- [ ] Create a nested directory and immediate child. Confirm reconciliation observes it.
- [ ] Confirm `.git`, platform state, Artifact paths, and junction targets are ignored/refused.
- [ ] Pause/delete and confirm no later event.

## Poll and WebSocket monitors

Use only reviewed local fixtures or configured origins.

- [ ] Named poll Monitor starts no overlapping request and shows offline/backoff state without leaking credentials.
- [ ] WebSocket Monitor connects only to an exact allowlisted origin.
- [ ] Redirect, private-address denial, oversized frame, reconnect exhaustion, and close remain visible and bounded.
- [ ] Stop/reload leaves no socket or poll timer.

## Scheduled Prompt

```text
/schedule create one-shot smoke-once <future-RFC3339> durable run-once <scheduled-profile> -- Inspect the repository read-only and report one line.
```

- [ ] Confirmation shows normalized time, profile, prompt SHA-256, prompt byte count, ID, and revision. It does not echo prompt body.
- [ ] `/schedules history` shows bounded untrusted metadata.
- [ ] One Scheduled Occurrence runs with `scheduled` role and exact profile tools.
- [ ] Result arrives once through mailbox with Artifact reference.
- [ ] Pause/resume/run-now/delete require exact current revision.
- [ ] Restart before a future occurrence. Confirm durable definition recovers.
- [ ] Paused or deleted Schedule never runs.

## Lifecycle

- [ ] `/reload` with active terminal/file/poll/WebSocket Monitors leaves no old callback or duplicate delivery.
- [ ] `/new`, `/resume`, `/fork`, and quit close old watchers, timers, sockets, and claims.
- [ ] No Phase 7 event arrives after shutdown acknowledgement.
- [ ] Child sessions expose no Monitor or Scheduler daemon/tools.

## Expected manual limitation

Windows Task Scheduler is not installed or modified. Scheduled Prompts run while a Parent Pi process is active. Missed policy applies when Parent Pi returns.
