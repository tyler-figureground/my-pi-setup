# Phase 4 configuration

## Feature flags

Both capabilities default off in code. Enable in user or trusted-project `platform.json`:

```json
{
  "languageIntelligence": true,
  "review": true
}
```

Project configuration is ignored until Pi trusts the project.

## Language servers

Without `languageServers`, Phase 4 uses:

- TypeScript and JavaScript: `typescript-language-server@6.0.0` with pinned `typescript@5.9.3`
- Python diagnostics: `ruff server` when Ruff is available on `PATH`

Custom configuration replaces the built-in catalog:

```json
{
  "languageIntelligence": true,
  "languageServers": [
    {
      "id": "ruff",
      "command": {
        "argv": ["ruff", "server"],
        "env": { "RUFF_TRACE": "off" }
      },
      "selectors": [
        { "languageId": "python", "extensions": [".py", ".pyi"] }
      ],
      "queries": ["diagnostics"],
      "initializationOptions": {},
      "settings": {}
    }
  ]
}
```

Rules:

- Maximum four servers.
- Commands are argv arrays. Shell strings are rejected.
- Project commands require project trust.
- Config loading does not start a process.
- `language_tools` discovers routes and activates only matching deferred tools.
- LSP line and character positions are zero-based UTF-16 positions.
- Language results are advisory. Native build, typecheck, lint, and tests remain authoritative.

Deferred tools:

- `lsp_diagnostics`
- `lsp_symbols`
- `lsp_navigate`
- `lsp_hover`
- `lsp_call_hierarchy`

## Local review

Command forms:

```text
/review
/review uncommitted
/review base [remote/branch]
/review commit <revision>
/review range <from> <to> [merge-base]
/review <target> --second
/review <target> --tests
/review <target> --allow-stale
/review cancel
```

No argument opens a target picker in TUI or RPC mode. Print and JSON modes reject `/review` because they cannot expose the bounded result and artifact ID.

Options:

- `--second`: independent second Pi reviewer, then host validation and deterministic deduplication.
- `--tests`: run the repository's declared `test` script in a disposable archived snapshot. Parent dependencies are never linked into the snapshot. Tests requiring installed dependencies may report unavailable or fail unless their command can run from archived content.
- `--allow-stale`: continue only when fetch fails and an existing remote-tracking ref is available. Result shows freshness as unknown.

Reviewer properties:

- Host-managed `review` role.
- Empty tool allowlist.
- Project context files disabled.
- Project settings/resources disabled.
- Strict JSON output with bounded findings.
- Git diff, immutable file layers, optional LSP diagnostics, and optional disposable test output supplied as evidence.

Full JSON artifacts live outside the source repository:

- Windows: `%LOCALAPPDATA%/pi-agent/artifacts`
- POSIX: `$XDG_STATE_HOME/pi-agent/artifacts` or `~/.local/state/pi-agent/artifacts`

## Rollback

Set either flag to `false`, then `/reload`:

```json
{
  "languageIntelligence": false,
  "review": false
}
```

Shutdown closes language servers, aborts active review, removes deferred language tools, and leaves immutable artifacts available for inspection.
