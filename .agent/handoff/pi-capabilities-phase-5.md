# Phase 5 checkpoint - MCP and browser adapters

Updated: 2026-08-26
Branch: `pi-capabilities-phase-5`
Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-5`
Base: `8c6f957`

## Objective

Complete Phase 5 only: F07 MCP client/OAuth and F03 live browser control/visual verification. Do not begin Phase 6.

## Preserved live state

- Deleted live `AGENTS.md`
- Untracked live `skills/impeccable/`
- Existing DLL/dependency backups referenced by program continuity

## Phase plan

### 1. Interface and threat design

- [x] Public test seams confirmed: `ExternalIntegrationControls`, `ToolFederation`, `BrowserControl`, platform wiring, and real adapters.
- [x] Define shared external-integration policy, credential, redaction, allowlist, approval, offline, status, and lazy-activation contracts.
- [x] Define `ToolFederation` and browser module interfaces and domain language.
- [ ] Record architecture and threat model.

### 2. Package and adapter research

- [x] Audit/trial exact `pi-mcp-adapter@2.29.0` and official MCP SDK generations.
- [x] Reproduce/falsify native argument and lifecycle-hang reports with disposable probes.
- [x] Audit all three named browser wrappers and run the selected Playwright path against a disposable fixture.
- [x] Audit exact versions, source, licenses, scripts, dependencies, network/credential behavior, Windows cleanup, and abandonment evidence.
- [ ] Record adopt/wrap/build ADRs before production dependency choice.

### 3. Shared controls, test-first

- [x] Add one failing interface-level test per vertical slice.
- [x] Implement credential storage policy, secret redaction, domain/origin policy, side-effect metadata/approval, offline behavior, status, dynamic activation foundation, and plan-mode classification.

### 4. F07 ToolFederation, test-first

- [ ] Implement trusted config, HTTP, untrusted instructions, bounded reconnect, official OAuth protocol adapter, and `/mcp` UI. Core namespaces, lazy schemas, per-tool policy, STDIO, PKCE/state, OS credential storage, refresh, and revoke are green.
- [ ] Verify mock servers, argument fidelity, collisions, auth failure paths, package/print exit, secret canaries, cancellation, reload, and shutdown.

### 5. F03 browser module, test-first

- [ ] Implement remaining actions, Impeccable coexistence detection, platform wiring, and visual workflow. Dedicated profile, owned pages, AI refs, click/fill policy, screenshots, console/errors/network evidence, origin/private-target policy, bounded artifacts, cancellation primitives, and real Chrome cleanup are green.
- [ ] Add reusable visual-verification skill integrated with background terminals, review, and artifacts.
- [ ] Verify local fixture flow, blocked operations, isolation, plan mode, and native Windows cleanup.

### 6. Hardening and acceptance

- [ ] Run adversarial architecture/security reviews and resolve every material finding with regression coverage.
- [ ] Run full isolated verification, secret scan, performance/startup/schema measurements, TUI checklist, live fixture verification, and rollback drill.
- [ ] Update tracker, configuration/setup docs, architecture, ADRs, threat model, acceptance ledger, and program continuity.

### 7. Publication and live integration

- [ ] Fetch before publication and report ahead/behind.
- [ ] Commit implementation and evidence separately where practical.
- [ ] Push Phase 5 branch, re-fetch, fast-forward live `main`, install only approved dependencies, and verify live checkout.
- [ ] Preserve live dirty user state.
- [ ] Stop before Phase 6.

## Current status

- Fresh remote state confirmed: live `main` 0 ahead / 0 behind `fork/main`.
- Isolated branch/worktree created from `8c6f957`.
- Public seams confirmed.
- Isolated dependencies installed. Baseline deterministic suite passed: 202 unit, 176 integration with 5 skips, 22 delegated, smoke. Focused Claude rerun passed 2/2 after the first live interrupt run lacked a pre-cancel text fragment.
- Research selects exact official MCP v2 client/core and `playwright-core@1.62.1`; broad third-party adapters are rejected as production abstractions. Reports under `docs/research/`.
- Foundation passes typecheck and 219 unit tests. Real Windows keyring, official MCP STDIO, and real Playwright Chrome fixtures pass. Full integration suite is running.
