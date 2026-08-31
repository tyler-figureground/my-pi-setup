# Phase 9 artifact threat model

## Security objective

Artifact viewing and sharing must not execute content with Pi authority, expose local files or credentials, grant ambient network access, publish without direct user authority, or place bodies/capabilities in model context or durable diagnostic surfaces. These controls are application policy and browser isolation, not an OS sandbox.

## Assets

- Artifact bodies and presentation metadata
- local capability and session tokens
- remote-provider credential references and resolved secrets
- remote share capabilities and revocation references
- Project Identity and local filesystem paths
- direct-user publication authority
- publication state and audit history

## Trust boundaries

- Artifact bytes are untrusted even when produced by an Agent.
- Markdown/HTML parsers and sanitizers process hostile input.
- Interactive HTML runs hostile script in a browser sandbox.
- Loopback requests may originate from malicious remote pages, browser extensions, or local processes.
- Provider responses, URLs, redirects, errors, and status are untrusted external data.
- Model, hook, schedule, Goal Worker, Mailbox Message, Memory, and child-session content cannot grant authority.

## Threats and controls

### Script injection and browser escape

- Static Markdown/HTML is sanitized immediately before its final sink.
- Interactive HTML uses an opaque-origin iframe and response CSP sandbox. Never combine `allow-scripts` with `allow-same-origin`.
- Network, forms, popups, downloads, top navigation, workers, objects, nested frames, and base URL changes are denied.
- Viewer shell and Artifact documents use separate CSPs. Artifact markup cannot modify shell DOM.
- Browser acceptance probes attempt parent access, top navigation, fetch/WebSocket/image beacons, forms, popups, downloads, service workers, storage, and CSP bypass.

### Loopback cross-site request forgery and DNS rebinding

- Listen only on `127.0.0.1` with ephemeral port.
- Reject non-exact Host, forwarded host, unexpected Origin, and cross-site Fetch Metadata.
- Capability exchange requires POST plus a non-safelisted header. No state-changing GET exists.
- Fragment token is removed before Artifact load. Tokens are random, short-lived, hashed in memory, publication-bound, and revoked on shutdown.
- CORS headers are restrictive but never counted as authentication.

### Capability leakage

- Capability and share URLs are returned only to trusted direct-user UI.
- Status, model tools, session entries, JSONL, logs, errors, Hook events, Memory, Mailbox, Goal Evidence, and Artifact metadata contain opaque host handles only.
- Referrer policy is `no-referrer`; remote viewer contains no third-party resources.
- Tokens have explicit expiry and manual revoke. Lost tokens cannot be recovered from status.

### Secret publication

- Exact outbound bytes and every bundle path are scanned before confirmation.
- Structural denial blocks `.env*`, private keys, credential stores, cloud configs, auth files, database dumps, source maps, `.git`, symlinks, junctions, devices, traversal, and undeclared files.
- Scanner reports category/rule/count only; no matched value or excerpt persists.
- Known provider credentials are exact canaries and block publication if present.
- Blocking findings cannot be overridden. Review findings require confirmation bound to scan digest.

### MIME confusion and parser differentials

- Artifact type and MIME are allowlisted.
- Images require magic-byte agreement.
- JSON must parse before rendering.
- UTF-8 text rejects NUL and invalid encoding.
- Every response sets `X-Content-Type-Options: nosniff`.
- Sanitized output is not modified or recontextualized after sanitization.

### Bundle traversal and resource exhaustion

- Manifest paths are normalized POSIX relative paths with unique case-folded identities and Windows-device rejection.
- Hash, size, file-count, aggregate-size, depth, and compression-ratio limits apply before commit.
- Import verifies all bytes before any Artifact is made visible.
- No archive recursion, filesystem extraction, symlinks, or overwrite.

### Unauthorized publication

- CapabilityPolicy classifies remote publication as `publish` and denies it in Plan Mode.
- Exact one-shot authority binds operation, source/outbound hashes, target, access, expiry, provider generation, and scan digest.
- Only a direct `ctx.ui.confirm` path issues authority. No agent/session message can issue it.
- Schedules and Agents may create local Artifacts but never publish them.
- Remote provider must prove private preview protection before upload.

### Provider outage and ambiguous effects

- Intent persists before dispatch; idempotency key is host-generated.
- No automatic retry after bytes may have reached provider.
- Ambiguous state blocks republish until status/revoke reconciliation.
- Provider errors and URLs are bounded, sanitized, and destination-validated.
- Revocation means access stops; deletion and physical erasure remain distinct and documented.

### Local path disclosure

- Shared pages use generated logical names only.
- Manifests, errors, HTML comments, source maps, metadata, and provider requests omit canonical paths, user names, worktree paths, and credential references.
- Acceptance scans remote bytes and headers for seeded path canaries.

## Abuse cases

1. Remote page submits a form to loopback viewer. Rejected: no mutation GET, non-safelisted header and same-origin checks required.
2. Artifact script reads parent DOM or local storage. Rejected by opaque origin, iframe sandbox, response sandbox CSP, and separate shell origin privileges.
3. Agent asks a Schedule to publish later. Denied: no unattended publication interface or authority issuer.
4. Upload times out after provider accepts it. Recorded Unknown; never replayed automatically.
5. Bundle declares `assets/../.env`. Rejected before body reads or publication.
6. Provider returns redirect to metadata IP. Rejected by pinned destination/origin checks.
7. User shares a URL then revokes it. Provider share capability revoked and deployment disabled/deleted; local record becomes revoked even though provider retention may delay erasure.

## Residual risks

- Sanitizers and browser engines can contain vulnerabilities; versions must stay pinned and patched.
- Browser extensions or local malware can observe user activity. Phase 9 does not provide OS containment.
- Secret scanners have false negatives. Explicit manifest confirmation remains mandatory.
- Vercel may retain deleted deployment data during documented recovery windows. UI and docs must not claim immediate erasure.
