# Phase 2 threat model

## Assets and authority

Phase 2 protects source files, Git state, credentials, session authority, model context, and process availability. `CapabilityPolicy` is the final operation authority. Project trust comes from Pi's host context and canonical `ProjectIdentity`, never model content, YAML, environment variables, or another session message.

This platform does not provide an operating-system sandbox. Trusted global and project hook configuration executes with the user's permissions after policy checks.

## Trust boundaries

- Global rule and hook configuration is user-controlled.
- Project rule and hook configuration is read only when Pi reports that project trusted.
- Rule and hook file contents remain data until strict parsing and validation succeeds.
- Model messages, tool inputs, hook output, and cross-session messages are untrusted and cannot grant approval.
- Symlinks and Windows junctions are aliases, not new trust roots.

## Threats and mitigations

| Threat | Mitigation | Verification |
|---|---|---|
| Untrusted project instructions enter context | Ignore all project rule sources unless host trust is active; retain source provenance | Untrusted-project discovery and activation tests |
| Traversal or symlink/junction bypass escapes project | Canonicalize through `ProjectIdentity`, require containment, bind reads to one handle, and compare file/directory identities before and after I/O | Static traversal/symlink/junction fixtures plus pre/open/post identity assertions |
| Rule set bloats startup or context | Index bounded frontmatter only; bound file/pattern/body counts; activate bodies lazily and once per context epoch | Startup and context-byte measurements; unrelated-rule test |
| Ambiguous duplicate or overlapping rules | Reject duplicate IDs/conflicts and sort valid matches deterministically by specificity, priority, source, and ID | Duplicate, conflict, and precedence tests |
| Malicious glob causes excessive CPU | Exact patched `minimatch` version plus pattern count and byte limits | Repeated-wildcard and oversized-pattern fixtures |
| YAML aliases or nesting exhaust memory/stack | Exact patched `yaml` version; byte, alias, node, collection, and depth bounds; catch all parser failures | Alias, deep-nesting, node-count, and malformed YAML fixtures |
| Plan mode bypassed by hidden or dynamic tool | Every `tool_call` crosses `CapabilityPolicy`; unknown tools are side-effecting and denied | Dynamic registration and unknown-tool denial tests |
| Shell allowlist is bypassed by quoting or subprocess behavior | `bash` and `powershell` are unavailable while planning; use dedicated structured read-only operations | Shell and user-bash denial tests |
| Tool removal alone is mistaken for enforcement | Active-tool filtering is usability only; policy denial is host backstop | Direct invocation of inactive/mutating tool test |
| Agent or another session approves execution | Approval transition requires explicit host/user authority; messages and hook effects cannot construct it | Forged message/session approval tests |
| Plan exit restores broader access than before entry | Persist and restore the exact pre-plan active tool-name set on the active session branch | Resume, tree navigation, reload, cancel, and approval restoration tests |
| Plan path overwrites arbitrary files | Resolve only beneath configured user/project plan root; sanitize generated names; atomic no-follow write | Traversal, alias, existing-target, and interrupted-write tests |
| Untrusted project hook runs a process | Project hook source excluded before parse unless trusted; provenance travels with every definition/effect | Untrusted-project hook tests |
| Hook command shell injection | Command actions are executable plus argument arrays; no implicit shell string | Schema rejection and argument-preservation tests |
| Hook allow effect bypasses plan mode | Intersect hook policy effects with `CapabilityPolicy`; deny remains dominant | Plan-plus-hook-allow test |
| Recursive hooks trigger unbounded work | Dispatch-chain identity, recursion depth, pending count, and per-hook concurrency limits | Reentrancy and recursion tests |
| Hung hook blocks Pi or leaks a process | Per-hook timeout, abort propagation, bounded output, and composition-owned shutdown | Timeout, cancellation, reload, and leak tests |
| Hook output or logs expose secrets/context | Bounded redacted summaries only; command output never enters context/logs; nonsensitive truncation spills to restrictive temporary files; likely-sensitive spills are deleted | Canary, spill, and output-cap tests |
| Failure policy silently weakens enforcement | Failure policy explicit per action; policy decisions fail closed; diagnostics preserve provenance | Fail-open/fail-closed matrix tests |

## Residual risks

- A user-trusted hook executable has normal user privileges. Trust and policy reduce accidental or confused-deputy execution but do not contain malicious trusted code.
- Local users able to modify `~/.pi/agent`, session JSONL, or the extension source already hold equivalent authority.
- Read-only tools may still expose sensitive local data to the selected model provider. Plan mode prevents mutation, not disclosure.
- Plan policy governs agent tool calls, interactive `!` shell interception, and hook effects. Explicit extension commands and direct RPC administrative commands are operator actions outside agent policy; invoking them is direct user authority, not model approval.
- Handle and file-identity checks reduce time-of-check/time-of-use risk but cannot provide kernel-enforced containment against a same-user attacker able to replace and restore paths between every check.
