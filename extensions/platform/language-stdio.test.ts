import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { languageStdioTestSeams } from "./src/language/stdio.ts";

const execFileAsync = promisify(execFile);
const windowsTest = process.platform === "win32" ? test : test.skip;

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Windows tree cleanup force-kills every descendant that survives CIM termination", async () => {
  const killed: number[] = [];

  await languageStdioTestSeams.terminateWindowsProcessTree(100, () => false, {
    terminateDescendants: async () => ({
      root: { pid: 100, startedAt: "133700000000000001" },
      remaining: [
        { pid: 303, startedAt: "133700000000000003" },
        { pid: 202, startedAt: "133700000000000002" },
      ],
    }),
    forceKill: async (identity) => {
      assert.match(identity.startedAt, /^1337/);
      killed.push(identity.pid);
    },
    waitForRootClose: async () => {},
    forceKillRoot: async (identity) => {
      assert.equal(identity.startedAt, "133700000000000001");
      killed.push(identity.pid);
    },
  });

  assert.deepEqual(killed, [303, 202, 100]);
});

windowsTest(
  "Windows survivor cleanup validates creation identity before terminating",
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    assert.equal(typeof child.pid, "number");
    const pid = child.pid!;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p=Get-Process -Id ${pid};[string][int64]([math]::Floor($p.StartTime.ToUniversalTime().ToFileTimeUtc()/10000))`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      const startedAt = stdout.trim();
      assert.match(startedAt, /^\d+$/);

      await assert.rejects(
        () =>
          languageStdioTestSeams.forceKillWindowsProcess({
            pid,
            startedAt: `${startedAt}0`,
          }),
        /identity changed/,
      );
      assert.equal(processExists(pid), true);

      await languageStdioTestSeams.forceKillWindowsProcess({ pid, startedAt });
      assert.equal(processExists(pid), false);
    } finally {
      if (processExists(pid)) child.kill("SIGKILL");
    }
  },
);
