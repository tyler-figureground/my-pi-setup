import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(import.meta.dirname, "..");

async function readObject(file, optional = false) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error(`Expected a JSON object: ${file}`);
    return value;
  } catch (error) {
    if (optional && error.code === "ENOENT") return {};
    throw error;
  }
}

// Overrides are deliberately limited to installation paths, not policy.
export function resolveMachinePaths({
  home = homedir(),
  platform = process.platform,
  env = process.env,
  overrides = {},
  exists = existsSync,
} = {}) {
  const unknown = Object.keys(overrides).filter(
    (key) => !["uv", "pyvoidRoot", "browser"].includes(key),
  );
  if (unknown.length)
    throw new Error(`Unknown machine setting: ${unknown.join(", ")}`);
  const p = platform === "win32" ? path.win32 : path.posix;
  const absolute = (value) =>
    p.isAbsolute(value) &&
    (platform !== "win32" || p.parse(value).root.length > 1);
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || !value.trim() || !absolute(value))
      throw new Error(`Invalid machine path (must be absolute): ${key}`);
  }
  const join = (...parts) => p.join(...parts).replaceAll("\\", "/");
  const first = (candidates) =>
    candidates.find((candidate) => candidate && exists(candidate));
  const uvName = platform === "win32" ? "uv.exe" : "uv";
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const pathUv = (env[pathKey] ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(absolute)
    .map((directory) => join(directory, uvName));
  const uv =
    overrides.uv ??
    first([
      ...pathUv,
      join(home, ".local", "bin", uvName),
      join(home, ".cargo", "bin", uvName),
      ...(platform === "win32"
        ? [
            join(
              env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
              "hermes",
              "bin",
              uvName,
            ),
          ]
        : []),
    ]);
  const browserCandidates =
    platform === "win32"
      ? [
          join(
            env.PROGRAMFILES ?? "C:/Program Files",
            "Google/Chrome/Application/chrome.exe",
          ),
          join(
            env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)",
            "Google/Chrome/Application/chrome.exe",
          ),
          join(
            env.LOCALAPPDATA ?? join(home, "AppData/Local"),
            "Google/Chrome/Application/chrome.exe",
          ),
          join(
            env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)",
            "Microsoft/Edge/Application/msedge.exe",
          ),
        ]
      : platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ];
  const browser = overrides.browser ?? first(browserCandidates);
  const pyvoidRoot =
    overrides.pyvoidRoot ?? join(home, "Documents/GitHub/Pyvoid");
  if (!uv || !exists(uv))
    throw new Error("Install uv or set uv in config/machine.local.json.");
  if (!browser || !exists(browser))
    throw new Error(
      "Install Chrome/Edge or set browser in config/machine.local.json.",
    );
  if (!exists(join(pyvoidRoot, "mcp_server")))
    throw new Error(
      "Clone Pyvoid or set pyvoidRoot in config/machine.local.json.",
    );
  return {
    UV: uv,
    BROWSER: browser,
    PYVOID_ROOT: pyvoidRoot.replaceAll("\\", "/"),
  };
}

export function renderTemplate(value, replacements) {
  if (typeof value === "string")
    return value.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(replacements, key))
        throw new Error(`Unknown config placeholder: ${key}`);
      return replacements[key];
    });
  if (Array.isArray(value))
    return value.map((entry) => renderTemplate(entry, replacements));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        renderTemplate(entry, replacements),
      ]),
    );
  return value;
}

export async function writeJsonAtomic(file, value) {
  const content = JSON.stringify(value, null, 2) + "\n";
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function syncConfig({
  directory = root,
  apply = false,
  machine = {},
} = {}) {
  const overrides = await readObject(
    path.join(directory, "config/machine.local.json"),
    true,
  );
  const replacements = resolveMachinePaths({ ...machine, overrides });
  const sharedSettings = await readObject(
    path.join(directory, "config/settings.json"),
  );
  const sharedPlatform = await readObject(
    path.join(directory, "config/platform.json"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const platformPath = path.join(directory, "platform.json");
  const settings = await readObject(settingsPath, true);
  const platform = await readObject(platformPath, true);
  const expected = [
    {
      file: settingsPath,
      current: settings,
      value: { ...settings, ...sharedSettings },
    },
    {
      file: platformPath,
      current: platform,
      value: renderTemplate(sharedPlatform, replacements),
    },
  ];
  const changed = expected.filter(
    ({ file, current, value }) =>
      !existsSync(file) || !isDeepStrictEqual(current, value),
  );
  if (apply && changed.length) {
    const backup = path.join(
      directory,
      "state/config-backups",
      new Date().toISOString().replaceAll(":", "-") + `-${randomUUID()}`,
    );
    await mkdir(backup, { recursive: true, mode: 0o700 });
    // Back up all existing destinations before making any change. Never read
    // or copy auth.json, .env, trust databases, or session history.
    for (const { file } of changed) {
      if (existsSync(file))
        await copyFile(file, path.join(backup, path.basename(file)));
    }
    for (const { file, value } of changed) await writeJsonAtomic(file, value);
  }
  return changed.map(({ file }) => path.basename(file));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !["--check", "--apply"].includes(args[0]))
      throw new Error("Usage: node scripts/sync-config.mjs --check|--apply");
    const apply = args[0] === "--apply";
    const changed = await syncConfig({ apply });
    console.log(
      changed.length
        ? `${apply ? "Updated" : "Drift"}: ${changed.join(", ")}`
        : "Shared Pi config is current.",
    );
    if (!apply && changed.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
