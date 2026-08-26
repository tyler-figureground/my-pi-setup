# ADR 0005: Build persistent language intelligence

Status: Accepted
Date: 2026-08-26

## Context

Phase 4 needs lazy persistent language servers, synchronized documents, semantic navigation, canonical worktree paths, bounded restart and response behavior, and central lifecycle ownership.

The required trial of `@narumitw/pi-lsp@0.49.6` succeeded for targeted Ruff diagnostics. The package deliberately creates a transient server for each route/call, exposes diagnostics and fixes only, owns child processes internally, and has no supported service interface. See `docs/research/pi-lsp-audit.md`.

## Decision

Build one internal `LanguageIntelligence` module behind the approved `discover`, `synchronize`, and `query` interface.

Use exact Microsoft protocol dependencies:

- `vscode-jsonrpc@9.0.1`
- `vscode-languageserver-protocol@3.18.2`

A lifecycle resource represents a restartable server slot. The slot starts no process until first relevant query, owns persistent document generations and bounded restart state, and closes under `LifecycleSupervisor`.

Language results are advisory. Repository-native build, typecheck, lint, and tests remain authoritative.

## Consequences

- More implementation than wrapping the package, but lifecycle, identity, bounds, and navigation remain local to one deep module.
- We own server catalog/config compatibility and Windows process-tree verification.
- We do not own JSON-RPC framing or protocol type definitions.
- Package routing and URI behavior may inform tests, but package internals are not imported.
- If benchmarks show no measurable value, the feature may remain disabled or be removed while preserving the trial result.
