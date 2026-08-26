# Phase 4 startup performance

Date: 2026-08-26

Same warm disposable `pi --print` harness used in prior phases. One warmup preceded ten measurements per branch. Phase 4 and Phase 3 control were measured back-to-back under the same elevated Windows/OneDrive load.

| Measurement | Phase 4 | Phase 3 control |
|---|---:|---:|
| Median | 12,389.8 ms | 14,334.8 ms |
| Mean | 12,459.0 ms | 15,769.3 ms |
| Minimum | 7,630.1 ms | 11,069.4 ms |
| Maximum | 18,610.2 ms | 24,169.1 ms |

Paired median change: **-1,945.0 ms (-13.6%)**.

Absolute values are not comparable to the historical Phase 3 record because machine-wide startup time increased during this run. The paired control shows no Phase 4 startup regression under matched conditions.

Language implementation, JSON-RPC transport, Git review engine, and disposable-test adapter load through dynamic imports. Session startup registers only the small loader/command wiring. No language server, Git capture, reviewer, or test process starts before first explicit operation.
