---
status: accepted
---

# Use built-in `node:sqlite` for durable StateStore persistence

StateStore uses a plain-data `transact`/`query`/`compact`/`export`/`diagnose` interface with interchangeable in-memory and built-in `node:sqlite` adapters. `node:sqlite` avoids a native third-party dependency while providing atomic migrations, WAL durability, `BEGIN IMMEDIATE` cross-process serialization, busy waiting, consistent online backup, and integrity checks on supported Node versions.

SQLite stores bounded metadata, records, ordered events, idempotency receipts, durable stream heads, and fenced leases. Large bodies remain outside StateStore. Event positions and lease fences never reset during compaction; transaction receipts may be removed only through an explicit age threshold, which also ends their idempotency window. Database and backup files use mode `0600` where POSIX file modes are supported.

Rejected alternatives: JSON files cannot safely coordinate concurrent Pi processes or recover interrupted multi-record writes; `better-sqlite3` adds an external native dependency and installation surface without needed Phase 1 capability. The synchronous SQLite interface is contained behind StateStore and each operation uses a short-lived connection, keeping callers asynchronous and preventing leaked handles during reload or Windows cleanup.
