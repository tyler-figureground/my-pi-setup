# Pi capabilities Phase 7 checkpoint

Updated: 2026-08-28
Branch: `pi-capabilities-phase-7`
Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-7`
Base: accepted Phase 6 live head `4ee0cb6`

## Objective

Complete Phase 7 from `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`: F08 declarative hooks completion, F15 reactive monitors, and F16 scheduled prompts. Stop before Phase 8.

## Preserved live state

Never stage, restore, overwrite, or delete:

- live `D AGENTS.md`
- live `?? skills/impeccable/`

Never recursively remove a worktree containing a live `node_modules` junction. Preserve DLL-lock backups.

## Phase plan

- [x] Fetch remotes before survey; confirm live `main` is 0 ahead / 0 behind `fork/main`.
- [x] Create isolated Phase 7 branch/worktree from `4ee0cb6`.
- [x] Survey existing hooks, lifecycle, policy, mailbox, background-terminal, profiles, projects, persistence, and child-session seams.
- [x] Compare three radically different interface designs; user confirmed external seams before tests.
- [ ] Record Phase 7 architecture/domain language and package/adopt-wrap-build decisions. Architecture, glossary, ADR 0009, and package research recorded; dependency trials/ADR remain.
- [ ] Build shared TriggerEngine test-first: core provenance, queue bounds, coalescing, recursion, concurrency, deadlines, lifecycle, fake clock, and adversarial hardening complete (37 tests); production StateStore persistence adapter running.
- [ ] Build F15 MonitorRegistry test-first: ordered terminal observation and identity-safe Windows cleanup complete; MonitorRegistry/filesystem/poll/WebSocket implementation running.
- [ ] Complete F08 test-first: hardened Hooks core, v1/v2 config, native/platform events, policy-gated named actions, history, trust/config revalidation, concurrency/deadlines, and close complete (35 focused tests); production wiring running.
- [ ] Build F16 Scheduler test-first: strict calendar/DST semantics, scheduled child execution seam/adapter, and initial 27-test core complete; adversarial scheduler blockers under regression-driven hardening.
- [ ] Run repeated independent adversarial review; fix every material finding with regression coverage.
- [ ] Run isolated full verification, performance benchmark, native multi-process tests, long-duration no-leak/no-duplicate soak, and live backend acceptance.
- [ ] Record acceptance evidence in tracker/docs; publication preflight; publish branch; fast-forward and verify live `main` while preserving user state.
- [ ] Stop before Phase 8 pending explicit approval.

## Current status

Setup, design, and baseline complete. User confirmed minimal/caller hybrid seams. Releasable Lifecycle handles, schedule calendar, terminal observation, scheduled runner, Phase 7 config, TriggerEngine core, and Hooks core are green. Trigger SQLite, MonitorRegistry, Hooks wiring, and Scheduler hardening are active.

### Dependency research run

- [x] Fetch remotes and inventory repository manifests, lockfiles, Phase 7 seams, and Node runtime.
- [x] Verify Node 26 built-ins and exact package metadata/source for cron, watching, WebSocket, and queue candidates.
- [x] Run survivorship-bias searches and disposable no-repository-code package trials.
- [x] Write and verify `docs/research/phase-7-trigger-packages.md`.

Dependency research complete. Conditional `cron-parser@5.10.0`, wrapped `@parcel/watcher@2.6.0`, wrapped `ws@8.21.3`, and repository-owned queue recommended. DST semantics and minimum-Node matrix remain implementation preflight gates.

## Key constraints

- Tests and callers cross the same confirmed public seams.
- Host owns project identity, Execution Role, trust, profile, workspace lease, direct-user authority, lifecycle, and process identity.
- Event/config/network/monitor/hook/schedule/model output is untrusted data, never authority.
- No recursive monitor/hook/schedule creation without explicit limits and policy.
- Multi-process execution uses transactional leases/fences and idempotent receipts.
- Every watcher, timer, socket, poll, process, and child operation is lifecycle-owned and bounded.
- Windows termination retains PID plus creation-identity validation; no PID-only fallback.
