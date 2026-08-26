# Phase 4 checkpoint

Updated: 2026-08-25

## Objective

Implement Phase 4 only from `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`:

- F04 LSP diagnostics and symbol navigation
- F06 first-class local review

Do not begin Phase 5.

## Repository state

- Base: `7b7654c`
- Branch: `pi-capabilities-phase-4`
- Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-4`
- Live `main` was ahead 0 / behind 0 from `fork/main` before branch creation.
- Preserve live deleted `AGENTS.md` and untracked `skills/impeccable/`.
- Preserve DLL backup at `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase1-live-backup-20260825-144510`.

## Phase plan

- [x] Fetch remotes and confirm live state.
- [x] Create isolated Phase 4 branch/worktree.
- [x] Confirm public test seams with user: `LanguageIntelligence`, `LocalReview`, platform wiring, and real adapters.
- [x] Install isolated dependencies and establish baseline verification: 167 unit, 145 integration plus 22 delegated, 4 POSIX-only skips, smoke pass.
- [x] Define language-intelligence and local-review invariants/interfaces.
- [x] Trial exact pinned `@narumitw/pi-lsp@0.49.6`; retain research, replace transient runtime.
- [x] Implement F04 in vertical red-green slices.
- [x] Benchmark TypeScript/Ruff and site-axis/Chronos/Pyvoid against native checks.
- [x] Implement F06 review model, execution, artifacts, TUI/RPC, immutable evidence, and disposable tests in vertical red-green slices.
- [x] Run iterative security/architecture/acceptance reviews; fix all reproduced blocker/high findings with regressions.
- [x] Complete acceptance evidence, documentation, performance evidence, smoke contract, and tracker.
- [ ] Re-fetch, publish, fast-forward live `main`, and verify without disturbing dirty state.
- [x] Stop before Phase 5.

## Constraints

- Repository-native build/typecheck/test remains authoritative.
- Review path must never mutate source.
- Fetch before remote/base assessment and publication.
- LSP processes live under bounded lifecycle supervision.
- Worktree paths map through canonical project identity.
- Full review artifacts stay outside model context.
- No acceptance checkbox without recorded evidence.
