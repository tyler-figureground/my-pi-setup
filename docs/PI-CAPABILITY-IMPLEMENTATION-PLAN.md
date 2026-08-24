# Pi Capability Expansion Implementation Plan

Status: **Phase 0 complete**
Created: 2026-08-24
Last updated: 2026-08-24
Source decision file: `C:/Users/Tyler/pi-competitor-feature-checklist.md`
Continuity file: `.agent/handoff/pi-capabilities-program.md`

## Objective

Implement every capability marked `[X]` in the reviewed competitor-gap checklist without regressing current Pi tools, leaking secrets, weakening project trust, or making the live `~/.pi/agent` setup unrecoverable.

This document is both implementation plan and progress tracker. Update it in the same commit as completed work.

## Tracking rules

- `[ ]` means pending.
- `[x]` means complete and verified.
- Add `**IN PROGRESS**` to exactly one phase heading while implementation is active.
- Add `**BLOCKED: <reason>**` beside a task when it cannot proceed.
- Never check a task merely because code exists. Check it only after its acceptance evidence is recorded.
- At each phase exit, update:
  1. Overall capability matrix
  2. Phase checklist
  3. Verification ledger
  4. Decision log
  5. `.agent/handoff/pi-capabilities-program.md`
- Commit each phase independently. One capability may use several commits, but no commit should mix unrelated capability work.
- Before every implementation session, run `git fetch --all --prune`, then report branch state as ahead/behind counts.
- Before any push after a long phase, fetch again.

## Definition of done

A capability is done only when all applicable conditions hold:

- [ ] Interface and invariants documented
- [ ] Threat model completed for any filesystem, process, network, browser, OAuth, or multi-process behavior
- [ ] Unit tests cover behavior through the module's interface
- [ ] Integration tests cover real adapter behavior
- [ ] Windows-native behavior verified
- [ ] TUI behavior verified where applicable
- [ ] Print, JSON, and RPC behavior either supported or rejected clearly
- [ ] `/reload`, session switch, compaction, resume, and shutdown verified where applicable
- [ ] Cancellation and bounded cleanup verified
- [ ] Large output bounded and full output persisted outside model context
- [ ] Secrets absent from session JSONL, tool results, logs, artifacts, memory, and child prompts
- [ ] `npm run check` passes
- [ ] Deterministic test suite passes
- [ ] Formatting gate passes for the agreed scope
- [ ] Live Pi smoke test passes this session
- [ ] Setup and user documentation updated
- [ ] Rollback path tested

## Selected scope

The reviewed file contains 15 `[X]` selections.

| ID | Capability | Phase | Status |
|---|---|---:|---|
| F02 | Guarded worktrees and isolated agent workspaces | 3 | [ ] |
| F03 | Live browser control and visual verification | 5 | [ ] |
| F04 | LSP diagnostics and symbol navigation | 4 | [ ] |
| F05 | Read-only plan mode | 2 | [ ] |
| F06 | First-class local code review | 4 | [ ] |
| F07 | MCP client and OAuth | 5 | [ ] |
| F08 | Declarative lifecycle hooks | 2, 7 | [ ] |
| F09 | Persistent named custom-agent profiles | 3 | [ ] |
| F10 | Cross-session messaging and queue | 6 | [ ] |
| F11 | Persistent memory | 6 | [ ] |
| F13 | Persistent task graph and goal mode | 8 | [ ] |
| F14 | Path-scoped lazy project rules | 2 | [ ] |
| F15 | Reactive monitor | 7 | [ ] |
| F16 | Scheduled and recurring prompts | 7 | [ ] |
| F23 | Shareable interactive artifacts | 9 | [ ] |

## Explicitly excluded

These were not marked `[X]` and are outside this program:

- F01 OS-enforced sandbox and permission profiles
- F12 IDE bridge
- F17 desktop and phone notifications
- F18 Jupyter cell editing
- F19 doctor/config provenance/shell completion
- F20 session archive/delete, marked `[s]` rather than `[X]`
- F21 OpenTelemetry export
- F22 remote control/cloud handoff

**Security consequence:** Browser and MCP work will not have an OS sandbox supplied by this program. Their adapters must use strict capability policy, dedicated credentials/profiles, trust gates, allowlists, and explicit side-effect approval. Documentation must not describe these controls as OS containment.

## Current repository baseline

### Source state

- [x] Fetched `origin` before survey
- [x] Confirmed `main` is ahead 0 / behind 0 relative to `origin/main`
- [x] Recorded pre-existing dirty state

Pre-existing changes to preserve:

- Deleted: `AGENTS.md`
- Modified: `extensions/subagents/src/backends/codex.ts`
- Untracked: `skills/impeccable/`

No implementation phase may overwrite, reformat, stage, or discard these changes without first resolving ownership with Tyler.

### Runtime state

- Installed Pi CLI: `0.84.3`
- Repo Pi dependencies: `^0.82.0`
- Node: `v26.4.0`
- npm: `11.17.0`
- Platform: native Windows 11, Git Bash plus PowerShell 5.1
- Current tools already include subagents, workflows, background terminals, Firecrawl, structured questions, `fd`, and `rg`

### Verification baseline

| Check | Result on 2026-08-24 | Required action |
|---|---|---|
| `npm run check` | Pass | Keep green |
| `npm test` | Fail: 5 background-terminal tests | Fix in Phase 0 |
| Isolated background-terminal suite | Same 5 failures | Fix Windows command quoting/status behavior |
| `npm run format:check` | Fail: 98 files | Establish explicit formatting baseline in Phase 0 |
| Live TUI smoke | Not run | Add deterministic smoke harness before feature work |

Observed test failures:

- Successful Windows command reported failed
- Non-zero Windows command reported done
- Killed Windows command reported `exit 1` rather than signal/termination state
- Settled-entry pruning assertion failed
- Spill-file completion assertion inherited incorrect process status

Likely seam: tests generate POSIX single-quoted `node -e` commands while production invokes `cmd.exe` on Windows. Diagnose rather than patching assertions.

## Architectural direction

### Composition root

Implement new cross-cutting capabilities under one deterministic composition root:

```text
extensions/platform/
├── index.ts
├── package.json
├── platform.test.ts
└── src/
    ├── core/
    │   ├── lifecycle/
    │   ├── policy/
    │   ├── persistence/
    │   ├── projects/
    │   └── artifacts/
    ├── agents/
    ├── automation/
    ├── browser/
    ├── goals/
    ├── lsp/
    ├── mcp/
    ├── memory/
    ├── messaging/
    ├── review/
    ├── rules/
    └── workspaces/
```

One extension factory gives deterministic event ordering for policy, tool activation, lifecycle, and persistence. Internal modules remain deep, independently testable modules. This is not permission to create a monolithic `index.ts`.

Existing public tool names and commands remain compatible. Mature implementations can be moved behind platform interfaces incrementally, not rewritten in one pass.

### Deep modules and seams

| Module | External interface | Implementation hidden behind seam | Dependency category |
|---|---|---|---|
| `LifecycleSupervisor` | `acquire(resource)`, `shutdown(reason)` | Timers, watchers, sockets, servers, processes, deadlines, idempotent cleanup | In-process/local-substitutable |
| `CapabilityPolicy` | `decide(operation, actor, mode)` | Tool classification, plan restrictions, trust, side-effect gates, child roles | In-process |
| `ProjectIdentity` | `resolve(cwd)` | Repo root, common Git dir, worktree identity, canonical paths, symlink checks | Local-substitutable |
| `WorkspaceManager` | `create`, `lease`, `inspect`, `release`, `integrate` | Git worktree state machine, locks, dirty checks, Windows-safe cleanup | Local-substitutable |
| `AgentCatalog` | `list`, `resolve(name, context)` | Profile discovery, precedence, trust, validation, inheritance | Local-substitutable |
| `AgentSupervisor` | `spawn`, `send`, `cancel`, `observe` | Pi/Claude/Codex backends, workspace leases, result delivery, turn budgets | Local-substitutable/external adapters |
| `StateStore` | Transaction, append event, claim lease, query | Multi-process records, migrations, mailboxes, schedules, goals, profile metadata | Local-substitutable |
| `ArtifactStore` | `put`, `get`, `export`, `serve` | Content addressing, metadata, size caps, CSP, retention | Local-substitutable |
| `LanguageIntelligence` | `diagnostics`, `symbols`, `definition`, `references` | LSP processes, document sync, restart, path mapping | Local-substitutable |
| `TriggerEngine` | `register`, `start`, `stop` | Hooks, file events, debouncing, cron, missed runs, recursion limits | Local-substitutable |
| `ToolFederation` | `discover`, `activate`, `invoke` | MCP transports, schemas, OAuth, reconnect, namespacing | True external plus local adapters |
| `MemoryStore` | `remember`, `search`, `forget`, `inspect` | Scope, provenance, redaction, ranking, expiry, contradiction handling | Local-substitutable |
| `SessionBroker` | `register`, `send`, `claim`, `ack`, `observe` | Heartbeats, authenticated identity, durable ordered delivery | Local-substitutable/multi-process |
| `GoalEngine` | `submit`, `resume`, `cancel`, `observe` | Directed acyclic graph validation, scheduling, retries, checkpoints | In-process plus local adapters |
| `ArtifactPublisher` | `publish`, `revoke`, `status` | Local preview and chosen remote host | True external plus local adapter |

Design rules:

- [ ] Keep interfaces small. Complexity belongs behind each seam.
- [ ] Tests and callers cross the same interface.
- [ ] Inject dependencies; do not create external clients inside domain logic.
- [ ] Use plain-data interfaces across extension/package boundaries until one Effect installation is guaranteed.
- [ ] Do not expose internal Effect fibers, maps, database handles, browser pages, LSP clients, or MCP clients.
- [ ] Unknown tools default to side-effecting under plan mode.
- [ ] Retrieved memory and MCP/browser content remain untrusted data, never system instructions.

### Reuse from current code

- `extensions/subagents/src/backend.ts`: retain normalized backend seam
- `extensions/subagents/src/manager.ts`: deepen into `AgentSupervisor`
- `extensions/shared/child-session.ts`: retain trust-aware child resource loading and bounded shutdown
- `extensions/workflows/controller.ts`: reuse concurrency and cancellation concepts
- `extensions/workflows/artifacts.ts`: reuse checkpointing concepts
- `extensions/workflows/serialization.ts`: reuse atomic write and bounded serialization
- `extensions/workflows/sandbox.ts`: reuse restricted workflow execution, not as an OS sandbox
- `extensions/background-terminals/src/manager.ts`: retain process-tree ownership and read-model pattern after Windows repair
- `extensions/git-info/src/changed-files-view.ts`: reuse diff presentation
- `extensions/git-info/src/refresh-coordinator.ts`: reuse refresh coalescing concepts
- `extensions/ui-customization/index.ts`: remains sole header/footer owner; new modules use namespaced statuses/widgets

### Child execution roles

Every child session must receive an explicit role:

```text
parent | subagent | workflow | review | scheduled | goal-worker
```

Role controls loaded extensions, tools, policy, memory, hooks, browser/MCP access, schedules, and result delivery.

- [ ] Add role to child resource options
- [ ] Preserve current parent behavior
- [ ] Prevent schedulers, brokers, browser daemons, MCP servers, and monitors from recursively starting in children
- [ ] Exclude orchestration tools from children unless a role explicitly permits them
- [ ] Verify project trust separately for alternate working directories

## Dependency and package policy

Third-party packages execute with full user privileges. Every candidate follows this gate:

- [ ] Record package name, exact version, source commit, license, maintainer activity, install scripts, runtime dependencies, and known issues
- [ ] Inspect source before execution
- [ ] Trial with a disposable `PI_CODING_AGENT_DIR`
- [ ] Trial in a disposable Git repository
- [ ] Verify package commands exit cleanly
- [ ] Verify `/reload`, session replacement, print/JSON mode, and shutdown
- [ ] Verify no unexpected network calls or credential reads
- [ ] Decide: adopt pinned package, wrap package, port reviewed implementation, or build against standard library
- [ ] Record decision in `docs/decisions/`

Potential new dependencies require separate approval in Phase 1:

| Candidate | Purpose | Gate |
|---|---|---|
| Exact `effect` version | One shared runtime | Confirm dedupe and compatibility |
| `@modelcontextprotocol/sdk` | MCP transports/types/OAuth | Prefer official SDK |
| `playwright-core` or reviewed browser package | Browser control | No automatic browser download; dedicated profile |
| `vscode-jsonrpc` | LSP transport | Trial against fixture server |
| `vscode-languageserver-protocol` | LSP types | Keep protocol details internal |
| `chokidar` | Cross-platform watching | Compare Node watcher behavior first |
| `croner` | Cron/time-zone calculation | Fake-clock and DST tests required |
| SQLite adapter | Durable multi-process state | Spike `node:sqlite` vs `better-sqlite3`; Windows/Node support required |
| `yaml` | Declarative hooks/profiles/rules/goals | Safe schema validation; aliases bounded/disabled |
| `minimatch` | Path rules | Confirm Git-style semantics needed by project identity |

Pi packages belong in `peerDependencies: "*"` when packaging extensions. Runtime dependencies belong in `dependencies`.

## Phase dependency graph

```text
Phase 0 Baseline stabilization
  ↓
Phase 1 Platform foundation
  ↓
Phase 2 Policy, lazy rules, plan mode, hook core
  ↓
Phase 3 Profiles, workspaces, isolated agents
  ↓
Phase 4 LSP and local review
  ↓
Phase 5 MCP and browser adapters
  ↓
Phase 6 Messaging and memory
  ↓
Phase 7 Monitors, hooks completion, scheduler
  ↓
Phase 8 Goal/task graph
  ↓
Phase 9 Interactive artifacts and sharing
  ↓
Phase 10 Integrated hardening and release
```

Parallel work is allowed only inside a phase where files and seams do not overlap. One agent owns each file at a time.

---

# Phase 0 - Baseline stabilization **COMPLETE**

Goal: green, reproducible foundation before feature code.

## Repository safety

- [x] Resolve or explicitly preserve ownership of deleted `AGENTS.md`
- [x] Resolve or checkpoint user modification in `extensions/subagents/src/backends/codex.ts`
- [x] Resolve intended tracking status of `skills/impeccable/`
- [x] Create implementation branch from freshly fetched `origin/main`
- [x] Create short external worktree under `~/.worktrees/my-pi-setup/`
- [x] Do not junction shared `node_modules`; run `npm install` in worktree
- [x] Confirm live `~/.pi/agent` remains usable and untouched during development
- [x] Add this plan and continuity file to implementation branch

## Dependency alignment

- [x] Inventory every root and extension-local `package.json`/lockfile
- [x] Align `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` with installed Pi `0.84.3`
- [x] Pin one compatible Effect version
- [x] Prove `npm ls effect` has intended topology
- [x] Verify in-process Pi child sessions use same Pi library generation as parent extension code
- [x] Record minimum supported Node version
- [x] Add dependency-update procedure to `SETUP.md`

## Test repair

- [x] Make background-terminal test command generation platform-aware
- [x] Verify successful command exits `done` with code 0 on Windows
- [x] Verify non-zero command exits `failed` with exact code
- [x] Verify kill reports truthful Windows termination state
- [x] Repair pruning test without weakening behavior
- [x] Verify full spill file is flushed before settle notification
- [x] Separate deterministic tests from live Claude/Codex backend tests
- [x] Add `test:unit`, `test:integration`, `test:live`, `test:smoke`, and `verify` scripts
- [x] Ensure root test discovery includes every intended test file and excludes live tests by default
- [x] Add timeout and process-leak checks

## Formatting baseline

- [x] Diagnose why Prettier reports 98 files
- [x] Add `.gitattributes` line-ending policy appropriate for Windows/Git Bash
- [x] Normalize formatting in a dedicated no-semantic-change commit, after dirty-file ownership is resolved
- [x] Make `npm run format:check` green
- [x] Add changed-file formatting command for fast iteration

## Smoke harness

- [x] Add no-network extension-load smoke test
- [x] Add print-mode startup/shutdown smoke test
- [x] Add JSON/RPC startup/shutdown smoke test
- [x] Add TUI checklist for commands, tool visibility, status widgets, and `/reload`
- [x] Capture child process count before/after smoke to detect leaks

## Phase 0 exit gate

- [x] `npm run check` passes
- [x] `npm run test:unit` passes
- [x] `npm run test:integration` passes
- [x] `npm run format:check` passes
- [x] Smoke harness passes
- [x] Live Claude/Codex tests pass or have documented external blocker
- [x] Baseline evidence added to verification ledger

---

# Phase 1 - Platform foundation

Goal: create shared deep modules before capability-specific implementation.

## Composition root

- [ ] Create `extensions/platform/` package and minimal `index.ts`
- [ ] Register no user-facing tools until core lifecycle is verified
- [ ] Define feature flags, all defaulting off during migration
- [ ] Add startup diagnostics for invalid config without blocking unrelated features
- [ ] Ensure platform does not replace custom header/footer

## `LifecycleSupervisor`

- [ ] Define resource interface and bounded shutdown contract
- [ ] Support timers, watchers, sockets, child processes, and external client closers
- [ ] Make acquisition/shutdown idempotent
- [ ] Abort acquisition if session shuts down mid-start
- [ ] Close resources in deterministic reverse order
- [ ] Verify `/reload`, new/resume/fork, and process exit
- [ ] Add fake resources for deadline/error/race tests

## `ProjectIdentity`

- [ ] Resolve canonical cwd, repo root, main worktree, common Git dir, and current worktree
- [ ] Normalize Windows drive casing and separators
- [ ] Resolve symlink/junction identity without following unsafe deletion paths
- [ ] Represent non-Git projects explicitly
- [ ] Provide stable project ID shared by worktrees
- [ ] Add repositories, linked worktrees, symlinks, junctions, bare repos, and non-repo fixtures

## `CapabilityPolicy`

- [ ] Define operation vocabulary: read, local-write, process, network-read, remote-write, credential-use, orchestration, publish
- [ ] Define actor roles from child-role list
- [ ] Define decisions: allow, deny, require-user-confirmation
- [ ] Classify current built-in/custom tools
- [ ] Unknown tool defaults to side-effecting
- [ ] Preserve denial reason and provenance
- [ ] Ensure agent messages cannot grant approval
- [ ] Add in-memory policy adapter for tests

## `StateStore`

- [ ] Write storage decision ADR after SQLite feasibility spike
- [ ] Define schema versioning and migrations
- [ ] Implement transactions, event append, lease claim, query, and compaction
- [ ] Implement in-memory test adapter
- [ ] Implement production adapter with cross-process locking
- [ ] Store metadata only; large bodies go to `ArtifactStore`
- [ ] Use restrictive file permissions where supported
- [ ] Recover cleanly from interrupted writes and stale leases
- [ ] Add backup/export and corruption diagnostics

## `ArtifactStore`

- [ ] Define content-addressed `put/get/export` interface
- [ ] Persist metadata separately from bodies
- [ ] Enforce per-artifact and total storage limits
- [ ] Sanitize filenames and reject traversal
- [ ] Provide retention and garbage collection
- [ ] Keep artifact bodies out of model context by default
- [ ] Port reusable atomic/bounded serialization from workflows

## Child roles and compatibility

- [ ] Add explicit role to `createChildResources`
- [ ] Add role-aware extension/tool filtering
- [ ] Preserve existing subagent/workflow tool behavior
- [ ] Add compatibility tests for all existing tool names and schemas
- [ ] Prevent recursive platform daemons in child sessions

## Phase 1 exit gate

- [ ] Core modules pass interface-level tests
- [ ] Cross-process store tests pass on Windows
- [ ] Resource leak tests pass
- [ ] Existing extension suite remains green
- [ ] Platform feature flags off produces behavior identical to baseline
- [ ] ADRs and diagrams committed

---

# Phase 2 - Policy, lazy rules, plan mode, and declarative hook core

Features: F05, F08 foundation, F14.

## F14 path-scoped lazy rules

### Interface and discovery

- [ ] Define rule format and frontmatter schema
- [ ] Choose user and trusted-project locations
- [ ] Support include/exclude path patterns and priority
- [ ] Record source path and trust provenance
- [ ] Detect duplicate IDs and conflicting rules
- [ ] Reject malformed project rules without loading them

### Activation

- [ ] Index metadata only at startup
- [ ] Activate full rule content on relevant read/edit/search/LSP/browser/review path
- [ ] Inject each rule once per applicable context epoch
- [ ] Avoid unrelated rule content in prompt
- [ ] Handle renamed files and worktree-relative paths
- [ ] Handle symlinks/junctions through `ProjectIdentity`
- [ ] Expose `/rules` inspector with active/source/reason fields
- [ ] Support `/reload`

### Acceptance

- [ ] Relevant rule appears before model acts on matching file
- [ ] Unrelated rule remains absent
- [ ] More-specific precedence deterministic
- [ ] Untrusted project rules ignored
- [ ] Path traversal and symlink bypass tests pass
- [ ] Context-size comparison recorded

## F05 read-only plan mode

### State and interface

- [ ] Define `off`, `planning`, `approval-pending`, and `executing` states
- [ ] Persist state and exact pre-plan active tool set in session entries
- [ ] Add `/plan [prompt]`, `/plan status`, `/plan cancel`, and approval flow
- [ ] Add visible mode status/widget
- [ ] Store plan in configurable project/user plan location

### Enforcement

- [ ] Use `CapabilityPolicy` as host backstop
- [ ] Disable mutation-capable and unknown tools while planning
- [ ] Expose dedicated read-only Git/search/LSP operations
- [ ] Block write/edit and shell-mediated mutation
- [ ] Block mutating MCP/browser calls
- [ ] Block schedules, publishing, and agent work unless explicitly read-only
- [ ] Ensure dynamically activated tools are classified before use
- [ ] Restore exact prior tool set after approved exit
- [ ] Restore plan state correctly after resume/tree navigation

### Acceptance

- [ ] Every known mutation path has a denial test
- [ ] Reads remain usable
- [ ] Approval transition cannot be triggered by another agent/session message
- [ ] Aborted/failed plan leaves no source changes
- [ ] Resume and `/reload` retain state
- [ ] TUI clearly distinguishes plan from execution

## F08 declarative hooks, core

### Format and trust

- [ ] Trial `pi-yaml-hooks` in disposable profile
- [ ] Decide adopt/wrap/build and record ADR
- [ ] Define global and trusted-project config locations
- [ ] Parse YAML with bounded aliases/depth/size
- [ ] Validate event, matcher, action, timeout, and failure policy
- [ ] Record config provenance
- [ ] Add `/hooks`, `/hooks validate`, `/hooks reload`, and `/hooks logs`

### Trigger core

- [ ] Implement hook registration through `TriggerEngine`
- [ ] Support command, notify/status, context injection, and policy decision actions
- [ ] Define deterministic ordering
- [ ] Add recursion/reentrancy guard
- [ ] Add per-hook timeout and output cap
- [ ] Make fail-open/fail-closed explicit by event/action
- [ ] Never execute untrusted project hooks
- [ ] Prevent hooks from silently bypassing plan policy

### Phase 2 exit gate

- [ ] F14 acceptance complete
- [ ] F05 acceptance complete
- [ ] Hook core acceptance complete
- [ ] Existing tools restore correctly after plan mode
- [ ] Context and startup-cost measurements recorded
- [ ] Documentation includes rule/hook examples and security limits

---

# Phase 3 - Named profiles, guarded worktrees, and isolated agents

Features: F02, F09.

## F09 persistent named custom-agent profiles

### Profile model

- [ ] Define fields: name, description, backend, model, effort, instructions, skills, allowed/disallowed tools, max turns, timeout, workspace policy, role
- [ ] Define user and trusted-project profile locations
- [ ] Define managed/user/project precedence
- [ ] Validate names and collisions
- [ ] Resolve relative skill/instruction paths against profile source
- [ ] Add source provenance to resolved profile
- [ ] Add `/agents` browser and validation diagnostics

### Subagent integration

- [ ] Extend `SpawnTask` to accept resolved profile identity
- [ ] Keep ad hoc spawn parameters backward compatible
- [ ] Define override rules between profile and tool arguments
- [ ] Enforce tool restrictions in Pi children
- [ ] Pass compatible restrictions to Claude/Codex backends
- [ ] Enforce max turns/timeout at supervisor layer
- [ ] Include profile in snapshots and transcript metadata
- [ ] Hot reload profiles safely

### Acceptance

- [ ] User/project precedence tests pass
- [ ] Untrusted project profile ignored
- [ ] Invalid profile never partially applies
- [ ] Backend/model/tool/workspace settings verified for Pi, Claude, Codex
- [ ] Existing ad hoc spawn calls remain compatible

## F02 guarded worktrees

### Package trial and design

- [ ] Trial exact pinned `@narumitw/pi-worktree` version
- [ ] Audit source, tests, license, install behavior, Windows cleanup
- [ ] Decide package command adoption vs reviewed port
- [ ] Record state machine ADR

### `WorkspaceManager`

- [ ] Implement states: creating, ready, leased, dirty, reviewed, integrated, abandoned
- [ ] Create from explicit verified base commit
- [ ] Support fresh remote-aware base and current-HEAD base
- [ ] Add searchable inspect/list
- [ ] Add atomic lease with owner/session/expiry
- [ ] Refuse concurrent lease collision
- [ ] Detect tracked, staged, untracked, ignored, submodule, detached, and unpushed state
- [ ] Support `.worktreeinclude` with secret warnings
- [ ] Never use recursive filesystem deletion
- [ ] Use `git worktree remove` after revalidation
- [ ] Detach Windows junctions before removal and verify shared targets
- [ ] Refuse dirty cleanup without explicit preserve/integrate/abandon decision
- [ ] Recover stale leases after process death

### Agent isolation

- [ ] Replace raw alternate cwd with verified workspace lease for isolated profiles
- [ ] Preserve raw cwd mode for backward compatibility, clearly unisolated
- [ ] Create one worktree per isolated agent/task
- [ ] Bind profile, role, project identity, and trust to lease
- [ ] Prevent writes back into protected main checkout through Pi tools
- [ ] Pass cwd and strongest available backend isolation to Claude/Codex
- [ ] Preserve changed worktree after agent failure
- [ ] Surface integrate/review/abandon actions
- [ ] Map result paths back to project-relative paths

### Acceptance

- [ ] Dirty parent remains byte-for-byte unchanged
- [ ] Parallel child writes do not collide
- [ ] Lease collision rejected
- [ ] Alternate repo trust fails closed
- [ ] Dirty cleanup refused
- [ ] Windows junction cleanup fixture verified
- [ ] Shared `node_modules` target survives failed and successful cleanup
- [ ] Session resume rebinds valid worktree and rejects unsafe identity

## Phase 3 exit gate

- [ ] F09 acceptance complete
- [ ] F02 acceptance complete
- [ ] Current subagent tests remain green
- [ ] Pi/Claude/Codex live backend matrix passes
- [ ] Worktree recovery runbook tested

---

# Phase 4 - Language intelligence and local review

Features: F04, F06.

## F04 LSP diagnostics and symbol navigation

### Trial and measurement

- [ ] Trial exact pinned `@narumitw/pi-lsp` version
- [ ] Benchmark targeted diagnostics against native typecheck/lint on at least three representative repos
- [ ] Record latency, context bytes, tool calls, defect detection, startup cost
- [ ] Decide retain package diagnostics, wrap it, or build persistent client
- [ ] Preserve negative result if LSP adds no measurable value

### `LanguageIntelligence`

- [ ] Implement lazy server discovery/config
- [ ] Support persistent server lifecycle under `LifecycleSupervisor`
- [ ] Synchronize open/change/close documents
- [ ] Expose diagnostics, file symbols, workspace symbols, definition, references, implementations, type hover, and call hierarchy where server supports them
- [ ] Map worktree paths through `ProjectIdentity`
- [ ] Cap files, responses, and startup/request time
- [ ] Restart crashed server with bounded backoff
- [ ] Shut down cleanly on reload/session switch
- [ ] Register tools lazily to preserve prompt cache
- [ ] Keep repository-native build/typecheck/test authoritative

### Acceptance

- [ ] Fixture server protocol tests pass
- [ ] TypeScript and one non-TypeScript real server pass
- [ ] Crash/restart test passes
- [ ] Worktree diagnostics map to correct source-relative path
- [ ] Unsupported method returns clear capability error
- [ ] Benchmark decision recorded

## F06 first-class local review

### Review model

- [ ] Define targets: uncommitted, base branch, commit, custom range
- [ ] Fetch before any remote/base assessment
- [ ] Define finding schema: severity, confidence, file, line/range, summary, failure scenario, evidence, category
- [ ] Validate finding paths/lines against reviewed diff
- [ ] Deduplicate overlapping findings
- [ ] Persist full review artifact outside main context

### Execution

- [ ] Add `/review` target picker
- [ ] Add model-facing review tool only if needed
- [ ] Run reviewer under read-only profile and role
- [ ] Support optional second reviewer/verifier
- [ ] Use Git diff, code reads, tests, and LSP evidence
- [ ] Forbid source modification throughout review
- [ ] Render structured findings in TUI
- [ ] Emit machine-readable JSON artifact
- [ ] Support cancellation and bounded output

### Acceptance

- [ ] Fixture diff yields validated findings
- [ ] False file/line finding rejected
- [ ] Duplicate findings merged deterministically
- [ ] Source tree hash unchanged before/after review
- [ ] Untracked files included for uncommitted target
- [ ] Base branch staleness shown explicitly
- [ ] No-findings result distinct from review failure

## Phase 4 exit gate

- [ ] F04 decision and acceptance complete
- [ ] F06 acceptance complete
- [ ] Review command live-tested on this repo and a fixture repo
- [ ] No source mutations from review path

---

# Phase 5 - MCP and browser adapters

Features: F07, F03.

## Shared external-integration controls

- [ ] Create dedicated credential storage policy
- [ ] Define domain/origin allowlists
- [ ] Define side-effect metadata and approval rules
- [ ] Redact headers, tokens, cookies, form secrets, and OAuth codes
- [ ] Add offline mode behavior
- [ ] Add connection status UI without exposing secrets
- [ ] Add dynamic tool activation to prevent schema explosion
- [ ] Ensure plan mode blocks unknown/mutating external tools

## F07 MCP client and OAuth

### Adapter decision

- [ ] Trial exact pinned `pi-mcp-adapter` version in disposable profile
- [ ] Reproduce/falsify known argument-type issue
- [ ] Reproduce/falsify package-command hang from long-lived resources
- [ ] Test STDIO and streamable HTTP lifecycle
- [ ] Decide adopt/wrap/build with official MCP SDK
- [ ] Record ADR

### `ToolFederation`

- [ ] Define user and trusted-project server config
- [ ] Support STDIO and streamable HTTP
- [ ] Support bearer token and OAuth with PKCE/state validation
- [ ] Store tokens outside session/config files
- [ ] Refresh and revoke credentials
- [ ] Namespace server/tool collisions
- [ ] Discover server instructions as untrusted data
- [ ] Defer tool schemas until search/activation
- [ ] Support enabled/disabled tools and per-tool policy
- [ ] Enforce startup/tool timeouts
- [ ] Reconnect with bounded backoff
- [ ] Do not start clients during package list/update commands or child roles that do not need them
- [ ] Add `/mcp` status/config/auth/logout UI

### Acceptance

- [ ] Mock STDIO and HTTP servers pass
- [ ] OAuth state mismatch rejected
- [ ] Token refresh/revocation pass
- [ ] Tool collision safe
- [ ] Invalid native argument types preserved correctly
- [ ] Package/print commands exit without hang
- [ ] Tokens absent from all persisted/logged surfaces

## F03 live browser control

### Adapter decision

- [ ] Trial `pi-agent-browser-native`, `pi-browser-harness`, and `betterwright` against same local fixture
- [ ] Compare setup, security, context size, screenshots, console/network support, cancellation, profile isolation, Windows reliability
- [ ] Choose one exact pinned adapter or build thin `playwright-core` adapter
- [ ] Record ADR and rejected alternatives

### Browser module

- [ ] Use dedicated agent browser profile by default
- [ ] Detect and avoid collision with Impeccable live-browser sessions
- [ ] Expose page list/open/close/navigation
- [ ] Expose accessibility snapshot and stable element references
- [ ] Expose click/fill/select/key/scroll/wait
- [ ] Expose screenshot, console, page errors, and network requests
- [ ] Support local dev-server origins
- [ ] Require explicit approval for downloads, uploads, purchases, submissions, account changes, and authenticated remote writes
- [ ] Restrict origins and private/metadata network targets
- [ ] Bound screenshots/snapshots and persist full evidence as artifacts
- [ ] Cancel in-flight actions
- [ ] Close browser resources on reload/shutdown

### Visual verification workflow

- [ ] Add reusable skill for start server, navigate, exercise flow, capture proof, inspect errors, report evidence
- [ ] Integrate with background terminals
- [ ] Integrate with review findings and artifacts
- [ ] Require live-app verification before frontend task completion when applicable

### Acceptance

- [ ] Local fixture navigate/click/fill/screenshot passes
- [ ] Console and failed request surfaced
- [ ] Blocked origin/download/upload tests pass
- [ ] Dedicated profile isolation verified
- [ ] Browser process cleanup verified
- [ ] Plan mode blocks mutating browser action
- [ ] Impeccable session coexistence verified

## Phase 5 exit gate

- [ ] F07 acceptance complete
- [ ] F03 acceptance complete
- [ ] Secret scan passes
- [ ] External adapters disabled cleanly when unconfigured
- [ ] No startup regression beyond agreed budget

---

# Phase 6 - Cross-session messaging and persistent memory

Features: F10, F11.

## F10 cross-session messaging

### Identity and registry

- [ ] Define session identity from Pi session ID plus process-held proof
- [ ] Register heartbeat, cwd, project identity, name, status, and capabilities
- [ ] Expire stale sessions safely
- [ ] Make discovery opt-in
- [ ] Keep project boundaries visible

### Durable mailbox

- [ ] Define ordered message envelope: id, sender, recipient, timestamp, summary, body artifact, delivery mode
- [ ] Transactionally claim and acknowledge messages
- [ ] Support online and offline delivery
- [ ] Prevent duplicate delivery after crash/restart
- [ ] Support send, broadcast-to-explicit-list, and notify-when-idle
- [ ] Queue through Pi follow-up/steering mechanisms without forging user approval
- [ ] Preserve sender provenance in transcript
- [ ] Add `/sessions` and `/messages` UIs
- [ ] Add model tools for list/send with policy limits

### Acceptance

- [ ] Two Pi processes exchange ordered messages
- [ ] Offline recipient catches up once
- [ ] Crash between claim/ack does not lose message
- [ ] Duplicate delivery prevented
- [ ] Sender identity cannot be spoofed through tool input
- [ ] Message cannot approve a protected action
- [ ] Native Windows transport/store behavior verified

## F11 persistent memory

### Package trial

- [ ] Trial exact pinned `pi-memory` version with automatic generation disabled
- [ ] Audit scope, retrieval, dependencies, storage, deletion, redaction, and prompt injection handling
- [ ] Decide adopt/wrap/build
- [ ] Record ADR

### `MemoryStore`

- [ ] Define memory kinds: preference, project fact, decision, procedure, ephemeral note
- [ ] Require scope: user, stable project identity, or explicit workspace
- [ ] Store source citation, created/updated time, confidence, expiry, and contradiction links
- [ ] Add explicit `/remember`, `/memories`, `/forget`, `/memory edit`
- [ ] Add full-text retrieval with bounded results
- [ ] Quote retrieved memory as untrusted context
- [ ] Redact likely secrets before storage
- [ ] Deduplicate near-identical entries
- [ ] Detect contradictory active memories
- [ ] Never retrieve unrelated project memory
- [ ] Add export/import and complete deletion

### Automatic extraction gate

- [ ] Build labeled evaluation set of should-remember/should-not-remember examples
- [ ] Measure false-positive and false-memory rate
- [ ] Require user review queue before promotion
- [ ] Enable auto-extraction only if threshold is met
- [ ] Keep generation off by default until validated

### Acceptance

- [ ] Restart persistence passes
- [ ] Project isolation passes
- [ ] Dedupe/contradiction/expiry passes
- [ ] Secret redaction passes
- [ ] Malicious memory cannot become system instruction
- [ ] Forget removes retrieval and underlying body
- [ ] Retrieval quality benchmark recorded

## Phase 6 exit gate

- [ ] F10 acceptance complete
- [ ] F11 explicit-memory acceptance complete
- [ ] Automatic memory remains off unless evaluation gate passes
- [ ] Multi-process contention and recovery tests pass

---

# Phase 7 - Reactive monitors, completed hooks, and scheduling

Features: F08 completion, F15, F16.

## `TriggerEngine`

- [ ] Unify hook events, file/process events, cron timers, and missed-event delivery
- [ ] Define event envelope and source provenance
- [ ] Add bounded queue, debounce, coalescing, and backpressure
- [ ] Add recursion/self-trigger suppression
- [ ] Add per-trigger concurrency and timeout
- [ ] Persist only events that require restart/offline delivery
- [ ] Register every watcher/timer with `LifecycleSupervisor`
- [ ] Use fake clock and fake watcher adapters in tests

## F15 reactive monitor

- [ ] Extend background terminal interface with monitor subscriptions rather than a second process manager
- [ ] Support log line matcher
- [ ] Support file/directory watcher
- [ ] Support bounded polling adapter for CI/PR status
- [ ] Support WebSocket only after URL policy validation
- [ ] Batch event bursts into bounded model messages
- [ ] Let user/model pause, resume, inspect, and stop monitor
- [ ] Persist monitor definition if explicitly requested
- [ ] Prevent monitor output from recursively triggering itself
- [ ] Replace duplicate Git polling only after equivalent behavior is proven

### F15 acceptance

- [ ] Log, file, poll, and WebSocket fixture tests pass
- [ ] Burst coalescing/backpressure pass
- [ ] Ignore filters and self-trigger suppression pass
- [ ] Cancellation and reload cleanup pass
- [ ] No event arrives after shutdown

## F08 declarative hooks, completion

- [ ] Add remaining session/tool/compaction/worktree/subagent/task events supported by platform
- [ ] Add HTTP/MCP/agent actions only where `CapabilityPolicy` permits
- [ ] Surface hook execution history and errors
- [ ] Make changed config require revalidation/trust
- [ ] Add migration guide from TypeScript one-off hooks
- [ ] Verify hooks cannot create recursive schedules/monitors without explicit limits

### F08 acceptance

- [ ] Ordering, matcher, timeout, failure policy, output cap, and recursion tests pass
- [ ] Untrusted project config ignored
- [ ] Hook changes visible before execution
- [ ] Plan and child-role policy remain authoritative

## F16 scheduled prompts

### Scheduler

- [ ] Define one-shot, interval, and cron schedules
- [ ] Store timezone, next run, missed-run policy, role, profile, cwd/project identity, and enabled state
- [ ] Use transactional lease so only one Pi process executes each occurrence
- [ ] Support session-scoped and durable schedules
- [ ] Deliver result through mailbox/artifact store
- [ ] Add `/schedule`, `/schedules`, pause, resume, run-now, delete
- [ ] Validate project/profile still exists before run
- [ ] Fail closed when credentials/trust unavailable
- [ ] Bound runtime, retries, and output
- [ ] Document Windows Task Scheduler adapter only if no Pi process is expected to remain active

### F16 acceptance

- [ ] Fake-clock one-shot/interval/cron pass
- [ ] DST and timezone cases pass
- [ ] Missed-run skip/run-once policy passes
- [ ] Two processes produce one claimant
- [ ] Offline result delivered once
- [ ] Deleted/paused schedule never runs
- [ ] Scheduled child uses correct role and tool policy

## Phase 7 exit gate

- [ ] F15 acceptance complete
- [ ] F08 full acceptance complete
- [ ] F16 acceptance complete
- [ ] Long-duration soak test has no leaked handles or duplicate events

---

# Phase 8 - Persistent task graph and goal mode

Feature: F13.

## Domain model

- [ ] Define goal, node, dependency, attempt, evidence, status, retry policy, failure policy, and budget
- [ ] Define states: draft, ready, running, paused, blocked, failed, done, cancelled
- [ ] Reject cycles and missing dependencies
- [ ] Make state transitions explicit and validated
- [ ] Keep workflow JavaScript separate from goal graph semantics

## `GoalEngine`

- [ ] Implement `submit`, `resume`, `pause`, `cancel`, `observe`
- [ ] Persist graph and every transition transactionally
- [ ] Claim runnable nodes with leases
- [ ] Enforce bounded concurrency, calls, time, and token/cost budget
- [ ] Resolve named profile and workspace policy per node
- [ ] Reuse `AgentSupervisor`, `WorkspaceManager`, `ArtifactStore`, review, and mailbox
- [ ] Require evidence references for completion
- [ ] Support retry with bounded attempts and backoff
- [ ] Resume after crash without duplicate node execution
- [ ] Preserve blocked workspaces/artifacts for inspection
- [ ] Add `/goal` and `/goals` dashboard
- [ ] Add model tools with small interface

## User control

- [ ] User can edit goal/task text and dependencies while paused
- [ ] User can mark skip/block/done with reason
- [ ] User can inspect attempts and evidence
- [ ] User can resume from selected node
- [ ] Agent cannot silently change success criteria
- [ ] Completion summary links verification evidence

## Acceptance

- [ ] Cycle and invalid transition tests pass
- [ ] Dependency scheduling and bounded parallelism pass
- [ ] Crash/restart resumes without duplicate work
- [ ] Retry/failure policies pass
- [ ] Workspace leases released or preserved correctly
- [ ] User edits audited
- [ ] Existing workflow tool remains compatible
- [ ] Goal completion cannot occur without required evidence

## Phase 8 exit gate

- [ ] F13 acceptance complete
- [ ] Multi-hour simulated run passes
- [ ] Recovery drill from killed parent process passes
- [ ] Goal dashboard and handoff are understandable without transcript context

---

# Phase 9 - Shareable interactive artifacts

Feature: F23.

## Artifact model and local viewer

- [ ] Define artifact types: Markdown, HTML, JSON, image, bundle
- [ ] Add metadata: title, creator, project, content hash, MIME type, size, created time, sensitivity, retention
- [ ] Build local loopback viewer with random capability token
- [ ] Bind loopback only
- [ ] Sandbox HTML iframe and set strict Content Security Policy
- [ ] Disable network by default in artifact HTML
- [ ] Sanitize Markdown/HTML
- [ ] Support live refresh for explicitly live artifacts
- [ ] Add `/artifacts` browser, open, export, delete
- [ ] Keep body outside model context

## Sharing provider decision

- [ ] Write requirements: private-by-default, authentication, expiry, revocation, size limits, no secret leakage, interactive HTML support
- [ ] Evaluate existing hosted provider vs self-hosted option
- [ ] Implement local publisher adapter
- [ ] Implement one approved remote publisher adapter
- [ ] Add explicit publish confirmation with sensitivity scan result
- [ ] Return share URL and revocation handle
- [ ] Support expiry and manual revoke
- [ ] Never auto-publish from agent or schedule
- [ ] Record provider/privacy ADR

## Workflow integration

- [ ] Let review, browser proof, goals, LSP reports, and workflows emit artifacts
- [ ] Add `artifact` reference rendering to session without body injection
- [ ] Support export/import bundle with integrity manifest
- [ ] Link artifact evidence from goal/review completion

## Acceptance

- [ ] Local Markdown/HTML/image/JSON render correctly
- [ ] Script injection, traversal, oversized body, malformed MIME, and network escape tests pass
- [ ] Export/import hash verification passes
- [ ] Remote publish requires human confirmation
- [ ] Revoke and expiry pass
- [ ] Secret scanner blocks seeded credentials
- [ ] Shared page contains no local filesystem paths or tokens

## Phase 9 exit gate

- [ ] F23 local and remote acceptance complete
- [ ] Privacy/security review complete
- [ ] Provider outage and revoke runbooks tested

---

# Phase 10 - Integrated hardening and release

Goal: prove all selected capabilities compose safely.

## Composition matrix

- [ ] Plan mode plus dynamically activated MCP tools
- [ ] Plan mode plus browser actions
- [ ] Lazy rules inside worktrees
- [ ] LSP path mapping inside worktrees
- [ ] Named profile plus isolated workspace plus goal node
- [ ] Review of agent-created worktree
- [ ] Browser proof attached to review/goal artifact
- [ ] Scheduled goal result delivered through offline mailbox
- [ ] Hooks observing monitor/schedule events without recursion
- [ ] Memory retrieval scoped across main checkout/worktrees
- [ ] `/reload` with browser, LSP, MCP, monitors, broker, and scheduler active
- [ ] Parent shutdown while child/workflow/goal tasks run
- [ ] Compaction and session resume with active durable resources

## Security review

- [ ] Threat model reviewed for every external/process feature
- [ ] Project trust bypass tests pass
- [ ] Symlink/junction/path traversal tests pass
- [ ] Secret canaries absent from every persisted surface
- [ ] OAuth/browser credentials isolated
- [ ] Cross-session identity spoof tests pass
- [ ] Message/memory/MCP/browser prompt-injection tests pass
- [ ] Remote artifact publish always requires human confirmation
- [ ] Documentation accurately states lack of OS sandbox

## Reliability and performance

- [ ] 24-hour scheduler/monitor/broker soak test
- [ ] Crash recovery for store, leases, worktrees, goals, and mailbox
- [ ] Startup time budget met
- [ ] Idle CPU and memory budget met
- [ ] Tool-schema/context budget met through lazy activation
- [ ] 100 repeated `/reload` cycles without leaked handles
- [ ] Process tree clean after tests
- [ ] Storage retention/garbage collection verified

## Compatibility

- [ ] Native Windows 11
- [ ] Git Bash
- [ ] PowerShell-launched Pi
- [ ] TUI mode
- [ ] Print mode
- [ ] JSON mode
- [ ] RPC mode
- [ ] Pi backend
- [ ] Claude backend
- [ ] Codex backend
- [ ] Trusted and untrusted project
- [ ] Git repo, linked worktree, and non-Git directory

## Release

- [ ] Update `README.md` capability list and screenshot
- [ ] Update `SETUP.md` with dependencies, credentials, profiles, and recovery
- [ ] Add configuration examples with safe defaults
- [ ] Add migration notes for existing users
- [ ] Add rollback/uninstall procedure per feature
- [ ] Pin package versions and record lock/source commits
- [ ] Run complete `npm run verify`
- [ ] Run live-app verification
- [ ] Review final diff with `/review`
- [ ] Re-fetch and report ahead/behind
- [ ] Tag release/checkpoint
- [ ] Mark all capability matrix rows complete

---

# Verification ledger

Add one row for every phase exit and material regression fix.

| Date | Phase/feature | Commit | Commands/tests | Live verification | Result | Notes/artifacts |
|---|---|---|---|---|---|---|
| 2026-08-24 | Planning baseline | n/a | `npm run check` | Not run | Typecheck pass | Current repo dependencies |
| 2026-08-24 | Planning baseline | n/a | `npm test` | Not run | Fail: 5 background-terminal tests | Windows command/status baseline |
| 2026-08-24 | Planning baseline | n/a | `npm run format:check` | Not run | Fail: 98 files | Formatting baseline unresolved |
| 2026-08-24 | Phase 0 formatting | `4dd6b32` | `npm run format:check` | n/a | Pass | LF policy in `.gitattributes`; 98 failures diagnosed as CRLF-only |
| 2026-08-24 | Phase 0 Windows processes | `366fa6f`, `2c58fa3` | `npm run test:unit`; `npm run test:integration` | Native Windows process trees | Pass: 74 unit, 67 integration; 4 POSIX-only skipped | `cmd.exe` argument boundary, forced tree kill, truthful kill state, platform paths, Codex `.cmd` launcher |
| 2026-08-24 | Phase 0 exit | `4dd6b32`, `366fa6f`, `2c58fa3` | `npm ci`; `npm run install:extensions:ci`; `npm run verify` | Claude/Codex 4/4; print/JSON/RPC/reload/shutdown | Pass | Offline production-extension smoke and process-leak gate; TUI checklist at `docs/verification/phase-0-tui-smoke.md` |
| 2026-08-24 | Protected Codex reconciliation | `1b1e784` | focused Codex process tests; pruning test 3x; `npm run test:integration`; `npm run verify` | Claude/Codex 4/4; print/JSON/RPC/reload/shutdown | Pass | Synthesized explicit `cmd.exe` boundary with `.cmd`/`.bat` coverage; corrected pruning-history assertion exposed under concurrent Windows load |

# Decision log

Record durable decisions here, then link a full ADR when needed.

| ID | Date | Decision | Status | Rationale/ADR |
|---|---|---|---|---|
| D001 | 2026-08-24 | Scope equals `[X]` markers only | Accepted | 15 selected capabilities |
| D002 | 2026-08-24 | Feature 20 `[s]` treated as skipped | Accepted | Not an `[X]` selection |
| D003 | 2026-08-24 | One platform composition root with deep internal modules | Proposed | Deterministic policy/lifecycle ordering; avoid 15 independent daemons |
| D004 | 2026-08-24 | Existing public tools remain backward compatible | Proposed | Preserve current workflows and user muscle memory |
| D005 | 2026-08-24 | Goal graph remains distinct from arbitrary workflow JavaScript | Proposed | Durable declarative recovery vs advanced scripting |
| D006 | 2026-08-24 | Unknown tools count as side-effecting in plan mode | Proposed | Safe dynamic MCP/browser/tool loading |
| D007 | 2026-08-24 | Preserve independent extension package topology in Phase 0; pin Effect ecosystem to `4.0.0-beta.101` | Accepted | Avoid workspace migration while eliminating version drift |
| D008 | 2026-08-24 | Repository text uses LF; Windows command files use CRLF | Accepted | Stable Prettier behavior under Git Bash and `core.autocrlf=true` |
| D009 | 2026-08-24 | Deterministic unit/integration tests are default; provider tests are live-only | Accepted | No paid or credentialed calls from `npm test` |
| D010 | 2026-08-24 | Invoke Windows shell command strings and `.cmd` shims through explicit `cmd.exe` boundaries | Accepted | Prevent Node 26 `spawn EINVAL`, quote corruption, and orphaned descendants |
| D011 | 2026-08-24 | Reconcile protected live Codex work by retaining explicit `cmd.exe` invocation and adding `.bat` support plus rationale | Accepted | Preserves live intent while keeping deterministic quoting, testable invocation, and DEP0190 avoidance |

# Risk register

| Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|
| Live config repo edited during development | Medium | High | External worktree; feature flags; rollback | Closed for Phase 0 |
| Existing dirty changes overwritten | Medium | High | Resolve ownership in Phase 0 | Closed; preserved |
| Pi library version skew | High | High | Align dependencies before feature work | Mitigated at 0.84.3 |
| Windows process semantics remain broken | High | High | Phase 0 repair and real process tests | Mitigated; native tests green |
| Junction cleanup deletes shared target | Medium | Critical | Never recursive delete; detach and verify | Open |
| Cross-extension Effect incompatibility | Medium | High | One exact version per independent package; plain-data seams | Mitigated; topology verified |
| MCP lifecycle hangs package commands | Medium | High | Disposable trial; supervisor-owned clients | Open |
| OAuth/browser secrets leak | Medium | Critical | Dedicated stores/profiles; redaction canaries | Open |
| Browser mutates remote system in plan mode | Medium | High | Side-effect policy and explicit approval | Open |
| Memory poisoning/stale facts | High | Medium | Provenance, contradiction, review queue, auto off | Open |
| Multi-process duplicate schedules/messages | Medium | High | Transactional claims and leases | Open |
| Tool schema/context explosion | High | Medium | Deferred registration/activation | Open |
| Watcher/timer/process leaks on reload | Medium | High | `LifecycleSupervisor` and soak tests | Open |
| Hosted artifact exposes sensitive data | Medium | Critical | Private default, scan, confirmation, revoke | Open |
| Scope expands into excluded sandbox/remote-control work | Medium | Medium | Enforce explicit exclusions and ADR review | Open |

# Rollback strategy

Every phase must remain independently reversible.

- [ ] Feature flags default off until phase acceptance
- [ ] Keep current extensions intact until replacement compatibility passes
- [ ] Back up user settings before package/config migration
- [ ] Store schema migrations with tested downgrade/export path
- [ ] Preserve worktrees and artifacts when cleanup confidence is low
- [ ] Disable external adapters without deleting credentials/data
- [ ] Provide one command or documented edit to disable each capability
- [ ] Keep last known-good tagged configuration
- [ ] Test rollback before enabling feature by default

# Implementation-session handoff template

Copy into `.agent/handoff/pi-capabilities-program.md` after each work session:

```markdown
## Current phase

<phase and capability>

## Completed this session

- [x] <task and evidence>

## In progress

- [ ] <task>

## Blocked

- <exact blocker, attempts, smallest unblock>

## Files changed

- `<path>` - <purpose>

## Verification

- `<command>` - pass/fail
- Live check - pass/fail/not applicable

## Repo state

- Branch: `<branch>`
- Ahead N / behind M
- Pre-existing dirty files preserved: yes/no

## Next exact action

<one concrete step>
```
