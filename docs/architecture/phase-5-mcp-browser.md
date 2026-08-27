# Phase 5 architecture - MCP and browser adapters

## Scope

Phase 5 composes F07 `ToolFederation` and F03 `BrowserControl` under shared `ExternalIntegrationControls`. It does not add an OS sandbox, remote browser attachment, arbitrary page evaluation, MCP Apps, sampling, or server-driven elicitation.

## Confirmed seams

| Module | Interface | Hidden implementation |
|---|---|---|
| `ExternalIntegrationControls` | `assess`, `sanitize` | Capability policy, origin normalization, DNS/IP classification, offline mode, authority verification, bounded recursive redaction |
| `CredentialVault` | `store`, `resolve`, `inspect`, `replace`, `remove` | Opaque references, exact binding, Windows Credential Manager chunking, generation switch, digest, rollback |
| `ToolFederation` | `status`, `search`, `activate`, `invoke`, `close` | Lazy catalogs, namespaces, include/exclude, official-schema validation, policy, reconnect state, bounded artifacts |
| `McpTransportAdapter` | `connect` | Official v2 STDIO/Streamable HTTP, pinned HTTP connection, auth provider, request deadlines, Windows cleanup |
| `McpAuthorization` | `start`, `complete`, `refresh`, `logout`, `token` | State/PKCE, server fingerprint, issuer-bound vault binding, single-flight refresh, reference metadata |
| `BrowserControl` | `status`, `pages`, `observe`, `act`, `close` | Owned-page mapping, approval scopes, credential injection, evidence artifacts, redirect/origin checks |
| `BrowserAdapter` | `start` | Playwright persistent context, AI ARIA refs, actions, request routing, host pinning, diagnostics, screenshots, process/profile cleanup |

Tests and callers use these same interfaces. Pi wiring translates interfaces into a small stable model surface.

## Composition

```text
Pi session_start (parent role only)
  |
  +-- CapabilityPolicy + per-process user authority
  +-- ExternalIntegrationControls
  +-- lazy CredentialVault
  +-- ArtifactStore
  |
  +-- ToolFederation
  |     +-- mcp_tools loader
  |     +-- deferred mcp_<namespace> tool schemas
  |     +-- official MCP v2 adapter on first catalog use
  |     +-- OAuth coordinator only for user-owned OAuth config
  |
  +-- BrowserControl
        +-- browser_pages
        +-- browser_observe
        +-- browser_action
        +-- lazy playwright-core adapter on first open
```

No MCP transport, keyring native module, Playwright module, browser, socket, or child process starts from extension factory load. Unconfigured MCP remains disconnected. Browser executable validation occurs before profile creation.

## External control flow

1. Normalize request and classify effect.
2. Deny side effects in plan mode.
3. Require host-issued direct-user authority for protected effects.
4. Normalize destination and match exact configured origin.
5. Resolve hostname and reject private, metadata, link-local, multicast, and disallowed loopback addresses.
6. Return canonical URL plus approved addresses.
7. MCP/OAuth connect through an address-pinned Node transport preserving hostname for HTTP Host and TLS SNI.
8. Browser launch pins configured hostnames through Chromium resolver rules; every request is rechecked. Service workers and WebSockets are blocked. WebRTC is disabled.
9. Sanitize all external results/errors before model, UI, log, or artifact publication.

Browser non-GET requests, including HEAD and OPTIONS, are blocked unless one originates from the approved page during the protected action. The permit is page-bound, single-request, and cleared when the action settles. Every DOM interaction - click, fill, select, key, scroll, upload, download - requires a scope-bound one-shot approval. Wait is read-only. Open/navigate are allowlisted network reads.

## MCP lifecycle

- Search starts only enabled configured servers and is lazy until first search.
- STDIO config receives a safe base environment; configured variables are user-only `${ENV_NAME}` references.
- HTTP and OAuth use address-pinned clients with redirects disabled.
- Catalog failures are isolated per server.
- Tool IDs retain readable names where already canonical and add a stable hash when normalization would collide.
- Schemas compile through the official dialect-aware validator before dynamic Pi registration.
- Tool arguments are bounded before clone/validation.
- Ambiguous call failures are never replayed. Next invocation may reconnect.
- Close fences pending connect generations, aborts waiters, closes late connections, terminates HTTP sessions, and performs identity-validated Windows tree cleanup.

## OAuth and credentials

OAuth configuration is user-managed only. State and verifier are random, flow-local, bounded, expiring, and consumed once. Callback redirect and server fingerprint must match. Official discovery validates issuer metadata; callback `iss` is forwarded for RFC 9207 validation.

Vault binding includes integration, server id, MCP origin, and a SHA-256 fingerprint of resource URL, issuer, client id, scopes, and redirect. Reconfiguration cannot reuse old tokens. Reference metadata in `StateStore` contains only opaque references. Token refresh is single-flight and generation-switched in the OS credential store. Revocation deletes chunks before deleting their discoverable index.

## Browser lifecycle and identity

Browser profiles are scoped by agent directory plus stable project identity, then profile name. A private atomic lease prevents concurrent use and carries process start identity for stale-owner recovery. Profile lease is retained on degraded shutdown.

Playwright launches host Chrome/Edge without downloading a browser. Initial blank pages close. Context page events track popups; `BrowserControl` adopts only allowlisted pages and closes denied pages. Persistent cookies remain inside that project/profile identity. Separate Impeccable profiles coexist; same-profile collisions fail before launch.

Approval scope hashes page id, adapter page id, action, ref/input digest, effect, destination, classifier reason, live URL, and a Playwright accessibility-document digest. After user delay or credential/artifact lookup, document identity, target classification, and live origin are rechecked. Real actions use a fixed `ElementHandle`; detached/replaced nodes fail instead of retargeting.

## Evidence and context

- Accessibility snapshots and diagnostic records are bounded before model output.
- Screenshots and downloads persist as content-addressed artifacts; pixels/bytes are absent from text/details.
- Form controls are masked in screenshots. Screenshots are disabled after any credential use in that browser session because echoed secret pixels cannot be reliably redacted.
- Console, page errors, and network records use bounded rings and per-record limits.
- Large MCP results persist as bounded sanitized JSON artifacts. Inline output remains at or below Pi's 50 KiB budget.
- Artifact metadata is stable per source/project/kind to preserve content-address deduplication.

## Modes and roles

- Parent role only owns platform integrations.
- Child roles do not start MCP/browser modules.
- Plan mode permits `browser_pages` and `browser_observe`, but blocks `browser_action`, MCP loader process/credential use, and unknown dynamic MCP tools.
- TUI and RPC support status and direct-user approval. Print/JSON reject interactive commands clearly and still exit.
- `/reload`, session replacement, and shutdown call capability stop before lifecycle shutdown.

## Rollback

Set `mcp` and/or `browser` to `false` in `platform.json`, then `/reload`. This disconnects clients and removes active tool surfaces without deleting credentials, browser profiles, or artifacts. Remove credentials separately through OAuth logout or the credential management flow.
