# Phase 9 F23 acceptance

Date: 2026-08-31
Status: accepted in isolated Phase 9 worktree, pending publication/live checkout integration

## Scope

F23 Shareable Interactive Artifacts:

- Project Identity-namespaced immutable Artifact bodies and bounded catalog metadata
- direct-user file creation for Markdown, HTML, JSON, and images
- integrity-manifest bundle export/import
- loopback-only local viewer with fragment Capability Token exchange
- static sanitization and local interactive opaque-origin containment
- explicitly live local revision refresh through Publisher-owned CAS state
- local and Vercel preview publication adapters
- exact publish/refresh/revoke authority
- sensitivity and credential-canary scan
- Artifact browser, metadata tool, transcript references, Review/Browser/Goal/LSP/Workflow producers

## Interface and invariants

`ArtifactPublisher` owns `publish`, `refresh`, `status`, `revoke`, and lifecycle `close`. Callers supply Artifact IDs and intent. Implementation owns materialization, scan, exact approval scope, one-shot authority, publication revisions, external certainty, adapter selection, recovery, and shutdown fencing.

Bodies, custom metadata, local Capability Tokens, Vercel share URLs, provider credentials, and revocation secrets are absent from model tools, publication records, session references, logs, errors, Memory, Mailbox, hooks, and Goal Evidence. Vercel intent/deployment IDs and opaque credential references are metadata, not authority.

## Local viewer acceptance

Passed on native Windows and real installed Chromium:

- listener binds `127.0.0.1`; production requests port `0`
- exact Host validation
- fragment token absent from HTTP request and shell body
- same-origin POST plus non-safelisted capability header
- cross-site Origin/Fetch Metadata rejection
- `HttpOnly; SameSite=Strict` scoped cookie
- static and interactive response CSP
- opaque origin blocks parent access
- external fetch blocked before dispatch
- no forms, popups, downloads, top navigation, workers, objects, or child frames
- expiry and revoke deny content
- live revision endpoint updates exact local frame
- shutdown closes listener and invalidates token/session maps

Visual evidence: `docs/verification/phase-9-artifact-viewer.png` and `docs/verification/phase-9-tui-smoke.md`.

## Rendering and input acceptance

- Markdown rendered with exact `marked@18.0.10`, then sanitized.
- Static HTML sanitized with exact `sanitize-html@2.17.7` restrictive allowlist.
- Interactive script remains intact only for local opaque-origin sandbox.
- Remote interactive/live HTML refused.
- JSON must parse and renders escaped formatted text.
- PNG, JPEG, GIF, and WebP require MIME/signature agreement.
- malformed/unsupported MIME and NUL/invalid UTF-8 fail closed.
- direct file import revalidates regular-file identity and rejects links/oversize.
- quoted command parser preserves native Windows paths containing spaces.

Dependency audit: `docs/research/phase-9-rendering-dependencies.md`; `npm audit --omit=dev` reports zero platform production vulnerabilities.

## Storage and bundle acceptance

- Artifact roots include host-resolved Project Identity namespace.
- IDs are lowercase SHA-256 body digests inside that namespace.
- conflicting intrinsic/security metadata remains rejected.
- list is bounded, newest-first, body-free, and cursor-paged.
- explicit remove handles missing/corrupt body cleanup without following links.
- export uses exclusive atomic installation and rejects linked parent directories.
- batch import executes under one cross-process ArtifactStore lock.
- failed batch rolls back every body/metadata pair created by that batch.
- manifest and each body hash verify before mutation.
- encoded/decoded/file-count/per-file limits pass.
- tampered bundle leaves target catalog empty.

## Publication and remote-provider acceptance

- Plan Mode denies publish/refresh/revoke before adapter dispatch.
- one-shot authority binds source/outbound hashes, provider, interactive/live flags, access, expiry, current state, and scan digest.
- declined/blocked preparation writes no derived Artifact.
- local paths become blocking findings for remote targets.
- private keys, authorization headers, credential assignments, AWS keys, GitHub/GitLab tokens, JWTs, credential URIs, and exact provider canaries block.
- unknown/internal/confidential/restricted classification requires review even with no regex finding.
- Vercel project protection is verified before deployment.
- response must match exact immutable project ID, intent metadata, and preview target.
- invalid non-preview/mismatched deployment is deleted immediately when ID is known.
- pending record contains `intent:<handle>` before remote dispatch.
- fresh-process intent lookup re-verifies project, exact meta, project ID, and preview target.
- malformed/oversized/timeout post-dispatch response remains Unknown and reconcilable.
- Vercel link TTL equals confirmed expiry; no non-expiring remote publication exists.
- share capability secret stays in OS credential vault and is revoked before deployment deletion.
- 404 revoke/delete is idempotent.
- provider project/team participate in credential binding.

No paid live Vercel mutation was performed because no Phase 9 provider credential/config exists. Production adapter behavior is covered through exact REST request/response fixtures, native fetch semantics, outage/ambiguity tests, and provider runbook. This is an external-configuration absence, not a product failure.

## Concurrency and recovery

- publication repository uses optimistic revisions.
- stale status/refresh/revoke writes fail.
- refresh verifies publication owner and persists `refreshing` before viewer mutation.
- `status` does not overwrite `refreshing` or `revoking`.
- revoke persists `revoking`, catches adapter exceptions, and records Unknown ambiguity.
- Publisher close fences new work and drains accepted mutations.
- teardown closes Publisher before owner-scoped local retirement.
- one Pi process cannot retire another process's local publication records.
- terminal publication retention evicts oldest terminal record at registry capacity.
- local active and session capacities are bounded.

## Integration and model-context acceptance

- Review JSON, Browser screenshot/diagnostics, Goal Evidence, Language Intelligence, and Workflow result producers write first-class title/creator/project/type/sensitivity metadata.
- Workflow producer is host-local, retained through workflow settlement, returns typed storage failures, and places Artifact ID only in completion text.
- `artifact-reference` session entry is TUI-only and body-free.
- `artifact_inspect` returns at most 25 projected metadata entries with no custom metadata/body/share capability.
- no model-facing tool can publish, refresh, revoke, export, import, delete, or mutate credentials.
- `/artifacts` rejects print/JSON clearly; repository smoke confirms print/JSON/RPC startup and shutdown.

## Verification

- TypeScript: pass.
- Formatting: pass.
- Unit: 750 pass.
- Integration: 433 pass, 5 platform skips in the final cumulative run. Two unrelated composition tests missed internal startup deadlines after 12-22 seconds under cumulative Windows load; immediate isolated rerun passed 16/16 in 26 seconds. Earlier same-tree serialized integration passed 435/435 plus 5 skips before final Vercel-only unit hardening.
- Delegated file-search: 22 pass.
- Smoke: repository extensions, public schemas, print, JSON, RPC, reload, shutdown, no leaks - pass with Artifacts enabled.
- Live backends: Claude 2/2, Codex 2/2, Pi 1/1 pass.
- Focused Phase 9: 78+ pass across storage, materialization, scanner, publisher, repository, wiring, viewer, Vercel, configuration, Workflow producer, and composition.
- Real Chromium visual flow: pass, zero page errors/failed network requests.
- Adversarial review: repeated security, correctness, interface, and visual review/fix/signoff cycles; final critical/high blockers closed. Final post-dispatch signoff passed 18/18 focused checks.

## Rollback/outage

- Rollback ordering and provider-console fallback: `docs/phase-9-configuration.md`.
- Provider outage, Unknown reconciliation, revoke, deletion/erasure distinction: `docs/runbooks/phase-9-provider-outage-and-revoke.md`.
- Disabling Artifacts closes listener and removes command/tool surface without deleting bodies.
- Vercel deletion is not represented as immediate physical erasure.
