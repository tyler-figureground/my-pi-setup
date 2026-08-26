# Research: `@narumitw/pi-lsp` for Phase 4

## Findings

- [HIGH | Primary] Current exact package is `@narumitw/pi-lsp@0.49.6`, MIT, published from attested repository commit `d94e200db31c5acd5d8f402aed58f7594078a460`. It declares Pi and TypeBox wildcard peers and no direct runtime dependencies. - [npm](https://www.npmjs.com/package/@narumitw/pi-lsp), [release](https://github.com/narumiruna/pi-extensions/releases/tag/%40narumitw%2Fpi-lsp%400.49.6)
- [HIGH | Primary] Package creates and terminates one server per tool route/call. It has no `didChange`, persistent document state, restart budget, semantic navigation, `LifecycleSupervisor`, or canonical `ProjectIdentity` integration. - [source](https://github.com/narumiruna/pi-extensions/blob/d94e200db31c5acd5d8f402aed58f7594078a460/packages/pi-lsp/src/lsp-client.ts)
- [HIGH | Primary] Tool surface is `lsp_diagnostics`, `lsp_fix`, and `/lsp`. There is no supported module interface to wrap; internal subpaths are not exports. - [source](https://github.com/narumiruna/pi-extensions/blob/d94e200db31c5acd5d8f402aed58f7594078a460/packages/pi-lsp/src/pi-lsp.ts)
- [HIGH | Primary] Hand-written framing, stderr, diagnostics, actions, edits, and preview bodies lack hard response limits. Timeouts are per request rather than aggregate. Configured timeout and file limit have no hard ceilings. - [source](https://github.com/narumiruna/pi-extensions/tree/d94e200db31c5acd5d8f402aed58f7594078a460/packages/pi-lsp/src)
- [HIGH | Primary] Windows support handles executable suffixes and URI casing, but process termination owns only the direct child. Closed PR 507 attempted descendant cleanup. - [PR 507](https://github.com/narumiruna/pi-extensions/pull/507), [Node process docs](https://nodejs.org/api/child_process.html#subprocesskillsignal)
- [HIGH | Direct] Exact package trial on Windows with Pi peers `0.84.3` and Ruff found the expected `F821` at line 4. Five per-call samples had 31.5 ms median latency and returned 137 text bytes.
- [HIGH | Direct] Native `ruff check --output-format json` found the same defect in one call. Five samples had 25.4 ms median latency and returned 473 JSON bytes. Package saved output bytes but added 6.1 ms on this tiny target; neither path changed defect detection.
- [HIGH | Direct] Exact package trial exposed a caller-root footgun: omitted tool `root` resolves from process cwd rather than `ctx.cwd`. Explicit root worked.
- [HIGH | Primary] Package documentation explicitly says LSP has not demonstrated improved agent success, latency, or tool usage and repository-native checks remain authoritative. - [README](https://github.com/narumiruna/pi-extensions/blob/d94e200db31c5acd5d8f402aed58f7594078a460/packages/pi-lsp/README.md)

## Contradictions and hidden variables

- Package is lazy because it starts on each call; Phase 4 requires lazy first use plus persistent synchronized state.
- Linux server breadth does not establish Windows process-tree safety. Upstream continuous integration is Linux-only.
- Targeted Ruff diagnostics are competitive on one file. Value may reverse on larger repositories where persistent semantic indexes amortize startup, or where native checks are already fast.

## Survivorship-bias sweep

- [HIGH | Primary] Package is active rather than abandoned; `0.49.6` was current during audit.
- [HIGH | Primary] Negative operational history includes strict protocol parameters, URI encoding, push diagnostics, and process cleanup. Most protocol issues received fixes; full process-tree ownership remains outside package design. - [issues](https://github.com/narumiruna/pi-extensions/issues?q=is%3Aissue%20lsp)
- [HIGH | Primary] OpenAI's Pyright author reports that coding-agent LSP experiments did not provide expected gains. - [OpenAI issue 8745](https://github.com/openai/codex/issues/8745#issuecomment-3713058579)
- [LOW] No package-specific public migration-away report found. Failed adoption is underreported.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| JSON-RPC framing | Another `Content-Length` parser | Microsoft `vscode-jsonrpc@9.0.1` | Maintained framing, request lifecycle, cancellation |
| Protocol request/result types | Local partial protocol types | `vscode-languageserver-protocol@3.18.2` | Maintained LSP definitions |
| Session resource ownership | Package-local spawn/kill | Existing `LifecycleSupervisor` plus guarded Windows process adapter | Bounded central shutdown and reload ownership |
| Project keys | Raw normalized roots | Existing `ProjectIdentity` | Worktree and alias-safe identity |

## Decision

Replace package at runtime. Build the approved deep `LanguageIntelligence` seam with Microsoft protocol libraries, existing lifecycle/project modules, and bounded normalized results. Retain package server-routing lessons and Windows URI regression cases as reference.

Thin wrapping cannot satisfy Phase 4 because the package owns transient clients internally and exports no persistent service interface.

## Validation queue

- [x] Persistent TypeScript and non-TypeScript real servers on Windows
- [x] `.cmd` server under a path containing spaces
- [x] Complete descendant termination on timeout and shutdown
- [x] Canonical worktree and junction-alias mapping
- [x] Frame traffic, stderr, file, item, and model-facing byte limits
- [x] Three-repository benchmark against authoritative native checks
