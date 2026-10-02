// One-off reclaim of state/platform.sqlite disk space.
//
// Session-broker heartbeat receipts used to be retained for 24 hours, which
// grew the transactions table to ~190k rows (~740 MB of pages). Messaging
// maintenance now prunes them after one hour, but SQLite keeps the freed pages
// (auto_vacuum is off), so the file does not shrink on its own.
//
// Usage (every pi window must be closed first):
//   node scripts/compact-state.mjs            report only
//   node scripts/compact-state.mjs --apply    prune stale heartbeats, VACUUM
//   --database <file>                         operate on a copy instead
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repository = path.resolve(import.meta.dirname, "..");
const liveDatabase = path.join(repository, "state", "platform.sqlite");
const databaseFlag = process.argv.indexOf("--database");
const database =
  databaseFlag === -1
    ? liveDatabase
    : path.resolve(process.argv[databaseFlag + 1] ?? "");
const apply = process.argv.includes("--apply");
// Mirrors HEARTBEAT_TRANSACTION_PREFIX / HEARTBEAT_RECEIPT_RETENTION_MS in
// extensions/platform/src/messaging/index.ts.
const heartbeatPrefix = "session-broker.heartbeat:";
const heartbeatRetentionMs = 60 * 60 * 1_000;

function megabytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileSizes() {
  let total = 0;
  const parts = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = database + suffix;
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    total += size;
    parts.push(`${path.basename(file)} ${megabytes(size)}`);
  }
  return { total, text: parts.join(", ") };
}

function runningPiProcesses() {
  if (process.platform !== "win32") {
    const result = spawnSync("pgrep", ["-af", "pi(\\.js)?( |$)"], {
      encoding: "utf8",
    });
    return result.stdout
      .split("\n")
      .filter((line) => line.trim() && !line.includes("compact-state"));
  }
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -match '[\\\\/]pi\\.js' } | " +
    "ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not check for running pi processes: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.trim());
}

if (!fs.existsSync(database)) {
  console.log(`No state database at ${database}`);
  process.exit(0);
}

// Live pi sessions write heartbeats every few seconds; a VACUUM would block
// them past their 20 s lease TTL. Copies are nobody's live store.
const running = database === liveDatabase ? runningPiProcesses() : [];
if (running.length > 0) {
  console.error(
    `Refusing to touch ${database}: ${running.length} pi process(es) still running.`,
  );
  for (const line of running) console.error(`  ${line.slice(0, 160)}`);
  console.error("Close every pi window, then re-run.");
  process.exit(2);
}

const before = fileSizes();
const db = new DatabaseSync(database, { readOnly: !apply });
try {
  const pragma = (name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
  const pageSize = pragma("page_size");
  const cutoff = Date.now() - heartbeatRetentionMs;
  const stale = db
    .prepare(
      "SELECT COUNT(*) AS n FROM transactions WHERE committed_at < ? AND instr(transaction_id, ?) = 1",
    )
    .get(cutoff, heartbeatPrefix).n;
  const totalTransactions = db
    .prepare("SELECT COUNT(*) AS n FROM transactions")
    .get().n;
  console.log(`Database: ${database}`);
  console.log(`Files: ${before.text}`);
  console.log(
    `Free pages: ${megabytes(pragma("freelist_count") * pageSize)} of ${megabytes(pragma("page_count") * pageSize)}`,
  );
  console.log(
    `Transactions: ${totalTransactions}, stale heartbeat receipts: ${stale}`,
  );
  if (!apply) {
    console.log("Report only. Re-run with --apply to prune and VACUUM.");
    process.exit(0);
  }

  db.exec("PRAGMA busy_timeout = 5000");
  const deleted = db
    .prepare(
      "DELETE FROM transactions WHERE committed_at < ? AND instr(transaction_id, ?) = 1",
    )
    .run(cutoff, heartbeatPrefix).changes;
  console.log(`Deleted ${deleted} stale heartbeat receipts.`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const startedAt = Date.now();
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  console.log(`VACUUM finished in ${Date.now() - startedAt} ms.`);
  const integrity = Object.values(db.prepare("PRAGMA quick_check").get())[0];
  if (integrity !== "ok") {
    console.error(`quick_check reported: ${integrity}`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}

const after = fileSizes();
console.log(
  `Files: ${after.text} (reclaimed ${megabytes(before.total - after.total)})`,
);
