# Pi capabilities Phase 6 checkpoint

Updated: 2026-08-27
Branch: `pi-capabilities-phase-6`
Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-6`
Base: `c08835e`

## Scope

Complete Phase 6 only:

- F10 cross-session discovery and messaging
- F11 persistent explicit memory
- Automatic extraction remains disabled unless its measured evaluation gate passes

Do not begin Phase 7 without explicit approval and accepted Phase 6 evidence.

## Durable phase plan

- [x] Fetch remote and verify live `main` is 0 ahead / 0 behind `fork/main`.
- [x] Create external Phase 6 branch/worktree from accepted Phase 5 head.
- [x] Confirm public module interfaces and test seams before writing tests: flexible host-bound `SessionBroker` and five-method `MemoryStore` selected; delivery/persistence adapters remain internal.
- [x] Research exact `pi-memory@0.4.2`; reject adopt/wrap and select repository-owned `MemoryStore` over built-in FTS5; ADR 0008 recorded.
- [x] Record Phase 6 domain language, architecture, configuration, and threat model.
- [x] Run isolated baseline verification: 239 unit passed; integration reached 187 pass/5 skip with one unrelated 60-second browser timeout under concurrent research load; isolated retry passed in 98.4 seconds; smoke passed.
- [x] Build F10 in vertical red-green slices through confirmed registry/mailbox interfaces: host proof/fencing, opt-in Presence, ordered mailbox, Artifact bodies, delivery receipts, safe notification modes, retention, and native multi-process races.
- [x] Build F11 in vertical red-green slices through confirmed `MemoryStore` interface.
  - [x] Slice 1: host-resolved typed remember/inspect with citations, provenance, confidence, expiry, and idempotency.
  - [x] Slice 2: secret redaction/rejection, exact/conservative near dedupe, review ingress, and symmetric contradictions.
  - [x] Slice 3: bounded scoped search, expiry exclusion, optimistic revisions, promotion, and complete managed-body forget.
  - [x] Slice 4: versioned export plus digest-bound preview/commit import.
  - [x] Slice 5: dedicated `node:sqlite` FTS5 adapter, restart/isolation/contention/deletion integration evidence.
- [x] Add Pi command/tool wiring while preserving project identity, role, trust, direct authority, and plan mode.
- [x] Run native Windows multi-process, crash/restart, contention, isolation, deletion, redaction, and prompt-injection fixtures.
- [x] Run repeated independent adversarial review; all reported blockers have regression fixes; final critical/high sign-off `sa-101`: no blockers.
- [x] Run full isolated verification, performance checks, live backend checks, and acceptance evidence.
  - [x] Add versioned Memory retrieval/extraction evaluation dataset.
  - [x] Benchmark current SQLite-backed `MemoryStore` through its public interface; record precision@k, recall@k, MRR, scope leaks, latency, and context bytes.
  - [x] Record absent automatic extractor as no-write (zero false positives/false memories, zero recall); verify review-state and direct-user promotion guard; keep automatic extraction off.
- [ ] Fetch publication preflight, publish branch, fast-forward live `main`, preserve live user state, and verify live checkout. Isolated branch is ready.
- [ ] Update authoritative tracker/program handoff and stop before Phase 7.

## Confirmed constraints

- Session identity combines Pi session ID with process-held proof; model/tool input cannot choose sender identity.
- Messages and memories are untrusted data and cannot confer user authority or become system instructions.
- Project identity is stable across linked worktrees; cross-project visibility must be explicit.
- Claims, acknowledgements, leases, and retries must be transactional and fenced across native Windows processes.
- Message body and large memory evidence use immutable artifacts; metadata remains bounded state.
- Secrets are rejected/redacted before persistence and must not appear in model output, logs, artifacts, child prompts, or handoffs.
- Offline delivery is at-least-once internally with exactly-once visible transcript semantics through durable acknowledgement/dedupe.
- Forget removes retrieval and underlying owned body without crossing shared artifact ownership.
- Dirty child worktrees are preserved after failures; no recursive junction cleanup.

## Existing evidence to preserve

- Authoritative tracker: `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`
- Program continuity: `.agent/handoff/pi-capabilities-program.md`
- Phase 5 acceptance: `docs/verification/phase-5-acceptance.md`
- Phase 5 final handoff: `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase-5-final-handoff.md`
- Live user state: deleted `AGENTS.md`, untracked `skills/impeccable/`
- DLL backup: `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase1-live-backup-20260825-144510`
