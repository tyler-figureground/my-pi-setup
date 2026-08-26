# Phase 2 TUI verification

## Automated evidence

`extensions/platform/phase2-composition.test.ts` exercises the platform extension wiring through Pi's public extension interface and records UI calls:

- entering `/plan` sets `platform-plan` status to `planning`
- entering `/plan` adds a below-editor plan widget
- approval-pending and executing states persist through custom entries
- direct confirmation gates approval
- approval restores the exact pre-plan tools
- cancellation clears mode state
- hook status actions use namespaced `platform-hook:<key>` statuses
- `/rules` and `/hooks logs` render bounded notifications
- shutdown clears plan status and widget ownership

Repository smoke verifies Phase 2 commands and five read-only Git tool schemas after `resources_discover`, then verifies print, JSON, RPC, reload, shutdown, and process cleanup.

## Manual visual checklist

Run in a real terminal:

1. `/plan Inspect one source file`
2. Confirm footer shows `plan: planning`.
3. Confirm widget below editor shows state and plan file.
4. Confirm edit, write, shell, agent, and unknown tools are unavailable or denied.
5. Let planning finish and confirm footer changes to `plan: approval pending`.
6. Reject approval and confirm mutation tools remain unavailable.
7. `/plan approve`, accept direct confirmation, and confirm footer changes to `plan: executing`.
8. `/plan cancel` and confirm status/widget clear and exact prior tools return.
9. `/rules` and `/hooks` and confirm readable bounded notifications.
10. `/reload` in planning and executing states and confirm restored state is visually accurate.

## Harness limitation

Manual visual verification was not available in this agent harness. `winpty` rejected redirected input because stdin was not a TTY. Automated TUI-call, RPC, print, JSON, reload, and shutdown evidence passed. Complete the checklist above from an interactive terminal before relying on visual polish; policy enforcement does not depend on rendering.
