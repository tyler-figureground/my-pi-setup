# ADR 0007: Build BrowserControl on playwright-core

Status: Accepted
Date: 2026-08-26

## Context

Phase 5 requires a dedicated browser profile, owned pages, AI accessibility references, bounded evidence, origin/private-network policy, cancellation, reliable Windows cleanup, and coexistence with Impeccable sessions. The three requested wrappers each violate at least one hard requirement: external unverified engine coupling and optional origin policy, control of a real authenticated user profile plus current Windows/install defects, or an over-broad young runtime with unsafe defaults and incomplete mutation cancellation.

Research and evidence: `docs/research/phase-5-browser-packages.md`.

## Decision

Build a thin repository-owned `BrowserControl` adapter on exact `playwright-core@1.62.1`.

Use a host-installed Chrome or Edge executable. Never invoke Playwright browser download/install commands automatically. Launch a host-owned dedicated persistent profile, block service workers, expose only owned pages, and keep raw Playwright objects, evaluation, CDP, routes, headers, bodies, and filesystem paths behind the seam.

The repository owns origin/DNS policy, protected-action approval, credential references, output/artifact bounds, diagnostic rings, lifecycle deadlines, profile identity, and Pi wiring. Playwright owns browser protocol, AI ARIA snapshots and `aria-ref` locators, actionability, screenshots, cancellation signals, and browser/context closure.

## Consequences

- Lowest controllable prompt/schema footprint and strongest mature Windows/browser substrate.
- Significant host policy and adapter tests remain necessary.
- Existing browser installation is required; missing executables fail without mutation or download.
- Browser routing is defense in depth, not OS or network containment. Unsupported transports and WebSockets fail closed.

## Rejected alternatives

- `pi-agent-browser-native@0.5.0`: hidden exact external engine/postinstall dependency and incompatible profile/origin controls.
- `pi-browser-harness@0.11.0`: real-user-profile design, eager schema/prompt cost, current Windows/runtime defects, and unsafe script/network surfaces.
- `betterwright@1.10.2`: closest feature fit, but over-broad, young, unsafe network defaults, and incomplete in-flight cancellation.
- Custom CDP: duplicates mature Playwright protocol, refs, waiting, and cleanup.
