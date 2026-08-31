# Research: Phase 9 interactive artifact sharing

> Research-only session. Repository content never read, modified, or uploaded. All external requests contained only documentation queries.

**Recommendation:** local loopback viewer by default. Optional **Vercel preview adapter** as the only remote adapter. Two rendering modes: sanitized static content and isolated interactive HTML.

## Findings

### Proposed architecture

- **[MEDIUM | Synthesis] Local-first viewer:** serve a generated viewer shell from an ephemeral loopback port. Keep artifacts on disk and stop server when viewing ends. Remote upload requires explicit action.
- **[MEDIUM | Synthesis] One remote adapter:** support only Vercel preview deployments initially. Its APIs cover non-Git file deployment, platform authentication, expiring and revocable share links, and deployment deletion.
- **[MEDIUM | Synthesis] Two trust modes:**
  1. `safe`: sanitize HTML, disable scripts.
  2. `interactive`: preserve scripts but place artifact in a response-sandboxed, network-denied iframe with an opaque origin.
- **[HIGH | Primary] Sanitization cannot preserve arbitrary JavaScript while also declaring that JavaScript safe.** Interactive artifacts therefore need containment, not script sanitization. DOMPurify sanitizes HTML but warns against changing parsing context after sanitization: [DOMPurify](https://github.com/cure53/DOMPurify), [2026 re-contextualization advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-h8r8-wccr-v5f2).

### Local and self-hosted options

- **[HIGH | Primary] Bind only to IP-literal loopback addresses**, preferably an operating-system-assigned ephemeral port. RFC 8252 recommends `127.0.0.1` or `[::1]`, not `localhost`, and says listeners should remain open only as long as needed: [RFC 8252 sections 7.3 and 8.3](https://datatracker.ietf.org/doc/html/rfc8252).
- **[MEDIUM | Synthesis] Validate `Host` exactly** against the selected IP literal and port. Reject alternate hostnames, forwarded hosts, and unexpected ports. This reduces DNS-rebinding exposure.
- **[HIGH | Primary] CORS is not authentication.** Cross-origin pages can issue requests whose response they cannot read, including state-changing requests. The Local Network Access draft explicitly notes that CORS does not prevent these cross-site request forgery attacks: [Local Network Access](https://wicg.github.io/local-network-access/).
- **[MEDIUM | Synthesis] Reject cross-site browser requests** using all available signals:
  - Exact `Origin` for mutation/session endpoints.
  - Reject `Sec-Fetch-Site: cross-site`.
  - Require an application-specific non-safelisted header.
  - Accept no ambiently authenticated `GET` mutations.
  - Treat missing Fetch Metadata as unsupported-client input, not trusted input.
- **[HIGH | Primary] Fetch Metadata identifies request context**, including `cross-site`, `same-origin`, and user-initiated navigation: [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/).
- **[MEDIUM | Synthesis] Capability bootstrap:** open `http://127.0.0.1:<port>/#<high-entropy-token>`. Shell exchanges fragment token through a same-origin request, removes it with `history.replaceState`, and receives a short-lived `HttpOnly; SameSite=Strict` session cookie. Fragment avoids ordinary HTTP logs and `Referer` transmission.
- **[HIGH | Primary] Bearer capability possession grants access.** RFC 6750 recommends short lifetimes and explicitly advises against bearer tokens in page URLs because history and logs expose them: [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750).
- **[HIGH | Primary] Capability URLs have high browser-leakage risk** through history, logs, third-party scripts, referrers, plugins, and URL-sharing systems. They need expiry and revocation: [W3C Capability URLs draft](https://www.w3.org/TR/capability-urls/).
- **[MEDIUM | Synthesis] Self-hosted deployment:** package the same viewer behind an existing identity-aware reverse proxy or organization single sign-on. Do not add custom accounts, passwords, OAuth issuance, or internet-facing artifact storage in Phase 9.

### Hosted-provider evaluation

| Option | Finding | Decision |
|---|---|---|
| **Vercel preview** | **[HIGH | Primary]** Standard Protection with Vercel Authentication protects preview and generated deployment URLs on all plans. Production domains are a separate plan/scope question: [Deployment Protection](https://vercel.com/docs/deployment-protection), [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication). | **Selected adapter. Preview target only.** |
| **Cloudflare Pages** | **[HIGH | Primary]** Preview deployments are public by default unless Access is enabled. Access protects previews but not the project’s main `pages.dev` or custom domain: [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/). | No Pages adapter. Too easy to misconfigure public access. |
| **Cloudflare Workers + private R2** | **[HIGH | Primary]** Technically viable using application authorization, private objects, and immediate-visibility deletion: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), [Access cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/). | Reconsider only if Vercel fails validation. Requires more gateway and authorization code. |
| **Netlify** | **[HIGH | Primary]** Password and team-login protection exist, but relevant protection modes vary by plan: [Password Protection](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/). | No adapter. Plan semantics and shared-password mode add avoidable variance. |
| **GitHub secret Gists** | **[HIGH | Primary]** Secret means unlisted, not private. Anyone with URL can access it: [Creating gists](https://docs.github.com/en/get-started/writing-on-github/editing-and-sharing-content-with-gists/creating-gists). | Reject. |
| **GitHub Pages** | **[MEDIUM | Primary]** Private publication availability depends on organization and enterprise configuration rather than a broadly private default. | Reject for Phase 9. |

### Vercel adapter contract

- **[HIGH | Primary] Non-Git uploads are supported.** Files may be inline or referenced by SHA after using the deployment-file upload API: [Create deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment), [Upload deployment files](https://vercel.com/docs/rest-api/deployments/upload-deployment-files).
- **[MEDIUM | Synthesis] Use one dedicated Vercel project.** Do not connect it to a Git repository. Never upload a repository root.
- **[HIGH | Primary] Platform auth is API-configurable** through project `ssoProtection`; the documented Standard Protection value is `prod_deployment_urls_and_all_previews`: [Vercel Authentication API configuration](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication#how-to-manage-vercel-authentication-with-the-api).
- **[MEDIUM | Synthesis] Adapter must fail closed before upload:**
  1. Fetch project configuration.
  2. Assert Vercel Authentication protects previews/generated URLs.
  3. Refuse production target or production aliases.
  4. Upload only a prepared artifact bundle.
  5. Verify anonymous access is denied before returning URL.
- **[HIGH | Primary] Identity access is private by default** to members and explicitly granted Vercel users. Hobby permits only one external user: [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).
- **[HIGH | Primary] Optional share links are bearer query URLs.** They are available on all plans and revocable: [Shareable Links](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links).
- **[HIGH | Primary] Share-link API supports required TTL and revocation.** Omitting `ttl` creates a non-expiring link, so adapter must reject missing TTL: [Update protection bypass](https://vercel.com/docs/rest-api/aliases/update-the-protection-bypass-for-a-url).
- **[MEDIUM | Synthesis] Do not create a share link during normal publication.** Default URL remains identity-gated. External bearer sharing requires a distinct command and explicit expiry.
- **[HIGH | Primary] Deployment deletion has a supported API:** [Delete deployment](https://vercel.com/docs/rest-api/deployments/delete-a-deployment).
- **[HIGH | Primary] Deletion is not guaranteed physical erasure.** Retention deletion has a 30-day recovery period for successful deployments, and default retention differs by plan: [Deployment Retention](https://vercel.com/docs/deployment-retention).
- **[MEDIUM | Synthesis] Define lifecycle terms precisely:**
  - **Expiry:** authorization stops.
  - **Revocation:** share capability or user grant stops.
  - **Deletion:** deployment URL stops serving.
  - **Erasure:** provider confirms physical removal. Not promised by adapter.
- **[MEDIUM | Synthesis] Keep a local deployment registry** containing deployment ID, URL, share-link ID/secret, creation time, and expiry. No artifact content or provider token. Cleanup retries revoke and delete expired deployments.
- **[HIGH | Primary] Documented Vercel static-upload limits** include 100 MB on Hobby, 1 GB on Pro, 15,000 source files, and 100 Hobby deployments per day: [Vercel limits](https://vercel.com/docs/limits).
- **[MEDIUM | Synthesis] Impose lower Phase 9 limits:** 25 MiB total, 1,000 files, 10 MiB per file, bounded decompression ratio, and no nested archives. Provider ceilings are not safe application defaults.

### Artifact staging and secret leakage prevention

- **[MEDIUM | Synthesis] Build an isolated staging bundle** containing only:
  - generated viewer shell,
  - selected artifact,
  - explicitly referenced local assets,
  - adapter-owned security configuration.
- **[MEDIUM | Synthesis] Reject symlinks, junctions, path traversal, absolute paths, device files, hidden credential files, and assets outside staging root.**
- **[MEDIUM | Synthesis] Require a manifest** listing every uploaded path, byte size, hash, MIME type, and aggregate size. Show this manifest before remote publication.
- **[HIGH | Primary] Secret scanners detect likely secrets but do not prove absence.** Gitleaks describes itself as a detector using rules and entropy over files or standard input: [Gitleaks](https://github.com/gitleaks/gitleaks). Secretlint provides a current extensible alternative: [Secretlint](https://github.com/secretlint/secretlint).
- **[MEDIUM | Synthesis] Run at least two local checks before upload:**
  1. Secretlint or Gitleaks over the staging bundle, including ignored and hidden files.
  2. Structural denylist for private keys, `.env*`, credential files, cloud configs, database dumps, source maps, `.git`, and package-manager auth files.
- **[MEDIUM | Synthesis] Scanner output must redact matched values.** Logs should record rule ID and file path only.
- **[MEDIUM | Synthesis] A scanner pass is necessary but insufficient.** Require explicit confirmation of bundle manifest and destination. Never offer “upload current repository” as an adapter operation.
- **[MEDIUM | Synthesis] Provider credentials belong in operating-system credential storage or environment injection.** Never place them in artifact HTML, generated config, query strings, logs, or the deployment itself.

### Browser isolation

- **[HIGH | Primary] `iframe sandbox` is broadly supported.** Omitting `allow-same-origin` gives content a special origin; `allow-scripts` permits scripts without granting normal origin privileges: [`iframe` sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox).
- **[HIGH | Primary] Combining `allow-scripts` and `allow-same-origin` is strongly discouraged** for same-origin content because the artifact may remove its sandbox: [`iframe` warning](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox).
- **[MEDIUM | Synthesis] Interactive iframe attribute:** `sandbox="allow-scripts"`. Do not grant forms, popups, downloads, top navigation, pointer lock, storage access, or same-origin.
- **[MEDIUM | Synthesis] Apply equivalent CSP `sandbox allow-scripts` as a response header** on the artifact document. This retains sandboxing when artifact URL is opened directly.
- **[MEDIUM | Synthesis] Recommended artifact CSP:**

```http
Content-Security-Policy:
  default-src 'none';
  sandbox allow-scripts;
  script-src 'unsafe-inline' blob:;
  style-src 'unsafe-inline';
  img-src data: blob:;
  font-src data:;
  media-src data: blob:;
  connect-src 'none';
  object-src 'none';
  frame-src 'none';
  child-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'self'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

- **[MEDIUM | Synthesis] Inline script is allowed only inside the opaque, network-denied artifact context.** Viewer shell should use nonce- or hash-based scripts and no `unsafe-inline`.
- **[MEDIUM | Synthesis] Default interactive mode is self-contained.** Network access, modules requiring cross-origin loading, workers, popups, and external fonts are unsupported unless a later threat review introduces narrower profiles.
- **[HIGH | Primary] `srcdoc` is an injection sink.** Unsandboxed content may gain parent-origin access; Trusted Types can enforce transformed input: [`HTMLIFrameElement.srcdoc`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc).
- **[MEDIUM | Synthesis] Prefer a dedicated artifact response over `srcdoc`.** Response headers can then enforce CSP and sandboxing independently of artifact markup.
- **[HIGH | Primary] Trusted Types controls HTML and script injection sinks but supplies no sanitizer itself:** [Trusted Types API](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API).
- **[MEDIUM | Synthesis] Enforce Trusted Types on the viewer shell** with named policies. Treat it as defense in depth, not artifact containment.

### Sanitization choices

| Input | Recommendation | Confidence |
|---|---|---|
| Untrusted HTML without required scripts | DOMPurify with HTML-only, restrictive configuration and current patched version | **[HIGH | Primary]** [DOMPurify](https://github.com/cure53/DOMPurify) |
| Markdown in an existing unified pipeline | `rehype-sanitize` after the last unsafe transform | **[HIGH | Primary]** [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize) |
| Markdown via Marked | Sanitize Marked output separately | **[HIGH | Primary]** Marked explicitly does not sanitize: [Marked](https://github.com/markedjs/marked) |
| Arbitrary interactive HTML | Do not strip required scripts and claim it remains interactive. Use sandbox/CSP isolation | **[MEDIUM | Synthesis]** |
| Native Sanitizer API | Progressive enhancement only | **[HIGH | Primary]** Safari remains unsupported and API is not Baseline: [HTML Sanitizer API](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API) |

- **[HIGH | Primary] DOMPurify remains actively maintained**, but it has had sanitizer bypass advisories. Pin and patch promptly: [2026 advisory, fixed in 3.3.2](https://github.com/cure53/DOMPurify/security/advisories/GHSA-h8r8-wccr-v5f2), [2024 advisory, fixed in 2.5.4 and 3.1.3](https://github.com/cure53/DOMPurify/security/advisories/GHSA-mmhx-hmjr-r674).
- **[HIGH | Primary] DOMPurify warns that post-sanitization markup changes can void sanitization.** Sanitize once, immediately before final sink, without concatenating wrappers or re-parsing in a different context: [DOMPurify foot-gun guidance](https://github.com/cure53/DOMPurify#is-there-any-foot-gun-potential).
- **[MEDIUM | Synthesis] Use HTML-only profile**, forbid styles if unnecessary, disallow unknown protocols, avoid custom hooks, and prefix named properties to reduce DOM clobbering.
- **[MEDIUM | Synthesis] Sanitation and sandboxing are complementary:** sanitization reduces dangerous markup; sandbox/CSP limits impact if parser behavior or sanitizer configuration fails.

## Contradictions and hidden variables

- **[HIGH | Primary] “Preview URL” does not imply private.** Cloudflare preview URLs are public by default; Vercel preview URLs can be protected under Standard Protection. Split by provider and project configuration.
- **[HIGH | Primary] “Expired” does not imply deleted.** Vercel share-link TTL denies authorization, deletion disables serving, and retained deployment resources may remain recoverable. Split by authorization state, URL availability, and physical storage.
- **[MEDIUM | Synthesis] “Sanitized” and “interactive” conflict when interaction requires arbitrary scripts.** Split into safe static and isolated interactive modes.
- **[HIGH | Primary] Capability links are convenient but transferable.** Identity authentication supports targeted revocation; bearer links support frictionless forwarding. Split by sharing audience and risk tolerance.
- **[HIGH | Primary] Trusted Types are supported in current browsers but older clients remain.** Split enforcement claims by browser version: [Trusted Types compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API#browser_compatibility).
- **[HIGH | Primary] Native HTML Sanitizer support is narrower than Trusted Types support.** Do not substitute one support matrix for the other: [HTML Sanitizer compatibility](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API#browser_compatibility).
- **[MEDIUM | Synthesis] Provider size limit is not application safety limit.** Split by plan, upload mechanism, compressed versus expanded size, file count, and artifact runtime needs.
- **[MEDIUM | Synthesis] Self-hosted does not automatically mean private.** Privacy depends on bind address, reverse proxy, authentication policy, logging, and storage lifecycle.

## Survivorship-bias sweep

- **[HIGH | Primary] Google Caja is abandoned.** Archived in 2021 with an explicit warning that security vulnerabilities would no longer be patched: [Caja deprecation](https://github.com/googlearchive/caja#deprecation).
- **[HIGH | Primary] Old `sanitize-html` repository was archived in 2026**, but package work moved to the Apostrophe monorepo. Repository archival alone is not package abandonment: [archived repository and successor](https://github.com/apostrophecms/sanitize-html).
- **[MEDIUM | Primary] `rehype-sanitize` standalone repository shows no release since 2023.** It has no deprecation notice, so evidence supports maintenance scrutiny, not a definite abandonment finding: [repository](https://github.com/rehypejs/rehype-sanitize).
- **[HIGH | Primary] Gitleaks is now feature-complete and security-patch-only**, with maintainer focus moving to Betterleaks: [Gitleaks notice](https://github.com/gitleaks/gitleaks). Existing use remains viable, but new integration should compare Secretlint and Betterleaks.
- **[HIGH | Primary] Secretlint remains actively maintained:** [Secretlint](https://github.com/secretlint/secretlint).
- **[HIGH | Primary] Native Sanitizer API is still evolving and lacks Safari support.** It cannot yet be the sole cross-browser sanitizer: [MDN compatibility](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API#browser_compatibility).
- **[HIGH | Primary] DOMPurify is active but requires rapid updates.** Recent bypass advisories demonstrate that “widely adopted” does not mean vulnerability-free.
- **[MEDIUM | Primary] No first-party evidence of wholesale abandonment found for Vercel, Cloudflare, or Netlify.** Current documentation and APIs remain actively updated. This does not eliminate commercial pricing or product-change risk.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Hosted identity authentication | Custom login, password store, session issuance, OAuth server | Vercel Authentication | **[HIGH | Primary]** Managed access, revocation, and API configuration |
| HTML sanitization | Regex or custom tag stripper | DOMPurify or `rehype-sanitize` | **[HIGH | Primary]** Browser parsing and mutation-XSS behavior are complex |
| Markdown safety | Assume parser output is safe | Sanitizer after Markdown conversion | **[HIGH | Primary]** Marked explicitly does not sanitize |
| Secret detection | Small custom regex list | Secretlint, Gitleaks, or validated successor | **[HIGH | Primary]** Maintained rule sets and entropy detection |
| Interactive-code isolation | JavaScript rewriting, Caja fork, home-grown membrane | Browser iframe sandbox, CSP, separate/opaque origin | **[HIGH | Primary]** Caja is deprecated; browser controls are maintained |
| Capability security | Sequential IDs or permanent query tokens | Cryptographic random capabilities with expiry and revocation | **[HIGH | Primary]** Capability URLs are bearer credentials |
| Remote storage gateway | Custom Phase 9 auth/object gateway | Vercel protected previews | **[MEDIUM | Synthesis]** Smaller implementation and audit surface |
| TLS for internet sharing | Embedded certificate management | Hosted provider or existing reverse proxy | **[MEDIUM | Synthesis]** Avoid certificate issuance and renewal logic |

## Validation queue

- [ ] **[LOW]** Create a disposable Vercel project, configure `ssoProtection` by API, and prove anonymous access is denied before any real artifact upload.
- [ ] **[LOW]** Verify non-Git upload API limits independently of CLI-documented 100 MB/1 GB limits.
- [ ] **[LOW]** Confirm security headers can be assigned distinctly to shell and artifact routes in a static Vercel deployment.
- [ ] **[LOW]** Test share-link TTL, explicit revocation, cookie behavior, and propagation delay using disposable content.
- [ ] **[LOW]** Test deletion response, URL behavior, restoration window, and retention metadata. Document that deletion is not secure erasure.
- [ ] **[LOW]** Confirm least-privilege Vercel token scopes and operating-system credential-store integration.
- [ ] **[LOW]** Run malicious-artifact browser tests: parent DOM access, cookie/storage access, fetch, image beacon, WebSocket, form submission, popup, download, top navigation, worker, service worker, and direct artifact navigation.
- [ ] **[LOW]** Test loopback attacks: DNS rebinding, malicious `Host`, cross-site form POST, fetch with and without CORS, iframe navigation, port scanning, stale capability reuse, and IPv4/IPv6 binding.
- [ ] **[LOW]** Verify capability fragment removal from browser history and absence from logs, crash reports, telemetry, and clipboard diagnostics.
- [ ] **[LOW]** Build a secret-scanner corpus containing real-format fake credentials, high-entropy false positives, hidden files, ignored files, encoded secrets, archives, and source maps.
- [ ] **[LOW]** Re-evaluate DOMPurify, Secretlint, `rehype-sanitize`, and native Sanitizer advisories immediately before dependency selection.
- [ ] **[LOW]** Confirm representative interactive artifacts work under the proposed no-network CSP. Add narrower named profiles only for demonstrated needs.
- [ ] **[LOW]** Review provider terms, data residency, subprocessors, backup retention, and deletion commitments before enabling remote sharing for sensitive artifacts.

## Summary

- **Objective:** Research secure Phase 9 artifact sharing.
- **Completed:** Evaluated local, self-hosted, hosted, authentication, lifecycle, limits, leakage, browser isolation, sanitizers, APIs, and abandonment signals.
- **Key Decisions:** Local-first viewer; safe and interactive modes; Vercel preview as sole candidate remote adapter.
- **Status:** Research complete. No repository access or uploads.
- **Next Steps:** Execute disposable-provider and hostile-browser validation queue before implementation.