---
name: visual-verification
description: Verify a frontend change in the live app with the dedicated browser. Use after changing user-visible web UI, before claiming completion.
---

# Visual Verification

Prove frontend behavior in the running app. Source checks alone are insufficient.

## Workflow

1. Identify the project's documented dev or preview command and expected origin.
2. Check existing background terminals before starting another server.
3. Start the server with `bg_start` when needed. Record terminal id and stop it before completion unless user asks to keep it.
4. Use `browser_pages` to avoid reusing an unrelated page.
5. Open the configured local origin with `browser_action`. Never broaden origin policy to make a test pass.
6. Use `browser_observe` with `snapshot` first. Act through current accessibility refs. Re-snapshot after navigation or substantial rerender.
7. Exercise the requested flow. Protected clicks, keys, uploads, and downloads require direct user approval. Use an opaque credential reference for password fields.
8. Capture proof with `browser_observe` using `screenshot` only after semantic behavior passes.
9. Inspect `console`, `page-errors`, and `network`. Treat new errors, failed requests, and blocked routes as failures until explained or fixed.
10. Run applicable repository build, typecheck, lint, and tests. Browser proof supplements them; it does not replace them.
11. If local review applies, run `/review` and include browser artifact ids in the completion evidence.
12. Close owned pages and stop server terminals started for verification.

## Evidence contract

Report:

- Origin and flow exercised
- Viewport or relevant responsive state
- Semantic result from accessibility snapshot
- Screenshot artifact id
- Console/page-error/network result
- Repository verification commands
- Any skipped step and exact blocker

Never paste screenshot pixels, cookies, authorization values, form secrets, callback codes, or full network bodies into model context. Artifact ids are the evidence reference.
