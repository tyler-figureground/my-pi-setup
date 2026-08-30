# Phase 8 Goal Mode configuration

Goal Mode is a durable declarative task graph. It is separate from Workflow JavaScript and never evaluates orchestration code from a Goal definition.

## Enable

Goal Mode requires trusted project state, Agent Profiles, Guarded Workspaces for isolated profiles, cross-session messaging, and the Goal Worker execution service supplied by the subagents extension.

```json
{
  "profiles": true,
  "workspaces": true,
  "messaging": true,
  "goals": true,
  "goalSettings": {
    "maxGoals": 100,
    "maxNodesPerGoal": 32,
    "maxConcurrentNodes": 4,
    "maxAgentCalls": 256,
    "maxRuntimeMs": 21600000,
    "defaultConcurrency": 2,
    "defaultAgentCalls": 8,
    "defaultTimeoutMs": 900000,
    "defaultMaxAttempts": 3,
    "defaultRetryDelayMs": 30000,
    "defaultOutputBytes": 262144,
    "leaseTtlMs": 300000,
    "terminalRetentionMs": 604800000,
    "maxTokensPerGoal": 20000000,
    "defaultNodeTokenReservation": 200000,
    "maxCostMicrosPerGoal": 100000000,
    "defaultNodeCostMicrosReservation": 1000000
  }
}
```

Trusted-project settings may narrow host ceilings, never widen them. `leaseTtlMs` cannot be changed by project config.

## Agent Profile

Each node names a profile whose role is exactly `goal-worker`.

```yaml
name: goal-builder
description: Bounded implementation worker
backend: pi
role: goal-worker
workspace: isolated
maxTurns: 12
timeout: 15m
```

Profile name, source, catalog generation, and content digest are pinned at submission and revalidated before dispatch. Drift blocks the node.

## Controls

```text
/goal submit <goal-id> <profile> -- <objective>
/goals id <goal-id> history
/goal pause <goal-id> <revision> -- <reason>
/goal resume <goal-id> <revision> -- <reason>
/goal cancel <goal-id> <revision> -- <reason>
```

Use `/goal` edit/restart/resolve/dispose subcommands shown by command usage for direct-user revisions and recovery. Every mutation requires exact TUI/RPC confirmation. Plan Mode keeps `goal_inspect` only.

## Budgets

Calls, concurrency, runtime, and cumulative tokens are enforced. Tokens are metered separately from context occupancy across Pi, Claude, and Codex. Cancellation occurs between provider requests, so reservation covers one in-flight request.

The common production Goal Worker does not expose authoritative monetary cost. A finite cost budget is rejected before confirmation. No estimated or subscription-list price is represented as actual spend.

## Crash behavior

Pre-dispatch Attempts reclaim the same durable identity. Post-dispatch work is adopted only when the executor certifies the same Attempt or result. Otherwise it becomes Unknown and blocks without redispatch. Inspect the workspace/evidence, then use direct-user resolution.

## Retention and rollback

Finished Goal records are swept after `terminalRetentionMs`; active/unknown/cancellation-reconciling work and Guarded Workspaces remain preserved. Disable without deleting state:

```json
{ "goals": false }
```

Reload Pi. Commands/tools disappear and no Goal worker starts. Re-enable to recover retained durable state.
