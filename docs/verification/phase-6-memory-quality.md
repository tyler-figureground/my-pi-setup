# Phase 6 Memory quality evaluation

Date: 2026-08-27  
Dataset: `docs/verification/phase-6-memory-evaluation.json` v1.0.0  
Benchmark: `extensions/platform/memory-quality.test.ts`  
Source revision: `65fe81f` plus current Phase 6 worktree changes

## Decision

SQLite FTS5 retrieval passes the conservative v1 dataset gate. Automatic extraction does not pass its gate and remains off.

No extractor implementation or callable `MemoryStore` extraction interface exists. Current prediction is therefore no writes for every labeled extraction case. This produces zero false positives and zero false memories, but zero recall. A synthetic `automatic-proposal` write confirms proposed Memory enters `review`, stays out of search, and cannot be promoted except through direct-user ingress.

## Retrieval result

Final isolated run on Windows 11, Node 26.4.0, SQLite 3.53.2:

| Metric                                   |      Result |           Gate | Status |
| ---------------------------------------- | ----------: | -------------: | ------ |
| Precision@3                              |      0.3611 |        >= 0.25 | Pass   |
| Recall@3                                 |      0.9167 |        >= 0.85 | Pass   |
| Mean reciprocal rank (MRR)               |      0.9167 |        >= 0.85 | Pass   |
| Scope leaks                              |           0 |           <= 0 | Pass   |
| Forbidden stale/expired/cross-scope hits |           0 |           <= 0 | Pass   |
| Median search latency                    |   4.7645 ms |  Informational | -      |
| p95 search latency                       |   6.0211 ms |      <= 250 ms | Pass   |
| Maximum search latency                   |  10.4886 ms |  Informational | -      |
| Maximum returned context                 | 1,512 bytes | <= 8,192 bytes | Pass   |

The benchmark passed five consecutive implementation runs, including the full integration suite. Quality, scope, and context metrics were identical. Observed p95 latency ranged from 6.0211 ms to 26.7762 ms; the high run overlapped typecheck/format activity. Each run executed 70 measured searches.

Thresholds are intentionally conservative and dataset-specific:

- Precision uses a fixed denominator of `k=3`. Most cases have one relevant Memory, so a perfect single-hit case scores 0.3333 rather than 1.0.
- The corpus contains one deliberate semantic paraphrase miss: `Keep responses concise` queried as `short answers`. One additional positive-query miss would drop macro recall and MRR below the 0.85 gate.
- Zero tolerance applies to project/workspace scope leakage and explicitly forbidden expired or unrelated-project Memory.
- 250 ms p95 allows loaded Windows variance while still catching gross local-index regressions.
- 8 KiB context is one quarter of the store's 32 KiB default search-context ceiling.

## Automatic extraction result

The labeled set has eight should-remember and eight should-not-remember examples, including explicit preferences, durable project facts, identifiers, dates, expiry, multilingual inputs, transient questions, tool output, speculation, secrets, prompt injection, and third-party claims.

| Metric                                 | Result |                              Gate | Status   |
| -------------------------------------- | -----: | --------------------------------: | -------- |
| Predicted writes                       |      0 |                     Informational | -        |
| Recall                                 | 0.0000 |                           >= 0.80 | **Fail** |
| False-positive rate                    | 0.0000 |                           <= 0.05 | Pass     |
| False-memory rate                      | 0.0000 |                           <= 0.00 | Pass     |
| Proposal enters review state           |    Yes |                          Required | Pass     |
| Promotion requires direct-user ingress |    Yes |                          Required | Pass     |
| Overall extraction gate                | Failed |                    All conditions | **Fail** |
| Automatic extraction enabled           |     No | Must remain off after failed gate | Pass     |

For an absent extractor, false-memory rate is defined as zero when predicted-write count is zero. This is not evidence of useful extraction quality. Recall is the blocking metric.

## Method

1. Load versioned labels from the JSON dataset.
2. Create one disposable SQLite database through `createSqliteMemoryPersistenceAdapter`.
3. Create fixtures only through bound public `MemoryStore.remember` calls.
4. Model main and linked worktrees with distinct paths but the same stable Project Identity. Model a separate project and an explicit leased Guarded Workspace.
5. Advance a fixed clock past the expiry fixture.
6. Query only through `MemoryStore.search`, five times per case at `k=3`.
7. Compute macro precision@3, recall@3, and MRR over 12 positive queries. Keep two zero-relevance expiry/workspace cases as safety queries, not quality-denominator cases.
8. Count a scope leak whenever a returned record's typed scope is inaccessible to the querying host binding. Count labeled forbidden hits separately.
9. Measure each awaited search with `performance.now()`. Measure context as UTF-8 bytes of the serialized returned hit array.
10. Verify the labeled contradiction pair is symmetric through `MemoryStore.inspect`.
11. Score absent extraction as an empty predicted-write set. Probe existing review and direct-user promotion enforcement through public `MemoryStore` methods.

Coverage includes exact terms, lexical and semantic paraphrases, identifiers, dates, stale contradictory facts, expiry, linked worktrees, workspace isolation, cross-project isolation, Spanish, French, and should-remember/should-not-remember extraction labels.

## Limits

- Small, hand-labeled synthetic corpus. Metrics do not estimate production prevalence or user satisfaction.
- FTS5 is lexical. The deliberate `short answers` paraphrase miss confirms no semantic recall claim.
- Multilingual coverage is limited to Spanish and French and does not establish quality for unsegmented scripts or every tokenizer behavior.
- Contradiction labels verify retrieval and symmetric links, not truth resolution. Both active claims are returned; neither silently wins.
- Latency is warm local temporary-storage performance on one Windows machine. It excludes model calls, command UI, ambient recall, and end-to-end prompt assembly.
- Context-byte measurement covers serialized `MemoryHit[]`, not outer tool-protocol framing.
- The extraction result is a negative baseline, not an extractor benchmark. Any future extractor needs concrete predictions, source-grounded false-memory scoring, review-queue evidence, and a new versioned result before enablement.

## Commands

```text
node --test --test-timeout=60000 --experimental-strip-types extensions/platform/memory-quality.test.ts
npm run check
npm run format:check
npm run test:unit        # 291 passed
npm run test:integration # 265 passed, 5 skipped; delegated suite 22 passed
npx prettier --check docs/verification/phase-6-memory-evaluation.json docs/verification/phase-6-memory-quality.md
```

Production Memory code, platform configuration, and wiring were not changed for this evaluation.
