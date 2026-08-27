# Phase 5 startup performance

Date: 2026-08-26

Paired warm RPC `get_commands` benchmark. Each checkout used itself as `PI_CODING_AGENT_DIR`, offline/no-session mode, one warmup, then seven measurements. Phase 5 had MCP/browser flags enabled but no MCP servers or browser origins, proving the unconfigured lazy path.

| Measurement | Phase 5 | Phase 4 control |
|---|---:|---:|
| Median | 4,170.4 ms | 4,061.4 ms |
| Mean | 4,292.0 ms | 4,189.7 ms |
| Minimum | 3,785.4 ms | 3,896.2 ms |
| Maximum | 5,058.2 ms | 4,689.5 ms |

Paired median change: **+109.0 ms (+2.7%)**.

No MCP transport, keyring native module, Playwright module, browser process, OAuth discovery, or network request starts during this path. Exact MCP and Playwright adapters load on first catalog search or browser open respectively.
