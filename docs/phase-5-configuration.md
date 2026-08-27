# Phase 5 configuration

Phase 5 config lives in user `platform.json` and trusted-project `.pi/platform.json`. Project config is ignored until Pi trust is active. Secrets are never literal config values.

## Safe unconfigured defaults

```json
{
  "mcp": true,
  "browser": true,
  "mcpServers": [],
  "browserSettings": {
    "executablePath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "profileName": "phase5",
    "allowedOrigins": [],
    "allowLoopback": false
  }
}
```

This registers status/loader tools but starts no transport or browser. Empty browser origins deny every navigation.

## MCP STDIO

```json
{
  "mcpServers": [
    {
      "id": "docs",
      "transport": {
        "kind": "stdio",
        "command": "node",
        "args": ["C:/trusted/mcp/docs-server.mjs"],
        "env": {
          "DOCS_API_KEY": "${DOCS_API_KEY}"
        }
      },
      "protocol": "auto",
      "tools": {
        "include": ["search_*", "read_*"],
        "exclude": ["*_delete"],
        "effects": {
          "search_docs": "read",
          "read_doc": "read"
        }
      }
    }
  ]
}
```

STDIO environment references and all credential configuration are user-managed only. Project config may define trusted commands but cannot request environment secrets. Unknown tool effects default to protected remote write.

## MCP HTTP bearer

```json
{
  "mcpServers": [
    {
      "id": "issues",
      "transport": {
        "kind": "http",
        "url": "https://mcp.example.com/mcp",
        "allowedOrigins": ["https://mcp.example.com"]
      },
      "credentialReference": "credential:opaque-reference",
      "tools": {
        "include": ["*"],
        "exclude": [],
        "effects": {
          "list_issues": "network-read",
          "create_issue": "remote-write"
        }
      }
    }
  ]
}
```

Bearer credentials require HTTPS. References resolve only for exact server id, origin, and credential scope.

## MCP OAuth

OAuth entries are accepted only from user config:

```json
{
  "mcpServers": [
    {
      "id": "oauth-docs",
      "transport": {
        "kind": "http",
        "url": "https://mcp.example.com/mcp",
        "allowedOrigins": ["https://mcp.example.com"]
      },
      "oauth": {
        "authorizationServer": "https://auth.example.com",
        "redirectUri": "http://127.0.0.1:3118/callback",
        "clientId": "pi-phase5",
        "scopes": ["tools.read"]
      }
    }
  ]
}
```

Commands:

- `/mcp` or `/mcp status`
- `/mcp auth <server>`
- `/mcp complete <server> <full-loopback-redirect-url>`
- `/mcp refresh <server>`
- `/mcp logout <server>`

Authorization URLs and callback codes stay in direct UI/command handling, not model output. OAuth tokens persist in the OS credential store. State, verifier, and authorization code never persist.

## Browser

```json
{
  "browserSettings": {
    "executablePath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "profileName": "phase5",
    "allowedOrigins": [
      "http://127.0.0.1:5173",
      "https://staging.example.com"
    ],
    "allowLoopback": true
  }
}
```

Executable path and profile name are user-managed. Trusted-project config may add exact origins and enable loopback for a local dev server, but cannot redirect the platform to another profile. The production profile path is additionally scoped by agent directory and stable project identity.

Tools:

- `browser_pages`
- `browser_observe`: `snapshot`, `screenshot`, `console`, `page-errors`, `network`
- `browser_action`: `open`, `close`, `navigate`, `click`, `fill`, `select`, `key`, `scroll`, `wait`, `upload`, `download`

All DOM interactions require one scope-bound direct approval. Open/navigate are allowlisted reads. Wait is read-only. Password fields require an opaque credential reference. Upload accepts an artifact id, never a local path. Download and screenshot return artifact ids. After any credential fill, screenshot and download operations fail closed for the rest of that browser session because arbitrary secret pixels and bytes cannot be reliably redacted.

To provision a password without placing it in command arguments or session text, launch Pi with a one-time environment variable and run:

```text
/browser credential-store https://app.example.com MY_ONE_TIME_PASSWORD
```

The handler removes the environment value immediately after reading it and returns an opaque reference. Remove it with:

```text
/browser credential-remove credential:opaque-reference https://app.example.com
```

## Offline and plan modes

`PI_OFFLINE=1` denies MCP HTTP/OAuth and browser network operations. STDIO search is also unavailable in plan mode because starting a process is side-effecting. Plan mode allows browser page listing and existing-page observations while denying browser actions and unknown dynamic MCP tools.

## Rollback

Set either flag to `false`, then `/reload`:

```json
{
  "mcp": false,
  "browser": false
}
```

Disabling does not delete credentials, browser profiles, or artifacts. OAuth logout revokes and removes a credential explicitly.
