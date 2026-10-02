# Shared Pi configuration

`config/settings.json` and `config/platform.json` are the portable source of truth. Root `settings.json` and `platform.json` are generated, private machine files. Do not force-add them to Git.

## Apply or check

```sh
npm run config:check
npm run config:apply
```

Check reports drift without writing anything. Apply:

- Resolves the current home directory, installed uv, and Chrome/Edge.
- Defaults Pyvoid to `~/Documents/GitHub/Pyvoid` and requires its `mcp_server` directory.
- Replaces platform configuration with the shared template. Machine policy overrides are deliberately unsupported.
- Merges shared settings into existing settings. Shared keys win; unrelated local keys remain.
- Backs up changed destinations under ignored `state/config-backups/`, then replaces each file atomically.
- Never reads or copies authentication, environment secrets, trust state, or conversations.

Missing prerequisites stop the apply before either configuration file changes. Install uv, Chrome/Edge, and Pyvoid first. Revit integration requires Windows, Revit, and the Pyvoid add-in; installing the same config cannot supply those dependencies.

For nonstandard installation locations, create ignored `config/machine.local.json`:

```json
{
  "uv": "D:/Tools/uv.exe",
  "pyvoidRoot": "D:/Source/Pyvoid",
  "browser": "C:/Program Files/Google/Chrome/Application/chrome.exe"
}
```

Only these three keys are accepted; values must be absolute paths. Omit keys that should be auto-detected.

## What stays consistent

Tracked extensions, instructions, themes, bundled skills, Pi dependency versions, model/provider defaults, thinking level, feature flags, tool-effect policies, browser origins, and hook/rule behavior.

The shared Kimi provider package is version-pinned. Pi installs configured packages when resources load; provider login remains local.

## Limits

Authentication and model entitlement must be configured on each computer. Project instructions/settings, existing sessions' model selections, custom local settings, independently installed skills, and Herdr-managed resources can still differ. In particular, this repository does not distribute `~/.agents/skills`, home-level `CLAUDE.md`, or project instructions. Matching this repository gives a common Pi baseline, not identical model responses or identical project context.

Use the same project revision and remove unintended local/project overrides when comparing behavior. Start a new session to use shared startup defaults; `/reload` refreshes extensions in existing sessions but does not reset every session preference.

## Updating shared defaults

Edit the templates, not generated root files. Run config tests and the normal repository checks, then apply locally and commit the templates. Never copy an entire live agent directory into Git: it contains credentials, histories, caches, and machine-specific integration files.

On an older checkout, a modified tracked `platform.json` can prevent Git from pulling this migration. Back it up outside the checkout and verify the backup, then restore only that file to its tracked version before pulling. Do not commit machine configuration to Git history. Do not reapply the obsolete file from a stash after migration. Recreate only needed installation paths in `config/machine.local.json`; `config:apply` renders the new shared policy.
