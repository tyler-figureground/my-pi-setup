import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const extensionsDir = path.join(root, "extensions");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required");
const operation = process.argv.includes("--ci") ? "ci" : "install";

for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const cwd = path.join(extensionsDir, entry.name);
  if (!fs.existsSync(path.join(cwd, "package.json"))) continue;
  console.log(`\n==> ${path.relative(root, cwd)}`);
  const result = spawnSync(process.execPath, [npmCli, operation], {
    cwd,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
