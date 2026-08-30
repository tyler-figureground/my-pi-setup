# Phase 8 Goal Mode threat model

Status: implementation review baseline
Date: 2026-08-29

## Assets

- User source trees and Guarded Workspaces
- Goal definitions and success criteria
- Agent Profile policy and project trust decisions
- Token, cost, runtime, and call budgets
- Evidence and result Artifacts
- StateStore integrity, leases, and audit history
- Mailbox identity and delivery idempotency

## Trust model

Goal definitions, node text, worker output, mailbox content, and Artifact bodies are untrusted data. They never grant authority. Project trust, direct user authority, profile resolution, workspace ownership, and policy decisions remain host-owned.

Goal Mode is orchestration, not operating-system containment. Child backends receive the strongest available profile and workspace policy, but no claim of OS sandboxing is made.

## Threats and controls

### Graph or transition corruption

Threat: cycles, missing dependencies, duplicate IDs, invalid transitions, or stale edits create unsafe scheduling.

Controls: bounded schema validation, directed acyclic graph validation before persistence, explicit transition table, optimistic revision checks, deterministic command digests, and immutable terminal history.

### Agent changes success criteria

Threat: model command silently weakens objective, criteria, dependencies, or evidence requirements.

Controls: semantic edits only while draft/paused; opaque direct user authority bound to exact command digest, project, session, and expiry; before/after digests and actor in audit event; model tools omit raw authority inputs.

### Duplicate execution after crash

Threat: lease expiry or process loss causes same node to run twice.

Controls: deterministic Attempt identity, two-phase fence binding before dispatch, exact owner/fence on every execution mutation, durable executor adoption when possible, and `unknown` blocked state for ambiguous post-dispatch work. Lease expiry alone never authorizes redispatch.

### Stale claimant commits

Threat: previous owner returns after lease transfer and marks node done or consumes budget twice.

Controls: Goal generation, Goal and Node record versions, Attempt identity, and lease renewal/release under exact fence in settlement transaction. In-memory generation checks are supplementary only.

### Budget oversubscription

Threat: parallel claims each observe remaining budget and collectively exceed it.

Controls: worst-case reservation in same Goal-head transaction as claim; concurrency, calls, Attempts, runtime, token, and integer-micro cost counters serialize through optimistic Goal version; unknown Attempt charged full reservation.

### False completion evidence

Threat: worker claims completion without tests/review/artifact proof or references stale evidence after an edit.

Controls: evidence requirements per criterion; evidence binds Goal/Node definition revision, Attempt, kind, trust, and Artifact hash; host verifies Artifact metadata; completion transaction rejects unsatisfied criteria, unknown Attempts, or invalidated revisions; user waiver requires reason and audit.

### Profile or project drift

Threat: pinned profile, trust, cwd, or project identity changes between submission and execution.

Controls: profile name/digest/generation/source pin; revalidation before each dispatch; canonical Project Identity check; Execution Role `goal-worker`; changed authority blocks Goal.

### Workspace loss or unsafe cleanup

Threat: failed/cancelled/unknown Goal work deletes changes or follows a Windows junction into shared dependencies.

Controls: reuse WorkspaceManager only; preserve disposition for failure, block, cancellation uncertainty, and unknown execution; no recursive filesystem deletion; normal WorkspaceManager junction checks and Git identity revalidation remain authoritative.

### Prompt or output injection

Threat: node text, worker result, review finding, mailbox content, or recovered records direct host behavior.

Controls: all remain bounded untrusted data; no content is interpreted as authority or executable Workflow JavaScript; Goal definition parser accepts plain data only; model-facing observations label authority `none`.

### Secret leakage

Threat: credentials appear in Goal definitions, state metadata, events, outputs, evidence, mailbox, or transcript.

Controls: Goal schema has opaque Credential References only if later enabled; bodies go to ArtifactStore; executor output sanitization/redaction; bounded summaries only in records; canary scans in acceptance; model tools never return secret-bearing bodies by default.

### Denial of service

Threat: huge graph, retry storm, long runtime, oversized output, excessive history, or rapid edits consume resources.

Controls: hard graph/dependency/Attempt/concurrency bounds; bounded backoff and retry window; host configuration ceilings; per-Attempt timeout/output/token/cost limits; bounded observation pagination; lifecycle-owned timers and bounded shutdown.

### Goal/Workflow confusion

Threat: Goal definition smuggles arbitrary JavaScript or users assume Workflow execution semantics and authority.

Controls: separate modules, commands, tools, schemas, persistence collections, and child role. Goal nodes are declarative records only. Workflow extension compatibility tests assert unchanged tool schema and execution path.

## Residual risks

- Exactly-once external Agent effects are impossible without transactional participation from every backend and side-effect target.
- Opaque post-dispatch crashes may block safe progress and require user inspection.
- Token limits are enforced from authoritative cumulative backend usage between provider requests; one in-flight request may overshoot and is covered by worst-case reservation.
- Monetary cost limits require authoritative backend cost metering. Production currently rejects finite cost budgets before confirmation rather than inventing prices.
- Backend isolation is not an OS sandbox.

## Required drills

- Two-process lease and budget contention
- Parent kill before dispatch, during dispatch, during execution, and after Artifact write
- Stale callback after fence transfer
- Workspace with changes and dependency junction preservation
- Secret canaries through output, error, evidence, event, mailbox, and observation paths
- Workflow schema and behavior compatibility
