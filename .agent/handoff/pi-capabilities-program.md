# Pi capabilities program handoff

Updated: 2026-08-24

## Objective

Execute the durable implementation program for every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md`.

## Source-of-truth plan

`docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`

## Current phase

Phase 0 baseline stabilization complete. Stop before Phase 1 pending Tyler review.

## Completed this session

- [x] Fetched remote before survey; started `pi-capabilities-phase-0` from `origin/main`.
- [x] Created external worktree at `~/.worktrees/my-pi-setup/pi-capabilities-phase-0` with independent `node_modules` installs.
- [x] Preserved live deleted `AGENTS.md`, modified `extensions/subagents/src/backends/codex.ts`, and untracked `skills/impeccable/`.
- [x] Aligned Pi packages to exact `0.84.3` and Effect ecosystem to exact `4.0.0-beta.101`.
- [x] Documented Node `>=22.19.0`, dependency updates, and reproducible root/extension installs.
- [x] Fixed Windows `cmd.exe` argument handling, background-terminal tree termination, truthful kill reporting, platform-path fixtures, and Codex `.cmd` launch.
- [x] Added deterministic unit/integration partition, isolated live tests, timeout/discovery guards, changed-file formatting, smoke, and aggregate verification scripts.
- [x] Added LF policy and made formatting gate green.
- [x] Added offline production-extension, print, JSON, RPC, reload, shutdown, and process-leak smoke coverage.
- [x] Added `docs/verification/phase-0-tui-smoke.md`.
- [x] Reconciled protected Codex launcher intent on the implementation branch: explicit `cmd.exe` boundary now handles `.cmd` and `.bat`, retains rationale, and has regression coverage.
- [x] Corrected pruning-history verification to compare retained status with the original settlement, eliminating a concurrent Windows-load false assumption without weakening behavior.

## In progress

- [ ] None. Phase 1 intentionally not started.

## Blocked

- Automated visual TUI verification needs a real ConPTY terminal. Attempt through this harness returned `stdin is not a tty`; manual checklist recorded. Headless lifecycle counterparts pass.
- Applying the branch to live config still requires explicit integration approval. Codex reconciliation is complete and verified on the implementation branch; no live file was changed.

## Files changed

- `.gitattributes` - LF/Windows command-file policy.
- `package.json`, `package-lock.json`, extension package manifests/locks - dependency pins and verification scripts.
- `extensions/background-terminals/` - Windows shell/process fixes and regression coverage.
- `extensions/file-search/index.spec.ts` - platform-native path fixtures.
- `extensions/subagents/src/backends/codex.ts`, `codex-process.test.ts` - Windows `.cmd`/`.bat` command-shim launcher and tests.
- `extensions/background-terminals/manager.test.ts` - pruning history asserts preserved settlement status under concurrent Windows load.
- `scripts/` - test partition, dependency install, changed-file formatting.
- `tests/smoke/` - offline CLI lifecycle harness.
- `SETUP.md`, Effect notes, TUI checklist - setup and verification documentation.
- `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md` - Phase 0 checkboxes, ledger, decisions, risks.

## Verification

- `npm ci` - pass.
- `npm run install:extensions:ci` - pass for all 10 extension packages.
- Pi dependency tree - all direct/nested Pi libraries `0.84.3`.
- Effect topology - all seven Effect-using extension trees `4.0.0-beta.101`.
- `npm run verify` - pass.
- Unit - 75 pass.
- Integration - 67 pass; 4 POSIX-only cases skipped on Windows.
- Smoke - pass: production extensions, print, JSON, RPC, reload, shutdown, no leaks.
- Live Claude/Codex - 4/4 pass.
- TUI visual checklist - not run; harness lacks TTY/ConPTY input.

## Repo state

- Branch: `pi-capabilities-phase-0`
- Ahead 6 / behind 0 after reconciliation continuity commit
- Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-0`
- Pre-existing dirty files preserved: yes
- Live checkout remained on `main`

## Commits

- `4dd6b32` - LF formatting baseline.
- `366fa6f` - Phase 0 dependency, process, test, and smoke stabilization.
- `2c58fa3` - Codex Windows command-shim regression test.
- `87a2dca` - plan, ledger, risks, decisions, and handoff.
- `1b1e784` - protected Codex launcher synthesis and pruning-history regression stabilization.
- Reconciliation continuity commit - verification ledger, decision, and handoff update.

## Next exact action

Request explicit approval to integrate the verified Phase 0 branch into the protected live checkout. Do not begin Phase 1 until explicitly requested.
