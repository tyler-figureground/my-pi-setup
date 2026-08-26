# Guarded workspace recovery runbook

## Rule

Never recursively delete a guarded workspace. Never use `rm -rf`, PowerShell recursive removal, or manual worktree-directory deletion.

## Automatic startup recovery

Platform startup calls `WorkspaceManager.recover()` for the current trusted Git project.

Recovery:

1. Reads durable project workspace records and lease state.
2. Ignores active unexpired leases.
3. Reclaims an expired lease with a higher fence.
4. Revalidates lexical path, canonical path, common Git directory, and current commit.
5. Re-inspects dirty state.
6. Releases recovery lease and restores `ready`, `dirty`, or `reviewed` state.
7. Reports unsafe identities and partial operations as blocked.

A blocked report is not permission to remove files manually.

## Inspection

Run `/workspaces` in TUI or call `workspace_list`.

Record:

- workspace ID and state
- lexical managed path
- project and current commit
- tracked, staged, untracked, ignored, submodule, detached, unpushed, and index-flag status
- current owner/fence/expiry when leased
- startup recovery warning

## Valid actions

### Preserve

Use when work may still be needed. Revalidates identity, releases lease, and records `ready`, `dirty`, or `reviewed`. No filesystem removal.

### Mark reviewed

Requires dirty/reviewable work plus bounded evidence. Keeps data and records `reviewed`.

### Integrate

Requires reviewed state, clean protected checkout, exact target branch, and exact expected target commit. Only fast-forward integration is allowed. Workspace cleanup then uses guarded link detachment and Git removal postconditions.

If target changed, re-review against new target. Do not bypass compare-and-swap.

### Abandon

Requires explicit data-loss acknowledgement when any dirty/ignored/detached/unpushed/index/submodule state exists.

Cleanup sequence:

1. Rebind owner/fence and inspect again.
2. Claim Git-operation guard.
3. Inventory links without following them.
4. Record each target identity.
5. Detach each link/junction itself.
6. Verify each target identity survived.
7. Run `git worktree remove --force -- <managed-path>`.
8. Verify registration absent and lexical path absent.
9. Release leases and record `abandoned`.

## Partial cleanup

If cleanup or integration returns `GIT_FAILED`:

- stop
- preserve the path and state database
- do not manually continue deletion
- inspect Git worktree registration and blocked diagnostic
- confirm shared targets still exist
- remove external locks or close processes only when identified
- retry through `/workspaces`

A missing Git registration with a remaining directory is still partial failure, not success.

## Native Windows junction check

Before and after any recovery involving `node_modules`:

1. Record target path and sentinel/hash.
2. Confirm link is detached, not traversed.
3. Confirm target path and sentinel/hash are unchanged.
4. Confirm guarded workspace path outcome matches durable state.

DLL-locked dependency backups must remain outside guarded workspace roots until no Pi process holds them.
