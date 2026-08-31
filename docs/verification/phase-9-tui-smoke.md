# Phase 9 Artifact viewer and TUI evidence

Date: 2026-08-31

## Artifact viewer

- Origin: loopback `http://127.0.0.1:<ephemeral>` in production; fixed `4173` only in isolated visual fixture.
- Flow: fragment Capability Token exchange, fragment removal, `HttpOnly; SameSite=Strict` session cookie, opaque-origin iframe load, blocked parent access, blocked external fetch, interactive button from `Count: 0` to `Count: 1`.
- Viewport: 1280 x 800.
- Semantic result: `Opaque origin and network blocked`; interaction advanced to `Count: 1`.
- Screenshot: `docs/verification/phase-9-artifact-viewer.png`.
- Page errors: none.
- Failed network requests: none; CSP blocked attempted request before dispatch.
- Console: two expected CSP diagnostics from deliberate network-denial probe; no `NETWORK ESCAPED` or isolation-failure marker.
- Mechanical Impeccable detector: no findings.
- Finish review: initial `fix` for recovery copy and assertion-only diagnostics; both fixes scored resolved; final disposition `ship`.

The dedicated session browser tool could not open the random or fixture loopback origin because current integration configuration had no allowed origins. Origin policy was not broadened. Equivalent live Chromium verification ran through repository-pinned `playwright-core` and installed Chrome/Edge, using the same viewer server and security headers.

## Pi surface

- `/artifacts browser` provides searchable TUI selection over bounded Artifact metadata, followed by explicit local-open or remote-share action.
- `/artifacts create`, `refresh`, `open`, `share`, `revoke`, `export`, `bundle-export`, `bundle-import`, `delete`, and credential mutations require TUI/RPC direct-user interaction.
- Exact confirmation displays source/outbound hashes, provider, interactivity, live status, access, expiry, current state when relevant, and bounded sensitivity findings.
- `artifact-reference` entries render Artifact ID, target, and state without entering model context.
- `artifact_inspect` returns at most 25 projected metadata records and excludes bodies, custom metadata, share URLs, credentials, and revocation secrets.
- Print/JSON `/artifacts` command use rejects clearly and points to `artifact_inspect`.
- RPC confirmation path is covered by wiring tests.

## Lifecycle

Repository smoke with Artifacts enabled passed:

- extension discovery
- public tool schema
- `/artifacts` command registration
- print startup/shutdown
- JSON startup/shutdown
- RPC startup/shutdown
- `/reload`
- clean shutdown
- no leaked processes or handles

Local capabilities and cookies are invalidated when the lifecycle-owned listener closes. Publisher close fences and drains active mutations before owner-scoped local records retire.
