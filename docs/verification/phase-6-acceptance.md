# Phase 6 acceptance evidence

Date: 2026-08-27
Scope: F10 cross-session messaging and F11 explicit persistent Memory

## Interface and package decisions

- Flexible host-bound interfaces confirmed before tests: `SessionBroker` and five-method `MemoryStore`.
- Exact `pi-memory@0.4.2` source inspected without runtime execution; adopt/wrap rejected.
- Repository-owned `MemoryStore` uses built-in `node:sqlite` FTS5 under ADR 0008.
- Pi 0.84.3 delivery behavior was source-audited and probed before adapter implementation.

## F10 evidence

- Host-issued process proof, Session Incarnation, fenced Presence, Parent-only ownership, and stale-owner rejection.
- Opt-in same-project/local-user discovery and acceptance matrices; trusted-project activation; linked-worktree Project Identity.
- Explicit bounded fanout, recipient incarnation/exposure fencing, ordered per-recipient mailbox, durable idempotency, quota/backpressure, retention, and recoverable targeted compaction.
- Immutable body Artifacts; structural and high-entropy secret controls across Presence, StateStore, Artifact, errors, rendering, and transcript.
- Native multi-process SQLite tests for concurrent sends, idempotent races, writer locks, close bounds, delivery/enqueue races, retention, and compaction recovery.
- Pi adapter uses strict UTF-8 JSONL, exact ID/hash dedupe, nontruncating fsync/readback, stale-generation and structural gates, and stable durable receipts.
- Mailbox attempts are at-least-once. Visible inbox effect is idempotent by message ID. No strict distributed exactly-once claim.
- `pi/inbox`, `pi/when-idle`, `pi/follow-up`, and `pi/steer` supported. Durable inbox receipt always precedes best-effort notification queueing.
- Real two-process Pi acceptance passed with synthetic local provider and no network:
  - recipient `60000000-0000-4000-8000-000000000001`
  - sender `60000000-0000-4000-8000-000000000002`
  - ordered durable inbox positions `[1, 2]`
  - output: `C:/Users/Tyler/AppData/Local/Temp/pi-phase6-real-process-acceptance.json`

## F11 evidence

- Opaque host-issued binding; exact user/project/workspace scope resolution; live workspace owner/fence revalidation.
- Main checkout and linked worktrees share project Memory; unrelated and untrusted projects cannot retrieve or activate it.
- Direct-user active writes only. Model proposals remain review-only. No model-callable durable write tool.
- Typed kinds, citations, confidence-as-data, expiry, revisions, deterministic exact/conservative near dedupe, and symmetric advisory Contradiction Links.
- Native two-process races for exact/near dedupe, contradiction linking, same/conflicting request IDs, FTS repair, import expiry, writer contention, and Windows sidecar churn.
- Named, structural, URL, token-shape, exact-canary, and high-entropy secret detection before persistence/indexing. UUIDs, digests, paths, and normal prose remain usable.
- Complete managed deletion covers canonical body, revisions, citations, relationships, FTS, staging, and live WAL/SHM after secure-delete/checkpoint. Exports/backups/snapshots remain independent copies.
- Versioned import/export with digest-bound preview, transaction-bound expiry, scope rebinding, authority stripping, duplicate/contradiction review, and bounded staging cleanup.
- Memory retrieval evaluation `pi-phase-6-memory-evaluation@1.0.0`:
  - precision@3 `0.3611`
  - recall@3 `0.9167`
  - MRR `0.9167`
  - scope leaks `0`
  - forbidden hits `0`
  - maximum context `1,512` bytes
  - latency remains below recorded gate; exact run metrics emitted by `memory-quality.test.ts`
- Automatic extraction evaluation predicts no writes: false-positive `0`, false-memory `0`, recall `0`. Gate fails and extraction remains absent/off.

## Policy and lifecycle

- Commands: `/sessions`, `/messages`, `/remember`, `/memories`, `/forget`, `/memory`.
- Model tools: `session_list`, `session_send`, `memory_search`.
- No model Memory write surface.
- Plan Mode allows reads and denies messaging orchestration/Memory mutations, including policy changes during TUI confirmation.
- Commands require TUI and post-intent confirmation for mutations; RPC/JSON/print reject command authority clearly.
- Flags off start no Phase 6 storage, timer, Artifact path, socket, process, provider call, prompt hook, or public surface.
- Memory enabled but unused does not open `memory.sqlite`.
- Reload removes/restores only Phase 6 tools, rotates messaging proof/incarnation, fences old callbacks, and preserves Memory.
- Degraded lifecycle reports are teardown failures after all cleanup is attempted.

## Independent review

Repeated adversarial reviews covered F10, F11, Pi delivery, composition, policy, storage, secrets, Windows paths/processes, lifecycle, and retention. Every material finding received a regression before re-review.

Final critical/high sign-off `sa-101`: **No blockers.**

## Verification

Final post-sign-off isolated `npm run verify` passed with exit 0:

- 299 unit tests
- 283 integration tests passed; 5 platform skips
- 22 delegated file-search tests
- repository public-schema, print, JSON, RPC, reload, shutdown, and no-leak smoke
- Claude completion/interrupt 2/2
- Codex completion/interrupt 2/2
- Pi profiled completion 1/1

Log: `C:/Users/Tyler/AppData/Local/Temp/pi-phase6-verify-final.log`.

Real terminal-keystroke behavior remains the manual checklist in `docs/verification/phase-6-tui-smoke.md`; automated TUI/RPC paths pass.

## Result

F10 and explicit F11 acceptance gates pass. Automatic Memory extraction remains disabled because its evaluation gate fails. Phase 6 is isolated-complete. Phase 7 has not started.
