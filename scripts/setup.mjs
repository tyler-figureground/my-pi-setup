import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(import.meta.dirname, "..");
const cliPackage = "@earendil-works/pi-coding-agent";

function readObject(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected JSON object: ${file}`);
  }
  return value;
}

export function assertNode(version = process.versions.node) {
  const [major, minor, patch] = version.split(".").map(Number);
  const supported =
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
    (major === 24 && minor >= 15) ||
    major >= 26;
  if (!supported) {
    throw new Error(
      "Node.js ^22.22.2, ^24.15.0, or >=26.0.0 is required by locked dependencies.",
    );
  }
}

export function run(command, args, cwd = repository, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}).${capture ? `\n${result.stderr}` : ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

export function planInstall(root, agentDir) {
  root = fs.realpathSync(root);
  agentDir = path.resolve(agentDir);
  const existingAgentDir = fs.existsSync(agentDir)
    ? fs.realpathSync(agentDir)
    : agentDir;
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };
  if (contains(existingAgentDir, root) || contains(root, existingAgentDir)) {
    throw new Error(
      "Keep the source checkout outside the Pi agent directory; neither directory may contain the other. Existing in-place installations require manual migration; nothing was changed.",
    );
  }
  const manifest = readObject(path.join(root, "package.json"));
  const version = manifest.dependencies?.[cliPackage];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Pi must have an exact release version in package.json.");
  }
  const settingsPath = path.join(agentDir, "settings.json");
  const original = fs.existsSync(settingsPath)
    ? fs.readFileSync(settingsPath, "utf8")
    : undefined;
  const settings = original === undefined ? {} : readObject(settingsPath);
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
    throw new Error("settings.json packages must be an array.");
  }
  for (const resource of manifest.pi.extensions) {
    const legacyPath = path.join(
      agentDir,
      "extensions",
      path.basename(resource),
    );
    if (fs.existsSync(legacyPath)) {
      throw new Error(
        `Existing extension would load twice: ${legacyPath}. Migrate the legacy installation first.`,
      );
    }
  }
  const source = root.replaceAll("\\", "/");
  const packages = settings.packages ?? [];
  let installed = false;
  for (const entry of packages) {
    const value = typeof entry === "string" ? entry : entry?.source;
    if (typeof value !== "string")
      throw new Error("Each settings package needs a string source.");
    const candidate = path.resolve(
      agentDir,
      value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value,
    );
    const local = fs.existsSync(candidate)
      ? fs.realpathSync(candidate)
      : undefined;
    if (local === root) {
      installed = true;
      continue;
    }
    const localManifest = local && path.join(local, "package.json");
    const sameName =
      localManifest &&
      fs.existsSync(localManifest) &&
      readObject(localManifest).name === manifest.name &&
      manifest.name;
    const knownRemote =
      /github\.com[/:](?:tyler-figureground|davis7dotsh)\/my-pi-setup(?:\.git)?(?:@[^\s]+)?\/?$/.test(
        value,
      );
    const legacySetup =
      local &&
      ["ask-user", "platform", "subagents", "workflows"].every((name) =>
        fs.existsSync(path.join(local, "extensions", name, "index.ts")),
      );
    if (sameName || knownRemote || legacySetup) {
      throw new Error(
        `Another copy of this setup is already registered: ${value}. Migrate its settings entry before installing this checkout.`,
      );
    }
  }
  if (!installed) settings.packages = [...packages, source];
  settings.theme ??= "github-dark-default";
  const files = [];
  const settingsContent = `${JSON.stringify(settings, null, 2)}\n`;
  if (
    original === undefined ||
    JSON.stringify(JSON.parse(original)) !== JSON.stringify(settings)
  ) {
    files.push({ path: settingsPath, content: settingsContent, original });
  }
  const platformPath = path.join(agentDir, "platform.json");
  if (fs.existsSync(platformPath)) readObject(platformPath);
  else
    files.push({
      path: platformPath,
      content: fs.readFileSync(
        path.join(root, "config/platform.example.json"),
        "utf8",
      ),
      original: undefined,
    });
  return { root, agentDir, version, files };
}

export function applyPlan(plan) {
  fs.mkdirSync(plan.agentDir, { recursive: true });
  // Refuse stale plans before any configuration write.
  for (const file of plan.files) {
    const current = fs.existsSync(file.path)
      ? fs.readFileSync(file.path, "utf8")
      : undefined;
    if (current !== file.original)
      throw new Error(
        `Configuration changed during installation: ${file.path}. Retry with Pi closed.`,
      );
  }
  let backupDir;
  for (const file of plan.files) {
    if (file.original !== undefined) {
      backupDir ??= fs.mkdtempSync(path.join(plan.agentDir, "setup-backup-"));
      fs.writeFileSync(
        path.join(backupDir, path.basename(file.path)),
        file.original,
        { flag: "wx", mode: 0o600 },
      );
    }
    const temporary = `${file.path}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, file.content, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file.path);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return backupDir;
}

export function updateCheckout(root, ref, remote = "origin", execute = run) {
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)) {
    throw new Error(
      "Update requires --ref <release-tag> (letters, digits, dots, underscores, hyphens).",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote))
    throw new Error("Invalid remote name.");
  // Fetch first, then survey. No reset, clean, stash, or overwrite of local work.
  execute("git", ["fetch", remote, `refs/tags/${ref}:refs/tags/${ref}`], root);
  const dirty = execute(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    root,
    true,
  );
  if (dirty)
    throw new Error(
      "Checkout has local changes. Commit or move them before updating; no files were overwritten.",
    );
  const previous = execute("git", ["rev-parse", "HEAD"], root, true);
  execute(
    "git",
    ["switch", "--no-overwrite-ignore", "--detach", `refs/tags/${ref}`],
    root,
  );
  return previous;
}

function options(argv) {
  const result = {
    action: argv[0],
    dryRun: false,
    agentDir:
      process.env.PI_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".pi", "agent"),
    remote: "origin",
  };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--dry-run") result.dryRun = true;
    else if (["--agent-dir", "--ref", "--remote"].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${flag}`);
      result[flag === "--agent-dir" ? "agentDir" : flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!["install", "doctor", "update"].includes(result.action))
    throw new Error("Use install, doctor, or update.");
  return result;
}

function npm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli)
    throw new Error("Run through npm: npm run setup (or setup:update).");
  run(process.execPath, [npmCli, ...args]);
}

export function main(argv = process.argv.slice(2)) {
  assertNode();
  const opts = options(argv);
  if (opts.action === "doctor") {
    const manifest = readObject(path.join(repository, "package.json"));
    run("git", ["--version"]);
    run(process.execPath, [
      path.join(repository, "node_modules", cliPackage, "dist/bundle/cli.js"),
      "--version",
    ]);
    console.log(`Expected Pi: ${manifest.dependencies[cliPackage]}`);
    const installed = readObject(
      path.join(repository, "node_modules", cliPackage, "package.json"),
    );
    if (installed.version !== manifest.dependencies[cliPackage])
      throw new Error(
        "Installed Pi version differs from package.json. Run npm run setup.",
      );
    console.log(`Agent directory: ${path.resolve(opts.agentDir)}`);
    console.log(
      "Optional prerequisites: Chrome/Edge for browser; Claude/Codex CLIs for those backends; provider login; Firecrawl key. Configure these locally.",
    );
    return;
  }
  let plan = planInstall(repository, opts.agentDir);
  console.log(
    `Source: ${plan.root}\nAgent directory: ${plan.agentDir}\nPi version: ${plan.version}`,
  );
  if (opts.dryRun) {
    if (opts.action === "update")
      throw new Error(
        "For update previews, fetch and inspect the release manually. --dry-run applies to install only.",
      );
    console.log(
      "Would install locked root/extension dependencies and the pinned global Pi CLI.",
    );
    for (const file of plan.files)
      console.log(
        `${file.original === undefined ? "Create" : "Back up and merge"}: ${file.path}`,
      );
    console.log("No changes made.");
    return;
  }
  if (!process.env.npm_execpath)
    throw new Error("Run through npm run setup or npm run setup:update.");
  run("git", ["--version"]);
  if (opts.action === "update") {
    const previous = updateCheckout(repository, opts.ref, opts.remote);
    console.log(
      `Previous revision: ${previous}. Recovery: git switch --detach ${previous}, then npm run setup.`,
    );
    // Run the installer from the selected release, not this older in-memory version.
    npm(["run", "setup", "--", "--agent-dir", plan.agentDir]);
    return;
  }
  npm(["ci"]);
  npm(["run", "install:extensions:ci"]);
  npm([
    "install",
    "--global",
    "--ignore-scripts",
    `${cliPackage}@${plan.version}`,
  ]);
  const backup = applyPlan(plan);
  console.log(
    backup
      ? `Settings backup: ${backup}`
      : "No existing configuration replaced.",
  );
  console.log(
    "Installed. Restart Pi; use /login for your provider. Browser is disabled on fresh installs until configured locally.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
