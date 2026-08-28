# Phase 7 automation architecture

Status: confirmed design, implementation in progress
Date: 2026-08-28

## Scope

Phase 7 completes declarative hooks (F08), adds Reactive Monitors (F15), and adds Scheduled Prompts (F16). It does not implement the Phase 8 Goal Engine.

## Confirmed module seams

Callers and tests cross the same four interfaces.

### TriggerEngine

```ts
interface TriggerEngine {
  reconcile(request: TriggerReconciliation): Promise<TriggerOutcome<TriggerGeneration>>;
  publish(event: TriggerInput, options?: TriggerPublishOptions): Promise<TriggerOutcome<TriggerReceipt>>;
  inspect(query?: TriggerInspectionQuery): TriggerInspection;
}
```

`reconcile` atomically replaces one owner's Trigger Bindings. `publish` admits a bounded Trigger Event after host/source binding stamps provenance. `inspect` returns bounded metadata and counters, never event bodies, callbacks, timers, sockets, or storage rows.

TriggerEngine owns:

- host-stamped event IDs, source provenance, Project Identity, session identity, trust class, and causal ancestry
- deterministic routing and per-binding FIFO
- bounded queues, byte budgets, debounce, batch coalescing, and observable overflow
- per-binding concurrency and deadlines
- direct and indirect recursion/self-trigger suppression
- restart-only persistence and replay receipts
- generation fencing, quiescence, and no delivery after close

Gate events such as tool/input/session interception execute inline on a reserved lane. They never debounce, coalesce, or replay. Observe events may batch and run concurrently across bindings. Only events explicitly requiring restart delivery enter StateStore.

### MonitorRegistry

```ts
interface MonitorRegistry {
  change(command: MonitorCommand): Promise<MonitorOutcome<MonitorSnapshot>>;
  inspect(query?: MonitorQuery): Promise<MonitorOutcome<MonitorInspection>>;
}
```

One revisioned `change` command owns create/replace, pause, resume, stop, and delete. Request IDs are idempotent and expected revisions reject stale controls.

Reactive Monitor sources:

- ordered Background Terminal output subscription, never a second process manager
- canonicalized filesystem root with bounded reconciliation
- named bounded poll adapter, never arbitrary shell or callback
- policy-approved WebSocket with pinned address resolution and bounded reconnect

Monitor output is untrusted data with authority `none`. Full evidence uses Artifact storage; model/session batches stay bounded. Terminal monitors are session-only. Durable remote/file monitors revalidate Project Identity, trust, policy, destination, and credentials before activation.

### Hooks

```ts
interface Hooks {
  configure(command: HookConfigurationCommand): Promise<HookOutcome<HookConfigurationResult>>;
  handle(invocation: HookInvocation, signal?: AbortSignal): Promise<HookOutcome<HookResponse>>;
  inspect(query?: HookQuery): HookInspection;
}
```

Hooks owns trusted config loading, matching, policy-safe action execution, history, and host decisions. Wiring receives only bounded context and block results. Version 1 YAML remains compatible; new configuration is revisioned and atomically applied.

Changed project config is suspended before another execution, then path identity and trust are revalidated. Invalid changed config never silently runs changed bytes. CapabilityPolicy and Plan Mode remain authoritative. Hook `allow` is advisory.

Initial Phase 7 actions: command, notify, status, context, policy, named HTTP, named MCP, and named Agent Profile. Hook-created monitors or schedules are intentionally absent from initial Phase 7, structurally preventing recursive daemon creation.

### Scheduler

```ts
interface Scheduler {
  change(command: ScheduleCommand): Promise<ScheduleOutcome<ScheduleSnapshot>>;
  inspect(query?: ScheduleQuery): Promise<ScheduleOutcome<ScheduleInspection>>;
}
```

One revisioned `change` command owns create/replace, pause, resume, run-now, and delete.

Schedule kinds:

- one-shot RFC 3339 instant with explicit offset
- anchored fixed interval
- five-field cron with explicit IANA timezone

Cron excludes seconds, aliases, `H`, `L`, `W`, `#`, and ambiguous simultaneous day-of-month/day-of-week constraints. Nonexistent local DST times are skipped. Repeated local times execute once at the earliest matching instant. Interval cadence derives from scheduled instants, not completion.

Missed-run `skip` advances to the first future occurrence. `run-once` collapses every overdue occurrence into one bounded catch-up occurrence. `run-now` has a separate deterministic identity and does not move regular cadence.

Every durable Schedule binds host-resolved Project Identity, canonical cwd, creator/result route, `scheduled` Execution Role, immutable Agent Profile identity/digest, prompt Artifact, and policy limits. These are revalidated before every occurrence.

A Schedule Occurrence has one current transactional claimant and a fencing token. The fence prevents stale completion and delivery, but arbitrary child/external effects cannot truthfully be exactly once. Ambiguous post-spawn crashes become visible `unknown`/blocked outcomes rather than automatic duplicate execution.

## Internal adapter seams

Each seam has a production adapter and deterministic test adapter.

| Seam | Production | Test |
|---|---|---|
| Clock | one physical timer and current wall clock | manually advanced fake clock |
| Trigger persistence | StateStore | in-memory adapter; native SQLite fixture |
| Terminal observation | existing TerminalManager multicast output | in-memory terminal feed |
| Filesystem watching | reviewed watcher plus bounded snapshot reconciliation | fake watcher; Windows fixture |
| Poll target | allowlisted CI/PR provider | recording/local fixture |
| WebSocket | pinned, no-redirect client | local fixture/mock |
| Hook command | bounded no-shell process runner | recording runner |
| Hook HTTP/MCP/agent | existing policy-controlled modules | recording/local fixture adapters |
| Scheduled child | host Agent execution adapter | deterministic recording runner |
| Result delivery | ArtifactStore plus SessionBroker | in-memory receipt adapter |

Pure matching, recurrence math, state transitions, causal checks, and queue bookkeeping remain implementation details, not adapter interfaces.

## Lifecycle

Only Parent owns TriggerEngine, MonitorRegistry, Hooks, or Scheduler daemons. A child with `scheduled` Execution Role cannot own them.

Dynamic source resources use releasable Lifecycle leases. Pause/delete/reconcile waits for watcher/timer/socket/subscription close before acknowledging the transition. Release and session shutdown share one close operation.

Startup order:

1. Resolve role, config, Project Identity, trust, policy, profile catalog, and result route.
2. Create shared state/artifact infrastructure only when needed.
3. Acquire TriggerEngine.
4. Configure Hooks.
5. Restore Reactive Monitors.
6. Restore Scheduler and recover due state.
7. Arm external sources and scheduler timer last.

Shutdown order:

1. Reject new Phase 7 mutations and seal scheduler claims.
2. Close monitor sources and fence late callbacks.
3. Drain/cancel Scheduled Occurrences within bounds while mailbox delivery remains available.
4. Run one bounded session-shutdown hook dispatch.
5. Quiesce TriggerEngine and settle accepted work.
6. Close messaging after automation can no longer deliver.
7. LifecycleSupervisor aggregates any remaining degraded cleanup.

## Authority and trust

- Event/config/source/model/monitor/schedule data cannot supply authority, provenance, project identity, role, trust, profile binding, recipient identity, or fencing token.
- Direct user confirmation is bound to the exact current mutation and rechecked immediately before commit.
- A background action that requires confirmation becomes blocked; it never opens an unattended modal or converts data into approval.
- Plan Mode denial cannot be overridden by a hook, monitor, Schedule, Mailbox Message, or child result.
- Scheduled children receive exact resolved profile tools and limits and cannot recursively orchestrate.
- Large and secret-bearing data never enters StateStore metadata or bounded inspection histories.

## Capacity and performance

Initial hard ceilings:

- 256 hooks
- 128 Reactive Monitors, at most 16 remote sources
- 1,000 durable Schedules
- 1,024 queued Trigger Events and bounded global bytes
- 128 pending events per Trigger Binding
- 8 active consumers globally
- 1 active Schedule Occurrence per Schedule
- 4 scheduled children globally, subordinate to Agent execution limits
- one physical wake timer for schedules/debounce deadlines

No definitions means no watcher, socket, poll, timer, database write, Artifact path, child, or network request.

## Confirmed test seams

- TriggerEngine through `reconcile`, `publish`, and `inspect`
- MonitorRegistry through `change` and `inspect`
- Hooks through `configure`, `handle`, and `inspect`
- Scheduler through `change` and `inspect`
- TerminalManager ordered observation interface
- Pi wiring/composition surfaces
- native SQLite multi-process boundary

Tests vary internal adapters only at factory construction. They do not inspect timer maps, worker promises, private queues, SQLite rows, watcher handles, or sockets.

Acceptance requires fake-clock calendar tests, native Windows watchers/processes, local poll/WebSocket fixtures, two-process claims, offline result delivery, reload/shutdown fencing, and long-duration no-leak/no-duplicate soak.
