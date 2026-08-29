# Phase 7 acceptance evidence

Date: 2026-08-29
Scope: F08 declarative hooks completion, F15 Reactive Monitor, F16 Scheduled Prompts

## Interface and package decisions

- One shared host-owned `TriggerEngine` receives native Pi events, platform events, monitor events, and scheduled occurrences through opaque source publishers.
- `cron-parser@5.10.0`, `@parcel/watcher@2.6.0`, and `ws@8.21.3` remain wrapped adapters. Queueing, authority, persistence, retries, lifecycle, and delivery remain repository-owned.
- Hooks, Monitor, and Scheduler callers and tests cross the same public seams. Host retains Project Identity, trust, policy, profile, credential, workspace, process, and direct-user authority.

## F08 declarative hooks completion

- V1 and V2 configuration supports the complete selected Pi/platform event vocabulary and deterministic source/hook/action ordering.
- Named HTTP, MCP, and Agent Profile actions are lazy, exact-bound, policy checked, trust revalidated, generation fenced, deadline bounded, and output capped.
- Remote writes require one exact direct-user authority token immediately before effect commit. Plan Mode and child-role policy remain authoritative.
- Changed project configuration suspends visibly before execution and resumes only after atomic trusted apply.
- History, errors, status, validation, reload, recursion, concurrency, and close behavior are bounded and sanitized.

## F15 Reactive Monitor

- Terminal observation extends the existing Background Terminal manager. Monitor stop never owns or kills the observed process.
- File/directory, bounded poll, and WebSocket sources use host authorization, exact origin policy, pinned address evidence, no redirects, query-free WebSocket URLs, bounded payloads, and lifecycle-owned cleanup.
- Credential values are resolved per request/connect, redacted from nested and encoded evidence, and stored only in short-lived Artifacts.
- Burst batching, coalescing, backpressure, ignore filters, self-trigger suppression, pause/resume/stop/delete, durable restore, and host-bound result delivery pass.
- Real Windows terminal/file/WebSocket generations close without duplicate delivery or surviving descendants.

## F16 Scheduled Prompts

- One-shot, fixed interval, and strict five-field cron schedules use explicit offsets/time zones, bounded search horizons, deterministic DST gap/overlap policy, and anchored cadence.
- Durable definitions bind Project Identity, creator session, result route, `scheduled` role, exact Agent Profile digest, prompt Artifact, credential references, timeout, retry, and output bounds.
- Native multi-process SQLite claims, renewals, fences, cancellation, and request admission prevent duplicate occurrence execution and conflicting request intent.
- Pause/delete atomically commit definition state, cancellation descriptor, and request receipt. Claimant acknowledgement and lease release are one fenced transaction.
- Recovered result delivery is claim-owned, renewable, cancellable, generation-bound, and mailbox-idempotent.
- Legacy persisted definitions missing `definitionGeneration` receive a deterministic compatibility generation on read.
- Request admission atomically coordinates global request identity, bounded receipt eviction, cancellation tombstones, schedule mutation, and receipt commit. Native 12-process probes retain the exact configured cap and reject same-scope and cross-scope conflicting intent.

## Trigger durability and authenticity

- Restart-only records use an exact authenticated envelope and HMAC-SHA256 under an agent-directory-scoped OS keyring account.
- Verification never creates or rotates a key. Missing/malformed keys fail closed; transient keyring failures retry instead of poisoning the process.
- Bare legacy-shaped and forged-envelope records quarantine before replay.
- Recovery runs only on first activation per owner and routes only through that owner's bindings. Same-owner reload cannot release an in-flight claim.

## Lifecycle, policy, and modes

- Parent-only ownership; every child execution role exposes no Phase 7 daemon or mutation surface.
- Messaging absence fails closed before Monitor/Scheduler activation in TUI, print, JSON, and RPC process modes.
- Reload, session replacement, shutdown, stale configuration, late authority checks, abort-ignoring adapters, and process cleanup remain generation fenced and bounded.
- Real terminal keystrokes remain the manual checklist in `docs/verification/phase-7-tui-smoke.md`. Automated RPC/process paths pass.
- Windows Task Scheduler is not installed or modified. Scheduled Prompts run while a Parent Pi process is active; missed policy applies when it returns.

## Independent review

Repeated blocker-only review and native adversarial probes covered Hook authority, Trigger authenticity/recovery, Monitor credentials/sources, Scheduler crash windows/cancellation/delivery/request admission, Background Terminal cleanup, headless failure, and suite watchdog behavior.

Final scheduler admission signoff `sa-10`: **no critical/high blockers**.

## Verification

Final immutable-tree run:

- TypeScript: pass
- Prettier: pass
- Unit: 469/469
- Integration: 413 passed, 5 platform skips
- Delegated file-search: 22/22
- Smoke: repository schemas, print, JSON, RPC, reload, shutdown, and no leaks pass
- Full run log: `C:/Users/Tyler/AppData/Local/Temp/pi-phase7-verify-final.log`

The combined `npm run verify` reached the live backend stage after all deterministic checks passed. Its first live run had one transient Windows Codex interrupt taskkill race. The exact Codex interrupt test then passed 3/3 isolated, and the complete `npm run test:live` rerun passed:

- Claude completion/interrupt: 2/2
- Codex completion/interrupt: 2/2
- Pi profiled completion: 1/1

Native/soak evidence:

- Trigger/Monitor/Scheduler focused acceptance: 148/148 before final hardening; final Scheduler 43/43 and Trigger persistence/engine 53/53.
- Fake-time soak: 26 hours Trigger time and 30 hours Scheduler time; 47 occurrences, 47 deliveries, one execution owner, zero active claims after close.
- Windows real-resource soak: five generations, 163 deliveries, five processes started/exited, zero surviving descendants, maximum one WebSocket client.
- Native scheduler admission: 12 concurrent processes at cap 3 retained exactly 3 receipts; failed command preserved receipts; same/cross-scope conflicts admitted one intent; crash replay returned one stable receipt.
- Platform production dependency audit: zero vulnerabilities.

## Live integration

Live `main` fast-forwarded through `8f88ece` and was pushed to `fork/main` while preserving deleted `AGENTS.md`, untracked `skills/impeccable/`, and dependency backups.

- Platform install/audit: 180 packages, zero vulnerabilities
- TypeScript and formatting: pass
- Focused Phase 7 acceptance: 214 passed, 4 platform skips
- Smoke: pass
- Live backends: Claude 2/2, Codex 2/2, Pi 1/1

## Result

F08 full acceptance, F15, and F16 pass isolated and live acceptance. Phase 7 is complete and live-integrated. Phase 8 remains unapproved and must not start.
