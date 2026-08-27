# Pi capabilities program handoff

Updated: 2026-08-26

## Objective

Execute every feature marked `[X]` in `C:/Users/Tyler/pi-competitor-feature-checklist.md` through `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`.

## Current phase

Phase 5 complete and live-integrated. F07 MCP client/OAuth and F03 browser control/visual verification accepted. Phase 6 remains out of scope until Tyler explicitly approves it.

## Completed this phase

- [x] `ExternalIntegrationControls`: exact origins, private-network/offline policy, address pinning, direct authority, plan-mode backstop, structural/string/exact redaction.
- [x] F07 `ToolFederation`: lazy namespaced discovery/activation, official MCP v2 STDIO and Streamable HTTP, official dialect schemas, protected effects, bounded results/artifacts, cancellation/reload/shutdown.
- [x] OAuth: PKCE/state, issuer/server/config binding, per-server origins, single-flight serialized refresh/logout, OS credential references, revoke, no ambiguous 401 mutation replay.
- [x] F03 `BrowserControl`: project/profile-scoped persistent Chrome, atomic leases, owned/opener-bound pages, 16-page caps, AI refs, prepared target identity, action approval, observations, screenshots, upload/download artifacts.
- [x] Browser network hardening: Chromium host pinning, no proxy, service-worker/WebSocket/WebRTC restrictions, one-shot page-bound non-GET authority including HEAD.
- [x] Visual verification skill and evidence on fixture and repository pages.
- [x] Official MCP and `playwright-core` package decisions recorded in ADRs 0006 and 0007; broader wrappers rejected as production boundaries.
- [x] Repeated adversarial review resolved all high/critical findings. Final MCP sign-off `sa-64` and browser/security sign-off `sa-66`: no blockers.

## Verification

Authoritative details: `docs/verification/phase-5-acceptance.md`.

- Post-sign-off isolated `npm run verify`: 239 unit; 188 integration with 5 platform skips; 22 delegated; smoke; Claude 2/2; Codex 2/2; Pi 1/1.
- Real Chrome, keyring, MCP STDIO/HTTP/OAuth, pinned-host, profile collision/persistence, detached descendant, and secret-canary fixtures pass.
- Repository visual artifacts: snapshot `c05b9157...4b061`; screenshot `fa670da7...f4d5`.
- Startup median 4,170.4 ms versus matched Phase 4 4,061.4 ms: +2.7%.
- Platform audit: zero vulnerabilities.
- Live clean platform install, typecheck, formatting, 61/61 focused Phase 5 tests, and repository smoke passed.

## Key references

- `docs/architecture/phase-5-mcp-browser.md`
- `docs/adr/0006-build-tool-federation-on-official-mcp-v2.md`
- `docs/adr/0007-build-browser-control-on-playwright-core.md`
- `docs/phase-5-configuration.md`
- `docs/security/phase-5-threat-model.md`
- `docs/verification/phase-5-acceptance.md`
- `docs/verification/phase-5-performance.md`
- `docs/verification/phase-5-tui-smoke.md`
- `.agent/handoff/pi-capabilities-phase-5.md`

## Repository state

- Live `main` fast-forwarded through Phase 5 implementation/evidence at `f1603a9`; final integration documentation commit follows this handoff update.
- Published branch: `pi-capabilities-phase-5`
- External worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-5`
- Live deleted `AGENTS.md` and untracked `skills/impeccable/` remain untouched.
- Preserve DLL backup at `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase1-live-backup-20260825-144510`.

## Next exact action

Wait for explicit Phase 6 approval. If approved: fetch first, create isolated Phase 6 branch/worktree and checkpoint, then design F10 cross-session messaging and F11 persistent memory test seams before implementation.
