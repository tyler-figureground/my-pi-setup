import { spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

const changed = new Set([
  ...git(["diff", "--name-only", "--diff-filter=ACMRT", "HEAD"]),
  ...git(["ls-files", "--others", "--exclude-standard"]),
]);
const supported = [...changed].filter((file) =>
  /^(?:extensions\/.*\.(?:ts|cjs|json)|tests\/.*\.(?:ts|cjs|mjs|json)|scripts\/.*\.mjs|[^/]+\.json)$/.test(
    file,
  ),
);

if (supported.length === 0) {
  console.log("No changed Prettier-supported files.");
  process.exit(0);
}

const prettier = path.join(
  root,
  "node_modules",
  "prettier",
  "bin",
  "prettier.cjs",
);
const result = spawnSync(
  process.execPath,
  [prettier, "--write", ...supported],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
