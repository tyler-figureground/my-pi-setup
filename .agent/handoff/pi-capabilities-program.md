# Pi capabilities program handoff

Updated: 2026-08-25

## Objective

Execute every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md` through the durable tracker at `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`.

## Current phase

Phase 2 implementation, three adversarial review rounds, final blocker check, and isolated deterministic verification complete. Final publication and live fast-forward integration pending. Do not begin Phase 3.

## Completed this phase

- [x] F14 path-scoped lazy rules: bounded frontmatter discovery, lazy bodies, include/exclude/priority, deterministic precedence, trust provenance, duplicate/conflict rejection, context epochs, stale-message filtering, prompt/tool/search-result activation, first-side-effect retry, inspectors, reload, Windows alias containment.
- [x] F05 read-only agent plan mode: four states, direct-user authority, exact tool restoration, tool provenance fingerprints, dedicated hardened Git reads, dynamic/unknown denial, branch-aware persistence, configurable plan roots, hash-verified create-new plan files, resume/reload/tree verification, status/widget, headless rejection.
- [x] F08 declarative hook core: bounded YAML, global/trusted-project sources, provenance, deterministic matching, command/notify/status/context/policy effects, explicit failure policy, plan-policy dominance, recursion and dispatch bounds, validation/reload/log commands.
- [x] Built narrow no-shell process runner with minimal environment, memory/spill caps, global/per-hook concurrency, timeout/abort, native Windows tree termination, and bounded shutdown; used by hooks and Git reads.
- [x] Trialed exact `pi-yaml-hooks@2026.8.11` in disposable Pi 0.84.3 RPC profile; startup/reload/shutdown worked only as documented Windows no-op. ADR 0003 selects build.
- [x] Audited/pinned `yaml@2.9.0`, `minimatch@10.2.5`, and `typebox@1.3.7`; no install scripts executed; platform audit reports zero vulnerabilities.
- [x] Added threat model, architecture, configuration guide, examples, rollback, performance evidence, and TUI checklist.
- [x] Added exact public contracts for five read-only Git tools and real repository RPC command smoke.
- [x] Independent architecture, compatibility, and security reviews reproduced and closed Git external-command execution, plan approval/restore races, stale tool sets, tool-identity drift, late rules, pathological globs, hook process leaks/output, payload truncation bypass, handler duplication, config/path identity, and shutdown hook failures.

## In progress

- [x] Final current-tree deterministic verification and final blocker re-review.
- [ ] Re-fetch, commit/push Phase 2 branch, fast-forward live `main`, install dependencies, and run live checkout verification while preserving dirty state.

## External/manual limits

- Claude live backend passed 4/4 earlier this session during Phase 1. Final Phase 2 live run reached Claude account session limit (`resets 7:30pm America/Los_Angeles`); Codex live passed 2/2. No Phase 2 code touches provider backends.
- Real visual TUI input is unavailable through this harness. `winpty` rejected redirected stdin as non-TTY. TUI status/widget calls and RPC UI behavior pass; manual checklist is `docs/verification/phase-2-tui-smoke.md`.

## Files changed

- `extensions/platform/src/rules/`, `rules*.test.ts` - F14 module and native adapter tests.
- `extensions/platform/src/plan/`, `plan-mode*.test.ts` - F05 module, persistence, authority, restore tests.
- `extensions/platform/src/automation/hooks/`, `hooks*.test.ts`, `hook-process.integration.test.ts` - F08 engine, parser, process runner.
- `extensions/platform/src/wiring/`, `src/composition.ts`, `phase2-composition.test.ts` - one-root Pi integration.
- `extensions/platform/src/core/policy/`, `src/config.ts`, `src/flags.ts` - policy classifications, config, Phase 2 flags.
- `platform.json`, package manifest/lock, smoke contract/harness, test classifier.
- `CONTEXT.md`, `README.md`, `SETUP.md`, `docs/adr/`, `docs/architecture/`, `docs/research/`, `docs/security/`, `docs/verification/`, `docs/examples/`.

## Verification

- Root/12-extension isolated installs - pass.
- Platform package tests - pass.
- Current recorded deterministic run - 163 unit; 115 integration; 4 POSIX-only skips; 22 delegated file-search.
- Smoke - repository extensions, print, JSON, repository RPC commands, reload, shutdown, no leaks.
- Native Windows - hook spill cap, process-tree timeout/abort/shutdown, plan/rule/hook junction containment, plan hash/identity, Git external diff suppression.
- Performance - 100-rule corpus reads zero bodies at startup/unrelated activation; matching injects one body. Final warm startup median 3408.4 ms, +1049.5 ms (+44.5%) over Phase 1.
- Live - Codex 2/2; Claude externally blocked by account session limit after earlier same-session 4/4 pass.

## Repo state

- Live checkout: `C:/Users/Tyler/.pi/agent`, `main` was ahead 0 / behind 0 before Phase 2.
- Phase 2 worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-2`.
- Branch: `pi-capabilities-phase-2`, based on `20a62d2`.
- Live deleted `AGENTS.md` and untracked `skills/impeccable/` remain untouched.
- Phase 1 DLL backup remains at `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase1-live-backup-20260825-144510`.

## Next exact action

Final blocker check reports none and current-tree deterministic suite passes. Re-fetch before commit/push, then integrate live without starting Phase 3.
