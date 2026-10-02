# Visible browser option

User approved adding a visible-browser option so they can manually sign into Newegg in Pi's dedicated profile.

## Plan
1. Add user-managed browserSettings.headless (default true), validate configuration, forward to browser launch; preserve origin/approval/profile controls.
2. Add regression tests and document configuration. Run relevant tests, typecheck and formatting.
3. Enable headless:false in existing user platform.json without changing other settings. Reload requires user action. Verify actual visible browser launch using isolated integration fixture.

## Baseline
Fetched origin: ahead 0 / behind 0. Existing unrelated dirty files include deleted AGENTS.md, background-terminals changes, hooks changes, platform.json and untracked resources. Preserve all. No commit requested in this Pi configuration repo.

## Status
Implemented and enabled browserSettings.headless:false in user platform.json. Config boolean is user-managed, defaults true, rejects invalid types/project overrides, forwards through composition/control to Playwright. Visible startup retains an unowned blank window until first requested page opens. Docs and regression tests added. Unrelated changes preserved; no commit.

Parent verification: platform npm run check passed; 18 focused config/composition/control tests passed, zero skips; two real Chrome launch/close tests (default headless and visible) passed, zero skips, using --test-force-exit; config JSON and git diff --check passed. Child additionally reports full browser integration 8/8 passed; broad root scripts blocked by unrelated running-widget test classification and formatting changes.

Next: Tyler runs /reload, then asks to reopen Newegg. Current in-memory adapter still uses old headless configuration. Manual sign-in is NOT guaranteed: existing origin and non-GET request restrictions remain unchanged; secure.newegg.com is not yet configured. Resolve via explicit user-approved integration flow, never bypass browser safeguards.
