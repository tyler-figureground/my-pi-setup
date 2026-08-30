# Phase 8 performance and endurance evidence

Date: 2026-08-30
Runtime: Windows 11, Node 26.4.0

## Hard bounds

- 128 nodes per Goal, 32 dependencies per node, 6 Attempts per node
- Host configuration narrows live setup to 100 Goals, 32 nodes per Goal, 4 concurrent nodes, and 256 Agent calls
- Transactional capacity and concurrent-claim checks apply across runtimes
- Per-Attempt timeout, output, token reservation, and retry/backoff bounds
- Cumulative token usage metered separately from context occupancy for Pi, Claude, and Codex
- Token cancellation occurs between provider requests; worst-case reservation includes one in-flight-request overshoot
- Monetary cost budgets require authoritative metering and fail before confirmation in current production adapters
- Observation pages, audit history, evidence, receipts, outbox, terminal retention, worker outcome retention, and cleanup passes are bounded
- Goal Worker retained state: 256 entries, 30-minute age, 32 outcomes, 64 KiB total, 8 KiB per entry
- Terminal Goal sweep runs at most every 60 seconds and never deletes unsettled Attempts, unreconciled cancellation, Artifacts, or Guarded Workspaces

## 72-hour simulated run

`extensions/platform/goal-soak.integration.test.ts` advances deterministic fake time across 72 hours with two shared-store runtimes, six bounded DAGs plus ambiguity/control scenarios, retries, evidence gates, pause/resume, runtime replacement, concurrency four, and lifecycle shutdown.

Latest focused metrics:

- Goals submitted/completed: 8/6
- DAG nodes completed: 48
- Attempts dispatched / unique Attempt keys: 68/68
- Peak concurrency: 4
- Retry Attempts: 18
- Evidence-gate rejections: 6
- Unknown Attempts / redispatches: 1/0
- Runtime instances/replacements: 4/2
- Armed deadline advances: 18
- Timers after close: 0
- Active leases after close: 0

Raw metrics: `C:/Users/Tyler/AppData/Local/Temp/pi-phase8-goal-soak-40488.json`.

## Killed-parent drill

`extensions/platform/goal-killed-parent.integration.test.ts` uses real child Node processes and real `node:sqlite` state. Parent process is force-killed with Windows process-tree termination at pre-dispatch `prepared` and post-dispatch `dispatching` barriers.

Observed:

- Pre-dispatch: same Attempt reclaimed, one Attempt record, Goal completed, higher fence, no duplicate evidence/outbox
- Post-dispatch: zero redispatch, Goal blocked as Unknown Attempt, dependent remained waiting, workspace preserved
- Four stale fence/version probes refused in each scenario
- Budget charged once and reservations returned to zero
- Recovery latency bounded by 5-second lease TTL

Focused drill: 2/2 pass.

## Live metering

An earlier Phase 8 `npm run test:live` run passed 5/5. Pi, Claude, and Codex each produced positive finite cumulative token totals across two turns while context occupancy remained separate. Final strict-increase rerun passed Codex and Pi; Claude could not run because the external account returned its session-limit response. Static and synthetic Claude aggregation tests include tool/sidechain billing; rerun the two live Claude cases after quota reset.
