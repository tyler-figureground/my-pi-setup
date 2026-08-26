# Phase 3 TUI smoke checklist

Automated extension, RPC, reload, and shutdown smoke runs cover command/tool registration and lifecycle. Real terminal input remains manual.

## `/agents`

- Opens profile browser.
- Shows generation, source scope, backend/model, workspace policy, role, digest prefix.
- Shows validation, collision, shadowing, and path diagnostics as browser rows.
- `/agents reload` publishes a new generation without changing running children.
- No profile file body or secret material appears in diagnostics.

## `/workspaces`

- Lists ready, leased, dirty, reviewed, integrated, and abandoned states.
- Shows dirty classifications without exposing managed root to model tools.
- Leased workspace refuses user disposition until settlement or recovery.
- Dirty workspace review requires evidence.
- Integration requests target branch and full expected commit.
- Abandon requires explicit confirmation.
- Blocked recovery notification names workspace ID and reason.

## Subagents

- Profile and workspace identity appear in `/subagents` rows.
- Ad hoc children show `unisolated`.
- Guarded children show workspace ID but model-facing output uses project paths.
- Settlement preserves workspace and clears lease.
- Failed preservation displays explicit error/recovery context.

## Windows cleanup

- Successful junction cleanup leaves shared target and sentinel intact.
- Failed locked-worktree cleanup leaves workspace blocked and target intact.
- No recursive delete command appears.
