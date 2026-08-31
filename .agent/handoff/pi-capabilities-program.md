# Pi capabilities program handoff

Updated: 2026-08-30

## Objective

Execute every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md` through `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`.

## Current phase

Phase 9 F23 Shareable Interactive Artifacts complete, published, and live-integrated. Phase 10 has not started and requires explicit approval.

## Phase 9 delivered

- Deep Artifact Publisher with exact publish/refresh/status/revoke authority, optimistic revisions, Unknown recovery, shutdown fencing, and body-free records.
- Project Identity-namespaced Artifact catalog with first-class metadata, safe list/remove/export, one-lock batch import, and integrity-manifest bundles.
- Loopback-only local viewer with fragment capability exchange, exact Host/Origin/Fetch Metadata checks, scoped HttpOnly cookie, static sanitization, opaque-origin interactive sandbox, network denial, expiry, revoke, and live revisions.
- Static Vercel preview adapter with verified project protection, exact project/intent/preview response validation, expiring links, OS-vault secrets, pre-dispatch intent recovery, bounded REST transport, idempotent revoke/delete, and outage runbook. Remote interactive/live HTML intentionally refused.
- Direct-user `/artifacts` creation/browser/open/refresh/share/status/revoke/export/import/delete/credential surface plus bounded `artifact_inspect` and body-free transcript references.
- Review, Browser, Goal, Language Intelligence, and Workflow producer integration.
- Exact `marked@18.0.10` plus `sanitize-html@2.17.7`, audited and dynamically loaded.

## Phase 9 verification

- TypeScript and formatting pass.
- Unit: 750 pass.
- Integration: 433 pass, 5 platform skips; two unrelated cumulative-load startup failures passed 16/16 immediately in isolation. Earlier same-tree full run passed 435 plus 5 skips.
- Delegated file-search: 22 pass.
- Smoke: schemas, print, JSON, RPC, reload, shutdown, no leaks.
- Live backends: Claude 2/2, Codex 2/2, Pi 1/1.
- Real Chromium viewer: opaque parent, network denial, interaction, screenshot, zero errors/failed requests.
- Repeated adversarial review closed every critical/high finding; final post-dispatch signoff passed.

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

- Branch: `pi-capabilities-phase-9`
- Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-9`
- Base: accepted Phase 8 live head `6e185f3` from fetched `fork/main`
- Start state: ahead 0 / behind 0; Phase 9 absent upstream
- Accepted implementation commit: `16bdccd`
- Live `main` and `fork/main` include `16bdccd`; live evidence commit pending.
- Preserve live deleted `AGENTS.md`, untracked `skills/impeccable/`, and dependency backups.
- Phase checkpoint: `.agent/handoff/pi-capabilities-phase-9.md`
- Acceptance: `docs/verification/phase-9-acceptance.md`

## Live integration

- Live main fast-forwarded through `16bdccd` and pushed to `fork/main`.
- Platform clean install: 205 packages; production audit zero vulnerabilities.
- Live check/format pass.
- Focused Phase 9 suite: 62 pass.
- Smoke passes schemas, print, JSON, RPC, reload, shutdown, and no-leak gates.
- Deleted `AGENTS.md`, untracked `skills/impeccable/`, and dependency backups preserved.

## Next exact action

Stop. Do not begin Phase 10 without explicit approval.
