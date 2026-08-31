# Phase 9 Artifact configuration

Phase 9 is local-first. Artifact bodies remain in a Project Identity-namespaced private content-addressed store. Enabling Artifacts adds bounded metadata inspection and `/artifacts`; no Artifact is opened or shared automatically.

## Enable

In user `~/.pi/agent/platform.json`:

```json
{
  "artifacts": true,
  "artifactSettings": {
    "defaultExpiryMs": 3600000,
    "maxExpiryMs": 604800000
  }
}
```

Artifact settings are user-managed. Trusted-project config cannot choose a remote provider or credential.

## Commands

```text
/artifacts create <path> <mime> [interactive] [live] [sensitivity]
/artifacts browser
/artifacts list
/artifacts publications
/artifacts refresh <live-publication-handle> <artifact-id>
/artifacts open <artifact-id> [private] [minutes]
/artifacts share <artifact-id> [link] [minutes]
/artifacts status <publication-handle>
/artifacts revoke <publication-handle>
/artifacts export <artifact-id> <directory>
/artifacts delete <artifact-id>
/artifacts bundle-export <path> <artifact-id...>
/artifacts bundle-import <path>
/artifacts credential-store <project> <team-id|-> <ENV_NAME>
/artifacts credential-remove <credential-reference> <project> <team-id|->
```

`create` reads one bounded regular file after direct confirmation. `open`, `share`, `refresh`, and effective `revoke` show exact content hashes, provider, access, expiry, and bounded sensitivity findings before one-shot confirmation. Print and JSON modes cannot confirm publication. `artifact_inspect` is read-only and returns metadata only.

Local viewer URLs contain a short-lived Capability Token in the fragment. Treat the full URL as a secret. It appears only in direct UI notification, not session JSONL, model tools, Artifact metadata, publication status, logs, Memory, Mailbox, hooks, or Goal Evidence.

## Vercel preview sharing

Phase 9 supports one optional remote provider: a dedicated non-Git Vercel project with Vercel Authentication protecting all preview and generated deployment URLs. Production targets and aliases are refused. Remote sharing always creates an expiring link capability; identity-only remote publication is refused because Vercel deployments do not provide per-deployment native expiry. Interactive and live HTML remain local-only because direct top-level remote HTML cannot prevent navigation-based network exfiltration.

1. Create a dedicated Vercel project with no Git repository.
2. Configure Vercel Authentication for all previews/generated deployment URLs.
3. Put a narrowly scoped Vercel access token in a temporary environment variable.
4. Run, using `-` when no team ID applies:

```text
/artifacts credential-store pi-artifacts team_optional VERCEL_ARTIFACT_TOKEN
```

The command deletes that environment variable from the Pi process and returns an opaque credential reference.

5. Add the returned reference to user config:

```json
{
  "artifacts": true,
  "artifactSettings": {
    "defaultExpiryMs": 3600000,
    "maxExpiryMs": 604800000,
    "vercel": {
      "project": "pi-artifacts",
      "teamId": "team_optional",
      "credentialReference": "credential:opaque-reference"
    }
  }
}
```

6. `/reload`, then use `/artifacts share <id> link <minutes>`.

Before upload, the adapter re-reads project protection, uploads only generated `index.html` and `vercel.json`, omits production target, binds link TTL to confirmed expiry, and stores the revocation secret in the OS credential vault. Provider API responses and errors are bounded; token values are exact sensitivity canaries.

## Artifact metadata

Artifact records support:

- `title`
- `creator`
- stable `projectId`
- `sha256` content hash
- MIME type and Artifact kind
- byte size and creation time
- sensitivity classification
- retention through `expiresAt`

Older producer records inside the current Project Identity remain readable with safe fallbacks. Phase 9 namespaces new Artifact roots by Project Identity; pre-Phase-9 global bodies remain on disk for rollback but are not exposed across projects. Review, browser evidence, Goal Evidence, and Language Intelligence now write first-class metadata. Bodies remain absent from list and tool results.

## Security limits

- Artifact body: 16 MiB default private-store limit.
- Bundle: 1,000 entries, 10 MiB each, 25 MiB aggregate, 36 MiB encoded file.
- Remote Vercel payload: 25 MiB application cap.
- Static Markdown/HTML: rendered then parser-sanitized.
- Interactive HTML: script preserved only inside opaque-origin sandbox with `connect-src 'none'` and no forms, popups, downloads, navigation, workers, or storage access.
- Images: PNG/JPEG/GIF/WebP signature must match MIME.
- JSON: must parse before rendering.
- Sensitivity block findings cannot be overridden.
- No remote publish from Agent tools, hooks, schedules, Goals, or child roles.

These are application and browser controls, not an OS sandbox.

## Revocation, deletion, erasure

- **Expiry:** Capability Token stops granting access.
- **Revocation:** publication access is disabled explicitly.
- **Deletion:** Vercel deployment stops serving.
- **Erasure:** provider confirms physical removal.

Vercel may retain deleted deployments during documented recovery windows. Phase 9 never describes deletion as immediate erasure.

## Rollback

1. Run `/artifacts publications` and revoke every active, revoking, or unknown remote publication.
2. If provider reconciliation is unavailable, delete matching `piArtifactIntent` previews in Vercel operator UI and record that evidence.
3. Run `/artifacts credential-remove <reference> <project> <team-id|->`.
4. Set `"artifacts": false` and `/reload`.
5. Keep local Artifact bodies for recovery, or delete selected bodies explicitly.

Disabling the feature closes the loopback server and removes Artifact commands/tools without deleting stored bodies.
