# ADR 0006: Build ToolFederation on official MCP v2 client packages

Status: Accepted
Date: 2026-08-26

## Context

Phase 5 requires lazy, policy-governed STDIO and Streamable HTTP MCP clients, OAuth, bounded lifecycle, dynamic schemas, and compatibility with Pi plan/child roles. `pi-mcp-adapter@2.29.0` is active and feature-rich, but owns broad config, UI, scripting, credential, MCP Apps, plugin, and load-time lifecycle policy. Its manager also cannot guarantee bounded descendant cleanup by itself. The legacy monolithic `@modelcontextprotocol/sdk@1.30.0` is no longer the current official client architecture.

Research and evidence: `docs/research/phase-5-mcp-packages.md`.

## Decision

Build repository-owned `ToolFederation` and host policy modules on exact:

- `@modelcontextprotocol/client@2.0.0`
- `@modelcontextprotocol/core@2.0.0`

Use `@modelcontextprotocol/server@2.0.0` only for test fixtures. Use `pi-mcp-adapter@2.29.0` as a reviewed MIT behavioral reference and trial oracle, not a runtime dependency. Defer MCP Apps.

The repository owns configuration trust, namespaces, lazy activation, per-tool effects, credential references, OAuth state, artifacts, reconnect ceilings, lifecycle deadlines, and Pi UI. Official packages own MCP framing, protocol negotiation, STDIO, Streamable HTTP, and protocol OAuth primitives.

## Consequences

- Smaller and current protocol dependency surface.
- MCP behavior remains subordinate to existing platform policy and lifecycle.
- More adapter implementation and conformance testing is required here.
- Every dependency upgrade requires source, integrity, lifecycle, Windows, argument-fidelity, OAuth, and process-tree review.
- No claim of OS containment. MCP servers execute with user privileges.

## Rejected alternatives

- Adopt `pi-mcp-adapter` wholesale: broad overlapping policy/lifecycle ownership and fast-moving single-publisher surface.
- Wrap legacy `@modelcontextprotocol/sdk` v1: starts new work on superseded architecture.
- Hand-roll MCP transport: unacceptable protocol/conformance risk.
