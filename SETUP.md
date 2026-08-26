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

`platform.json` enables read-only plan mode, path-scoped lazy rules, and declarative hooks:

```json
{
  "planMode": true,
  "hooks": true,
  "rules": true,
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

See [`docs/phase-2-configuration.md`](docs/phase-2-configuration.md) for formats, commands, security limits, and rollback.

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
