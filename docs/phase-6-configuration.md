# Phase 6 configuration

Phase 6 flags default off.

```json
{
  "messaging": true,
  "memory": true,
  "messagingSettings": {
    "discoverableBy": "same-project",
    "acceptsFrom": "same-project"
  },
  "memorySettings": {
    "defaultScope": "project",
    "automaticRecall": false,
    "automaticExtraction": false
  }
}
```

## Messaging

`discoverableBy` and `acceptsFrom` accept:

- `none` - closed default
- `same-project` - stable Project Identity must match
- `local-user` - explicit cross-project visibility/receipt under the same Pi installation

Trusted project configuration cannot widen either setting to `local-user`; only user configuration can. Session names and advertised capabilities are routing metadata, never authority.

Enabling messaging starts Parent-owned local Presence heartbeat and mailbox polling against `<agentDir>/state/platform.sqlite`. No network, socket, provider call, or child process starts. Message Artifact storage materializes only on first send.

## Memory

`defaultScope` accepts `user`, `project`, or `workspace`.

- `user` - current Pi installation
- `project` - stable Project Identity; linked worktrees share scope
- `workspace` - requires a current verified Guarded Workspace Lease

Workspace scope never falls back to project/user. Current Pi Parent context has no safe live workspace Lease provider, so workspace operations fail clearly unless a host provider is supplied.

`automaticRecall` and `automaticExtraction` must remain `false`. Setting either to `true` emits a diagnostic and leaves it disabled. Phase 6 exposes explicit search and direct-user-confirmed writes only.

Enabling Memory registers commands and `memory_search` without opening storage. First operation lazily initializes `<agentDir>/state/memory.sqlite`. No model download, provider call, embedding runtime, watcher, or background process starts.

## Commands

Commands require interactive TUI mode. RPC, JSON, and print invocation is rejected because command dispatch alone cannot prove direct-human authority.

```text
/sessions
/messages
/messages send <session-id>
/remember [user|project|workspace] [kind] [text]
/memories [scope]
/memories search <text>
/forget <memory-id> [revision]
/memory edit <memory-id>
/memory import <artifact-id> [scope]
/memory export [scope]
```

Mutation commands show bounded final intent and require confirmation.

## Model tools

- `session_list`: read-only discovery of opted-in sessions
- `session_send`: protected orchestration; denied in Plan Mode and child roles
- `memory_search`: read-only explicit retrieval

No model tool can persist, edit, promote, import, export, or forget Memory.

## Disable and rollback

Set both flags to `false`, then `/reload`:

```json
{
  "messaging": false,
  "memory": false
}
```

Disabling leaves durable mailbox and Memory data intact. Export before deleting data manually. Do not remove `platform.sqlite`, `memory.sqlite`, WAL/SHM sidecars, or Artifact directories while Pi processes may hold them.
