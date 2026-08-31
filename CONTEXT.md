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

**External Integration Control**:
Host-owned policy that classifies an external operation, validates its destination, decides whether direct user approval is required, and redacts sensitive data before any model-facing or persisted result.
_Avoid_: Adapter permission, sandbox

**Credential Reference**:
Opaque identifier for a secret held by an operating-system or dedicated credential store; never the secret value itself.
_Avoid_: Token config, credential string

**Tool Federation**:
Project-bound discovery, activation, and invocation of namespaced MCP tools whose schemas load only when selected and whose server content remains untrusted data.
_Avoid_: MCP proxy, remote tool registry

**Federated Tool**:
One namespaced MCP operation with source provenance, validated input schema, side-effect classification, and activation state.
_Avoid_: Dynamic tool, remote function

**Browser Session**:
Lifecycle-owned browser connection bound to a dedicated profile and a set of owned pages, isolated from unrelated user and Impeccable browser activity.
_Avoid_: Browser daemon, Chrome instance

**Browser Observation**:
Bounded, read-only evidence from an owned page, such as an accessibility snapshot, screenshot, console entry, page error, or network record.
_Avoid_: Browser result, scrape

**Browser Action**:
One classified operation against an owned page. Navigation and interaction remain distinct from protected submissions, uploads, downloads, purchases, and authenticated remote writes.
_Avoid_: Click command, browser mutation

**Origin Policy**:
Canonical allow/deny decision for a browser or MCP network destination after URL normalization, DNS/IP safety checks, redirect handling, and project/user allowlist evaluation.
_Avoid_: URL filter, CORS policy

**Session Incarnation**:
One live process attachment for a Pi session, derived from host-provided session identity plus process-held proof. A resumed session retains its logical identity but receives a new incarnation.
_Avoid_: Agent identity, sender token

**Session Presence**:
Expiring host-stamped discovery data for one Session Incarnation, including name, cwd, Project Identity, Execution Role, status, visibility, capabilities, and heartbeat time.
_Avoid_: Agent record, process row

**Mailbox Message**:
Durable ordered cross-session envelope whose sender provenance is host-stamped and whose summary, body, delivery options, names, and capabilities remain untrusted data.
_Avoid_: Prompt, user message, queue row

**Delivery Receipt**:
Durable evidence that one Mailbox Message became visible in its recipient Pi transcript. It does not imply model obedience, trust, or user approval.
_Avoid_: Acceptance, acknowledgement of authority

**Memory**:
Versioned, explicitly stored, scoped, source-cited untrusted knowledge that may inform a model but cannot grant authority or become a system instruction.
_Avoid_: Learned fact, memory instruction

**Memory Scope**:
Host-resolved user, Project Identity, or explicit Guarded Workspace locality used for Memory storage and retrieval isolation.
_Avoid_: Namespace string, cwd prefix

**Memory Citation**:
Bounded provenance describing where Memory content came from. Supports inspection without making the content true or authoritative.
_Avoid_: Proof, approval

**Contradiction Link**:
Symmetric relationship between active Memories making incompatible claims in one Memory Scope. Neither side wins automatically.
_Avoid_: Replacement, supersession

**Trigger Event**:
Host-stamped, bounded event with source provenance and causal ancestry admitted to the shared automation runtime. Its payload is data, never authority.
_Avoid_: Callback, signal, trusted event

**Trigger Binding**:
Revisioned owner configuration that selects Trigger Events and defines bounded delivery to one host-owned consumer.
_Avoid_: Listener, arbitrary callback, rule

**Reactive Monitor**:
Revisioned state machine that observes one terminal, filesystem, poll, or WebSocket source and delivers bounded untrusted batches without owning the underlying process.
_Avoid_: Watcher, background process, alert script

**Schedule**:
Revisioned one-shot, interval, or cron definition bound by the host to Project Identity, scheduled Execution Role, Agent Profile, result route, and missed-run policy.
_Avoid_: Timer, cron job, prompt alarm

**Schedule Occurrence**:
One deterministic due instance of a Schedule with a transactional claim, fencing token, execution outcome, and idempotent delivery identity.
_Avoid_: Run, callback, exactly-once job

**Goal**:
Durable, revisioned objective and success criteria executed through a bounded declarative task graph under direct user control.
_Avoid_: Workflow, prompt, autonomous loop

**Goal Node**:
One declarative unit of Agent work whose dependencies, pinned Agent Profile, policies, budget reservation, and evidence requirements are part of the Goal revision.
_Avoid_: Workflow step, callback, job

**Goal Attempt**:
One fenced execution claim for a Goal Node, including its resource reservation, execution certainty, workspace identity, outcome, and evidence.
_Avoid_: Retry, child session, run

**Goal Evidence**:
Revision-bound reference showing how a Goal or Goal Node criterion was checked, with explicit kind, trust, provenance, and optional Artifact.
_Avoid_: Worker output, completion claim, assertion

**Unknown Attempt**:
Goal Attempt whose external execution may have occurred but whose durable outcome cannot be proven. It blocks automatic replay until direct user resolution.
_Avoid_: Failed Attempt, stale lease, retryable error

**Artifact Publication**:
Revisioned record that one exact Artifact representation is available through a local or remote viewer under explicit access and expiry terms.
_Avoid_: Upload, deployment, share

**Sensitivity**:
Bounded classification of disclosure risk found in exact Artifact publication bytes. It informs or blocks publication without retaining matched secret values.
_Avoid_: Safety score, trust level

**Retention**:
Declared period during which an Artifact body or provider copy may remain stored. It does not imply that access remains available for the whole period.
_Avoid_: Expiry, lifetime

**Revocation**:
Authoritative transition that stops an Artifact Publication from granting access. It is distinct from provider deletion and physical erasure.
_Avoid_: Delete, expire, unshare

**Capability Token**:
High-entropy bearer secret granting narrowly scoped, time-bounded access to one Artifact Publication. Possession grants the capability; identity is not implied.
_Avoid_: Share ID, password, session token
