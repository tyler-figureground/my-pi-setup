# Research: Phase 7 TriggerEngine, monitor, and scheduler packages

Research date: 2026-08-28 UTC

Decision target: Phase 7 F08/F15/F16 in [`docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`](../PI-CAPABILITY-IMPLEMENTATION-PLAN.md#phase-7---reactive-monitors-completed-hooks-and-scheduling-in-progress).

[HIGH | Local method] Evidence order: repository manifests/lockfiles and seams, Node `v26.4.0` docs/runtime, npm metadata and exact tarballs, exact source/issues/releases, native Windows trials, then web discovery.

[HIGH | Local method] No repository code, credentials, customer data, or live settings were sent externally. Trials used synthetic files, loopback sockets, and OS-temp directories. Lifecycle scripts were inspected before execution. No implementation files changed.

## Recommendation

| Area       | Adopt / wrap / build                                                                                                                                                                                                                                                                                                                                                                                                  | Confidence                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Cron       | **Conditionally wrap `cron-parser@5.10.0`; never adopt scheduler authority.** Normalize allowed five-field grammar to six fields; pass explicit IANA `tz` and reference instant; use bounded `next()`/`prev()`. Repository owns timers, occurrences, missed-run policy, leases, retries, execution, persistence. Acceptance blocked on explicit DST policy because leading packages disagree on non-hour transitions. | [MEDIUM \| Primary + native trial]     |
| Filesystem | **Wrap `@parcel/watcher@2.6.0`; use `backend: "windows"` on Windows.** Scan created directories, reconcile snapshots, cap roots/events/bytes, canonicalize containment, lifecycle-own `unsubscribe()`.                                                                                                                                                                                                                | [HIGH \| Primary + native trial]       |
| WebSocket  | **Wrap `ws@8.21.3`; exact dev dependency `@types/ws@8.18.1`.** Reuse URL authorization, pinned `lookup`, preserve Host/TLS SNI, reject redirects, disable compression, set low limits, own close/terminate.                                                                                                                                                                                                           | [HIGH \| Primary + native trial]       |
| Queue      | **Build narrow repository queue; no queue package.** Use Node cancellation/timer primitives, `Map`, bounded deque/ring. Keep durable work and cross-process claims in existing `StateStore`.                                                                                                                                                                                                                          | [HIGH \| Primary + local architecture] |

### Exact manifest placement

- [HIGH | Local architecture] Add exact runtime versions to `extensions/platform/package.json`, not root: `"cron-parser": "5.10.0"`, `"@parcel/watcher": "2.6.0"`, `"ws": "8.21.3"`.
- [HIGH | Local architecture] Add exact `"@types/ws": "8.18.1"` to platform `devDependencies`; existing `@types/node` satisfies it.
- [HIGH | Local architecture] Do not add `croner`, `chokidar`, `p-queue`, `p-limit`, `undici`, durable broker, or second persistence layer.
- [HIGH | Local architecture] Exact pins match current platform policy; caret ranges weaken reviewed artifact boundaries.

### Decision matrix

| Candidate                         | Decision                           | Reason                                                                                                                                                               |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cron-parser@5.10.0`              | **Conditional wrap**               | [HIGH \| Primary] Calculator API, explicit reference/timezone, forward/backward iteration, strict validation, provenance. [MEDIUM \| Trial] DST contract unresolved. |
| `croner@10.0.1`                   | **Reject baseline; retain oracle** | [HIGH \| Primary + trial] Smaller but unneeded scheduler; no npm attestation; DST claims conflict with non-hour behavior.                                            |
| Node 26 `Temporal`                | **Do not baseline**                | [HIGH \| Primary] Default only in Node 26 while project supports Node `>=22.19.0`; no cron grammar.                                                                  |
| `@parcel/watcher@2.6.0`           | **Wrap**                           | [HIGH \| Primary + trial] Native recursive Windows backend, typed batches, snapshots, clean unsubscribe, stronger large-tree evidence.                               |
| `chokidar@5.0.0`                  | **Reject baseline; retain oracle** | [HIGH \| Primary] Lighter pure JS, but open fresh-directory race and per-directory pressure overlap requirements.                                                    |
| Node `fs.watch()`                 | **Reject direct primary adapter**  | [HIGH \| Primary + trial] Low-level `rename`/`change`, duplicates, nullable names, platform caveats; direct use recreates normalization library.                     |
| `ws@8.21.3`                       | **Wrap**                           | [HIGH \| Primary + trial] Address pinning, hard bounds, ping/pong, `terminate()`, zero mandatory runtime deps.                                                       |
| Node global `WebSocket`           | **Reject here**                    | [HIGH \| Primary] Stable basic client, but no exposed payload/fragment caps, ping/pong API, or forced termination. Custom dispatcher requires userland Undici.       |
| `p-queue@9.3.3` / `p-limit@7.3.1` | **Reject**                         | [HIGH \| Primary] No keyed coalescing, hard admission, recursion suppression, durable fences, or required shutdown semantics.                                        |

## Findings

### Repository and Node 26 fit

- [HIGH | Local primary] Root engines remain Node `>=22.19.0`; native runtime: Windows x64 Node `v26.4.0`, npm `11.17.0`, Undici `8.5.0`, ICU `78.3`.
- [HIGH | Local primary] Platform already owns TriggerEngine, lifecycle, destination validation, address-pinned HTTP, StateStore transactions/leases, mailbox delivery, and child roles. Packages remain adapters beneath those contracts.
- [HIGH | Local primary] Platform has no direct cron, watcher, WebSocket, or queue dependency. Transitive AWS WebSocket middleware and nested Undici are not legal direct imports.
- [HIGH | Primary] Node 26 enables `Temporal` by default, but repository floor is Node 22. [Node 26](https://nodejs.org/en/blog/release/v26.0.0)
- [HIGH | Primary] `setTimeout()` gives no exact timing guarantee; delays above `2_147_483_647` ms become `1` ms. Re-arm long waits and recompute persisted state. [timers](https://nodejs.org/download/release/v26.4.0/docs/api/timers.html#settimeoutcallback-delay-args)
- [HIGH | Primary] `node:timers/promises`, `AbortSignal.timeout()`, and `AbortSignal.any()` provide abortable queue waits, not cron or persistence. [timers promises](https://nodejs.org/download/release/v26.4.0/docs/api/timers.html#timers-promises-api) [AbortSignal](https://nodejs.org/download/release/v26.4.0/docs/api/globals.html#class-abortsignal)
- [HIGH | Primary] Recursive `fs.watch()` supports AbortSignal. Node 26.4 docs expose `ignore` and the v26.1-added `throwIfNoEntry`; Node 22.19 watcher docs expose neither. [Node 26 watch](https://nodejs.org/download/release/v26.4.0/docs/api/fs.html#fswatchfilename-options-listener) [Node 22 watch](https://nodejs.org/download/release/v22.19.0/docs/api/fs.html#fswatchfilename-options-listener)
- [HIGH | Primary] Node documents watcher inconsistency, network/virtualization unreliability, nullable names, Windows root-move silence and delete `EPERM`. [caveats](https://nodejs.org/download/release/v26.4.0/docs/api/fs.html#caveats)
- [HIGH | Primary + native trial] Raw recursive watcher emitted 17 low-level notifications for synthetic create/append/atomic replace/rename/delete/nesting. Cleanup passed; classification/dedupe remained application work.
- [HIGH | Primary] Global `WebSocket` is stable since Node 22.4. Userland Undici adds dispatcher and `ping()`, but global API lacks documented message limits/forced termination. [Node WebSocket](https://nodejs.org/download/release/v26.4.0/docs/api/globals.html#class-websocket) [Undici](https://undici.nodejs.org/api/WebSocket)
- [HIGH | Primary] Web Streams high-water strategies are not task admission/coalescing. `worker_threads.locks` is experimental, Node 24.5+, and same-process only. [streams](https://nodejs.org/download/release/v26.4.0/docs/api/webstreams.html) [locks](https://nodejs.org/download/release/v26.4.0/docs/api/worker_threads.html#worker_threadslocks)

### Cron parsing, timezones, and DST

- [HIGH | Primary] `cron-parser@5.10.0` requires Node `>=18`, depends only on `luxon@^3.7.2`, has built-in types, strict parsing, explicit date bounds/timezone, and forward/backward iteration. [npm](https://www.npmjs.com/package/cron-parser) [source](https://github.com/harrisiirak/cron-parser/tree/609feef553d76461a8925383bad9351fb6d91116)
- [HIGH | Primary] Recent `5.6.0`-`5.9.0` releases fixed several DST gaps, wide transitions, iteration limits, and invalid dates. Active repair is positive but proves need for permanent transition tests. [releases](https://github.com/harrisiirak/cron-parser/releases)
- [HIGH | Primary] `5.6.2` shipped stale `dist/` without advertised fixes and was deprecated; current `5.10.0` has SLSA provenance tied to commit `609feef`. [5.6.2](https://github.com/harrisiirak/cron-parser/releases/tag/v5.6.2) [attestation](https://registry.npmjs.org/-/npm/v1/attestations/cron-parser@5.10.0)
- [MEDIUM | Native Windows trial] In `America/New_York`, cron-parser and Croner moved nonexistent `02:30` to `03:30` after spring-forward and emitted ambiguous `01:30` once at first fall-back occurrence.
- [MEDIUM | Native Windows trial] In 30-minute `Australia/Lord_Howe`, behavior diverged: Croner shifted nonexistent `02:15` to `02:45`; cron-parser skipped that date. In overlap, cron-parser chose first `01:45`; Croner chose second.
- [HIGH | Primary + native contradiction] Croner docs say gaps skip and overlaps use first occurrence, while accepted PR calls moving New York `02:30` to `03:30` compliant and exact `10.0.1` selected second Lord Howe overlap. [PR #285](https://github.com/Hexagon/croner/pull/285) [source](https://github.com/Hexagon/croner/tree/adc86215e92e4f7cceaf8127dfcd1b514ef7bafc)
- [HIGH | Local architecture] One-shot schedules store absolute UTC. Fixed intervals advance from scheduled occurrence, not completion. Cron stores normalized expression + IANA zone and computes next UTC from last committed occurrence.
- [HIGH | Local architecture] Package callbacks/timers, overrun protection, and job registries stay out. StateStore owns occurrence identity, next-run commit, missed policy, lease/fence, and receipt.
- [MEDIUM | Recommendation] Prefer cron-parser because it is calculator-focused, strict, reference-explicit, and attested. Do not approve until Phase 7 chooses/tests gap and overlap semantics.

### Windows filesystem watching

- [HIGH | Primary] `@parcel/watcher@2.6.0` uses `ReadDirectoryChangesW`, emits coalesced `create`/`update`/`delete` batches, supports ignores, snapshots, and historical reconciliation. [README](https://www.npmjs.com/package/@parcel/watcher) [release](https://github.com/parcel-bundler/watcher/releases/tag/v2.6.0)
- [HIGH | Primary] Windows x64 selects `@parcel/watcher-win32-x64@2.6.0`, containing Node-API v3 native binary. Main loader falls back to local builds only if prebuild absent.
- [HIGH | Primary + static inspection] Install script runs `node-gyp rebuild` only when `npm_config_build_from_source=true`; otherwise no-op. Prebuilt trial succeeded with scripts disabled. [source](https://github.com/parcel-bundler/watcher/tree/b46c53feb075c9dfd2c87d2183eb259df384d90b)
- [HIGH | Native Windows trial] Exact `2.6.0`, `backend: "windows"`, passed create/update/atomic replace/rename/delete/nested events on Node `26.4.0`; `unsubscribe()` left no watcher/socket resources.
- [HIGH | Native Windows trial] Brute-force snapshot detected a file created while unsubscribed. Useful recovery primitive, not authority or exactly-once history.
- [MEDIUM | Native Windows trial] Child created immediately after directory can initially be represented by directory event only. Scan every created directory regardless of backend.
- [HIGH | Primary] Chokidar `5.0.0` is ESM-only, Node `>=20.19.0`, one dependency, normalizes atomic/chunked writes, and passed ordinary Windows fixture. [release](https://github.com/paulmillr/chokidar/releases/tag/5.0.0)
- [HIGH | Primary adverse] Chokidar v5 has open deterministic race between new-directory scan and watcher registration; files in gap are missed until later event. [issue #1471](https://github.com/paulmillr/chokidar/issues/1471)
- [HIGH | Local architecture] Watch paths are untrusted hints. Canonicalize at consumption, reject escapes/junction traversal, reapply scope/ignore policy, then enqueue bounded envelope.
- [HIGH | Local architecture] Network shares, OneDrive placeholders, junctions, root rename/delete, denial, and overflow degrade to explicit error plus bounded reconciliation. Never silently switch all trees to aggressive polling.

### WebSocket client

- [HIGH | Primary] `ws@8.21.3` has zero mandatory runtime dependencies, Node `>=10`, MIT, client ping/pong, `terminate()`, handshake timeout, redirect control, HTTP/TLS options, and `maxPayload`, `maxFragments`, `maxBufferedChunks`. [npm](https://www.npmjs.com/package/ws) [API](https://github.com/websockets/ws/blob/c791e707eab3c13dd9a261d2479c3cc4a49a6fed/doc/ws.md)
- [HIGH | Primary] Client defaults are too broad: compression enabled, `maxPayload` 100 MiB, `maxFragments` 16,384, `maxBufferedChunks` 262,144. Override all; keep UTF-8 validation.
- [HIGH | Primary] Redirect following defaults off. Set `followRedirects: false` explicitly so authorization cannot be redirected away.
- [HIGH | Native loopback trial] Pinned `lookup` resolved synthetic `phase7.invalid` only to `127.0.0.1` while preserving Host. Compression stayed absent; ping/pong worked; `maxPayload: 32` rejected 64 bytes with `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`; close released network resources.
- [HIGH | Local architecture] Reuse current external-control decision and resolved addresses. No second uncontrolled DNS lookup. For `wss:`, preserve hostname as TLS `servername`; reject origin/protocol changes.
- [HIGH | Local architecture] MonitorRegistry owns reconnect, jitter, heartbeat, pause/resume, decode, redaction, batching, and output bounds. Do not add reconnect wrapper.
- [HIGH | Primary] Do not install optional native peers `bufferutil` or `utf-8-validate`; supported Node does not need them. [README](https://github.com/websockets/ws/tree/c791e707eab3c13dd9a261d2479c3cc4a49a6fed)

### TriggerEngine queue primitives

- [HIGH | Local architecture] Queue needs provenance, deterministic order, hard global/per-source capacity, keyed coalescing, overflow accounting, recursion suppression, per-trigger concurrency, deadline propagation, inspectability, settled shutdown, fake clock.
- [HIGH | Primary] `p-queue@9.3.3` defaults concurrency to infinity, requires caller backpressure, does not persist, and warns `.clear()` leaves queued promises unsettled. Running work must honor abort itself. [README](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/readme.md)
- [HIGH | Primary] `p-limit@7.3.1` supplies only concurrency limiting, not pause, provenance, coalescing, admission, or durable claims. [npm](https://www.npmjs.com/package/p-limit)
- [HIGH | Local architecture] Implement bounded deque plus `Map<CoalesceKey, QueueNode>`, not unbounded promises. Every accepted item gets one settlement path; overflow/coalesce/shutdown settle or account deterministically.
- [HIGH | Local architecture] Compose shutdown, caller, deadline with `AbortSignal.any()`. Timeout is cancellation request, not proof work stopped; fence late results.
- [HIGH | Local architecture] Durable occurrences remain StateStore rows/events; process exclusivity remains transactional lease/fence. Restart reconstructs eligible work from records, never serialized closures.

### Dependency, license, provenance, and security footprint

| Selection               | Exact footprint                                                                                                                                                                          | License/scripts                                                                                                          | Provenance/security snapshot                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cron-parser@5.10.0`    | [HIGH \| Local registry] 2 runtime packages with `luxon@3.7.2`; 1,043,221 packed and 4,747,091 unpacked bytes combined.                                                                  | [HIGH \| Primary] Both MIT; no install scripts; Node `>=18`.                                                             | [HIGH \| Primary] Integrity `sha512-izNAxJyRWUP8ljBoDSub5WyrVOUlT4SLGShswE7eoRBpp6QUsSycYxLBMJlbshgPBMcPT/nrfgjNY2918ayv2A==`; SLSA; commit `609feef553d76461a8925383bad9351fb6d91116`. [MEDIUM \| Registry] Audit: 0 known vulnerabilities.                                                                                                                                                                                                        |
| `@parcel/watcher@2.6.0` | [HIGH \| Local registry] 18 lock entries across optional platforms; 7 actual Windows x64 packages. Main 34,902 packed / 133,279 unpacked bytes; Windows binary package 532,732 unpacked. | [HIGH \| Primary] MIT except `detect-libc` Apache-2.0; conditional build-from-source install script; Node-API v3 binary. | [HIGH \| Primary] Main integrity `sha512-7FNeNl8NCE7aINx7WXiKQrPYZWC/hvrTsmk6zmxbI7LTXE7hVek/n8AfVgpe2y82zl3w0HvCHN0bVKMBoJcC0w==`; Windows integrity `sha512-cA+/pXV2YkfxlIcXOQ5fSWqAzzPyD78/x5qbK/I0vUkrlYHA8TIz+MXjAbGouguKVSI4bOmkTSJ1/poVSsgt+A==`; commit `b46c53feb075c9dfd2c87d2183eb259df384d90b`; no attestation. Trial binary SHA-256 `6c26cff1cc989bde1cdb40f49463c6a1612e528ca0cc11ac1594541a1204f4f2`. [MEDIUM \| Registry] Audit: 0. |
| `ws@8.21.3`             | [HIGH \| Local registry] 1 runtime package; 35,016 packed / 150,929 unpacked bytes. `@types/ws@8.18.1`: 6,013 / 42,347 dev bytes, reuses Node types.                                     | [HIGH \| Primary] MIT; no scripts; optional native peers excluded.                                                       | [HIGH \| Primary] Integrity `sha512-201TZ/kPWxoPr/OKWjquZR1SWKXcvxdH+e1xrx89b3YbmzLMFCLfnaG1HFIgWzJOEWZ7MvpK++odZufgYR50Rw==`; commit `c791e707eab3c13dd9a261d2479c3cc4a49a6fed`; signatures, no attestation. [MEDIUM \| Registry] Audit: 0.                                                                                                                                                                                                        |
| Repository queue        | [HIGH \| Local architecture] 0 packages.                                                                                                                                                 | Existing license/tooling.                                                                                                | Existing review/test surface; no new supply chain.                                                                                                                                                                                                                                                                                                                                                                                                  |

- [HIGH | Local registry] Actual Windows Parcel tree resolved exactly: `@parcel/watcher@2.6.0`, `@parcel/watcher-win32-x64@2.6.0`, `detect-libc@2.1.2`, `is-glob@4.0.3`, `is-extglob@2.1.1`, `node-addon-api@7.1.1`, and `picomatch@4.0.7`.
- [HIGH | Primary] `@types/ws@8.18.1` integrity is `sha512-ThVF6DCVhA8kUGy+aazFQ4kXQ7E1Ty7A3ypFOe0IcJV8O/M511G99AW24irKrW56Wt44yG9+ij8FaqoBGkuBXg==`; its only dependency is `@types/node: "*"`, already present in platform.
- [HIGH | Primary] `croner@10.0.1`: one MIT/no-script package, 36,747 packed / 154,686 unpacked bytes, Node `>=18`, integrity `sha512-ixNtAJndqh173VQ4KodSdJEI6nuioBWI0V1ITNKhZZsO0pEMoDxz539T4FTTbSZ/xIOSuDnzxLVRqBVSvPNE2g==`, commit `adc86215e92e4f7cceaf8127dfcd1b514ef7bafc`, no attestation, audit 0.
- [HIGH | Primary] `chokidar@5.0.0`: `readdirp@5.1.1`; 108,894 combined unpacked bytes; MIT/no-script; SLSA main package; audit 0.
- [HIGH | Primary] `p-queue@9.3.3`: 3 MIT/no-script packages, 171,891 combined unpacked bytes. `p-limit@7.3.1`: 2 packages, 23,005 bytes. Neither closes TriggerEngine requirements.
- [MEDIUM | Security interpretation] Zero-result npm audit means current advisories matched no versions. It does not verify source correctness, native reproducibility, protocol policy, or future advisories.

## Contradictions and hidden variables

- [HIGH | Primary + trial] **Croner “skip / first” vs behavior:** New York gap shifted; Lord Howe overlap used later occurrence. Hidden variable is timezone transition width/rule.
- [HIGH | Primary + trial] **cron-parser “robust DST” vs policy:** New York gap shifted while Lord Howe gap skipped. “Handles DST” is not a portable semantic contract.
- [HIGH | Primary] **Node 26 Temporal vs baseline:** current runtime models ambiguity; minimum Node cannot rely on it. Raising engines is separate decision.
- [HIGH | Primary + trial] **Pure JS simplicity vs watcher reliability:** Chokidar is smaller but open registration race and per-directory model conflict with long-lived recursive monitoring. Parcel trades native supply surface for one recursive backend and snapshots.
- [HIGH | Primary] **Native WebSocket vs monitor safety:** Node has basic protocol client; Phase 7 needs pinning, low caps, heartbeat observability, and force-close.
- [HIGH | Primary] **Queue feature count vs fit:** `p-queue` controls do not repair clear/timeout semantics or generic unbounded admission.
- [HIGH | Primary] **Parcel snapshots vs durability:** Windows historical query can traverse current state; it does not prove exactly-once history. StateStore receipts remain authority.

## Survivorship-bias sweep

- [LOW | Discovery] Exact searches found no credible public migration away from `cron-parser` or Croner. Silent removals and private failures remain invisible.
- [HIGH | Primary adverse] Croner `9.1.0` emitted work every millisecond during fall-back on Node 22/24; `10.0.0` fixed it. Reject package-owned timers. [issue #286](https://github.com/Hexagon/croner/issues/286)
- [HIGH | Primary adverse] cron-parser has repeated DST/iteration fixes and one stale-dist release. Exact pin + transition matrix mandatory. [releases](https://github.com/harrisiirak/cron-parser/releases)
- [HIGH | Primary adverse] Chokidar v5 still has fresh-directory race. [issue #1471](https://github.com/paulmillr/chokidar/issues/1471)
- [MEDIUM | Primary project report] Kiri replaced Chokidar with Parcel watcher after `EMFILE` around 3,000+ files. One project is not universal evidence, but failure mode matches project monitors. [changelog](https://github.com/CAPHTECH/kiri/blob/main/CHANGELOG.md#0224---2025-12-17)
- [HIGH | Primary] Vite considered raw `fs.watch()` but declined to rebuild Chokidar-like normalization and said a switch would likely use Parcel watcher. [Vite #12495](https://github.com/vitejs/vite/issues/12495)
- [HIGH | Primary] Node's guide recommends native WebSocket for basic clients. Genuine migration pressure against `ws`, but guide omits caps, address pinning, heartbeat, force-close. [Node guide](https://nodejs.org/learn/getting-started/websocket)
- [LOW | Discovery] No credible current `ws` client migration-away report found. Server framework/Socket.IO migrations solve different requirements.
- [HIGH | Primary] `p-queue` declares itself feature-complete with no planned development/support and documents unsettled `.clear()` promises. [README](https://github.com/sindresorhus/p-queue/blob/180ab9e25cd10b6f548767d7176076b50d25e188/readme.md)
- [MEDIUM | Discovery] Download/dependent counts were only compatibility signals, never correctness or retention evidence.

## Don't Hand-Roll

| Problem                  | Don't Build                                                              | Use Instead                                                   | Why                                                      |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------- |
| Cron grammar             | [HIGH \| Primary] Tokenizer, ranges, calendar search                     | [MEDIUM \| Recommendation] Conditional cron-parser wrapper    | Mature parsing/iteration; DST policy stays explicit.     |
| Native recursive backend | [HIGH \| Primary] ReadDirectoryChangesW binding or per-dir farm          | [HIGH \| Recommendation] Parcel adapter                       | Native recursion, typed batches, snapshots, unsubscribe. |
| WebSocket framing        | [HIGH \| Primary] Upgrade, masking, fragmentation, UTF-8, control frames | [HIGH \| Recommendation] `ws` adapter                         | Tested RFC implementation with limits.                   |
| Durable claims           | [HIGH \| Local] File/PID/Node thread locks                               | [HIGH \| Local] Existing StateStore lease/fence               | Cross-process crash safety.                              |
| Generic queue            | [HIGH \| Local] Adapt broad queue into TriggerEngine                     | [HIGH \| Local] Narrow queue over Node primitives             | Core problem is policy, not FIFO.                        |
| Watcher truth            | [HIGH \| Primary] Assume complete ordered OS events                      | [HIGH \| Recommendation] Event hints + bounded reconciliation | Every watcher coalesces, duplicates, omits, or races.    |

## Disposable trial plan

1. [HIGH | Trial] Use OS-temp directories only. `npm pack --ignore-scripts`; verify integrity/gitHead/license/files; inspect lifecycle scripts; exact lock + `npm audit`; install scripts-disabled first. Synthetic inputs only.
2. [HIGH | Cron trial] Run vectors on Node `22.19.0`, repository baseline, and `26.4.0`; Windows x64 plus Linux CI. Cover New York, London, Lord Howe 30-minute changes, Chatham, Casablanca Ramadan, UTC, invalid zones, leap day, month ends, unsatisfiable expressions, DOM/DOW ambiguity, host `TZ` changes, next/previous symmetry, and 10,000 bounded iterations.
3. [HIGH | Cron gate] Choose one policy for nonexistent/duplicated wall times. Assert UTC occurrence IDs and local labels. If `cron-parser@5.10.0` cannot satisfy it without reimplementing calendar search, reject and record ADR rather than patch silently.
4. [HIGH | Watch trial] Compare Parcel, Chokidar, raw watcher against fixture oracle on NTFS: create/update/chunked/atomic/rename/delete, immediate child after new directory, 10,000-file checkout, case-only rename, Unicode/long paths, root move/delete, denial, junction escape, missing filename.
5. [HIGH | Watch environment] Repeat on OneDrive placeholders and opt-in SMB. Measure misses/duplicates/coalescing, ready latency, handles, RSS/CPU, rescan cost, shutdown leaks. Network failure explicit; no automatic aggressive polling.
6. [HIGH | Native gate] Clean-install Parcel scripts-disabled; verify selected platform package/hash; run after Node upgrade; reload repeatedly; prove DLL unload/cleanup does not damage shared worktree deps.
7. [HIGH | WebSocket trial] Loopback `ws`/`wss` only. Test pinned lookup, hostname/SNI, redirect denial, rebinding attempt, proxy-env non-use, header redaction, handshake deadline, text/binary/fragment caps, compression refusal, ping/pong, half-open termination, reconnect jitter/cap, pause/resume, abort-connect, reload/shutdown.
8. [HIGH | Queue trial] Inject fake clock/adapters. Test global/per-source bounds, coalescing, overflow, fairness/order, recursive traces, per-trigger concurrency, deadline abort, late fencing, all promises settled on stop, counters, no post-shutdown events.
9. [HIGH | Durable trial] Two real Pi processes over StateStore. Crash around claim/receipt; prove one fenced claimant, missed skip/run-once, offline delivery once, restart reconstruction without closures.
10. [MEDIUM | Upgrade trial] Re-run tarball/source/provenance/audit and focused matrix on every package update. Never approve timezone/native watcher update from semver/changelog alone.

## Validation queue

- [HIGH] Decide DST gap/overlap semantics before adding cron dependency. Evidence does not support unconditional “correct DST.”
- [HIGH] Confirm five-field POSIX-only grammar. Reject seconds, `H`, `L`, `W`, `#`, aliases, and DOM+DOW combinations unless needed and tested.
- [HIGH] Record ADR for conditional cron-parser selection or rejection after matrix.
- [HIGH] Complete native watcher burst, junction, OneDrive, root-delete, and DLL lifecycle trials before manifest adoption.
- [HIGH] Define Parcel rescans and caps: initial ready, created directory, backend error/overflow, resume, snapshot mismatch, optional low-frequency reconciliation.
- [HIGH] Define WebSocket limits: handshake, idle/pong, message bytes, fragments, buffered chunks, queue items/bytes, reconnect window, lifetime.
- [HIGH] Extend external URL policy through protocol-aware `ws:`/`wss:` authorization without bypassing current HTTP controls.
- [HIGH] Specify queue results/metrics for accepted, coalesced, rejected, evicted, expired, canceled, executed, failed, late-fenced.
- [MEDIUM] Verify package matrix on minimum Node `22.19.0`; local trials used `26.4.0`.
- [LOW] Repeat survivorship search before ADR acceptance. Public silence remains weak evidence.
