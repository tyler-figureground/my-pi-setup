# Pi Capability Platform

Shared language for capabilities composed into Tyler's Pi environment.

## Language

**Execution Role**:
Host-assigned identity describing why a Pi session is running and which platform responsibilities it may own.
_Avoid_: Agent type, child type

**Parent**:
Interactive or top-level Pi session allowed to own platform-wide background resources.
_Avoid_: Main agent, root agent

**Project Identity**:
Stable identity shared by a Git repository's main checkout and linked worktrees, or scoped to one canonical directory outside Git.
_Avoid_: Working directory ID, repository path

**Artifact**:
Immutable, content-addressed large body kept outside session and state metadata.
_Avoid_: Attachment, blob record

**State Record**:
Small versioned metadata value used for durable platform coordination.
_Avoid_: Artifact, database row

**Lease**:
Time-bounded exclusive claim carrying a fencing token that rejects stale owners.
_Avoid_: Lock

**Lazy Rule**:
Trusted Markdown guidance whose bounded metadata is indexed at startup and whose body enters model context only after a matching project-relative path is observed.
_Avoid_: Always-on instruction, prompt include

**Context Epoch**:
Caller-assigned scope in which one Lazy Rule may be injected at most once. A new prompt, reload, or branch restoration may begin a new epoch.
_Avoid_: Turn ID

**Plan Mode**:
Host-enforced session state that preserves the exact prior tool set while `CapabilityPolicy` denies every side-effecting or unknown operation until direct user approval.
_Avoid_: Planning prompt, read-only suggestion

**Declarative Hook**:
Trusted, provenance-carrying event matcher and bounded action definition executed through `TriggerEngine` and still subordinate to `CapabilityPolicy`.
_Avoid_: Shell snippet, callback

**Agent Profile**:
Immutable, generation-stamped named resolution of backend defaults and host execution policy from managed, user, or trusted-project configuration.
_Avoid_: Agent preset, prompt template

**Guarded Workspace**:
Manager-created Git worktree with verified project identity, explicit base commit, durable state, and fenced ownership.
_Avoid_: Alternate cwd, temp clone

**Workspace Disposition**:
Explicit host decision to preserve, mark reviewed, integrate, or abandon a Guarded Workspace after revalidation.
_Avoid_: Cleanup flag, auto-delete

**Language Intelligence**:
Project-bound advisory diagnostics and semantic navigation from lazily activated, synchronized language servers. Repository-native verification remains authoritative.
_Avoid_: Compiler result, verification result, LSP wrapper

**Review Target**:
Immutable, exact source comparison captured for one Local Review: uncommitted state, base branch comparison, commit, or custom range.
_Avoid_: Live diff, branch name

**Local Review**:
Read-only evaluation of one Review Target that yields validated structured findings or an explicit no-findings conclusion, with full evidence persisted as an Artifact.
_Avoid_: Diff summary, workspace approval, review prompt

**Review Finding**:
Host-validated defect claim tied to a reviewed path and range, with severity, confidence, failure scenario, category, and evidence.
_Avoid_: Comment, suggestion, model output
