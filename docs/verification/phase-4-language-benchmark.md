# Phase 4 language-intelligence benchmark

Date: 2026-08-26

## Method

Windows 11. Exact internal client dependencies `vscode-jsonrpc@9.0.1` and `vscode-languageserver-protocol@3.18.2`. TypeScript navigation used `typescript-language-server@6.0.0` with `typescript@5.9.3` supplied explicitly as its server library. Repository-native commands used each repository's declared typecheck path.

Each language sample synchronized one existing TypeScript file, requested document symbols, waited for diagnostics, then repeated the symbol request five times against the persistent server. Context bytes are serialized bounded results. Native checks covered the whole repository, so defect counts are not directly equivalent to targeted-file counts.

All three repository remotes were fetched before assessment.

## Results

| Repository | Target | LSP first | LSP warm median | LSP items / diagnostics | LSP context | LSP calls | Native check | Native output | Native defects |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| site-axis | `vite.config.ts` | 902.7 ms | 6.8 ms | 44 / 0 | 13,362 B | 3 | 30,320 ms | 37 B | 0 |
| Chronos | `src/types/index.ts` | 618.6 ms | 6.5 ms | 42 / 0 | 12,487 B | 3 | 8,484 ms | 83 B | 0 |
| Pyvoid | `packages/shared/src/tiers.ts` | 475.1 ms | 4.4 ms | 41 / 0 | 12,806 B | 3 | 14,619 ms | 1,996 B | 1 whole-repo error |

Pyvoid's native check found an unresolved `github-slugger` import in `web/src/lib/docs.ts`; targeted LSP evidence for a different shared-package file did not. This is expected scope behavior and direct evidence that LSP cannot replace authoritative repository checks.

## Exact package trial

`@narumitw/pi-lsp@0.49.6` and native Ruff each found the same injected `F821` error in one Python file.

| Path | Median | Output | Tool calls | Defects |
|---|---:|---:|---:|---:|
| Package transient Ruff LSP | 31.5 ms | 137 B | 1 | 1 |
| `ruff check --output-format json` | 25.4 ms | 473 B | 1 | 1 |

The package reduced output bytes but added startup latency on this tiny target. It cannot provide the persistent navigation measured above.

## Decision

Retain the internal persistent `LanguageIntelligence` implementation behind an off-by-default feature flag until live integration. Warm semantic navigation is materially faster than whole-repository typecheck, and first-use latency remains below one second on all three samples.

Keep repository-native checks authoritative because:

- targeted LSP scope can miss whole-repository defects;
- LSP emitted substantially more context for symbol-rich queries;
- language-server diagnostics and compiler/build configuration may differ;
- native commands remain CI's source of truth.

Use LSP for intermediate diagnostics and semantic navigation, not completion verification.
