# Install and maintain Tyler's Pi setup

## Model

Use `tyler-figureground/my-pi-setup` as the shared source of truth. No additional repository or Pi core fork is needed.

Keep a source checkout outside `~/.pi/agent`. Pi loads its extensions, skills, and themes as a local Pi package. Machine configuration and runtime state stay in `~/.pi/agent`. Do not synchronize the entire agent directory with Git or cloud storage.

The installer is intended for a new computer or an existing Pi installation without this setup's legacy extension directories. It refuses in-place migration rather than delete existing resources or load them twice.

## Prerequisites

- Node.js satisfying `^22.22.2 || ^24.15.0 || >=26.0.0`. Node 24.15+ in the 24.x line is the recommended baseline. The lockfiles require more than Pi's own minimum.
- Git and npm on PATH.
- Windows: Git Bash, `fd`, and `rg` (ripgrep). Run commands below in Git Bash. Install search tools with `winget install sharkdp.fd` and `winget install BurntSushi.ripgrep.MSVC`, then reopen the terminal.
- macOS/Linux: Bash. Search tools can use the extension's supported-platform download fallback, or install `fd` and `ripgrep` with the system package manager.
- Access to the GitHub repository. Authenticate Git first if the repository is private.
- Close Pi before installation or updates. The installer deliberately installs the exact global Pi version from `package.json`, which changes the `pi` command for other setups on that computer too.

## Fresh computer

These commands become available on GitHub only after the installer changes are reviewed and pushed. A release tag must exist before using `--branch <release-tag>`; no release tag is implied by this document.

```sh
mkdir -p ~/src
cd ~/src
git clone https://github.com/tyler-figureground/my-pi-setup.git
cd my-pi-setup
npm run setup -- --dry-run
npm run setup
npm run setup:doctor
npm run test:setup
npm run test:setup:smoke
pi
```

For a tested release, clone with `git clone --branch <release-tag> <repository-url>` instead. Keep the checkout at that location: Pi settings reference its absolute path. Do not use Pi's package updater to update this local package; use the release updater below.

The installer:

1. Validates Node, JSON settings, exact Pi version, legacy extension collisions, and already-registered copies before installation.
2. Runs `npm ci` at the root and in extension packages that have manifests. These commands execute dependency lifecycle scripts; install only reviewed source.
3. Installs the exact global Pi command-line version from `package.json`.
4. Adds the local package to `settings.json`, preserving existing values. Adds the included theme only when no theme is selected.
5. Saves a local backup before modifying existing settings (file mode `0600` where supported; Windows relies on the directory's access permissions). Repeated installation does not rewrite unchanged configuration.
6. Creates `platform.json` from `config/platform.example.json` only if absent. Existing platform configuration is preserved, not merged with new permissions.

`--dry-run` does not run Git, npm, or change files. `--agent-dir <path>` selects another agent directory; launch Pi with `PI_CODING_AGENT_DIR` set to that same path. This flag does not isolate the global Pi command or every extension's legacy home-path behavior.

Installation is not transactional. If dependency installation fails, user configuration is not activated; npm's partial dependency changes may remain. Fix the reported error and rerun. If configuration changes while dependencies install, activation refuses the stale plan. Keep Pi closed and retry.

## Local setup after installation

- **Provider:** run `/login` in Pi, or configure provider environment variables locally. Credentials are never copied by this installer. Use `/summary-model` to select an accessible summary model; the existing default may not be available through your provider.
- **Firecrawl:** optional. Set `FIRECRAWL_API_KEY` in the environment or a private `~/.pi/agent/.env`. Without a key, search tools report a missing-key error when invoked. Never commit the key.
- **Browser:** optional and disabled initially. Set `browser: true`, configure `browserSettings.executablePath` for an existing Chrome/Edge executable, and allow only the origins needed for the task. macOS needs an explicit executable path. See `../phase-5-configuration.md`. Do not copy another machine's cookies, trust decisions, or allowlists.
- **Claude/Codex agents:** optional. Install and authenticate those command-line tools locally if using those backends. Native Pi agents use Pi's configured provider.
- **Agent profiles:** personal named profiles live under `~/.pi/agent/agents/`. Review and install them separately; the package does not invent scheduled-worker permissions.
- **Global instructions and additional skills:** `~/AGENTS.md` and skills outside this repository are not copied. Review and install those separately. The included skills are only those in this checkout's `skills/` directory.
- **Personal integrations:** the package explicitly lists supported extension entry points. The local `herdr-agent-state.ts` integration is intentionally not included.

`setup:doctor` checks Git, local Pi availability, and exact version alignment. It does not authenticate services or prove optional features work. The portable smoke check starts real Pi without a model request in a temporary agent directory and checks package loading, tools, and shutdown.

## Updates

Publish tested tags from the development computer. On another computer, close Pi and run:

```sh
cd ~/src/my-pi-setup
npm run setup:update -- --ref <release-tag>
npm run setup:doctor
npm run test:setup
npm run test:setup:smoke
```

The updater fetches the exact tag from `origin`, refuses tracked or untracked local changes, and refuses to overwrite ignored files when switching to the tag. It checks out the tag without attaching to a branch. It prints the previous commit for recovery and runs the selected release's installer. It never resets, cleans, stashes, or pushes.

This development checkout calls Tyler's remote `fork`, not `origin`. If using it after an explicit migration, pass `--remote fork`. Fresh clones of Tyler's repository use `origin` normally.

Recovery after a failed release installation:

```sh
git switch --detach <previous-commit>
npm run setup
```

The prior release must contain the installer. Existing configuration and databases are not rolled back by this command; review schema migration compatibility before publishing a release. Settings backups live in `~/.pi/agent/setup-backup-*` and may contain private data. Keep them local.

Do not use `pi update --all` as the update strategy for this setup: it can move the global Pi command beyond the generation pinned by the extensions.

## Existing development computer

Current installation lives directly in `~/.pi/agent`; leave it running there during this work. The new installer does not migrate it automatically. A later migration must:

1. Commit only reviewed source changes to Tyler's repository.
2. Create a separate source checkout.
3. Back up personal configuration and runtime data securely.
4. Move legacy extension/skill/theme resources out of auto-discovery without deleting private state. Reconcile explicit settings paths and external skills.
5. Run setup from the separate checkout and verify before removing the backup.

Do not point a second package at the same legacy resources. Do not run `npm ci` against a shared dependency junction.

## Release gates

Before creating or pushing a tag:

- Fetch Tyler's remote and report ahead/behind counts.
- Review all local changes, including pre-existing browser and agent changes. No blanket `git add .`.
- Resolve the existing deleted `AGENTS.md` intentionally.
- Review the staged removal of legacy `platform.json` from Git. Its local contents are preserved and now ignored; only `config/platform.example.json` supplies new installations. Existing in-place users should back up their local platform file before pulling this migration, since Git removes previously tracked files on update.
- Audit tracked files and history for credentials, browser state, sessions, machine paths, and external dependencies. Ignore rules do not remove already-tracked data or history.
- Run `npm run check`, formatting checks, `npm test`, `npm run test:setup:smoke`, and applicable live-backend checks. Record skips as unrun, not passed.
- Validate a clean dependency installation and fresh-home smoke on every supported operating system before claiming support. Windows-only validation is not cross-platform certification.
- Document schema migrations and rollback compatibility. Commit reviewed changes, rerun any commit-bound checks, then create a versioned release tag.

## Private state boundary

Never commit `auth.json`, `.env`, `settings.json`, `trust.json`, models credentials/configuration, sessions, state databases, workflows, plans, browser profiles, workspaces, artifacts, or setup backups. Shared settings belong in reviewed templates, not copies of live files.
