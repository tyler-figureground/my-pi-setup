# Phase 3 threat model

## Authorities

- Direct user/project trust decision authorizes project profile loading.
- `ProfileCatalog` assigns source provenance and immutable policy.
- `WorkspaceManager` owns every managed path, Git mutation, state transition, and lease fence.
- Backend adapters may only narrow canonical policy. Unsupported enforcement fails spawn.
- Agent/model text is never profile, lease, trust, review, integration, or abandonment authority.

## Threats and controls

| Threat | Control |
|---|---|
| Untrusted project profile | Project directory never read without host trust |
| YAML alias/depth/size abuse | 64KB source cap, aliases disabled, node/depth/profile/material caps |
| Profile traversal or junction escape | regular-file identity checks, canonical containment, no linked sources/material |
| Collision or partial profile | same-scope names all rejected; immutable generation publication |
| Agent weakens isolation | profile backend/workspace/tool/role policy cannot be overridden |
| Backend silently ignores restriction | explicit compiler; unknown Claude tools and all unsupported Codex restrictions fail |
| Child writes protected main | separate worktree cwd, Pi shell denial, Pi write/edit containment, Claude fail-closed sandbox, Codex workspace-write |
| Alternate repository inherits trust | ad hoc resolver checks persisted trust; isolated manager is project-bound |
| Concurrent workspace mutation | fenced agent lease plus Git-operation lease and record versions |
| Stale process resumes | owner/fence/expiry/path/common-Git-dir revalidation; stale fence rejected |
| Git option/config injection | fixed argv, bounded revisions/remotes, no shell-built Git command, terminal prompts disabled |
| Dirty data deleted implicitly | cleanup refused without explicit disposition and acknowledgement |
| Junction target deletion | bounded non-following traversal, detach link itself, compare target identity before/after, no recursive deletion |
| Git reports false cleanup success | require absent worktree registration and absent lexical path |
| Crash between persistence and Git | creating/integration intent events and recovery report; partial state remains blocked |
| Secret copied into worktree | bounded `.worktreeinclude`, link/escape refusal, secret-name warnings |
| Result leaks managed root | guarded-workspace paths remapped to source project root before delivery |

## Residual limits

- Claude sandbox availability depends on installed Claude Code runtime. Isolated profile startup fails when sandbox cannot start.
- Codex app-server currently has no exact built-in tool allow/deny representation. Such profiles fail instead of weakening policy.
- Git and filesystem behavior varies by Windows/Git version. Native junction fixtures and postconditions remain release gates.
- Explicit fast-forward integration mutates the protected checkout only after clean-status, branch, and expected-commit compare-and-swap checks.
- `.worktreeinclude` warnings do not classify file contents; users remain responsible for listed secrets.
