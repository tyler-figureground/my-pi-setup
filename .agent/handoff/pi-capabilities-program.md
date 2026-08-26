# Pi capabilities program handoff

Updated: 2026-08-25

## Objective

Execute every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md` through `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`.

## Current phase

Phase 3 implementation, adversarial hardening, publication, live fast-forward integration, and live verification complete. Stop before Phase 4 pending Tyler approval.

## Completed this phase

- [x] F09 persistent named profiles: managed/user/trusted-project precedence, bounded YAML and material resolution, collisions, immutable digest/generation, provenance, `/agents`, reload, override matrix, backend policy compilers, host limits, snapshot/transcript metadata.
- [x] F02 guarded workspaces: exact explicit/current/fresh bases, durable states/events, fenced lease/renew/rebind, operation guards, inspection, `.worktreeinclude`, preserve/review/integrate/abandon, recovery, Windows link detachment, shared-target verification, no recursive deletion.
- [x] Isolated profile preparation for Pi/Claude/Codex with explicit ad hoc `unisolated` compatibility.
- [x] Pi write/edit containment and project-resource exclusion; Claude fail-closed sandbox plus unconditional PreToolUse containment; Codex workspace-write and native multi-agent disable.
- [x] Package trial rejected `@narumitw/pi-worktree@0.51.5` after native Windows false-success cleanup reproduction. ADR 0004 and research report recorded.
- [x] Three adversarial review rounds closed lease expiry/races, path tampering, Claude native writes, reviewed-commit drift, Codex restriction/delegation gaps, Git hooks, cleanup postconditions, result-path leaks, and dirty-parent coverage.
- [x] Final independent blocker check reports no unresolved code blockers.

## Verification

- Definitive isolated deterministic run: 167 unit; 145 integration; 4 POSIX-only skips; 22 delegated file-search.
- Smoke: repository extensions, print, JSON, RPC, reload, shutdown, no leaks.
- Live: Pi profiled 1/1; Codex 2/2.
- Claude: Phase 3 baseline completion/interrupt 2/2 passed before account quota exhaustion. Final rerun returned session-limit text; external account state, not code failure.
- Native Windows: successful and failed junction cleanup preserve shared target; dirty parent byte-for-byte fixture; lease collision/recovery; path identity; operation guards; `.worktreeinclude`; expected-target integration.
- Performance: warm startup median 3271.6 ms, 136.8 ms faster than Phase 2 median.
- Manual TUI checklist: `docs/verification/phase-3-tui-smoke.md`.

## Key files

- `extensions/platform/src/profiles/`
- `extensions/platform/src/workspaces/`
- `extensions/platform/src/agents/services.ts`
- `extensions/shared/agent-profile.ts`
- `extensions/shared/guarded-workspace.ts`
- `extensions/shared/child-session.ts`
- `extensions/subagents/`
- `docs/architecture/phase-3-profiles-workspaces.md`
- `docs/phase-3-configuration.md`
- `docs/security/phase-3-threat-model.md`
- `docs/runbooks/phase-3-workspace-recovery.md`
- `docs/research/pi-worktree-audit.md`
- `docs/verification/phase-3-acceptance.md`

## Repo state

- Base: `dc1a964`
- Branch: `pi-capabilities-phase-3`
- Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-3`
- Phase 3 branch published at `7a95fd6`; live `main` at `ece1639`, ahead 0 / behind 0 from `fork/main`, verified.
- Live deleted `AGENTS.md` and untracked `skills/impeccable/` remain untouched.
- Preserve `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase1-live-backup-20260825-144510`.

## Next exact action

Do not begin Phase 4 until explicitly requested.
