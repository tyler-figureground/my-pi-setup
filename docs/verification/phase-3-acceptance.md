# Phase 3 acceptance evidence

Date: 2026-08-25

## Deterministic verification

- TypeScript root and extension checks: pass
- Prettier check: pass
- Unit: 167 pass
- Integration: 145 pass, 4 POSIX-only skipped
- Delegated file-search: 22 pass
- Repository smoke: extension discovery, print, JSON, RPC, reload, shutdown, no leaks

## F09 profiles

- Managed over project over user precedence; same-scope collision rejection
- Untrusted project directory not read
- YAML aliases, bytes, nodes, depth, file counts, material bytes, links, junctions, and traversal bounded/rejected
- Relative instruction/skill material resolved with regular-file identity checks
- Immutable digest/generation publication and hot reload
- Named spawn override matrix and ad hoc compatibility
- Pi/Claude/Codex policy compilers fail closed where backend cannot enforce
- Supervisor timeout and finalized assistant-turn limit
- Snapshot, normalized transcript metadata, Pi session entry, spawn details, and `/agents` browser provenance

## F02 workspaces

Native Windows fixtures verify:

- explicit/current/fresh-remote exact base commits
- dirty parent contents and status unchanged
- parallel child paths/writes do not collide
- fenced lease collision and stale-fence rejection
- expired process lease recovery with higher fence
- canonical path/common Git registration rebind
- tracked, staged, untracked, ignored, detached, unpushed, submodule/index detection implementation
- bounded `.worktreeinclude` plus secret warnings
- review evidence bound to exact commit
- clean expected-target fast-forward integration
- dirty cleanup refusal
- successful junction detach and shared-target survival
- locked/failed cleanup remains blocked and shared target survives
- no recursive deletion
- settlement preservation and no restart after lease release
- operation guards block stale recovery during Git mutation

Recovery procedure: `docs/runbooks/phase-3-workspace-recovery.md`.

## Backend matrix

| Backend | Evidence | Result |
|---|---|---|
| Pi | Live profiled in-process run, model/effort/profile metadata | 1/1 pass |
| Claude | Baseline live completion/interrupt before quota; compiler, sandbox, unconditional PreToolUse containment tests | External quota blocked final rerun |
| Codex | Live completion/interrupt; workspace-write compiler; native multi-agent disabled | 2/2 pass |

Claude final rerun returned account session limit text. Earlier Phase 3 baseline Claude completion/interrupt passed 2/2 before quota exhaustion. No Phase 3 code changes credentials or account state.

## Independent review

Architecture, backend, and security rounds reproduced lease expiry, Claude native-write escape, reviewed-commit drift, Codex empty allowlist/native delegation, managed-path tampering, Git hooks, cleanup postconditions, and lifecycle races. Fixes landed with focused regressions.

Final independent blocker check: no unresolved code blockers.

## Manual limit

Harness cannot provide real terminal keystrokes. Automated TUI call paths and RPC behavior pass. Manual checklist: `docs/verification/phase-3-tui-smoke.md`.
