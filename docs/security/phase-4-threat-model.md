# Phase 4 threat model

## Assets

- Source, index, worktree, and Git refs
- Parent environment and credentials
- Language-server process tree
- Reviewer model instructions and output
- Review/LSP artifacts
- Model and terminal context budgets

## Trust boundaries

- Project files, diffs, names, comments, and attributes are untrusted data.
- Project `platform.json` can select servers only after explicit project trust.
- Language servers and test scripts execute with user privileges. They are not OS sandboxes.
- Reviewer output is untrusted until host schema, path, line, diff, and evidence validation passes.
- Remote Git configuration is untrusted even in a trusted project.

## Controls

### Language intelligence

- Minimal inherited environment allowlist. Parent secrets are not copied.
- Configured environment values may reach the configured server but never returned through stderr.
- Stderr is bounded and omitted from model-facing errors.
- Microsoft JSON-RPC implementation behind bounded header, frame, and aggregate traffic stream.
- Four servers/session, two/query, bounded files/documents/items/bytes/deadlines.
- Canonical realpath containment before open/query and before mapping returned URIs.
- Server slots key canonical current worktree, not shared project ID.
- Version/generation diagnostic cache invalidation rejects stale publications.
- Crash circuit, one transparent retry, additive lazy tools, and lifecycle shutdown.
- Windows shutdown enumerates and terminates detached descendants, then terminates direct child.
- Language results always state `advisory` and `repository-native-checks` authority.

Residual risk: trusted language servers can execute project plugins or arbitrary code. Configure only maintained servers. Disable `languageIntelligence` for hostile repositories.

### Local review

- Uncommitted capture reads HEAD/index/worktree bytes directly. It does not invoke clean filters.
- Git argv disables hooks, fsmonitor, external diff, textconv, external protocol, credential helpers, and prompts.
- Base fetch reads remote URL then fetches direct HTTPS/HTTP/file/local URL with explicit refspec. Repository `uploadpack` is ignored. SSH and custom protocols are rejected.
- Revisions resolve to exact commit IDs before capture.
- HEAD, index, and worktree layers remain distinct in manifest and diff.
- Symlink/junction targets outside project fail closed.
- Immutable captured text feeds reviewer and LSP evidence. Evidence never rereads mutable historical target content.
- Host reviewer receives no tools, project resources, or project context files.
- Prompt labels every source/evidence section untrusted.
- Finding paths, line ranges, changed ranges, schema, text bounds, and evidence IDs validate before publication.
- Full artifact persists outside source tree. Final source/index fingerprint occurs after persistence.
- Post-capture failures and cancellation return `Outcome` failures and preserve an artifact when storage remains available.
- Optional tests require direct user `--tests`, run in a disposable archive, inherit a minimal environment, and never link parent dependencies. Test code still has user-level process/network authority.
- TUI text strips control sequences and caps findings. Print/JSON review is explicitly rejected.

Residual risk: a trusted test script can affect systems outside its disposable working directory. `--tests` is explicit because this is not OS containment.

## Adversarial evidence

Regression fixtures cover:

- Parent and configured secret stderr canaries
- 100 MiB announced JSON-RPC frame
- Detached Windows descendants
- Junction path escape
- Stale diagnostic generation
- Git clean filter and remote upload-pack command injection
- Staged/index/worktree divergence
- Untracked and deleted files
- Project `AGENTS.md` reviewer injection
- Historical immutable LSP evidence
- Source mutation during reviewer and artifact persistence
- False file, line, and evidence references
- Parent dependency sentinel survival after disposable tests
