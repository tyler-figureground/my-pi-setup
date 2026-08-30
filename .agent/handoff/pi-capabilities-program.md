# Pi capabilities program handoff

Updated: 2026-08-30

## Objective

Execute every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md` through `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`.

## Current phase

Phase 8 F13 Persistent Task Graph and Goal Mode complete, published, and live-integrated. Phase 9 has not started and must not start without explicit approval.

## Phase 8 delivered

- Five-method deep `GoalEngine`: `submit`, `resume`, `pause`, `cancel`, `observe`.
- Durable bounded declarative DAG model with explicit Goal/Node/Attempt states, dependency/cycle validation, audited transitions, retry/failure policy, evidence gates, and revision invalidation.
- Transactional graph/receipt/outbox persistence, optimistic versions, fenced node leases, long-run renewal, multi-runtime concurrency and capacity control, periodic retention, and generation-safe Goal ID reuse.
- At-most-once opaque Agent dispatch. Pre-dispatch reclaim; certified outcome adoption; ambiguous post-dispatch work becomes Unknown and never auto-replays.
- Goal Worker on Agent Supervisor with role/profile pinning, guarded isolated workspace ownership, bounded output/runtime, typed pre-dispatch certainty, token-cap cancellation, bounded inspection retention, and lifecycle shutdown.
- Cumulative token metering separate from context occupancy across Pi, Claude, and Codex. Earlier two-turn live assertions passed all three; final strict Codex/Pi assertions pass while Claude is externally quota-blocked. Common authoritative monetary cost remains unavailable; finite cost budgets fail before confirmation.
- `/goal`, `/goals`, `goal_inspect`, and `goal_change`. Exact semantic confirmation, host-issued authority, Plan Mode inspect-only, and bounded untrusted dashboard.
- Direct-user objective/task/criteria/dependency edits, selected-node restart, Unknown resolution, and audited skip/block/done controls.
- Local Review evidence, ArtifactStore output/evidence, Session Broker delivery, WorkspaceManager preservation, ProfileCatalog revalidation.
- Existing Workflow JavaScript implementation and schema unchanged.

## Verification

Authoritative details: `docs/verification/phase-8-acceptance.md`.

- TypeScript and formatting pass.
- Unit: 712 pass.
- Integration: 433 pass, 5 platform skips, plus 22 delegated; 90-second per-test and 20-minute suite watchdog.
- Delegated file-search: 22 pass.
- Smoke: schemas, print, JSON, RPC, reload, shutdown, no leaks.
- Live backends: earlier 5/5 pass; final strict metering rerun passes Codex/Pi 3/3 while Claude is externally quota-blocked until account reset.
- 72-hour fake-time Goal soak: 68 unique Attempts, peak concurrency 4, one Unknown, zero redispatches, zero timers/leases after close.
- Real Windows killed-parent drill: pre-dispatch reclaim and post-dispatch Unknown block; stale writes refused; no duplicate workspace/evidence/outbox.
- Repeated adversarial review closed request atomicity, concurrency, reservation leaks, metadata bounds, cancellation races, lease renewal, authority forgery, confirmation omissions, retention, certainty, and metering blockers.

## Key references

- `docs/architecture/phase-8-goal-mode.md`
- `docs/security/phase-8-threat-model.md`
- `docs/phase-8-configuration.md`
- `docs/verification/phase-8-acceptance.md`
- `docs/verification/phase-8-performance.md`
- `docs/verification/phase-8-tui-smoke.md`
- `.agent/handoff/pi-capabilities-phase-8.md`

## Repository state

- Branch: `pi-capabilities-phase-8`
- Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-8`
- Base: accepted Phase 7 live head `282cec3`
- Accepted Phase 8 implementation: `c0edbd5`, `77f2464`
- Live `main` and `fork/main` fast-forwarded through `77f2464`
- Preserve live deleted `AGENTS.md`, untracked `skills/impeccable/`, and dependency backups.

## Live integration

- Live check/format pass.
- Focused Goal suite: 198 pass.
- Goal Worker/metering suite: 57 pass.
- Smoke passes schemas, print, JSON, RPC, reload, shutdown, and no-leak gates.
- Deleted `AGENTS.md`, untracked `skills/impeccable/`, and dependency backups preserved.

## Next exact action

Stop. Phase 9 requires explicit approval.
