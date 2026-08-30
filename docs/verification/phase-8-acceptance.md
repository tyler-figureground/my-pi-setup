# Phase 8 acceptance evidence

Status: accepted in isolated worktree; publication/live integration pending
Date: 2026-08-30
Branch: `pi-capabilities-phase-8`
Base: `282cec3`

## Scope

F13 persistent task graph and Goal Mode only. Phase 9 not started.

## Interface and architecture

- Five-method `GoalEngine`: `submit`, `resume`, `pause`, `cancel`, `observe`
- Declarative bounded data only; no Workflow JavaScript evaluator or dependency
- Architecture: `docs/architecture/phase-8-goal-mode.md`
- Threat model: `docs/security/phase-8-threat-model.md`
- Domain language: `CONTEXT.md`
- TUI/dashboard: `docs/verification/phase-8-tui-smoke.md`
- Endurance: `docs/verification/phase-8-performance.md`

## Acceptance matrix

| Requirement | Evidence | Result |
|---|---|---|
| Cycle/missing dependency rejection | `goal-validation.test.ts` | Pass |
| Explicit transition validation | `goal-transitions.test.ts` | Pass |
| Dependency scheduling | `goal-scheduling.test.ts`, `goal-engine.test.ts` | Pass |
| Bounded parallelism | in-memory + native SQLite multi-runtime claim race | Pass |
| Retry and failure policies | deterministic backoff, typed pre-dispatch certainty, Unknown blocks | Pass |
| Crash/restart without duplicate execution | `goal-recovery.test.ts`, killed-parent drill | Pass |
| Workspace release/preservation | Goal Worker isolated workspace tests; killed-parent workspace assertions | Pass |
| User edits audited | `goal-user-controls.test.ts`, `/goal` command tests | Pass |
| Existing Workflow compatibility | Workflow source/schema unchanged; complete suites and smoke | Pass |
| Evidence-gated completion | `goal-evidence.test.ts`, host review/manual attestation tests | Pass |
| Calls/runtime/tokens/cost | transactional reservations; live cumulative token metering; cost fails closed without authority | Pass |
| Profile/workspace policy per node | pinned/revalidated `goal-worker` profile and single workspace owner | Pass |
| `/goal`, `/goals`, model tools | strict schema/confirmation/Plan Mode tests and smoke contract | Pass |
| Multi-hour simulated run | deterministic 72-hour soak | Pass |
| Killed-parent recovery | real Windows process + SQLite pre/post-dispatch drill | Pass |
| Dashboard understandable without transcript | bounded detail + TUI document/checklist | Pass |

## Recovery guarantee

Exactly-once local state transitions under optimistic versions and fenced leases. External Agent effects use at-most-once opaque dispatch. Pre-dispatch Attempts reclaim safely; certified durable outcomes settle; ambiguous post-dispatch Attempts become `unknown`, preserve workspace/Artifacts, block, and require direct user resolution. Lease expiry never proves redispatch safe.

Long-running Attempts renew their exact node lease at one-third TTL. Lost renewal aborts only that worker and fences stale settlement. Cancellation persists reconciliation intent and terminal cancelled Goals remain recoverable until active Attempts, reservations, and leases reconcile.

## Budgets and metering

Concurrency, Agent calls, runtime, tokens, and integer-micro cost have transactional limit/reserved/consumed ledgers. Parallel claims serialize through Goal capacity/head state. Unknown Attempts consume full reservation.

Cumulative token totals are separate from context occupancy:

- Pi: `getSessionStats().tokens.total`
- Claude: aggregate SDK billing usage with sidechain requests
- Codex: cumulative `tokenUsage.total`

Live two-turn tests verified positive finite monotonic values on all three. Cancellation happens between provider requests; reservation includes one in-flight-request overshoot. Production does not claim common authoritative monetary cost; finite cost budgets are rejected before confirmation. Engine-level authoritative-cost adapter tests pass.

## Persistence and retention

- Goal/head/node/Attempt/request/outbox records and audit events are bounded
- Command receipt and transition commit atomically
- `maxGoals` enforced transactionally across runtimes
- Periodic terminal sweep runs independent of capacity pressure
- Cleanup preserves unsettled Attempts, cancellation reconciliation, Artifacts, and Guarded Workspaces
- Goal generation prevents identifier reuse collisions
- Worker inspection retention has entry/byte/age ceilings and never turns eviction into `not-started`

## Verification completed this session

- Root typecheck: pass
- Root formatting: pass
- Focused Goal suite: 200 pass after release hardening
- Phase 8 combined focused suite: 170 pass before final metering/user-control additions; all additions included in root suites
- Unit suite: 712 pass
- Integration suite: 433 pass, 5 platform skips, plus 22 delegated Vitest tests
- Smoke: repository schemas, print, JSON, RPC, reload, shutdown, no leaks - pass
- Live backends: earlier Phase 8 run 5/5 pass; final strict metering rerun Codex/Pi 3/3 pass while both Claude cases are externally blocked by account session limit (`resets 5pm America/Los_Angeles`), not product failures
- 72-hour fake-time soak: pass; 68 unique Attempt dispatches; zero unknown redispatches; zero timers/leases after close
- Killed-parent drill: 2 pass; stale writes refused; no duplicate workspace/evidence/outbox

One full integration run exposed an unrelated `extensions/git-info/process.test.ts` Windows load flake (`-1` versus exit `7`); isolated rerun passed 3/3. A second run exposed the known Playwright cookie test crossing its former 60-second per-test bound under load; the integration bound is now 90 seconds with a 20-minute suite watchdog. Final complete integration rerun is recorded before publication.

## Rollback

Set `"goals": false` in `platform.json` and reload. Goal commands/tools and runtime remain absent; durable Goal records and preserved workspaces are not deleted. Re-enable to recover them. Removing the Phase 8 code commit restores the prior tool contract; existing Workflow implementation remains unchanged.
