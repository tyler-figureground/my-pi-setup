# Pi capabilities program handoff

Updated: 2026-08-24

## Objective

Execute the durable implementation program for every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md`.

## Source-of-truth plan

`docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`

## Current phase

Phase 0 baseline stabilization complete and integrated into live `main`. Stop before Phase 1 pending Tyler approval.

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
- [x] Fast-forwarded verified Phase 0 into live `main` while preserving deleted `AGENTS.md` and untracked `skills/impeccable/`.
- [x] Installed live dependency trees, relocated DLL-locked prior trees to an external safety backup, normalized the live worktree under LF policy, and passed full verification from the live checkout.

## In progress

- [ ] None. Phase 1 intentionally not started.

## Blocked

- Automated visual TUI verification needs a real ConPTY terminal. Attempt through this harness returned `stdin is not a tty`; manual checklist recorded. Headless lifecycle counterparts pass.
- None for Phase 0 integration.

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

- Root `npm ci` - pass.
- Extension dependency installs and `npm ls --depth=0` - pass for all 10 extension packages. Loaded native DLLs required relocating four prior `node_modules` trees outside the repo before fresh installs.
- Pi dependency tree - all direct/nested Pi libraries `0.84.3`.
- Effect topology - all seven Effect-using extension trees `4.0.0-beta.101`.
- `npm run verify` - pass.
- Unit - 75 pass.
- Integration - 67 pass; 4 POSIX-only cases skipped on Windows.
- Smoke - pass: production extensions, print, JSON, RPC, reload, shutdown, no leaks.
- Live Claude/Codex - 4/4 pass.
- TUI visual checklist - not run; harness lacks TTY/ConPTY input.

## Repo state

- Live branch: `main`, tracking `fork/main`
- Ahead 0 / behind 0 after final handoff push; ahead 9 / behind 0 relative to original `origin/main`
- Live checkout: `C:/Users/Tyler/.pi/agent`
- Implementation worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-0`
- Pre-existing deleted `AGENTS.md` and untracked `skills/impeccable/` preserved: yes
- External safety backup: `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-live-backup-20260824-151315`

## Commits

- `4dd6b32` - LF formatting baseline.
- `366fa6f` - Phase 0 dependency, process, test, and smoke stabilization.
- `2c58fa3` - Codex Windows command-shim regression test.
- `87a2dca` - plan, ledger, risks, decisions, and handoff.
- `1b1e784` - protected Codex launcher synthesis and pruning-history regression stabilization.
- `738800d` - verification ledger, decision, and reconciliation handoff update.
- `e22cc5b` - live verification evidence and integration handoff.
- `9f53a2c` - fork publication and tracking state.
- Final continuity correction commit - post-publication divergence count.

## Next exact action

Do not begin Phase 1 until explicitly requested.
