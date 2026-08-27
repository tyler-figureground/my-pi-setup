# Phase 5 threat model - MCP and browser adapters

## Security boundary

Phase 5 provides host policy, trust gates, dedicated credentials/profiles, bounded lifecycle, and evidence controls. It does **not** provide an OS sandbox or network namespace. STDIO MCP servers and browser processes run with user privileges.

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

| Threat | Control | Residual risk / acceptance evidence |
|---|---|---|
| SSRF to metadata, loopback, RFC1918, link-local, IPv6-local, rebinding, redirect | Canonical `OriginPolicy`, DNS/IP checks, exact allowlists, per-request browser routing, service workers blocked, redirects revalidated or rejected | Browser/MCP origin fixtures; no claim of OS containment |
| Agent performs submission, purchase, upload/download, account change, or unknown MCP mutation | Host-side effect classification; unknown MCP and ambiguous clicks protected; direct user authority verifier; plan mode denies first | Policy and forged-authority tests; TUI approval tests pending |
| OAuth CSRF, mix-up, replay, verifier theft | Random flow-local state/verifier, S256 PKCE, exact redirect/server fingerprint, issuer/origin checks, one-shot state consumption, bounded expiry | Mismatch/replay tests green; local protocol fixture pending |
| Token/cookie/form/header leakage | Opaque credential references; OS keyring chunking; bounded structural redaction; no raw credentials in status/results; password fill resolves after approval inside host | Secret-canary scan and session/artifact tests pending |
| Credential store size/partial-update corruption | Chunked OS entries, digest, generation-switched replacement, exact server/origin binding, fail closed | Native Windows store/rotate/revoke fixture green |
| MCP tool/schema collision or prompt injection | Deterministic server namespace, collision rejection, server text marked/treated as untrusted, lazy generic tool descriptions, bounded schema/catalog | Catalog and dynamic wiring tests pending |
| Malformed/oversized protocol/schema/result exhausts context or process | SDK framing cap, catalog/schema/input bounds, AJV validation, artifact spill, result redaction/truncation, request/startup deadlines | STDIO/result boundary tests pending |
| MCP/browser process survives cancellation/reload/shutdown | `LifecycleSupervisor`, abort propagation, context/client close, identity-safe Windows tree fallback, leak checks | Browser close and direct MCP close green; descendant adversarial tests pending |
| Browser controls unrelated user/Impeccable pages | Dedicated platform profile directory, single-writer lock, owned page IDs only, no attach/CDP surface | Profile isolation/coexistence tests pending |
| Page bypasses route through service worker/WebSocket/popup | Service workers blocked, WebSockets fail closed, every owned page/redirect rechecked, popup ownership policy | Route/popup/WebSocket fixtures pending |
| File upload/download escapes or overwrites | No raw paths in model interface; explicit approval; canonical bounded artifact destinations; create-new semantics | Feature tests pending |
| Project config launches command or changes origins without trust | Project layer read only when Pi reports trust; bounded regular-file/canonical identity checks; malformed source atomic rejection | Config/junction/trust tests pending |
| Package/list/print command hangs from load-time resources | No resource startup in extension factory; lazy session/tool startup; bounded shutdown | Disposable package/print/RPC tests pending |

## Secret canaries

Acceptance seeds unique synthetic values into authorization headers, cookies, OAuth code/state/verifier, access/refresh tokens, MCP arguments/results/errors, form values, browser console/network/page errors, and credential-store records. Scan session JSONL, tool results/details, logs, statuses, artifacts, config, and child prompts. Credential-store test namespaces are disposable and removed.

## Failure policy

- Unknown effect, tool, origin, credential binding, callback state, schema, page/ref, or resumed identity fails closed.
- Offline mode denies external network operations.
- Approval cannot come from model/session messages or tool input.
- Cleanup failure is visible and retains enough non-secret identity for recovery.
