# Pi capabilities Phase 7 checkpoint

Updated: 2026-08-29
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
- [x] Record Phase 7 architecture/domain language and package/adopt-wrap-build decisions, including ADRs 0009-0011 and dependency trials.
- [x] Build shared TriggerEngine test-first with provenance, bounded queues/maps, causal recursion controls, deadlines, exact restart replay, digest verification, source revocation, and StateStore persistence.
- [x] Build F15 MonitorRegistry test-first with terminal/file/poll/WebSocket sources, host-bound restore delivery, query-free WebSockets, credential evidence redaction, expiring Artifacts, and lifecycle cleanup.
- [x] Complete F08 test-first with v1/v2 config, native/platform events, named guarded actions, trust/config alias revalidation, exact POST authority, causal propagation, history, concurrency, and bounded drains.
- [x] Build F16 Scheduler test-first with strict calendar/DST semantics, fenced SQLite claims/cancellation, creator-scoped session schedules, guarded scheduled workspaces, profile revalidation, durable dedupe, and bounded close.
- [x] Run repeated independent adversarial review and fix every reported critical/high finding with regression coverage.
- [ ] Run isolated full verification, performance benchmark, native multi-process tests, long-duration no-leak/no-duplicate soak, and live backend acceptance.
- [ ] Record acceptance evidence in tracker/docs; publication preflight; publish branch; fast-forward and verify live `main` while preserving user state.
- [ ] Stop before Phase 8 pending explicit approval.

## Current status

Implementation and critical/high hardening complete. Combined focused verification passes 278/278 tests, including two native SQLite scheduler processes, cross-process cancellation, exact Trigger replay, credential-safe Monitor evidence, guarded scheduled workspaces, exact confirmed HTTP writes, causal recursion, and the 26-30 hour fake-time plus Windows real-resource soak. Typecheck, formatting, diff checks, and package audit pass. Remaining work: fresh independent sign-off, full isolated verification, lower-load startup benchmark, real Pi acceptance, acceptance/tracker docs, publication preflight, live fast-forward, and live verification.

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
