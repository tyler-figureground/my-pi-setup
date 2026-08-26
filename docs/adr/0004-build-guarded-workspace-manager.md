# ADR 0004: Build guarded workspace manager

- Status: Accepted
- Date: 2026-08-25

## Context

Phase 3 requires durable workspace states, fenced leases, profile/trust binding, recovery, dirty-state dispositions, protected-main isolation, and Windows junction-safe cleanup.

Exact `@narumitw/pi-worktree@0.51.5` was audited and trialed on native Windows. It provides strong argv-only Git operations, porcelain parsing, exact object IDs, revalidation, and broad dirty/recovery checks. It exposes an interactive command rather than a reusable workspace authority. It has no lease, agent isolation, integration, or crash-recovery interface.

Native trial reproduced a release blocker: an ignored `node_modules` NTFS junction caused Git to deregister the worktree while retaining the junction and worktree directory. Package UI reported successful removal. Shared target survived, but cleanup postconditions were false.

Detailed evidence: `docs/research/pi-worktree-audit.md`.

## Decision

Build internal `WorkspaceManager` behind platform interfaces. Do not install, wrap, or copy package implementation.

Port reviewed behaviors as independently implemented tests and invariants:

- fixed argv Git commands
- NUL-delimited porcelain
- explicit verified base object IDs
- post-confirmation identity and dirty-state revalidation
- detached, index, submodule, ignored, untracked, and unpushed checks
- durable recovery records
- public Pi session switching

Additional platform requirements:

- `StateStore` records and fenced leases
- managed workspace paths only
- profile, role, project identity, trust, session, and owner binding
- persisted creating/integration sagas
- explicit preserve/review/integrate/abandon dispositions
- no recursive filesystem deletion
- detach Windows junctions before Git removal
- verify shared targets, registration, path, and administrative metadata after cleanup
- preserve blocked/partial workspaces with recovery diagnostics

## Consequences

More implementation than adopting one command, but authority and recovery remain local and testable. Package updates do not silently alter cleanup semantics. Any substantially copied source would require MIT attribution; this implementation ports behavior and independently implements code.

`profiles` and `workspaces` feature flags remain unavailable until end-to-end acceptance passes.
