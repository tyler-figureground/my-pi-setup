# Phase 4 acceptance evidence

Date: 2026-08-26

## Deterministic verification

- Root and extension TypeScript checks: pass
- Prettier: pass
- Unit: 200 pass
- Integration: 174 pass, 5 POSIX/opt-in skips
- Delegated file-search: 22 pass
- Repository smoke: extension discovery, public schema contract, print, JSON, RPC, reload, shutdown, no leaks

Integration suite runs serialized on Windows. Parallel file execution caused unrelated process-deadline assertions to drift under simultaneous language-server/PowerShell load; serialization retains intra-test concurrency coverage and stable wall-clock evidence.

## F04 Language Intelligence

- Exact `@narumitw/pi-lsp@0.49.6` trial: Ruff `F821` reproduced; package rejected as runtime dependency.
- Persistent internal module uses `vscode-jsonrpc@9.0.1` and `vscode-languageserver-protocol@3.18.2`.
- Lazy `discover`, document `open/change/close`, persistent slot reuse, bounded crash restart, global monotonic document generations, stale/versionless diagnostic handling.
- Diagnostics, document/workspace symbols, definition, references, implementations, hover, incoming/outgoing call hierarchy.
- Canonical linked-worktree source-relative mapping and junction escape rejection.
- Unsupported capability returns explicit error.
- Deferred `language_tools` activates relevant operation tools additively.
- Parent secrets absent from child environment; stderr omitted; 4 MiB frame and 64 MiB traffic ceilings.
- Windows path-with-spaces `.cmd`, detached descendant cleanup, cancellation, request/startup timeout, reload/shutdown pass.
- Real TypeScript navigation: pass.
- Real Ruff diagnostics: pass (`F821`).
- Three-repository benchmark and retain decision: `docs/verification/phase-4-language-benchmark.md`.
- Startup paired control: Phase 4 median 13.6% faster under matched elevated system load.

## F06 Local Review

Targets verified:

- uncommitted HEAD/index/worktree plus untracked and binary layers
- freshly fetched base with explicit ahead/behind or unknown freshness
- exact commit including root-parent semantics
- exact direct/merge-base range

Safety and behavior verified:

- direct raw uncommitted capture does not execute clean filters
- direct-URL fetch ignores repository upload-pack and rejects unsafe protocols
- HEAD/index/content fingerprint before and after review/artifact persistence
- unchanged large tracked files do not consume capture limits
- base/index/worktree/target coordinate validation
- false path, line, changed-range, and evidence IDs rejected
- overlapping findings merge deterministically
- successful empty findings distinct from reviewer failure
- post-capture failure/cancellation preserves artifact when store is available
- reviewer role has empty tools, no project settings, and no context files
- bounded diff plus immutable file context, strict JSON, output/candidate limits
- optional independent second reviewer
- current-worktree LSP evidence settles; historical LSP fails closed as unavailable
- optional `--tests` uses stock Windows tar, disposable text/binary snapshot, minimal environment, no parent dependency link
- artifact root outside source repository
- print/JSON reject rather than run silently

## Live command evidence

- Trusted fixture repository: `/review uncommitted` completed with one validated finding, artifact ID, all progress states, and unchanged Git source state.
- This repository: `/review commit HEAD` completed with explicit no-findings, artifact ID, and unchanged dirty state.
- Managed Pi reviewer transport reached real subagent backend. Standalone CLI inherited no selected provider key in two attempts; Node live Pi backend test passed 1/1 with authenticated runtime.
- Codex backend live completion/interrupt passed 2/2 after shared policy changes.
- Live checkout after fast-forward: dependency audit zero vulnerabilities; check/format pass; 200-unit run pass; focused Phase 4 suite 77 pass plus one opt-in Ruff skip; separate Ruff pass; smoke pass; Pi 1/1 and Codex 2/2.
- Late sign-off hardening in `425145b`: Git-safe text attribute/EOL comparison prevents `core.autocrlf` aliases and valueless true config from creating false review changes without executing clean filters; empty repositories remain capturable.
- Windows protocol-error cleanup now preserves root/descendant creation identity through discovery and termination, revalidates before every kill, sends the LSP exit notification, cleans detached descendants after graceful root exit, and has no reachable PID-only Windows fallback.
- Final isolated `npm run verify`: 202 unit; 176 integration with 5 platform skips; 22 delegated; smoke pass; Claude 2/2, Codex 2/2, Pi 1/1. Final independent review: no blockers.

## Manual limit

Harness cannot provide real terminal keystrokes. Automated TUI/RPC call paths pass. Manual checklist: `docs/verification/phase-4-tui-smoke.md`.
