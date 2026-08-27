# Phase 5 TUI and mode checklist

## Automated evidence

- Repository smoke loads `mcp_tools`, `browser_pages`, `browser_observe`, and `browser_action` with checked schemas.
- Repository smoke discovers `/mcp` and `/browser`.
- Print, JSON, RPC, reload, shutdown, and no-leak smoke paths pass with MCP/browser enabled and unconfigured.
- Wiring tests cover additive MCP activation, generic untrusted descriptions, browser direct approval retry, machine-readable details, status setup, and teardown removal.
- TUI approval scope includes action, origin, page, ref, artifact id when applicable, and classifier risk.
- Interactive-only commands reject print/JSON mode rather than waiting for input.

## Manual visual checklist

- [ ] Footer shows bounded `MCP connected/enabled` and `Browser state (owned pages)` status without URL, profile path, credential, code, or token.
- [ ] `/mcp` status lists server id/state/tool count only.
- [ ] `/mcp auth` renders clickable authorization URL; `/mcp complete`, refresh, and logout notify without code/token text.
- [ ] `/browser` status omits profile filesystem path.
- [ ] Browser approval dialog shows exact protected action context and defaults to deny on escape/timeout.
- [ ] `browser_observe` collapsed output shows artifact id and bounded preview; screenshot pixels/download bytes are not rendered as text.
- [ ] Expanded MCP/browser results remain terminal-control safe.
- [ ] `/reload` clears old MCP/browser statuses and recreates one clean status per capability.

Real terminal keystrokes remain a manual gate; RPC/UI call paths are automated.
