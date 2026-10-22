import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Dependencies are hoisted: every extension resolves from the single root
// node_modules tree. Per-extension node_modules directories are intentionally
// not created; they duplicated ~52k files on Windows and made Pi startup spend
// seconds in the module-resolution stat storm (see SETUP.md).
//
// Extension package.json manifests remain as documentation of per-extension
// intent, but versions must be added to the root package.json when introduced.
// Keep effect-family packages on one exact version via the root overrides.

const root = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required");
const operation = process.argv.includes("--ci") ? "ci" : "install";

let extensionsWithDeps = 0;
for (const entry of fs.readdirSync(path.join(root, "extensions"), {
  withFileTypes: true,
})) {
  if (
    entry.isDirectory() &&
    fs.existsSync(
      path.join(root, "extensions", entry.name, "package-lock.json"),
    )
  ) {
    extensionsWithDeps += 1;
  }
}
if (extensionsWithDeps > 0) {
  console.warn(
    `warning: found ${extensionsWithDeps} leftover per-extension lockfile(s); the shared root tree replaces them. Remove per-extension package-lock.json and node_modules files.`,
  );
}

console.log(`==> root ${operation}`);
const result = spawnSync(process.execPath, [npmCli, operation], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
