# Phase 8 Goal Mode architecture

Status: accepted implementation direction
Date: 2026-08-29

## Purpose

Goal Mode executes a durable, declarative directed acyclic graph of bounded Agent work. It is distinct from Workflow JavaScript: Goal definitions are plain validated data, contain no executable orchestration code, and expose no runtime evaluator.

## External seam

`GoalEngine` is a deep module with five methods:

```ts
interface GoalEngine {
  submit(command: GoalSubmitCommand, authority: GoalCommandAuthority): Promise<GoalOutcome<GoalMutationReceipt>>;
  resume(command: GoalResumeCommand, authority: GoalCommandAuthority): Promise<GoalOutcome<GoalMutationReceipt>>;
  pause(command: GoalPauseCommand, authority: GoalCommandAuthority): Promise<GoalOutcome<GoalMutationReceipt>>;
  cancel(command: GoalCancelCommand, authority: GoalCommandAuthority): Promise<GoalOutcome<GoalMutationReceipt>>;
  observe(query?: GoalObservationQuery): Promise<GoalOutcome<GoalObservation>>;
}
```

`submit` validates and persists a new graph. `resume` applies direct-user audited edits or manual dispositions while draft, paused, or blocked, optionally invalidates a selected node and its transitive dependents, then activates the graph. `pause` and `cancel` fence active work before cancellation. `observe` returns bounded summaries or paginated detail.

Claims, lease renewal, retries, budget reservation, attempt settlement, evidence validation, workspace disposition, and mailbox delivery remain implementation details.

## Domain

Public Goal states: `draft`, `ready`, `running`, `paused`, `blocked`, `failed`, `done`, `cancelled`.

Node states: `waiting`, `ready`, `running`, `retry-wait`, `blocked`, `failed`, `done`, `cancelled`. Ordinary unmet dependencies are `waiting`, never `blocked`.

Attempt phases: `reserved`, `prepared`, `dispatching`, `running`, `verifying`, `succeeded`, `failed`, `cancelled`, `unknown`. `unknown` means execution may have occurred but no durable outcome can be proven.

A dependency is satisfied only by a `done` node. Skip and direct user completion create an audited `done` disposition with reason and evidence.

## Validation bounds

- Maximum 128 nodes per Goal
- Maximum 32 dependencies per node
- Maximum 6 attempts per node
- Maximum 4 concurrent nodes
- Bounded text, criteria, evidence, history, and observation pages
- Cycles, self-dependencies, duplicate IDs, and missing dependencies rejected before persistence
- Retry delay and attempt count bounded
- Currency represented as integer micros, never floating point

## Persistence

Bounded records use project-namespaced collections:

- Goal head: definition revision, run generation, state, policy, budget counters
- Node: definition digest, dependency IDs, state, active Attempt, evidence
- Attempt: phase, fence, profile, workspace, reservation, outcome
- Request receipt: command digest and replay outcome
- Outbox: idempotent mailbox delivery
- Event stream: immutable user and runtime transition audit

State Records are authoritative. Events are audit, not the only reconstruction source.

Each mutation uses optimistic record versions and deterministic transaction IDs. Execution mutations also renew or release the exact lease owner and fence. Stale callbacks cannot commit.

## Claim protocol

1. Atomically validate Goal generation, node/dependency versions, reserve worst-case budget, create Attempt, update Node, and claim its lease.
2. Bind returned fence in a second transaction before any external work.
3. Revalidate pinned Agent Profile and prepare Guarded Workspace.
4. Persist `dispatching` before invoking Agent execution.
5. Settle result, usage, evidence, node state, Goal state, budget, event, and lease transactionally.

Crash before dispatch may reclaim the same Attempt. Crash after dispatch follows execution-certainty rules below.

## Execution certainty

SQLite and external Agent work cannot share one atomic transaction. Fencing guarantees exactly-once local transitions, not exactly-once external effects.

Safe recovery policy:

- Adopt a durable executor handle for the same Attempt when available.
- Settle a durable certified result when available.
- Continue when executor certifies the Attempt never started.
- Otherwise mark Attempt `unknown`, preserve workspace and Artifacts, block Goal, and require direct user resolution.
- Never automatically dispatch a second child from lease expiry, timeout, missing process, or generic retryable failure.

Production Agent execution therefore provides at-most-once opaque dispatch. Ambiguity may under-execute, but does not silently duplicate work.

## Budgets

Goal budget tracks limits, reserved amounts, and consumed amounts for:

- concurrency
- Attempts
- Agent calls
- active runtime
- tokens
- cost micros

Worst-case per-Attempt runtime, token, and cost amounts are reserved transactionally before dispatch. Settlement moves authoritative usage to consumed and releases unused reservation. Unknown Attempts consume full reservation. Token or cost limits require corresponding executor metering; unavailable metering rejects submission before confirmation rather than claiming enforcement.

Production Goal Workers meter cumulative tokens separately from context occupancy: Pi uses `getSessionStats()`, Claude uses aggregate SDK billing usage including sidechains, and Codex uses cumulative `tokenUsage.total`. Token cancellation occurs between provider requests, so worst-case reservation includes one in-flight-request overshoot. Monetary cost remains unavailable across all supported backends as one honest common interface; finite production cost budgets fail closed until backend-specific certified pricing is added.

## Profiles and workspaces

Submission pins Agent Profile name, content digest, catalog generation, and source. Every Attempt revalidates the pin and requires Execution Role `goal-worker`.

Isolated profile policy creates or rebinds a Guarded Workspace. Success may release or mark reviewed according to policy. Failure, block, cancellation uncertainty, and unknown execution preserve workspace for inspection. Recursive filesystem deletion is never used.

## Evidence gate

Worker output is an Artifact, not completion evidence by itself. Each criterion names accepted evidence kinds and minimum count. Evidence references bind criterion IDs, trust (`worker-reported`, `host-verified`, or `user-accepted`), Attempt, definition revision, and Artifact metadata.

Node completion requires all node criteria. Goal completion requires every required node `done`, all Goal criteria satisfied by current-revision evidence, and no unknown Attempt. User waivers are explicit evidence with reason and audit event.

## Authority and edits

Direct user authority is opaque, command-digest-bound, project/session-bound, and expiring. Model input cannot manufacture it.

Objective, success criteria, dependencies, budget expansion, manual dispositions, and unknown-Attempt resolution require direct user authority. Edits occur only in `draft`, `paused`, or `blocked`. Each accepted edit records actor, reason, old/new digests, invalidated nodes, and event position. Agent-authored commands cannot silently change success criteria.

## Reused modules

- `StateStore`: transactions, optimistic versions, events, fenced leases
- `ArtifactStore`: prompts, outputs, evidence, review reports
- Agent Supervisor through a host-only Goal Worker executor port
- `WorkspaceManager`: isolated workspace lifecycle and preservation
- `ProfileCatalog`: pinning and revalidation
- Local Review: host-verified review evidence
- Session Broker: idempotent result delivery
- `LifecycleSupervisor`: clocks, shutdown, and bounded drain

## Verification strategy

Interface-level tests cover graph validation, transitions, dependency ordering, bounded parallelism, retry/failure policy, budget reservation, evidence gating, user audit, and Workflow compatibility. Native SQLite tests race multiple engines. Fake time simulates multi-hour execution. Killed-parent helpers stop at every claim/dispatch/settlement barrier and prove stale fences cannot write or redispatch ambiguous work.
