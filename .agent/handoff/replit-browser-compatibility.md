# Replit browser compatibility and migration

User request: migrate ArchitecturalScopeBuilder from Replit to new tyler-figureground GitHub repo, clone locally and verify independent operation. User explicitly approved scoped Pi browser compatibility repair preserving approvals/network safeguards after browser failed to render.

## Evidence
- GitHub CLI authenticated as tyler-figureground; target repo did not exist at initial check.
- User platform.json allows https://replit.com, https://cdn.replit.com and https://github.com; existing settings preserved. Visible dedicated browser enabled.
- Live Replit login document and CDN scripts return 200. Console crashes with Cannot assign to read only property addEventListener. Pi init instrumentation defines EventTarget prototype methods non-writable.
- Background Cloudflare POST and elements.stytch.com telemetry script blocked. No evidence yet whether either must succeed for login.
- Pi repo fetched; ahead 1 / behind 10 against configured upstream. Numerous pre-existing staged/unstaged changes; preserve all. No commits requested here.

## Plan
1. Diagnose event instrumentation compatibility; regression test safe repair while preserving event-generation approval safety. Assigned child sa-1; owns implementation and focused tests only.
2. Inspect network request controls and documented supported login flow. Do not loosen request safeguards to make site work. Identify any additional architectural decision before changes.
3. Verify repair with focused tests, typecheck and actual browser after necessary reload. Login requires user interaction or supported credential reference.
4. Resume migration: inspect source/secrets, create private repository, clone to C:/Users/Tyler/Documents/GitHub/ArchitecturalScopeBuilder; verify build/tests/live app independently of Replit.

## Status
Step 1 complete, live verification pending reload. Updated extensions/platform/src/browser/playwright.ts with nonconfigurable accessors that accept site wrapper assignments while tracking method assignments and calls. Captured delegate per wrapper avoids recursion; inherited assignments remain receiver-local. Counter protection and network/approval controls unchanged. Added extensions/platform/browser-events.integration.test.ts covering native listener semantics, wrapper layering, saved functions, receiver-local overrides, tamper resistance and stale-approval rejection including revalidation drift. Child reproduced regression against original code; parent reviewed diff and reran 31 tests with zero skips, all passing, plus platform npm run check. Existing dirty changes preserved; no commits.

Network inspection: non-GET requests remain one-shot, approved-action/page-bound; Cloudflare POST blocked and Stytch telemetry origin blocked. No evidence yet that either must succeed for login. Do not relax controls speculatively.

Next: user runs /reload, then continue. Open https://replit.com/~ through browser_action and inspect snapshot/console/network. Actual Replit and login still unverified. No project source accessed, no GitHub repository created, no migration performed.
