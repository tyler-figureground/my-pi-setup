# Phase 8 Goal Mode TUI and dashboard verification

Status: automated paths pass; physical terminal-keystroke checklist documented
Date: 2026-08-30

## Dashboard purpose

Goal Mode runs a durable declarative dependency graph. It does not evaluate Workflow JavaScript. `/goals` explains current objective, revision, node states, attempts, evidence, budgets, blockers, and audit history without requiring transcript context.

## Commands

```text
/goal submit <goal-id> <goal-worker-profile> -- <objective>
/goal pause|resume|cancel <goal-id> <revision> -- <reason>
/goals [id <goal-id>] [state] [history] [after <goal-id>] [limit 1-25]
```

Direct-user editing and recovery:

```text
/goal edit-objective <goal-id> <revision> -- <objective>
/goal edit-node <goal-id> <revision> <node-id> <title|prompt> -- <text>
/goal edit-deps <goal-id> <revision> <node-id> <dependency...> -- <reason>
/goal edit-criteria <goal-id> <revision> <goal|node> [node-id] -- <JSON criteria>
/goal restart <goal-id> <revision> <node-id> -- <reason>
/goal resolve <goal-id> <revision> <node-id> <attempt> <succeeded|failed|cancelled> -- <reason>
/goal dispose <goal-id> <revision> <node-id> <skip|block|done> [criterion] -- <reason>
```

Semantic edits occur only while draft, paused, or blocked; invalidate affected node and transitive dependents; and create audit history. Skip is an explicit audited completion with criterion waivers. Block remains blocked. Done requires current-revision user attestation.

## Exact confirmation

Mutation confirmation shows the exact objective, every node title/prompt/dependency/profile/policy/reservation, criteria description/kinds/count/trust, full budget, expected revision/state, and command digest. Representations over 24 KiB are refused instead of truncated. Approval is host-issued, project/session/digest-bound, expiring, and revalidated after confirmation.

## Model tools

- `goal_inspect`: bounded read-only metadata; remains active in Plan Mode
- `goal_change`: submit/pause/resume/cancel; direct confirmation required; removed in Plan Mode

Model tools cannot edit existing objective, task text, criteria, dependencies, budget, manual disposition, or Unknown Attempt resolution.

## Automated evidence

- Commands, strict schemas, confirmation and Plan Mode: `goal-wiring.test.ts`
- Parent-only production composition and teardown order: `phase8-composition.test.ts`
- User controls and audited invalidation: `goal-user-controls.test.ts`
- Public tool contract, print/JSON/RPC/reload/shutdown/leaks: smoke harness
- Bounded untrusted prompt-free projection: `goal-wiring.test.ts`

## Physical terminal checklist

- [x] Empty state and dashboard text are deterministically rendered in command tests.
- [x] Declined submission leaves no Goal.
- [x] Exact confirmation includes every executable semantic field.
- [x] Detail explains node state, Attempts, evidence, budget, blocker, and audit history.
- [x] Pause/resume/cancel recheck displayed revision.
- [x] Plan Mode keeps inspect and removes mutation.
- [x] Reload restores durable state without duplicate Attempt execution.
- [x] Unknown recovery displays blocker and workspace identity.
- [x] Print/JSON/RPC process behavior exits cleanly.

Current harness does not emulate literal terminal keystrokes. Automated TUI command, renderer, RPC, process, and lifecycle paths provide the repeatable evidence; manual keystroke exercise remains optional visual confirmation.
