# Phase 7 threat model

Status: implementation threat model
Date: 2026-08-28

## Protected assets

- direct-user authority and protected-action confirmation
- Project Identity, canonical cwd, project trust, Execution Role, Agent Profile, workspace lease, session identity, and result route
- process, watcher, timer, socket, child, StateStore, Artifact, and mailbox lifecycle ownership
- credentials, environment values, hook/process output, terminal logs, filesystem names/content, poll responses, WebSocket frames, prompts, and child results
- schedule definitions, Schedule Occurrences, transactional claims, fencing tokens, and delivery receipts
- bounded model context, memory, disk, handles, CPU, network, and process capacity

## Trust boundaries

Untrusted data includes:

- model/tool input and model-generated monitor/Schedule definitions
- Declarative Hook YAML fields even when file provenance is trusted
- Hook command, HTTP, MCP, and agent results
- terminal output and process errors
- filesystem paths/names/events after source configuration
- poll responses, HTTP errors, redirects, DNS answers, and WebSocket frames
- Mailbox Messages, scheduled prompts, child output, and Artifact content
- persisted state read after process restart until schema and binding validation

Host authority includes only values resolved or minted inside current generation:

- current Pi mode and direct TUI confirmation
- Parent Execution Role
- Project Identity and current trust decision
- current immutable Agent Profile identity/digest and policy
- current workspace lease owner/fence
- source adapter binding, event provenance, causal ancestry, and generation
- StateStore lease fence and idempotency receipt

## Threats and controls

### Forged event provenance or authority

**Threat:** payload/config/model text supplies event ID, source trust, project/session identity, role, causal root, direct approval, or recipient identity.

**Controls:** source binding captures host values; runtime decoder rejects extra/accessor/cyclic/class data; engine stamps IDs/times/provenance/cause; model interfaces omit authority fields; every side effect rechecks CapabilityPolicy and generation.

### Recursive automation and event storms

**Threat:** hook output triggers itself, monitor delivery modifies watched files, or scheduled child creates more automation.

**Controls:** engine-owned parent/root ancestry; visited Trigger Binding IDs; depth/firing/fanout limits; self suppression; no initial hook monitor/Schedule actions; scheduled children cannot own Parent daemons; bounded queues/bytes/concurrency/batches; observable coalesced/dropped counts.

### Queue or context exhaustion

**Threat:** terminal firehose, watcher burst, remote frames, or mass due schedules consume memory/context.

**Controls:** global/per-binding count and byte admission limits; reserved gate lane; bounded partial lines/frames/events; matcher before Artifact/model delivery; batch windows and hard context cap; no per-event SQLite writes for ephemeral traffic; remote/source caps.

### Changed trusted configuration race

**Threat:** project config changes after validation or is replaced by link/junction/file identity swap.

**Controls:** regular-file/no-follow canonical containment; device/inode identity checks before/during read; digest/generation; change hint suspends affected bindings before next action; trust and identity revalidation; atomic last-known-good apply; invalid changed project config does not continue executing stale bytes silently.

### Filesystem escape or false watcher truth

**Threat:** junction/symlink swap escapes project, ambiguous rename/delete causes unsafe action, OneDrive/network watcher omits events.

**Controls:** watcher events are hints; canonicalize/re-stat at consumption; reject aliases/root replacement; default excludes for `.git`, state, Artifacts, workspaces, credentials, and monitor output; bounded snapshot reconciliation; explicit degraded state rather than completeness claim.

### Network destination bypass

**Threat:** WebSocket/poll/HTTP redirects, DNS rebinding, proxy environment, private/metadata addresses, credentialed URL, oversized frames.

**Controls:** extend External Integration Controls for monitor protocol; exact canonical origin allowlist; resolve/classify every address; pinned lookup; preserve Host/TLS SNI; disable redirects/proxy/compression; opaque Credential References only; handshake/frame/fragment/buffer/idle/reconnect/lifetime limits; reauthorize reconnect.

### Secret retention or disclosure

**Threat:** credentials appear in config, URLs, errors, terminal lines, hook output, state, Artifacts, inspection, or model messages.

**Controls:** reject raw credential fields/URL userinfo; exact references; structural and string redaction; bounded canaries where credentials are resolved; omit secret-bearing fields where possible; no raw event bodies in StateStore/history; sensitive output Artifact refusal or protected retention; all errors sanitized before persistence/rendering.

### Schedule identity or policy drift

**Threat:** changed project/profile/tools/credentials silently expand unattended authority.

**Controls:** bind Project Identity/canonical cwd, `scheduled` role, profile name/digest/source, prompt digest, result recipient, and policy limits at creation; re-resolve before each occurrence; digest mismatch blocks until direct rebind; no schedule payload role/tool overrides.

### Duplicate or stale Scheduled Occurrence

**Threat:** two Pi processes run same due occurrence; stale process commits/delivers after lease loss; crash causes duplicate remote effects.

**Controls:** deterministic occurrence IDs; atomic revision check plus lease claim; lease renewal/fence checked before spawn transitions, completion, Artifact, and delivery; idempotent receipts; stale completion rejected. Documentation promises one current claimant and once-visible result, not exactly-once arbitrary child effects. Ambiguous post-spawn crash is not automatically retried.

### Lifecycle leak or post-shutdown delivery

**Threat:** paused/deleted/reloaded monitor still emits; socket/watcher/timer/child survives shutdown.

**Controls:** releasable Lifecycle leases; release/shutdown share close; generation increment before closure; source ingress sealed first; callbacks recheck generation; bounded abort/drain; late results fenced; native handle/process/socket soak; no event accepted after close acknowledgement.

### Windows PID reuse or junction cleanup

**Threat:** PID-only taskkill terminates unrelated process; worktree cleanup follows junction into shared dependencies.

**Controls:** every process root/descendant kill binds PID plus creation identity and revalidates before signal; no PID-only fallback; detach `node_modules` junction before worktree deletion; never recursively remove live junctions; preserve DLL-locked dependency backups while Pi may hold native DLL handles.

## Residual risks

- Watcher APIs cannot prove complete ordered history. Reconciliation narrows but does not eliminate gaps.
- A child or external operation may have side effects before a crash makes occurrence state ambiguous. Fencing cannot roll those effects back.
- Running Schedules while no Pi Parent process exists is outside Phase 7. Missed-run policy applies when a Parent returns.
- Native watcher dependencies increase DLL/supply-chain handling if selected. Exact pins, lazy loading, integrity checks, and lifecycle trials are required.
- Real terminal keystrokes remain a manual acceptance gate; automated TUI/RPC paths still run.

## Security acceptance

- forged provenance/authority and extra-field tests
- accessor/cycle/oversize payload rejection without getter execution
- recursion/fanout/backpressure/deadline/late-generation tests
- config trust/path replacement/junction tests
- terminal/file/poll/WebSocket secret, destination, frame, reconnect, and shutdown fixtures
- Plan Mode and child-role policy tests
- two-process SQLite Schedule claim/fence/crash tests
- profile/project/trust/credential drift tests
- Artifact/mailbox idempotency and offline delivery tests
- native Windows process identity and watcher cleanup tests
- repeated reload and long-duration no-handle/no-duplicate soak
