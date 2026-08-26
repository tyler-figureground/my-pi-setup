# Phase 4 architecture: language intelligence and local review

## Interfaces

### `LanguageIntelligence`

One project-bound module exposes three methods:

- `discover()` returns bounded available routes/capabilities without starting a server.
- `synchronize(updates, signal?)` owns open/change/close document versions.
- `query(request, signal?)` returns normalized advisory diagnostics or navigation results.

Protocol methods, URIs, numeric enum values, document versions, call-hierarchy preparation, process generations, restart state, and artifact spill remain implementation details.

A lifecycle resource represents one restartable server slot keyed by server ID plus canonical current-worktree root. Acquiring the slot starts no process. First relevant synchronization/query starts one generation. A crash may create a bounded replacement generation and reopen current snapshots. Session lifecycle owns final close.

The real adapter uses Microsoft `vscode-jsonrpc` and `vscode-languageserver-protocol`. Fixture adapters test behavior through `LanguageIntelligence`.

### `LocalReview`

One project-bound module exposes:

```text
run(target, options) -> Outcome<ReviewReport, LocalReviewError>
```

A successful report has conclusion `findings` or `no-findings`; review failure is an error outcome. The module owns target resolution/capture, evidence collection, reviewer execution, candidate validation, deterministic deduplication, source-mutation checks, and artifact persistence.

A lazy reviewer seam is bound by the subagent extension. Platform review policy supplies a host-owned `review` role, zero mutation/process/network tools, bounded prompt/output, and Pi backend. Profile defaults may narrow model/limits but cannot widen authority.

No model-facing review tool is initially needed. `/review` is the first-class user interface.

## Shared invariants

- Project paths resolve through canonical `ProjectIdentity`; linked worktrees never share process/document state.
- Untrusted project configuration never chooses executable code, reviewer instructions, or test commands.
- Commands use fixed argv without a shell; Git disables hooks, external diff/textconv, fsmonitor, lazy fetch, and interactive prompting.
- Caller-supplied limits may only lower platform hard ceilings.
- Full outputs persist as immutable `Artifact`s; model/TUI results remain bounded.
- Cancellation reaches process, protocol request, reviewer, and persistence checkpoints.
- Reload/session switch rejects new work before lifecycle shutdown.

## Language invariants

- Zero language-server processes before first relevant query.
- Concurrent first queries start one generation; later queries reuse it.
- Per-server document versions strictly increase. `didChange` never precedes `didOpen`; `didClose` occurs at most once per generation.
- Restart reopens current snapshots before retry. Stale publications from prior generations are ignored.
- Unsupported operations return a capability error, never empty success.
- Returned locations are deterministic, deduplicated, bounded, and project-relative when contained. External locations remain explicit.
- Every result says `advisory: true`; empty diagnostics never mean project verification passed.

Initial hard ceilings: four servers/session, two servers/query, 32 diagnostic files, 64 open documents/server, 2 MiB/file, 200 result items, 50 KiB model-facing response, 64 KiB stderr tail, 15 s startup, 20 s request, three crashes/60 s.

## Review target semantics

- `uncommitted`: exact HEAD plus staged, unstaged, deleted, renamed, and untracked state captured at run start.
- `base`: freshly fetched remote base versus current HEAD using merge base. Fetch failure fails unless explicit stale continuation is allowed and recorded.
- `commit`: exact commit versus first parent; root commit versus Git empty tree.
- `range`: separately resolved `from` and `to` object IDs with direct or merge-base comparison.

Raw revision expressions never enter a shell. Captured object IDs and content hashes, not moving ref names, define a Review Target.

## Finding validation

Host validation precedes reporting:

1. Strict bounded schema.
2. Canonical project-relative path.
3. Path and selected base/index/worktree/target line exists in its distinct captured coordinate space.
4. Range is ordered and intersects reviewed diff.
5. Evidence references resolve inside captured evidence.
6. Finding ID derives from normalized content.

Candidates overlapping in file/category/side/range and normalized failure scenario merge deterministically. Highest severity/confidence wins; evidence unions and final order is stable. All-invalid candidates are failure, not no findings.

## Read-only guarantee

Reviewer receives only bounded captured diff/file/evidence content in its prompt and no tools capable of project access or mutation. Optional tests run only in a separately materialized disposable snapshot, never link parent dependencies, and require direct `--tests` authority. HEAD/index/content fingerprints are compared before review and after external artifact persistence. Any change returns `source_changed_during_review` even when caused concurrently rather than by reviewer.

Once target capture succeeds, outcomes persist a bounded artifact. Successful content uses neutral `result` artifact status until the post-persistence fingerprint passes; failure artifacts remain explicit. Full raw candidates and evidence stay outside main context.

## Composition

Phase 4 adds two available flags:

- `languageIntelligence`
- `review`

Parent sessions only may own these modules. Platform composition creates shared project identity, lifecycle, state, and artifact adapters once. Language tools activate additively after explicit discovery. `/review` uses standard select/input/notify paths in TUI/RPC and requires explicit target syntax in print/JSON mode.
