# Pi capabilities Phase 6 checkpoint

Updated: 2026-08-26
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
- [ ] Confirm public module interfaces and test seams before writing tests.
- [ ] Research exact `pi-memory` package and messaging/storage alternatives; record confidence-tiered reports and ADRs.
- [ ] Record Phase 6 domain language and threat model.
- [ ] Run isolated baseline verification.
- [ ] Build F10 in vertical red-green slices through confirmed registry/mailbox interfaces.
- [ ] Build F11 in vertical red-green slices through confirmed `MemoryStore` interface.
- [ ] Add Pi command/tool wiring while preserving project identity, role, trust, direct authority, and plan mode.
- [ ] Run native Windows multi-process, crash/restart, contention, isolation, deletion, redaction, and prompt-injection fixtures.
- [ ] Run repeated independent adversarial review; fix every material finding with regression coverage.
- [ ] Run full isolated verification, performance checks, live backend checks, and acceptance evidence.
- [ ] Fetch publication preflight, publish branch, fast-forward live `main`, preserve live user state, and verify live checkout.
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
