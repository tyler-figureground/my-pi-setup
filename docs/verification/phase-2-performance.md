# Phase 2 startup and context measurements

## Method

Startup measurement launches Pi 0.84.3 in native Windows print mode with network, sessions, tools, skills, prompts, themes, context files, and approval disabled. `PI_CODING_AGENT_DIR` points at the complete repository extension tree. Ten warm subprocess launches are measured with `performance.now()` after a separate cold-cache run.

Context measurement indexes a fixed synthetic rule set, activates one matching path in a caller-assigned context epoch, and counts UTF-8 bytes returned for model injection. The same set is queried with an unrelated path. Rule bodies are not read during indexing.

## Baseline

Phase 1 commit: `9b97aba`

| Measurement | Result |
|---|---:|
| Warm launches | 10 |
| Median startup | 2358.9 ms |
| Mean startup | 2433.1 ms |
| Minimum | 2216.6 ms |
| Maximum | 2837.8 ms |

A separate first cold launch took 33574.5 ms and was excluded from the warm comparison because Windows file hydration and antivirus/cache state dominated it.

## Phase 2 context

Synthetic corpus: 100 rules with 1,024-byte bodies and mutually exclusive path patterns.

| Measurement | Result |
|---|---:|
| Startup frontmatter reads | 100 |
| Startup body reads | 0 |
| Unrelated-path body reads | 0 |
| Unrelated-path injected bytes | 0 |
| Matching-path body reads | 1 |
| Matching-path body bytes | 1,024 |
| Matching-path injected bytes including ID/source metadata | 1,084 |

Lazy discovery avoided 102,400 body bytes at startup and injected no unrelated rule content.

## Phase 2 startup

| Measurement | Result |
|---|---:|
| Warm launches | 10 |
| Median startup | 3408.4 ms |
| Mean startup | 3394.1 ms |
| Minimum | 3174.2 ms |
| Maximum | 3741.0 ms |
| Median change from Phase 1 | +1049.5 ms (+44.5%) |

The enabled Phase 2 composition adds canonical Git project resolution plus bounded global/project rule and hook discovery. No watcher, timer, daemon, or background process starts. The measured cost is accepted for Phase 2 but remains a Phase 10 optimization target; future work should cache project identity across same-cwd reloads without weakening trust or alias checks.
