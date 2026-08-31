# Phase 9 provider outage and revoke runbook

## Provider unavailable before dispatch

Symptoms: `/artifacts share` reports provider unavailable during credential, project-protection, or deployment admission checks.

1. Keep local Artifact and derived outbound Artifact. No remote retry occurs automatically.
2. Check `PI_OFFLINE`, provider status, Vercel credential existence, dedicated project name/team, and preview authentication.
3. Run `/artifacts share` again only after confirming the previous failure occurred before deployment dispatch. A fresh direct confirmation is required.

## Unknown after dispatch

Symptoms: publication state is `unknown` after timeout, cancellation, malformed provider response, or failed receipt persistence.

1. Do not publish the same intent again.
2. Run `/artifacts status <handle>`.
3. If status remains unknown, inspect Vercel deployments for the persisted deployment ID or `piArtifactIntent` publication handle through trusted operator UI.
4. Run `/artifacts revoke <handle>` once provider status is reachable.
5. If intent lookup is ambiguous or host metadata is unavailable but a deployment exists, delete it directly in Vercel, then record operator evidence. Never fabricate local success.

## Normal revoke

1. Run `/artifacts revoke <handle>`.
2. Confirm exact provider, content hash, access, expiry, sensitivity digest, and current state.
3. Adapter revokes the expiring share capability first, then deletes the preview deployment.
4. Run `/artifacts status <handle>` and confirm `revoked`.
5. Remember that Vercel deletion is not immediate physical erasure; documented recovery retention may remain.

## Lost share URL

Publication status intentionally cannot return Capability Tokens. Revoke the old publication and create a new one. Never recover tokens from logs or storage.

## Local viewer

`/reload`, session replacement, or Pi shutdown closes the loopback listener and invalidates all local capabilities/cookies. Re-open the Artifact for a new URL.

## Tested behavior

Deterministic adapter tests cover:

- missing preview protection blocks before upload
- bounded provider error surfaces without token/body disclosure
- expiring link TTL binding
- share-secret storage outside publication records
- share revoke before deployment delete
- local capability expiry and revoke
- unknown publication state after ambiguous dispatch
