# Pi capabilities program handoff

Updated: 2026-08-24

## Objective

Execute the durable implementation program for every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md`.

## Source-of-truth plan

`docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`

## Current phase

Phase 1 platform foundation complete and independently hardened in isolated worktree. Live fast-forward integration **IN PROGRESS**.

## Completed this session

- [x] Tyler approved Phase 1 and confirmed public TDD seams.
- [x] Created `pi-capabilities-phase-1` worktree from fetched `fork/main`; installed independent root and extension dependencies.
- [x] Added minimal `extensions/platform/` composition root with all 15 migration flags off, inert lifecycle hooks, and no public tools/commands/UI ownership.
- [x] Implemented `LifecycleSupervisor` seam with idempotent acquisition/shutdown, abort-safe startup, reverse-order bounded cleanup, failure reports, and race/error/deadline tests; composition root owns one supervisor per session runtime.
- [x] Implemented `ProjectIdentity.resolve(cwd)` with canonical Windows paths, explicit non-Git/bare results, linked-worktree identity, common project IDs, and real Git/junction fixtures.
- [x] Implemented pure `CapabilityPolicy.decide` with eight-capability vocabulary, six roles, multi-capability tool classification, conservative unknowns, deny precedence, provenance, in-memory rules, and no approval input.
- [x] Implemented `ArtifactStore` with content-addressed immutable bodies, separate metadata, in-memory/filesystem adapters, exact limits and quotas, safe export, retention/GC, atomic writes, cross-process locking, and native Windows tests. Lock cleanup never recursively deletes directories.
- [x] Ran native `node:sqlite` spike: WAL, 12-process single-winner lease claim, backup, and integrity check passed without a new dependency.
- [x] Implemented `StateStore` with plain-data transaction/query/compact/export/diagnose seam, in-memory and built-in `node:sqlite` adapters, migrations, WAL, idempotency, ordered events, fenced leases, backup, diagnostics, and native Windows cross-process contention tests.
- [x] Added loader-scoped execution roles, canonical child trust/cwd binding, consolidated Pi child resource/shutdown code, parent-only private daemon acquisition, and unchanged workflow/subagent behavior.
- [x] Froze all existing public tool names and schemas in smoke coverage; flags-off platform adds no public surface or header/footer ownership.
- [x] Added `CONTEXT.md`, two ADRs, and platform architecture diagram.
- [x] Completed two review passes and fixed role propagation, junction trust/layout, lifecycle late-start cleanup, StateStore ABA/validation/bounds/backup/diagnostics, artifact corruption/metadata conflicts, and strict smoke findings.
- [x] Re-reviewed Phase 1 before integration and fixed reproduced lifecycle timeout leaks, bare-linked-worktree identity, parent extension leakage into child roles, canonical trust wiring, malformed optimistic-concurrency inputs, SQLite backup sidecar collisions, ArtifactStore partial collection deletion, junction traversal, stale-lock ABA races, crashed reclamation guards, and export-to-lock-path poisoning.
- [x] Added native Windows and interface-level regressions for every material review finding; final isolated `npm run verify` passed.
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

- [ ] Commit and publish Phase 1 review hardening.
- [ ] Fast-forward verified Phase 1 into live `main` while preserving pre-existing dirty state.
- [ ] Reinstall/verify from live checkout and record final evidence. Phase 2 remains intentionally unstarted.

## Blocked

- No implementation or approval blocker.
- Visual TUI verification remains unavailable through this harness, but Phase 1 adds no user-facing TUI surface; print/JSON/RPC/reload/session-shutdown counterparts pass.

## Files changed

- `extensions/platform/` - composition root, core modules, adapters, package lock, contract/integration tests.
- `extensions/shared/execution-role.ts`, `child-session.ts` - role transport, canonical child context, shared resource/shutdown seam.
- `extensions/subagents/`, `extensions/workflows/` - explicit child roles and duplicated Pi child helper removal.
- `tests/smoke/fixtures/public-tool-contract.json`, smoke harness - exact public schema and flags-off compatibility evidence.
- `CONTEXT.md`, `docs/adr/`, `docs/architecture/platform-foundation.md` - domain language, decisions, diagram.
- `scripts/run-test-suite.mjs` - Phase 1 test classification.
- `extensions/git-info/process.test.ts` - Windows-load-safe fixture deadline; explicit timeout case unchanged.
- `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`, this handoff - Phase 1 tracking and evidence.

Prior Phase 0 files:

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
- Independent extension installs - pass for all 11 extension packages, including new `platform` package; no junctioned dependency trees.
- Final isolated `npm run verify` after review hardening - pass.
- Unit - 135 pass.
- Integration - 99 pass; 4 POSIX-only cases skipped on Windows; delegated file-search - 22 pass.
- Smoke - pass: exact public tool schemas, production extensions, print, JSON, RPC, reload, shutdown, no leaks.
- Native Windows StateStore contention - one lease winner across eight processes; stale fencing, backup aliases, corruption diagnostics pass.
- Live Claude/Codex - 4/4 pass.
- TUI visual - not applicable to disabled, non-UI Phase 1 surface; harness limitation remains documented.

Phase 0 baseline details:

- Extension dependency installs and `npm ls --depth=0` - pass for all 10 Phase 0 extension packages. Loaded native DLLs required relocating four prior `node_modules` trees outside the repo before fresh installs.
- Pi dependency tree - all direct/nested Pi libraries `0.84.3`.
- Effect topology - all seven Effect-using extension trees `4.0.0-beta.101`.
- Phase 0 `npm run verify` - pass: 75 unit, 67 integration, 4 POSIX-only skips, smoke, Claude/Codex 4/4.

## Repo state

- Phase 1 branch: `pi-capabilities-phase-1`, tracking `fork/pi-capabilities-phase-1`
- Branch state before final integration fetch/commit: ahead 0 / behind 0 relative to `fork/pi-capabilities-phase-1`; ahead 1 / behind 0 relative to `fork/main`
- Live checkout: `C:/Users/Tyler/.pi/agent`
- Phase 1 worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-1`
- Phase 0 worktree retained: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-0`
- Pre-existing deleted `AGENTS.md` and untracked `skills/impeccable/` preserved: yes
- External safety backup: `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-live-backup-20260824-151315`

## Commits

- Phase 1 implementation and evidence - this commit.
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

Re-fetch, commit/push review hardening, then fast-forward live `main`, install extension dependencies, and run `npm run verify` from the live checkout. Do not begin Phase 2.
