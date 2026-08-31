# Phase 9 shareable interactive artifacts

## Decision

Phase 9 adds one deep `ArtifactPublisher` module beside the existing immutable `ArtifactStore`.

```ts
interface ArtifactPublisher {
  publish(input, signal?): Promise<ArtifactPublisherOutcome<PublicationReceipt>>;
  status(handle, signal?): Promise<ArtifactPublisherOutcome<ArtifactPublication>>;
  revoke(input, signal?): Promise<ArtifactPublisherOutcome<ArtifactPublication>>;
}
```

`publish` accepts an Artifact ID and explicit `local` or `remote` target. Local is the default, private path. Remote is always explicit. The first call performs validation, safe materialization, sensitivity scanning, provider capability checks, and returns an exact approval requirement. A second call carrying one-shot direct-user authority may commit the same immutable intent. Changed content, scan, target, access, expiry, or provider generation invalidates authority.

`status` returns bounded metadata only. `revoke` uses the same exact two-call authority protocol for active or uncertain publications. No method returns an Artifact body. The publication URL appears once in a trusted UI receipt and never in model tool output, logs, errors, publication status, or session JSONL.

## Why this interface

Three designs were compared:

1. Minimal `publish/status/revoke` with target as intent.
2. Flexible provider-driven requests and provider capability negotiation.
3. Common-caller `open/share/status/revoke` with separate local and remote verbs.

The minimal design has greatest depth and locality. It keeps policy, scanning, expiry, uncertainty, and provider variance behind one seam without teaching every caller four workflows. Local safety remains obvious because target defaults to `local`; remote publication has no default and requires direct confirmation. Provider selection remains configuration, not caller input.

## Modules and seams

### `ArtifactStore`

Local-substitutable module owning immutable content-addressed bodies and logical metadata. Phase 9 deepens its interface with bounded catalog listing, explicit deletion, and integrity-manifest bundle export/import. Export never overwrites. Import verifies every digest before committing any body.

### `ArtifactMaterializer`

In-process internal seam. Converts Markdown, HTML, JSON, image, and bundle Artifacts into exact outbound bytes. Sanitized documents and generated viewer shells become new immutable Artifacts. Interactive HTML is not declared safe through sanitization; it is isolated by browser controls.

### `SensitivityScanner`

In-process internal seam. Deterministically scans exact outbound bytes and bundle paths. Results contain rule IDs, severities, and counts only. Matched values and excerpts never leave the module. Blocking findings cannot be overridden. Review findings become part of exact confirmation.

### `ArtifactPublicationAdapter`

Internal adapter seam for transport mechanics only. Adapters do not decide authority, sensitivity, expiry acceptability, or state transitions.

- Local adapter: loopback-only viewer, random capability bootstrap, request-time expiry, lifecycle-owned listener.
- Vercel adapter: authenticated static preview deployment, verified project protection, mandatory expiring share capability, intent-based recovery, status, revoke, and delete. Interactive/live HTML is refused because top-level navigation is outside `connect-src`.
- In-memory adapter: deterministic interface tests.

### `ArtifactPublisher`

Owns Artifact verification, safe materialization, scan caching, exact approval scopes, one-shot authority consumption, persisted publication intent, concurrency, adapter dispatch, uncertainty, status reconciliation, expiry, and revocation.

Removing this module would spread those rules across slash commands, TUI, Goal/Review integration, and provider code. The seam therefore earns its depth.

## Artifact types

- `markdown`: UTF-8 Markdown rendered then sanitized.
- `html`: UTF-8 static HTML sanitized, or explicitly interactive HTML isolated in the local opaque-origin sandbox. Remote interactive HTML is refused.
- `json`: valid bounded JSON rendered as escaped formatted text.
- `image`: PNG, JPEG, GIF, or WebP with signature/MIME agreement.
- `bundle`: bounded integrity manifest plus explicit files; no symlinks, junctions, traversal, absolute paths, device names, nested archives, or undeclared bytes.

Artifact roots are namespaced by host-resolved Project Identity while body hashes remain content-addressed within that scope. Artifact metadata includes title, creator, Project Identity, content hash, media type, size, created time, sensitivity, and retention. Duplicate bytes reuse identical intrinsic metadata; conflicting sensitivity, interactivity, retention, type, or custom metadata is rejected. Producer/run provenance belongs to Artifact references. Existing producers may omit presentation metadata; the browser displays safe fallbacks.

## Local viewer protocol

- Bind IP-literal `127.0.0.1` on an operating-system-assigned port. Never bind wildcard addresses or `localhost`.
- Validate exact `Host` value on every request.
- Return bootstrap URL as `http://127.0.0.1:<port>/open#<capability>`.
- Trusted shell exchanges fragment capability through a same-origin POST using a non-safelisted header, removes the fragment, and receives a short-lived `HttpOnly; SameSite=Strict` session cookie.
- Reject cross-site Fetch Metadata and unexpected Origin values. CORS is never treated as authentication.
- Content loads in `sandbox="allow-scripts"` without `allow-same-origin`, forms, popups, downloads, navigation, or storage access.
- Artifact response also carries CSP `sandbox allow-scripts`, `default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`, and `frame-ancestors 'self'`.
- Viewer shell uses nonce-bound script, Trusted Types enforcement where supported, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.
- Live refresh is opt-in, local-only, bounded, and uses same-origin polling. Artifact content receives no network capability.

## Publication state

`pending -> active | failed | unknown`

`active | unknown -> revoking -> revoked | unknown`

`active -> expired`

External dispatch is at-most-once for an opaque publication intent. Cancellation, timeout, or persistence failure after dispatch begins produces `unknown`. Unknown publication is never automatically replayed; `status` reconciles it.

## Integration

Review, browser proof, Goal Evidence, Language Intelligence, Scheduler, Monitor, and Workflow producers continue writing bodies to `ArtifactStore`. They pass Artifact references, not bodies, to transcript rendering and publication. Custom session entries render bounded title/type/hash/status metadata and do not participate in model context.

`/artifacts` owns direct-user file creation, browsing, local opening/live refresh, export/import, deletion, publication, status, and revocation in TUI/RPC modes. Print/JSON modes reject the command clearly and use `artifact_inspect` for bounded metadata. Model tools may inspect bounded metadata only; no model tool can publish or revoke.

## Performance bounds

- Materialization and scan: linear in bounded outbound bytes, maximum 16 MiB per Artifact unless a lower provider limit applies.
- Bundle: maximum 1,000 files, 25 MiB aggregate, 10 MiB per file, no nested archive expansion.
- One scan-cache entry per `(outbound hash, scanner version, canary digest)`.
- One bounded provider request per `status` or `revoke`; no unbounded retries or redirects.
- Publication mutations serialize per handle and use generation checks across processes.
