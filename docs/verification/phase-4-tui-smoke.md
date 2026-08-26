# Phase 4 TUI smoke checklist

Automated wiring tests cover standard select/input/notify/status paths. Real terminal keystrokes remain manual.

## Language tools

1. Start trusted TypeScript project with `languageIntelligence: true`.
2. Confirm only `language_tools` appears initially.
3. Ask agent to discover TypeScript definition support.
4. Confirm relevant LSP tools activate additively without removing unrelated tools.
5. Run diagnostics and definition lookup.
6. Confirm output says advisory and paths are project-relative.
7. Edit file, rerun diagnostics, confirm stale diagnostic is absent.
8. `/reload`; confirm server process exits and loader returns to deferred state.

## Local review

1. Start trusted Git project with `review: true`.
2. Run `/review`; select uncommitted changes.
3. Confirm progress status: capture, review, validate, persist.
4. Confirm findings show severity, path/range, confidence, and summary.
5. Confirm result shows base freshness when reviewing a base branch.
6. Confirm artifact ID appears and full JSON exists outside source repository.
7. Run `/review uncommitted --second`; confirm deterministic merged findings.
8. Run `/review uncommitted --tests`; confirm explicit disposable-test progress/evidence.
9. Start another review and `/review cancel`; confirm cancellation and cleared status.
10. Confirm source/index hash is unchanged after each path.

## Noninteractive modes

- RPC: picker and notifications use standard extension UI messages.
- Print/JSON: `/review` rejects with explicit mode error rather than running silently.
