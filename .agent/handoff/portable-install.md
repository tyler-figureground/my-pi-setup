# Portable installation

## Objective
Make existing tyler-figureground/my-pi-setup repository safely installable and maintainable on another computer. Preserve unrelated working-tree changes. No automatic publication or release until reviewed and verified.

## Phases
1. Audit tracked configuration, machine dependencies, and Pi loading behavior. Complete. Found incompatible Node minimum, unignored browser/workspace state, personal platform file, external skills and optional binaries.
2. Implement portable installer/updater with safe defaults, backups, exact Pi version, and focused regression tests. Complete. Review fixes: git switch --no-overwrite-ignore, refusal of duplicate local/Git setup copies, refusal of nested private-data directory. Tests expanded to 96; all pass in final isolated run.
3. Document installation, updates, private state boundaries, and release gates. Complete. SETUP.md and docs/runbooks/portable-install.md. Added Windows/Linux/macOS GitHub checks (not run remotely).
4. Verification complete on Node26 Windows: final isolated run (bt-12) passed TypeScript check, 853 unit tests (including 96 setup tests), 22 file-search tests, fresh-home smoke, doctor, and zero-vulnerability audits. Full formatting check passes. Negative control passes (bt-11). Standard Pi lifecycle smoke passes (bt-7). Initial full integration (bt-5): 441 passed, 1 browser shutdown failed, 5 skipped. Error: Windows process remained alive after one-second termination wait; both headless cases passed focused retry. No speculative browser change made. Clean-install rehearsal passed (bt-6). bt-10's 20 unit failures were caused by rehearsal PI_OFFLINE=1, not code; removing override yielded all 853 passes.
5. Node24 baseline complete. Explicit node-win-x64@24.15.0 binary version confirmed; all 96 installer tests and patched-installation startup passed (bt-14/bt-15). npm exec --package=node@24.15.0 had silently used Node26; caught and excluded from evidence.

## Current stopping point
Implementation and scoped Windows verification complete. No active verification jobs. Changes remain uncommitted; only platform.json removal deliberately staged. Next: review pre-existing mixed edits and AGENTS.md deletion, address/confirm the integration browser-shutdown caveat, run hosted OS checks, then publish reviewed release. See docs/verification/portable-install.md. Do not imply installer commands are already available from GitHub.

## Important modifications
- Explicit local Pi package manifest; scripts/setup.mjs installs dependencies and pinned CLI, merges settings with backup, and updates only explicit release tags from a clean checkout.
- config/platform.example.json is portable, browser-disabled, no external service config.
- platform.json removed from Git index with git rm --cached, verified still on disk and ignored. This is the only deliberately staged change. Do not delete local file.
- scripts/run-test-suite.mjs now classifies pre-existing running-widget.test.ts, which blocked baseline npm test before our edits.
- No commit, tag, push, or migration of live installation.
- Existing formatting violations fixed with Prettier only, preserving semantic edits. Standard tests/smoke/pi-smoke.mjs now uses isolated config/home, not personal platform.json.
- Clean install exposed 5/1/4 npm audit findings in file-search/git-info/subagents. Updated compatible transitive lockfile versions; Vitest pin 4.1.10 -> 4.1.11. Updated lockfiles audit to zero vulnerabilities. No active node_modules changes while main suite runs; fresh patched dependencies installed/tested in isolated rehearsal instead.
- Full clean install initially tested installer before final duplicate/ignored-file guards; bt-12 rechecked final guards and lockfiles with real installed modules. See docs/verification/portable-install.md for exact evidence and caveats.
- Clean-install rehearsal script: C:/Users/Tyler/AppData/Local/Temp/pi-install-rehearsal.mjs. Temporary root logged by bt-6; retained for evidence.

## Starting state
Fetched fork. HEAD ahead 0 / behind 0 of fork/main. Many pre-existing browser, workflow, subagent, background-terminal changes; AGENTS.md deleted in working tree. Do not revert or publish these indiscriminately.
