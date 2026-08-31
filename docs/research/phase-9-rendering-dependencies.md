# Research: Phase 9 rendering dependencies

## Findings

- [HIGH | Primary] `marked@18.0.10` is MIT-licensed, has no runtime dependencies or install scripts, and explicitly states that its HTML output is not sanitized. Phase 9 sanitizes output after the final Markdown transform. Source: https://marked.js.org/ and https://github.com/markedjs/marked
- [HIGH | Primary] `sanitize-html@2.17.7` is MIT-licensed, maintained in the Apostrophe monorepo, uses an allowlist parser, and has no install script. Exact runtime dependencies: `deepmerge`, `escape-string-regexp`, `htmlparser2`, `is-plain-object`, `launder`, `parse-srcset`, and `postcss`. Source: https://github.com/apostrophecms/apostrophe/tree/main/packages/sanitize-html
- [HIGH | Primary] `sanitize-html@2.17.7` upgrades `htmlparser2` to address numeric character-reference parsing security. Source: https://github.com/apostrophecms/sanitize-html/blob/main/CHANGELOG.md
- [HIGH | Primary] npm package metadata reports exact integrity values:
  - `marked@18.0.10`: `sha512-FJeH4bRpYoXiggcgriCGItKCSv3xkngJc4QCZ/rkQCogU3VYaLxYJoZl8Nw/b4+x7iij/pd+09mZ6A1dXzpL0A==`
  - `sanitize-html@2.17.7`: `sha512-PGtEkc9cbnedU3s9TmzDbpsZ8w086g/0Q8k8/oIO1NLNU3i5k9yn835CrjJSajp1KMmkisbO1qPXxNKO3welAg==`
- [HIGH | Primary] `@types/sanitize-html@2.16.1` is MIT-licensed, has no install script, and is development-only. Source: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/sanitize-html
- [HIGH | Local verification] `npm audit --omit=dev` reports zero vulnerabilities after exact installation.

## Contradictions and hidden variables

- DOMPurify is the browser-oriented recommendation in Marked and security guidance, but Node use requires a DOM implementation with its own parser/security update surface. `sanitize-html` is selected for server-side static HTML because it avoids a simulated browser DOM. Interactive HTML is not declared safe through either sanitizer; it remains intact only inside an opaque-origin sandbox with network-denying CSP.
- Sanitizer safety depends on parser version and final sink context. Phase 9 performs no post-sanitization markup concatenation except wrapping already-sanitized fragments in a fixed document shell.

## Survivorship-bias sweep

- Historical sanitizer advisories show bypasses and regular-expression denial-of-service flaws in old versions. This supports exact pinning, restrictive configuration, deterministic malicious fixtures, and prompt dependency updates rather than hand-rolling a sanitizer.
- No primary-source evidence found that current Marked or sanitize-html is abandoned. Both published current releases in 2026.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Markdown grammar | Custom Markdown parser | `marked@18.0.10` | Mature CommonMark/GFM behavior and no runtime dependency tree |
| Static HTML sanitization | Regex-based tag stripping | `sanitize-html@2.17.7` | Parser-backed allowlist with maintained security fixes |
| Interactive HTML safety | A sanitizer configuration that preserves arbitrary scripts | Browser sandbox plus CSP | Script-preserving sanitization cannot establish script trust |

## Validation queue

- Re-run malicious corpus tests and `npm audit` on every dependency update.
- Inspect sanitize-html release notes for parser-context or URL-scheme changes before upgrading.
- Keep static allowed tags/attributes narrow; expand only through a failing Artifact rendering acceptance case plus threat review.
