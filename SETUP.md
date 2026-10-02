# Setup

Requires Node.js 22.19.0 or newer. Use the `main` branch of `https://github.com/tyler-figureground/my-pi-setup` on every computer.

## Sync another computer

Clone to `~/.pi/agent` on a new computer. For an existing checkout, preserve local source edits on a separate branch or stash before switching branches. Back up machine configuration outside Git instead of committing it; see the migration notes below. Never overwrite an existing agent directory.

```sh
cd ~/.pi/agent
git fetch origin
git switch main
git pull --ff-only origin main
npm ci --ignore-scripts
npm run install:extensions:ci
npm run config:apply
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
npm run config:check
```

Install uv, Chrome/Edge, and clone Pyvoid first. See [`config/README.md`](config/README.md) for machine-path overrides, migration from tracked `platform.json`, backups, and parity limits. Run the block again after future updates, using the CLI version pinned in the root `package.json`. Authenticate providers locally with `/login`; no credentials are synced.

Restart Pi afterward. Existing sessions can `/reload` for code changes; start a new session for shared model/thinking defaults. These commands update this computer only; run them on each other computer.

## Dependencies only

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

`config/platform.json` is the shared template; `npm run config:apply` generates the private root `platform.json`. The current baseline disables Reactive Monitors and includes the Pyvoid tool server and approved browser origins. Refer to that template for current values; the following is a generic capability example:

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
  "messaging": true,
  "memory": true,
  "monitors": true,
  "scheduler": true,
  "goals": true,
  "artifacts": true,
  "mcpServers": [],
  "browserSettings": {
    "executablePath": "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "profileName": "phase5",
    "allowedOrigins": [],
    "allowLoopback": false
  },
  "messagingSettings": {
    "discoverableBy": "same-project",
    "acceptsFrom": "same-project"
  },
  "memorySettings": {
    "defaultScope": "project",
    "automaticRecall": false,
    "automaticExtraction": false
  },
  "monitorSettings": {
    "maxActive": 128,
    "maxRemote": 16,
    "batchWindowMs": 250,
    "pollMinimumMs": 5000,
    "allowedWebSocketOrigins": [],
    "allowLoopback": false,
    "pollTargets": []
  },
  "schedulerSettings": {
    "maxSchedules": 1000,
    "maxConcurrent": 4,
    "defaultTimeoutMs": 900000,
    "leaseTtlMs": 60000
  },
  "artifactSettings": {
    "defaultExpiryMs": 3600000,
    "maxExpiryMs": 604800000
  },
  "goalSettings": {
    "maxGoals": 100,
    "maxNodesPerGoal": 32,
    "maxConcurrentNodes": 4,
    "maxAgentCalls": 256,
    "maxRuntimeMs": 21600000,
    "defaultConcurrency": 2,
    "defaultAgentCalls": 8,
    "defaultTimeoutMs": 900000,
    "defaultMaxAttempts": 3,
    "defaultRetryDelayMs": 30000,
    "defaultOutputBytes": 262144,
    "leaseTtlMs": 300000
  },
  "hookActions": {
    "http": [],
    "mcp": []
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
- guarded workspace, mailbox, Trigger, Monitor, Schedule, and Goal state: `~/.pi/agent/state/platform.sqlite`
- persistent Memory state and FTS index: `~/.pi/agent/state/memory.sqlite`
- guarded workspace roots: `%LOCALAPPDATA%/pi-agent/workspaces/` on Windows, `~/.pi/agent/workspaces/` elsewhere
- language/review/MCP/browser/message/Monitor/Schedule/Goal/Workflow/shareable/export Artifacts: Project Identity-namespaced directories under `%LOCALAPPDATA%/pi-agent/artifacts/projects/` on Windows, `$XDG_STATE_HOME/pi-agent/artifacts/projects/` or `~/.local/state/pi-agent/artifacts/projects/` elsewhere
- dedicated browser profiles: platform-managed project/profile-specific directories under `%LOCALAPPDATA%/pi-agent/browser-profiles/` on Windows
- OAuth, browser, and Artifact publisher credentials: OS credential store, referenced by opaque ids in state/config

Empty MCP servers, browser origins, Monitor definitions, poll targets, WebSocket origins, Schedules, Goals, and Artifact remote-provider settings start no external resource. Configure exact trusted servers/origins before use. The browser requires an existing Chrome or Edge executable; Playwright downloads no browser. Reactive Monitors, Scheduled Prompts, and Goal Mode require an active Session Broker. Scheduled Prompts require a named profile with role `scheduled`; Goal nodes require role `goal-worker`.

See [`docs/phase-2-configuration.md`](docs/phase-2-configuration.md), [`docs/phase-3-configuration.md`](docs/phase-3-configuration.md), [`docs/phase-4-configuration.md`](docs/phase-4-configuration.md), [`docs/phase-5-configuration.md`](docs/phase-5-configuration.md), [`docs/phase-6-configuration.md`](docs/phase-6-configuration.md), [`docs/phase-7-configuration.md`](docs/phase-7-configuration.md), [`docs/phase-8-configuration.md`](docs/phase-8-configuration.md), and [`docs/phase-9-configuration.md`](docs/phase-9-configuration.md).

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

`npm run config:apply` sets the included theme and shared model defaults while keeping unrelated local settings. The equivalent theme setting is:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
