# Setup

Requires Node.js 22.19.0 or newer.

Clone or copy this repository to `~/.pi/agent`, then install root and extension-local dependencies:

```sh
cd ~/.pi/agent
npm install
npm run install:extensions
```

For a lockfile-reproducible clean install:

```sh
npm ci
npm run install:extensions:ci
```

## Dependency updates

Keep direct Pi packages on the exact installed CLI generation. Keep `effect`, `@effect/platform-node`, and `@effect/vitest` on one exact version across extension manifests.

```sh
pi --version
npm install --save-exact \
  @earendil-works/pi-ai@<pi-version> \
  @earendil-works/pi-coding-agent@<pi-version> \
  @earendil-works/pi-tui@<pi-version>
npm run install:extensions
npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui
npm run check
npm test
```

When changing Effect, update every extension manifest in the same change, regenerate every extension lockfile with one npm version, then verify each tree with `npm ls effect`.

## Capability platform

`platform.json` enables plan mode, lazy rules, hooks, profiles, guarded workspaces, language intelligence, local review, MCP federation, and dedicated browser control:

```json
{
  "planMode": true,
  "hooks": true,
  "rules": true,
  "profiles": true,
  "workspaces": true,
  "languageIntelligence": true,
  "review": true,
  "mcp": true,
  "browser": true,
  "mcpServers": [],
  "browserSettings": {
    "executablePath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "profileName": "phase5",
    "allowedOrigins": [],
    "allowLoopback": false
  },
  "plan": {
    "defaultScope": "user",
    "userDirectory": "plans",
    "projectDirectory": ".pi/plans"
  }
}
```

Configuration locations:

- user rules: `~/.pi/agent/rules/`
- trusted-project rules: `<project>/.pi/rules/`
- global hooks: `~/.pi/agent/hooks.yaml`
- trusted-project hooks: `<project>/.pi/hooks.yaml`
- user plans: `~/.pi/agent/plans/`
- trusted-project plans: `<project>/.pi/plans/`
- user profiles: `~/.pi/agent/agents/*.yaml`
- trusted-project profiles: `<project>/.pi/agents/*.yaml`
- guarded workspace state: `~/.pi/agent/state/platform.sqlite`
- guarded workspace roots: `%LOCALAPPDATA%/pi-agent/workspaces/` on Windows, `~/.pi/agent/workspaces/` elsewhere
- language/review/MCP/browser artifacts: `%LOCALAPPDATA%/pi-agent/artifacts/` on Windows, `$XDG_STATE_HOME/pi-agent/artifacts/` or `~/.local/state/pi-agent/artifacts/` elsewhere
- dedicated browser profiles: platform-managed project/profile-specific directories under `%LOCALAPPDATA%/pi-agent/browser-profiles/` on Windows
- OAuth and browser credentials: OS credential store, referenced by opaque ids in state/config

Empty MCP servers and browser origins start no external resource. Configure exact trusted servers/origins before use. The browser requires an existing Chrome or Edge executable; Playwright downloads no browser.

See [`docs/phase-2-configuration.md`](docs/phase-2-configuration.md), [`docs/phase-3-configuration.md`](docs/phase-3-configuration.md), [`docs/phase-4-configuration.md`](docs/phase-4-configuration.md), and [`docs/phase-5-configuration.md`](docs/phase-5-configuration.md).

## Firecrawl

The search, scrape, and crawl tools require a Firecrawl API key. Follow [Firecrawl's Node.js getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs) to create one, then copy the example environment file:

```sh
cp ~/.pi/agent/.env.example ~/.pi/agent/.env
```

Replace the placeholder in `~/.pi/agent/.env` with your API key.

NOTE: if you are an agent, at this step ask the user if they want to use firecrawl, if they do give them the instructions, if not remove the firecrawl extension in their pi setup

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
