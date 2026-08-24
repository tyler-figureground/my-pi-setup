# Phase 0 TUI smoke checklist

Run from the isolated implementation worktree after deterministic smoke passes.

```sh
PI_OFFLINE=1 PI_TELEMETRY=0 PI_CODING_AGENT_DIR="$PWD" pi --no-session --no-approve
```

Record date, Pi version, terminal, and result in the implementation plan verification ledger.

- [ ] Startup header renders without extension-load errors.
- [ ] `/hotkeys` opens and closes.
- [ ] `/ps` opens; empty and settled states render correctly.
- [ ] Background-terminal, subagent, workflow, question, Firecrawl, `fd`, and `rg` tools appear in tool visibility/config UI.
- [ ] Git, model, summary-model, and activity status areas render without overlap.
- [ ] Start a short background terminal; `/ps` shows live output and settled result.
- [ ] `/reload` completes; commands, tools, statuses, and widgets remain present once each.
- [ ] Start then stop a background terminal; shutdown reports truthful termination state.
- [ ] `/quit` exits cleanly.
- [ ] No child `pi`, `node`, `cmd`, or tested command process remains after exit.

Automated counterparts run under `npm run test:smoke`: offline extension load, print mode, JSON mode, RPC mode, startup, reload, graceful shutdown, command survival, status/widget calls, and token-based process-leak detection.
