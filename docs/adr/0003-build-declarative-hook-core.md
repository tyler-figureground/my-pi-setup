---
status: accepted
---

# Build declarative hooks behind the platform TriggerEngine

Phase 2 builds its declarative hook core behind the platform `TriggerEngine` interface instead of adopting, wrapping, or porting `pi-yaml-hooks@2026.8.11`.

The package has useful breadth and documentation, but its core execution model is POSIX Bash (`bash -c`). Its Pi adapter explicitly reports that native Windows is unsupported and becomes a no-op. A disposable native-Windows RPC trial confirmed startup, reload, and shutdown exit cleanly only by disabling all hook behavior and printing the unsupported warning on each load. The package also exposes environment-controlled trust/import/auto-approval behavior that does not share this platform's host-bound `ProjectIdentity`, `CapabilityPolicy`, execution-role, and plan-mode authority seams. Its published `test` script performs no consumer tests.

The platform implementation therefore uses:

- `yaml@2.9.0` only for bounded parsing
- plain-data hook definitions and effects at the `TriggerEngine` seam
- structured executable-plus-argument command actions, never implicit shell strings
- host-provided project trust and provenance
- `CapabilityPolicy` as the final authority, so hook allow effects cannot bypass plan-mode denial
- explicit ordering, recursion, timeout, output, failure-policy, and log bounds
- native Windows tests and lifecycle ownership through the existing platform composition root

Rejected alternatives:

- **Adopt:** functional behavior is unavailable on the required native Windows platform.
- **Wrap:** a wrapper cannot replace the package's disabled Windows runtime or safely interpose on every environment-controlled authority decision.
- **Port:** copying a Bash-oriented implementation would import excess surface and preserve the wrong execution model. Reusing documented concepts without copying implementation keeps the platform module deeper and policy-local.

Evidence and package metadata are recorded in `docs/research/pi-yaml-hooks-audit.md` and `docs/research/phase-2-parser-dependencies.md`.
