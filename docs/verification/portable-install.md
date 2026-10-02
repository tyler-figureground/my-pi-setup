# Portable installation verification

## Scope and environment

Prepared existing `tyler-figureground/my-pi-setup` checkout for separate-source installation. No commit, release tag, push, or migration of the live in-place installation was performed.

Windows 11; Node.js 26.4.0; npm 12.0.2; Git 2.55.0.windows.2. Fetched `fork` at start and again after implementation: ahead 0 / behind 0 `fork/main`.

## Passed

- Root TypeScript check (`npm run check`). No separate build command exists.
- Repository formatting check (`npm run format:check`), plus whitespace validation of staged and unstaged diffs.
- Final isolated installation: 853 unit tests, zero failures/skips. Includes 96 installer tests.
- Updated file-search Vitest 4.1.11 suite: 22 tests passed.
- Full fresh dependency installation into a temporary source checkout, with private home and global npm prefix isolated from the live installation. Installed Pi 0.84.3, root dependencies, all extension dependencies, then ran doctor and fresh-home startup.
- Final installer safety guards and patched dependencies rechecked in that isolated installation. Repeated configuration planning is a no-op.
- Node.js 24.15.0 baseline verified with its explicitly invoked Windows binary: all 96 installer tests and patched-installation startup passed. An earlier `npm exec --package=node@24.15.0` attempt actually selected Node 26.4.0 and was not counted as Node 24 evidence.
- Fresh-home real Pi smoke: local package discovery, expected tools, approved temporary project, shutdown, and no copied credentials. Pi may initialize an empty auth store itself.
- Standard Pi lifecycle smoke: package tools, print/JSON/RPC modes, reload, shutdown, and process-leak checks. Updated test to use temporary configuration rather than personal `platform.json`.
- Real Git regression: tracked/untracked changes refuse update; conflicting ignored private files survive update refusal. Negative control removed `--no-overwrite-ignore`: regression failed. Restored guard: passed.
- CI YAML parsed locally. Windows/Linux/macOS jobs exercise the actual installer with isolated state and command prefix. Hosted jobs have not run.
- npm audits of patched file-search, git-info, and subagents lockfiles and their isolated installations: zero vulnerabilities.

## Broad-suite caveat

The initial root `npm test` run passed 823 unit tests, then integration reported 441 passed, one failed, five skipped. The failed case was `real browser launches and closes with headless=default true`:

```text
AggregateError: Browser shutdown failed.
Windows process operation failed with exit 1: process remained alive 15956
```

The Windows cleanup helper waited one second after terminating an owned process. Both headless modes passed a focused rerun, with no source changes. This establishes a successful retry, not a proven root cause or a fully green integration run. No speculative process-termination change was made as part of packaging. Remaining integration cases passed; platform-only and missing-Ruff skips remain unrun.

An isolated-unit verification attempt initially inherited `PI_OFFLINE=1` from the rehearsal environment, causing 20 network-policy test failures. Removing that test-runner environment override, without source/dependency changes, produced 853 passes. Offline mode remains explicitly set by the no-model startup smoke itself.

## Dependency remediation

Clean installation initially reported 5/1/4 audit findings in file-search/git-info/subagents. Applied compatible transitive lockfile updates and changed exact Vitest pin from 4.1.10 to 4.1.11. Pi and Effect pins unchanged. No force updates or overrides.

Patched dependencies were installed and verified in the isolated rehearsal. Active extension `node_modules` in the live Pi installation were deliberately not replaced mid-session. Lockfiles are the source for future installations; close Pi before refreshing the live dependency trees.

## Evidence locations

Local terminal logs: `C:/Users/Tyler/AppData/Local/Temp/pi-background-terminals/session-LTDUO6/`.

- `bt-5`: original full root checks, including integration caveat.
- `bt-6`: full clean installation rehearsal.
- `bt-7`: portable and standard lifecycle smoke.
- `bt-8`: root check/format and expanded installer regression verification.
- `bt-9`: compatible dependency lockfile remediation, zero audit findings.
- `bt-10`: patched installation plus the incorrectly offline unit attempt.
- `bt-11`: ignored-file overwrite negative control.
- `bt-12`: corrected environment, final 853 unit tests, 22 file-search tests, audits, doctor, and portable smoke.
- `bt-14`: explicit Node 24.15.0 binary version and startup check.
- `bt-15`: Node 24.15.0, all 96 installer tests plus startup against the patched isolated installation.

Retained isolated checkout: `C:/Users/Tyler/AppData/Local/Temp/pi-rehearsal-deZivD/source`. It contains its own dependency trees, not junctions to live dependencies.

## Publication remains separate

Review all pre-existing mixed browser/agent/UI edits and the deleted `AGENTS.md` before committing. `platform.json` removal is staged; its current personal contents remain on disk and are ignored. New-computer defaults come only from `config/platform.example.json`.

Before declaring a cross-platform stable release, run hosted OS checks, address the broad-suite caveat, review migration compatibility, and publish a reviewed tag. Provider authentication, paid live-agent backends, and interactive browser journeys were not verified by the installer tests.
