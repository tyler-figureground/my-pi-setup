# Phase 5 acceptance evidence

Date: 2026-08-26
Branch: `pi-capabilities-phase-5`
Scope: F07 MCP client/OAuth and F03 browser control/visual verification only

## Environment and dependencies

- Windows 11, Node `v26.4.0`
- Official MCP v2 client/core `2.0.0`
- `@napi-rs/keyring@1.3.0`
- `playwright-core@1.62.1`
- Platform `npm audit --audit-level=high`: **0 vulnerabilities**
- Browser: installed Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`; no browser download

## Full isolated verification

`npm run verify` passed after final adversarial hardening.

| Gate | Result |
|---|---|
| TypeScript | passed |
| Changed-file formatting | passed |
| Unit | 239 passed |
| Integration | 188 passed, 5 platform skips |
| Delegated file search | 22 passed |
| Repository smoke | print, JSON, RPC, reload, shutdown, no leaks passed |
| Live backends | Claude completion/interrupt 2/2; Codex completion/interrupt 2/2; Pi profiled completion 1/1 |

Final pre-sign-off log: `C:/Users/Tyler/AppData/Local/Temp/pi-phase5-verify-final.log`.
Post-sign-off full rerun: `C:/Users/Tyler/AppData/Local/Temp/pi-phase5-verify-post-signoff.log`.

## F07 MCP client and OAuth

- Lazy search and activation against official STDIO and Streamable HTTP fixtures passed.
- Native integer/boolean/array/object arguments survived official protocol validation and invocation.
- Catalogs, schemas, input, protocol frames, results, errors, and artifact spill enforce bounds.
- Schema validation uses the official dialect-aware compiler. Model publication strips schema annotations while preserving property and definition entry names.
- Dynamic names are namespaced, collision-resistant, at most 64 characters with `mcp_`, and refuse existing Pi tool collisions.
- Unknown effects remain protected; plan mode blocks process/credential/mutation operations.
- HTTP and OAuth connect to the policy-approved IP while retaining original Host/TLS identity. Redirects fail closed.
- OAuth discovery/exchange/refresh/revoke fixtures passed with PKCE, one-shot state, callback issuer, full server fingerprint, per-server origins, and OS credential references.
- Refresh is single-flight and serialized with logout. Regression proves a refresh that observed stale tokens cannot resurrect a logged-out credential.
- No `onUnauthorized` callback is installed, preventing official-client replay of an ambiguous `tools/call` POST.
- Windows aborted-connect fixture terminates root and detached descendant by PID plus creation identity; no PID-only fallback remains.

## F03 browser control

- Dedicated persistent profile, collision refusal, stale-lease recovery, failed-launch release, project isolation, cookie persistence, and separate Impeccable profile coexistence passed against real Chrome.
- Browser start is lazy. Unconfigured enabled state starts no Chrome process.
- Origin pinning, `--no-proxy-server`, request revalidation, service-worker blocking, WebSocket blocking, and WebRTC restrictions are active.
- Real network adversary fixture proved non-GET authority is page-bound, one request only, cleared when action settles, and treats HEAD as protected. Background page writes remained blocked.
- All protected DOM actions use direct host authority. Approval binds action/input, live URL, page/document digest, event-handler generation, and a prepared `ElementHandle`; replacement fails rather than retargeting.
- Concurrent opens serialize at 16 owned pages. Adapter also closes pages beyond its 16-page cap. Popup adoption requires opener lineage.
- Credential values are exact redaction canaries for all later text/error/artifact observations. Credential capacity fails closed rather than evicting canaries. Screenshot and download evidence are disabled after credential use because arbitrary secret pixels/bytes cannot be safely redacted.
- Uploads accept only project-bound artifact ids. Downloads and screenshots return content-addressed artifact ids, never raw model bytes.
- Accessibility refs, click/fill/select/key/scroll/wait, upload/download, screenshot, console, page-error, and network diagnostics passed real-browser fixtures.

## Visual verification

Known fixture page:

- Real Playwright integration produced AI accessibility refs, clicked a real button, uploaded and downloaded bounded fixture bytes, collected console/page/network evidence, and created a PNG screenshot.

Repository page:

- Served current repository `README.md` from an ephemeral allowlisted loopback origin.
- Accessibility snapshot artifact: `c05b9157b85e1588e0e264fa0df39b104eb3813c04822e35d737221bbab4b061`
- PNG screenshot artifact: `fa670da78f9bb10260cb7f24e8288d958543a837cd6d71443928f10740eef4d5` (56,823 bytes)
- Persistent artifact root: `C:/Users/Tyler/AppData/Local/pi-agent/phase5-acceptance-artifacts`
- Output record: `C:/Users/Tyler/AppData/Local/Temp/pi-phase5-visual-acceptance.json`

Visual verification skill: `skills/visual-verification/SKILL.md`.

## Performance

Paired warm offline RPC benchmark:

- Phase 5 median: 4,170.4 ms
- Phase 4 control median: 4,061.4 ms
- Change: +109.0 ms (+2.7%)

No MCP transport, keyring module, Playwright module, browser, OAuth request, or socket started in the unconfigured startup path. See `phase-5-performance.md`.

## Independent review

Three initial adversarial reviews and multiple focused rereviews found and drove fixes for DNS rebinding/proxy bypass, browser network authority, target drift, secret leakage, schema injection/collision, OAuth issuer and logout races, ambiguous MCP replay, lifecycle races, profile leases, popup/page bounds, keyring ordering, and Windows descendant identity.

Final focused MCP sign-off (`sa-64`): **no blockers**.
Final browser/security sign-off (`sa-66`): **no blockers**.

## TUI and mode evidence

Automated tool registration, command discovery, approval retry, machine-readable details, status lifecycle, RPC, print/JSON rejection, reload, and shutdown passed. Real terminal keystrokes remain manual and are explicitly listed in `phase-5-tui-smoke.md`.

## Rollback

Set `mcp` and/or `browser` false in `platform.json`, then `/reload`. Verification keeps flags-off platform behavior inert and preserves existing Phase 0-4 tools. Rollback does not delete credentials, profiles, or artifacts.

## Result

F07 and F03 isolated acceptance gates pass. Live-main integration evidence remains before final tracker completion. Phase 6 has not started.
