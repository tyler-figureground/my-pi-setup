# Phase 6 performance evidence

Date: 2026-08-27
Runtime: Windows 11, Node 26.4.0, offline Pi RPC startup

## Startup

Paired seven-run measurement after one warm-up per checkout:

| Checkout | Median | Mean | Min | Max |
|---|---:|---:|---:|---:|
| Phase 5 control | 5,468.1 ms | 5,481.6 ms | 5,180.2 ms | 5,890.3 ms |
| Phase 6 | 5,720.6 ms | 5,688.2 ms | 5,336.4 ms | 5,855.1 ms |

Median change: **+252.5 ms (+4.6%)**.

Raw output: `C:/Users/Tyler/AppData/Local/Temp/pi-phase6-startup-benchmark.json`.

Phase 6 production configuration enables local same-project messaging, so startup includes project resolution, shared StateStore initialization, Session Presence/Lease attachment, and delivery adapter indexing. Memory remains lazy: enabled-but-unused startup does not create or open `memory.sqlite`.

## Memory retrieval

Versioned SQLite-backed evaluation:

- precision@3: `0.3611`
- recall@3: `0.9167`
- MRR: `0.9167`
- scope leaks: `0`
- forbidden hits: `0`
- p95 observed in final isolated run: `7.5269 ms`
- maximum observed in final isolated run: `16.7338 ms`
- maximum returned context: `1,512` bytes

See `docs/verification/phase-6-memory-quality.md` and `extensions/platform/memory-quality.test.ts`.

## Messaging bounds

Focused/native evidence verifies:

- discovery pages beyond 1,000 nonmatching Presence records
- explicit fanout cap: 32 recipients
- pending mailbox cap: 1,000 per recipient
- sender-indexed bounded outbound query
- 30-day terminal history and 24-hour messaging receipt retention
- targeted StateStore compaction preserves unrelated module receipts
- native writer-lock close remains bounded
- failed event compaction is recoverable on a later broker generation

## Disabled and lazy behavior

With Phase 6 flags off:

- no Phase 6 tools or commands
- no SQLite open/migration
- no Artifact directory
- no heartbeat/poller
- no provider/network/process work

With Memory enabled but unused, no Memory database or Artifact path materializes.
