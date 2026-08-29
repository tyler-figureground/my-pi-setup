# Phase 7 performance evidence

Date: 2026-08-29
Runtime: Windows 11, Node 26.4.0, offline Pi RPC startup

## Startup

Paired seven-run measurement after one warm-up per checkout, run after verification load settled:

| Checkout | Median | Mean | Min | Max |
|---|---:|---:|---:|---:|
| Phase 6 control | 4,569.1 ms | 4,601.5 ms | 4,215.4 ms | 5,042.6 ms |
| Phase 7 | 4,890.1 ms | 4,706.4 ms | 4,385.1 ms | 4,955.0 ms |

Median change: **+321.0 ms (+7.0%)**.

Raw output: `C:/Users/Tyler/AppData/Local/Temp/pi-phase7-startup-benchmark-final.json`.

Phase 7 production configuration initializes the shared StateStore, authenticated Trigger persistence adapter, and configured Parent automation composition. Empty Monitor/Scheduler configuration remains inert: no source, timer, network connection, Artifact body, or child process starts.

## Runtime bounds

- Trigger queue, root fanout, causal depth, active callbacks, per-binding concurrency, history, and persistence paging are hard bounded.
- Monitor sources enforce fixed active/remote ceilings, no overlapping poll, one WebSocket connection per source, bounded evidence, and short credential-sensitive retention.
- Scheduler enforces fixed schedule/concurrency/receipt/history bounds, one transactional occurrence claimant, bounded retries/output/runtime, and one armed wake coordinator per instance.
- Suite watchdog bounds each deterministic suite process and terminates its owned process tree.

## Soak evidence

Fake-time soak:

- Trigger elapsed: 93,600,000 ms (26 hours)
- Scheduler elapsed: 108,000,000 ms (30 hours)
- Scheduler occurrences/deliveries: 47/47
- Duplicate execution owners: 0
- Active claims after close: 0
- Monitor generations: 8
- Unresolved Monitor callbacks/sources after close: 0/0

Windows real-resource soak:

- Five generations
- 163 total deliveries
- Five terminal processes started and exited
- Zero descendants before/after
- Maximum one WebSocket client

Raw metrics:

- `C:/Users/Tyler/AppData/Local/Temp/pi-phase7-soak-150972-fake-time.json`
- `C:/Users/Tyler/AppData/Local/Temp/pi-phase7-soak-150972-windows-real-time.json`
