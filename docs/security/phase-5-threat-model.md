# Phase 5 threat model - MCP and browser adapters

## Security boundary

Phase 5 provides host policy, trust gates, dedicated credentials/profiles, bounded lifecycle, pinned destinations, and evidence controls. It does **not** provide an OS sandbox or network namespace. STDIO MCP servers and browser processes run with user privileges.

## Assets

- OAuth/bearer credentials, PKCE verifiers, state, authorization codes, cookies, form secrets
- Source checkout, local files, browser profile, authenticated remote accounts
- Session JSONL, model context, logs, status UI, artifacts, configuration
- Process, socket, browser, MCP, and lifecycle availability

## Trust zones

- Direct user authority and managed/user configuration
- Trusted-project configuration, still attacker-controlled after repository compromise
- MCP server instructions, descriptions, schemas, results, errors, and HTTP responses: untrusted data
- Browser pages, DOM, accessibility text, console, errors, requests, redirects, downloads: untrusted data
- Model tool arguments: untrusted requests, never authority

## Threats and controls

| Threat | Control | Evidence / residual risk |
|---|---|---|
| SSRF, metadata/private access, DNS rebinding, redirect, proxy bypass | Exact canonical origins; DNS/IP class checks; address-pinned MCP/OAuth; Chromium host resolver rules plus `--no-proxy-server`; request/redirect recheck | Pinned-fetch and real-browser host fixtures. No OS network namespace claim |
| Browser mutation outside approved action | Every method except GET needs adapter permit; permit binds one page and one request, expires, and clears on action settlement | Real concurrent background-page POST and HEAD fixture |
| Target changes during direct approval | Scope binds URL, document/accessibility/body state, event-listener generation, handler properties, action inputs, and prepared `ElementHandle`; replacement fails | Unit same-origin drift regression plus Playwright implementation review |
| Agent performs unknown MCP/browser mutation | Conservative effect default, host-issued scope-bound authority, plan-mode denial first | Forged-authority, unknown-effect, plan, approval-retry tests |
| OAuth CSRF, mix-up, replay, stale resurrection | Random state/verifier, S256, exact callback/fingerprint/issuer, one-shot state, bounded expiry, per-server operation serialization and current-token reload | Official fixture, state replay, issuer, refresh/logout race regression |
| Ambiguous MCP call executes twice | Federation never retries calls; HTTP auth transport has no `onUnauthorized` replay callback | Failure/reconnect regression and SDK behavior review |
| Token/cookie/form/header leakage | Opaque references; OS keyring; field/pattern and exact-canary redaction; safe base environments; no secrets in status/results | Stringified token variants and browser echo artifact regressions |
| Secret appears in pixels or downloaded bytes | Screenshots and downloads fail closed after any browser credential use; controls remain masked before credential use | Credential screenshot/download policy tests and review |
| Credential canary eviction | At most 32 distinct browser canaries; 33rd credential use fails before adapter invocation | Capacity implementation; no oldest-secret eviction |
| Credential store partial transition | New generation chunks stage first, index changes durably before old cleanup; remove deletes discoverable index before chunks; exact binding/digest | Native Windows store/replace/remove fixture; ordering review |
| MCP schema/tool prompt injection or collision | Official schema compile; annotation-only publication stripping with schema-map awareness; generic host descriptions; max-64 hashed names; existing Pi collision refusal | Nested property-name regression, namespace and wiring tests |
| Malformed/oversized protocol/schema/result exhausts host/context | Frame, catalog, schema, input, output, recursion, node, string, artifact, request, and startup bounds | Boundary and artifact-spill fixtures |
| MCP/browser process survives cancellation/reload/shutdown | Lifecycle owner, abort fencing, late-start close, browser context timeout, profile lease retention on degraded close, PID plus creation identity, retained descendant snapshots | Full shutdown smoke, aborted MCP detached descendant, browser failed-launch fixtures |
| Browser controls unrelated user/Impeccable pages | Project/profile-specific persistent directory, atomic single-writer lease, no CDP attach, owned ids, opener lineage, serialized/control and adapter page caps | Isolation, coexistence, stale lease, concurrent 40-open regressions |
| Page bypasses routing via service worker/WebSocket/WebRTC | Service workers blocked, WebSockets closed, WebRTC APIs/UDP restricted, every request routed | Real launch/network fixture; no arbitrary extension loading |
| File upload/download escapes or overwrites | No model paths; project-bound upload artifact id; bounded bytes; content-addressed create-new evidence | Upload/download unit and real fixture |
| Project config launches command or changes secrets without trust | Project layer read only with Pi trust; user-only environment/OAuth/executable/profile fields; canonical regular-file checks; atomic source decode | Config trust and malformed-source tests |
| Load-time package/print hangs | No external resource startup in extension factory; dynamic imports on first use; bounded shutdown | Startup benchmark and print/JSON/RPC smoke |

## Secret canaries

Acceptance seeds synthetic values into authorization headers, OAuth fields, tokens, MCP errors, form values, console/network/page errors, and credential-store records. Sanitization recognizes structured keys and stringified camel/snake/kebab variants including access, refresh, session, bearer, ID, OAuth code, API key, password/passwd, secret, verifier, and authorization code. Browser-resolved credential values additionally become exact canaries.

## Failure policy

- Unknown effect, tool, origin, credential binding, callback state, schema, page/ref, or process identity fails closed.
- Offline mode denies external network operations.
- Approval cannot come from model/session messages or tool input.
- Cleanup failure is visible; browser profile lease remains when ownership may still be live.
- No Windows PID-only fallback is permitted.
