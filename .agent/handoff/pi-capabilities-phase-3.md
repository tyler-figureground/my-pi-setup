# Phase 3 execution checkpoint

Updated: 2026-08-25

## Objective

Implement only Phase 3 from `docs/PI-CAPABILITY-IMPLEMENTATION-PLAN.md`:

- F09 persistent named custom-agent profiles
- F02 guarded worktrees and isolated agents

Do not begin Phase 4.

## Starting state

- Base: `dc1a964`
- Branch: `pi-capabilities-phase-3`
- Worktree: `C:/Users/Tyler/.worktrees/my-pi-setup/pi-capabilities-phase-3`
- Live `main` was ahead 0 / behind 0 after `git fetch --all --prune`.
- Preserve live deleted `AGENTS.md` and untracked `skills/impeccable/`.
- Preserve `C:/Users/Tyler/AppData/Local/Temp/pi-capabilities-phase1-live-backup-20260825-144510`.

## Confirmed public seams

Tyler approved these seams before tests:

- `ProfileCatalog`: discover, validate, resolve, inspect, and reload named profiles.
- Existing spawn interface extended with optional resolved profile identity while retaining ad hoc calls.
- `WorkspaceManager`: create, lease/rebind, inspect/list, disposition, integrate, and recover guarded workspaces.
- Platform wiring and `/agents` user interface exercised through Pi extension events and tools.

## Phase plan

- [x] 1. Fetch remotes, verify live state, create isolated external worktree.
- [x] 2. Write durable checkpoint.
- [x] 3. Confirm public test seams; read architecture, subagent, and Pi extension interfaces completely.
- [x] 4. Establish baseline and install isolated dependencies. Full `npm run verify` passed: 163 unit, 115 integration plus 22 delegated, 4 POSIX-only skips, smoke, and Pi/Claude/Codex live 4/4.
- [x] 5. Define shared profile/workspace/lease/trust/provenance invariants; recorded domain terms and immutable shared contracts.
- [x] 6. Implement F09 profile catalog and diagnostics in vertical TDD slices. Precedence, provenance, digest/generation, bounds, collision, path material, trust, browser, and reload pass.
- [x] 7. Integrate profiles with Pi/Claude/Codex spawning and retain ad hoc compatibility. Override matrix, backend compilers, host limits, isolation, metadata, and production wiring pass.
- [x] 8. Trial/audit exact pinned `@narumitw/pi-worktree@0.51.5`; rejected adoption after native Windows false-success cleanup reproduction; ADR 0004 recorded.
- [x] 9. Implement `WorkspaceManager`, recovery, and safe Windows cleanup in vertical TDD slices. Create, inspect, fenced lease/renew/rebind, operation guards, preserve/review/abandon, junction detachment, recovery, and fast-forward integration pass.
- [x] 10. Bind isolated profiles to verified workspace leases and surface dispositions.
- [x] 11. Run adversarial security/architecture/backend reviews and fix reproduced findings. Final independent blocker check reports none.
- [x] 12. Complete acceptance, recovery runbook, backend matrix, documentation, measurements, and tracker evidence. Deterministic 167 unit, 145 integration plus 22 delegated, 4 skips, smoke pass; Pi profile 1/1 and Codex 2/2 live pass; Claude final rerun externally quota-blocked after Phase 3 baseline 2/2.
- [x] 13. Re-fetch, publish branch, fast-forward live `main`, and verify live checkout without disturbing dirty state. No dependency additions required.

## Hard gates

- Never recursively delete a worktree.
- Detach Windows junctions before removal and verify shared targets afterward.
- Refuse dirty cleanup without explicit disposition.
- Preserve changed child worktrees after failure.
- Fail closed for untrusted profiles and unsafe resumed workspace identity.
- Prevent isolated children from writing into protected main checkout through Pi tools.
- Keep raw alternate cwd backward compatible and explicitly unisolated.
- Do not mark capability complete without acceptance evidence.
