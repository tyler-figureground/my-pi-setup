# ADR 0008: Build persistent memory on node:sqlite FTS5

Status: Accepted
Date: 2026-08-27

## Context

Phase 6 requires explicit user, stable Project Identity, and Guarded Workspace scopes; typed provenance; expiry; deduplication; contradiction links; bounded full-text retrieval; secret handling; untrusted-context delivery; complete managed-body deletion; and native Windows multi-process recovery.

The selected package trial inspected exact `pi-memory@0.4.2` without executing its runtime. It stores global Markdown/JSON, enables exit-summary generation by default, injects memory into the system prompt, has no secret redaction or transactional multi-process protocol, retains forgotten text in recovery data, and relies on an optional unpinned qmd installation for search. Wrapping would replace most package behavior while preserving its lifecycle and dependency risks.

Built-in `node:sqlite` on the supported Windows runtime includes FTS5. Native probes passed scoped queries, BM25, tokenizers, snippets, integrity features, and secure-delete configuration. Existing platform work already establishes SQLite WAL, contention, integrity, backup, and Windows lifecycle patterns.

Generic `StateStore` is intentionally deep around bounded State Records, events, transaction receipts, and Leases. Widening it with SQL-shaped FTS, relationship, revision, staging, and erasure operations would weaken that interface. Its receipts also retain written metadata, making it unsuitable for memory plaintext that must be forgotten completely.

## Decision

Build a repository-owned, host-bound `MemoryStore` with the confirmed flexible interface:

- `remember`
- `search`
- `inspect`
- `change`
- `transfer`

Keep a dedicated internal persistence seam with:

- production `node:sqlite` adapter at `agentDir/state/memory.sqlite`
- deterministic in-memory adapter for interface tests
- FTS5 lexical retrieval
- scope predicates applied inside candidate queries
- `secure_delete`, FTS secure-delete, and controlled WAL checkpointing before reporting complete managed-body deletion
- content-free idempotency receipts and deletion tombstones

Use `ArtifactStore` only for explicit import/export bundles and external citations. Exported artifacts are independent user-requested copies; forgetting a Memory cannot retract them.

Automatic extraction and ambient recall remain absent until a labeled evaluation and user-review gate pass. Retrieved Memory remains quoted untrusted data outside system/developer instructions and never carries authority.

## Consequences

### Positive

- Exact project/workspace isolation and deletion semantics remain local to one deep module.
- No new runtime package, native addon, model download, provider call, or background child process.
- Deterministic, explainable retrieval with mature FTS5 ranking.
- Multi-process, migration, integrity, and Windows behavior can be verified through the same `MemoryStore` interface.

### Negative

- A second SQLite schema needs migrations, backup/export policy, diagnostics, contention tests, and secure-deletion evidence.
- Lexical retrieval may miss paraphrases. Retrieval benchmark must identify actual misses before any vector dependency is considered.
- SQLite secure deletion cannot promise erasure from filesystem snapshots, backups, crash dumps, or SSD remanence. Documentation must state the managed-storage boundary.

## Rejected alternatives

- **Adopt `pi-memory@0.4.2`:** incompatible scope, authority, deletion, redaction, generation, and concurrency semantics.
- **Wrap `pi-memory@0.4.2`:** no stable storage/interface seam; wrapper would become a fork while retaining package lifecycle risk.
- **Use qmd:** large optional native/model dependency surface without solving domain authority, isolation, or deletion.
- **Widen generic `StateStore`:** leaks memory-specific search and erasure concerns into a shared deep interface.
- **Build custom search:** FTS5 already supplies robust lexical indexing and ranking.

## Evidence

- `docs/research/phase-6-memory-packages.md`
- `docs/adr/0002-state-store-node-sqlite.md`
- Native Windows Node 26.4.0 FTS5 probe recorded in Phase 6 research
