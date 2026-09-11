# Pi capability platform

Source map for `extensions/platform/`: one Pi extension that composes every
cross-cutting capability (plan mode, hooks, profiles, memory, goals, ...)
behind feature flags. Why it is one extension instead of many:
[ADR-0001](../../docs/adr/0001-platform-composition-root.md). Domain vocabulary
(capitalized terms below): [CONTEXT.md](../../CONTEXT.md).

## How a session starts

1. `index.ts` is the Pi entry point. It calls `createPlatformExtension()` from
   `src/composition.ts`, the composition root.
2. `src/config.ts` loads flags and settings from the global
   `<agentDir>/platform.json` and the trusted project's `.pi/platform.json`.
   `src/flags.ts` defines the flag names; every flag defaults to off.
3. Platform work runs only in the `parent` Execution Role and only when at
   least one flag is on. Child roles (subagent, workflow, review, scheduled,
   goal-worker) never own platform daemons.
4. For each enabled flag, composition calls the matching
   `src/wiring/<capability>.ts` module, which adapts the domain module to Pi
   (tools, commands, renderers, event handlers).

Config dependencies are reported as diagnostics: monitors, scheduler, and
goals need `messaging`; goals also need `profiles`. Memory, messaging,
monitors, scheduler, and goals stay off in untrusted projects.

## Layers

| Layer | Path | Role |
|---|---|---|
| Core | `src/core/` | Phase 1 deep modules shared by everything: LifecycleSupervisor, ProjectIdentity, CapabilityPolicy, StateStore, ArtifactStore |
| Capability | `src/<capability>/` | Domain logic for one capability: model, config parsing, persistence, runtime service |
| Wiring | `src/wiring/<capability>.ts` | Adapts one capability to the Pi extension API: tools, commands, renderers, event handlers |

Within `src/` but outside `src/wiring/`, only `src/composition.ts`, `src/config.ts`, and
`src/messaging/pi-delivery.ts` import the Pi SDK; the rest of the capability
code is independent of it.

## Capability index

| Flag | Code | Key terms | Architecture | ADR |
|---|---|---|---|---|
| (always) | `src/core/` | Execution Role, Lease, State Record, Artifact, Project Identity | [platform-foundation](../../docs/architecture/platform-foundation.md) | [0001](../../docs/adr/0001-platform-composition-root.md), [0002](../../docs/adr/0002-state-store-node-sqlite.md) |
| `planMode` | `src/plan/` | Plan Mode | [phase-2](../../docs/architecture/phase-2-policy-rules-hooks.md) | |
| `rules` | `src/rules/` | Lazy Rule, Context Epoch | [phase-2](../../docs/architecture/phase-2-policy-rules-hooks.md) | |
| `hooks` | `src/automation/hooks/` | Declarative Hook | [phase-2](../../docs/architecture/phase-2-policy-rules-hooks.md), [phase-7](../../docs/architecture/phase-7-automation.md) | [0003](../../docs/adr/0003-build-declarative-hook-core.md), [0009](../../docs/adr/0009-unify-automation-through-trigger-engine.md) |
| `profiles` | `src/profiles/`, `src/agents/` | Agent Profile | [phase-3](../../docs/architecture/phase-3-profiles-workspaces.md) | |
| `workspaces` | `src/workspaces/` | Guarded Workspace, Workspace Disposition | [phase-3](../../docs/architecture/phase-3-profiles-workspaces.md) | [0004](../../docs/adr/0004-build-guarded-workspace-manager.md) |
| `languageIntelligence` | `src/language/` | Language Intelligence | [phase-4](../../docs/architecture/phase-4-language-review.md) | [0005](../../docs/adr/0005-build-persistent-language-intelligence.md) |
| `review` | `src/review/` | Review Target, Local Review, Review Finding | [phase-4](../../docs/architecture/phase-4-language-review.md) | |
| `mcp` | `src/mcp/` | Tool Federation, Federated Tool | [phase-5](../../docs/architecture/phase-5-mcp-browser.md) | [0006](../../docs/adr/0006-build-tool-federation-on-official-mcp-v2.md) |
| `browser` | `src/browser/` | Browser Session, Browser Action, Origin Policy | [phase-5](../../docs/architecture/phase-5-mcp-browser.md) | [0007](../../docs/adr/0007-build-browser-control-on-playwright-core.md) |
| (shared) | `src/external/` | External Integration Control, Credential Reference | [phase-5](../../docs/architecture/phase-5-mcp-browser.md) | |
| `messaging` | `src/messaging/` | Session Presence, Mailbox Message, Delivery Receipt | [phase-6](../../docs/architecture/phase-6-messaging-memory.md) | |
| `memory` | `src/memory/` | Memory, Memory Scope, Contradiction Link | [phase-6](../../docs/architecture/phase-6-messaging-memory.md) | [0008](../../docs/adr/0008-build-persistent-memory-on-node-sqlite-fts5.md) |
| (shared) | `src/automation/triggers/` | Trigger Event, Trigger Binding | [phase-7](../../docs/architecture/phase-7-automation.md) | [0009](../../docs/adr/0009-unify-automation-through-trigger-engine.md) |
| `monitors` | `src/automation/monitors/` | Reactive Monitor | [phase-7](../../docs/architecture/phase-7-automation.md) | [0011](../../docs/adr/0011-wrap-parcel-watcher-and-ws.md) |
| `scheduler` | `src/automation/scheduler/` | Schedule, Schedule Occurrence | [phase-7](../../docs/architecture/phase-7-automation.md) | [0010](../../docs/adr/0010-wrap-cron-parser-as-calendar-calculator.md) |
| `goals` | `src/goals/` | Goal, Goal Node, Goal Attempt, Unknown Attempt | [phase-8](../../docs/architecture/phase-8-goal-mode.md) | |
| `artifacts` | `src/artifacts/` | Artifact Publication, Revocation, Capability Token | [phase-9](../../docs/architecture/phase-9-artifacts.md) | [0012](../../docs/adr/0012-publish-artifacts-through-protected-vercel-previews.md) |

Per-phase settings reference: `docs/phase-<N>-configuration.md`. Threat
models: `docs/security/phase-<N>-threat-model.md`. Acceptance and performance
evidence: `docs/verification/`.

Note: `src/artifacts/` (Phase 9 publication and sharing) is separate from
`src/core/artifacts/` (the Phase 1 content-addressed ArtifactStore it builds
on).

## Tests

Tests sit flat in this folder as `<area>.test.ts` and
`<area>.integration.test.ts`. The `*-worker.ts` files next to them are child
processes that tests spawn to exercise cross-process SQLite, lease, and
cancellation behavior. They are not runtime code.

Run from the repo root: `npm run check` (types), `npm run format:check`,
`npm test` (unit, then integration). `scripts/run-test-suite.mjs` holds an
explicit unit / integration / live / delegated list and refuses to run if any
`*.test.ts` or `*.spec.ts` under `extensions/` is missing from it, so register
new test files there.
