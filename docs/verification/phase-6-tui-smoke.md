# Phase 6 TUI smoke checklist

Automated command/tool/RPC behavior is covered by `messaging-wiring.test.ts`, `memory-wiring.test.ts`, composition tests, repository smoke, and real two-process Pi acceptance. Real terminal keystrokes remain a manual gate.

## Messaging

- [ ] `/sessions` shows opted-in same-project Presence with session ID, name, role, status, and capabilities.
- [ ] `/messages` shows bounded inbound/outbound state without loading body Artifacts.
- [ ] `/messages send <session-id>` opens summary/body flow and shows exact recipient, byte count, delivery mode, and untrusted/no-authority warning.
- [ ] Declining confirmation creates no mailbox record or Artifact.
- [ ] Switching to Plan Mode before final confirmation blocks send.
- [ ] Incoming `platform-session-inbox` remains visibly labeled untrusted and non-authoritative in compact and expanded views.
- [ ] Follow-up/steer notification occurs only after durable inbox entry; inbox is not duplicated.

## Memory

- [ ] `/remember project decision <text>` shows scope/kind/bytes and requires confirmation.
- [ ] Declining confirmation writes no Memory or FTS entry.
- [ ] `/memories project` lists bounded records with kind, revision, citation, expiry, and contradiction state.
- [ ] `/memories search <query>` renders quoted untrusted/no-authority results.
- [ ] `/memory edit <id>` shows current revision and rejects a stale revision.
- [ ] `/forget <id>` shows managed-deletion boundary and confirms before deletion.
- [ ] `/memory export` warns that Artifact is an independent copy.
- [ ] `/memory import` previews counts/digest, then requires separate commit confirmation.
- [ ] Workspace scope appears only in a proven current leased workspace; otherwise fails without fallback.

## Lifecycle and modes

- [ ] `/reload` replaces messaging incarnation and keeps durable Memory searchable.
- [ ] Resume/new/fork closes old broker generation and does not duplicate inbox delivery.
- [ ] Quit leaves no timer, claim, SQLite handle, or browser/MCP process.
- [ ] Commands reject RPC, JSON, and print modes with explicit TUI-only errors.
- [ ] `session_send` and Memory mutations remain blocked in Plan Mode even if tools are manually reactivated.
