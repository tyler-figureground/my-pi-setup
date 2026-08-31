# Phase 9 Artifact performance and endurance

Date: 2026-08-31

## Bounds

- Private Artifact: 16 MiB default.
- Local active publications: 128; terminal/expired entries reclaimed before capacity admission.
- Local session cookies: 1,024 retained maximum.
- Publication registry: 1,000 records with oldest terminal-record eviction.
- Artifact bundle: 1,000 entries, 10 MiB per entry, 25 MiB decoded aggregate, 36 MiB encoded envelope.
- Vercel payload: 25 MiB application cap.
- Vercel response: streamed and aborted above 1 MiB; oversized `Content-Length` rejected before body allocation.
- Artifact inspect: 25 projected records; no arbitrary custom metadata.
- Sensitivity canaries: 32 exact values, 64 KiB each maximum.

## Startup and idle behavior

- Artifact flag creates no listener, browser, timer, poller, provider request, or credential read at startup.
- Loopback server begins lazily on first confirmed local publication and binds one `127.0.0.1` ephemeral socket.
- Vercel transport starts only during explicit confirmed share/status/revoke work.
- Marked and sanitize-html load dynamically only on materialization, not platform startup.
- Live-refresh polling exists only in a viewer shell for an explicitly live local publication; one-second interval ends with page/listener lifecycle.
- Repository smoke with Artifacts enabled passed process/handle leak gates.

## Deterministic measurements

- Focused Phase 9 suite: local viewer exchange/render/revoke tests complete in well under one second on native Windows.
- Real Chromium visual flow: shell exchange, iframe isolation assertion, network denial, click interaction, and screenshot complete within the 120-second hard harness deadline with zero page errors or dispatched failed requests.
- Unit suite and integration suite retain existing watchdogs: 90 seconds per test, 20 minutes for serialized integration.
- Filesystem batch import runs under one ArtifactStore lock and rolls back every newly created body on later failure.
- Vercel polling is bounded to 30 one-second waits; every transport request has a 30-second timeout and propagated cancellation.

## Recovery/endurance cases

- Repeated local publications use active-count capacity, not lifetime-count capacity.
- Same materialized body republishes with different publication expiry without derived-metadata conflict.
- Publication revisions reject stale status/refresh/revoke writes.
- Publisher shutdown fences new work and drains accepted work before owner-scoped retirement.
- Ambiguous Vercel dispatch persists `intent:<handle>` before network mutation; fresh-process lookup re-verifies project identity and exact deployment metadata.
- Invalid non-preview/mismatched Vercel deployments are deleted immediately when their ID is known.
- Native filesystem bundle rollback uses one cross-process store lock.

No long-lived Phase 9 timer, socket, or browser remains after smoke shutdown.
