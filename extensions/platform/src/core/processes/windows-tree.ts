import { spawn, type ChildProcess } from "node:child_process";

export interface WindowsProcessIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

export interface WindowsProcessTreeSnapshot {
  readonly root?: WindowsProcessIdentity;
  readonly descendants: readonly WindowsProcessIdentity[];
}

function signalDirectly(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

function runPowerShell(
  script: string,
  capture: boolean,
  timeoutMs = 15_000,
  input?: string,
) {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          shell: false,
          stdio: [
            input === undefined ? "ignore" : "pipe",
            capture ? "pipe" : "ignore",
            "pipe",
          ],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    if (input !== undefined) child.stdin?.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8 * 1024) stderr += chunk;
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      signalDirectly(child, "SIGKILL");
      finish(new Error("Windows process inspection timed out."));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              `Windows process operation failed with exit ${code}: ${stderr.trim()}`,
            ),
      ),
    );
  });
}

function identity(kind: string, pid: string, startedAt: string) {
  const parsedPid = Number(pid);
  if (
    (kind !== "R" && kind !== "D") ||
    !Number.isSafeInteger(parsedPid) ||
    parsedPid <= 0 ||
    !/^\d+$/.test(startedAt)
  )
    throw new Error("Windows process inspection returned malformed identity.");
  return { kind, pid: parsedPid, startedAt };
}

export async function findWindowsProcessIdentitiesByCommandLine(
  fragment: string,
): Promise<readonly WindowsProcessIdentity[]> {
  if (
    !fragment ||
    Buffer.byteLength(fragment) > 8 * 1024 ||
    fragment.includes("\0")
  )
    throw new TypeError("Windows process command-line fragment is invalid.");
  if (process.platform !== "win32")
    throw new Error(
      "Windows process discovery is unavailable on this platform.",
    );
  const encoded = Buffer.from(fragment, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$needle=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$found=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -and $_.CommandLine.Contains($needle)})",
    "$ids=@($found|ForEach-Object {$_.ProcessId})",
    "$roots=@($found|Where-Object {$ids -notcontains $_.ParentProcessId})",
    "if($roots.Count -lt 1 -or $roots.Count -gt 8){throw ('expected 1-8 root processes, found '+$roots.Count+' from '+$found.Count)}",
    "$roots|ForEach-Object {[string]$_.ProcessId+'|'+[string][int64]([math]::Floor($_.CreationDate.ToFileTimeUtc()/10000))}",
  ].join(";");
  const output = (await runPowerShell(script, true)).trim();
  return output.split(/\r?\n/).map((line) => {
    const match = /^(\d+)\|(\d+)$/.exec(line.trim());
    if (!match)
      throw new Error("Windows process discovery returned malformed output.");
    const parsed = identity("R", match[1]!, match[2]!);
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  });
}

export async function findWindowsProcessIdentityByCommandLine(
  fragment: string,
): Promise<WindowsProcessIdentity> {
  const identities = await findWindowsProcessIdentitiesByCommandLine(fragment);
  if (identities.length !== 1)
    throw new Error(
      `Expected one Windows process identity, found ${identities.length}.`,
    );
  return identities[0]!;
}

export async function snapshotWindowsProcessTree(
  rootPid: number,
): Promise<WindowsProcessTreeSnapshot> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
    throw new TypeError("Windows process root PID is invalid.");
  if (process.platform !== "win32") return { descendants: [] };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$all=@(Get-CimInstance Win32_Process)",
    `$root=@($all|Where-Object {$_.ProcessId -eq ${rootPid}}|Select-Object -First 1)`,
    `$frontier=@(${rootPid})`,
    "$targets=@()",
    "while($frontier.Count -gt 0){$next=@();foreach($parent in $frontier){$children=@($all|Where-Object {$_.ParentProcessId -eq $parent});$targets+=$children;$next+=@($children|ForEach-Object {$_.ProcessId})};$frontier=$next;if($targets.Count -gt 1024){throw 'process tree exceeds 1024 descendants'}}",
    "$targets=@($targets|Sort-Object CreationDate -Descending)",
    "$root|ForEach-Object {'R|'+[string]$_.ProcessId+'|'+[string][int64]([math]::Floor($_.CreationDate.ToFileTimeUtc()/10000))}",
    "$targets|ForEach-Object {'D|'+[string]$_.ProcessId+'|'+[string][int64]([math]::Floor($_.CreationDate.ToFileTimeUtc()/10000))}",
  ].join(";");
  const output = await runPowerShell(script, true);
  const parsed = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^([RD])\|(\d+)\|(\d+)$/.exec(line.trim());
      if (!match)
        throw new Error(
          "Windows process inspection returned malformed output.",
        );
      return identity(match[1]!, match[2]!, match[3]!);
    });
  const root = parsed.find((item) => item.kind === "R");
  return {
    ...(root ? { root: { pid: root.pid, startedAt: root.startedAt } } : {}),
    descendants: parsed
      .filter((item) => item.kind === "D")
      .map(({ pid, startedAt }) => ({ pid, startedAt })),
  };
}

export async function isWindowsProcessIdentityAlive(
  identity: WindowsProcessIdentity,
): Promise<boolean> {
  if (process.platform !== "win32") {
    try {
      process.kill(identity.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$process=Get-Process -Id ${identity.pid}`,
    `$expected='${identity.startedAt}'`,
    "if(-not $process){exit 3}",
    "$actual=[string][int64]([math]::Floor($process.StartTime.ToUniversalTime().ToFileTimeUtc()/10000))",
    "if($actual -eq $expected){exit 0}else{exit 3}",
  ].join(";");
  try {
    await runPowerShell(script, false);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("exit 3"))
      return false;
    throw error;
  }
}

export async function terminateWindowsProcessTreeByIdentity(
  identity: WindowsProcessIdentity,
) {
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='Stop'",
    `$process=Get-Process -Id ${identity.pid}`,
    `$expected='${identity.startedAt}'`,
    "if(-not $process){exit 0}",
    "$actual=[string][int64]([math]::Floor($process.StartTime.ToUniversalTime().ToFileTimeUtc()/10000))",
    "if($actual -ne $expected){exit 2}",
    `& taskkill.exe /PID ${identity.pid} /T /F | Out-Null`,
    "if($LASTEXITCODE -ne 0){exit 1}else{exit 0}",
  ].join(";");
  await runPowerShell(script, false, 15_000);
}

export async function terminateWindowsProcessIdentity(
  identity: WindowsProcessIdentity,
) {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !/^\d+$/.test(identity.startedAt)
  )
    throw new TypeError("Windows process identity is invalid.");
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$process=Get-Process -Id ${identity.pid}`,
    `$expected='${identity.startedAt}'`,
    "if(-not $process){exit 0}",
    "$actual=[string][int64]([math]::Floor($process.StartTime.ToUniversalTime().ToFileTimeUtc()/10000))",
    "if(-not $actual){exit 1}",
    "if($actual -ne $expected){exit 2}",
    "$process.Kill()",
    "$process.WaitForExit(1000)|Out-Null",
    "if(-not $process.HasExited){exit 1}",
  ].join(";");
  try {
    await runPowerShell(script, false);
  } catch (error) {
    if (error instanceof Error && error.message.includes("exit 2"))
      throw new Error(
        `Windows process ${identity.pid} identity changed before termination.`,
        { cause: error },
      );
    throw error;
  }
}

async function terminateWindowsIdentities(
  identities: readonly WindowsProcessIdentity[],
) {
  if (identities.length === 0 || process.platform !== "win32") return;
  if (identities.length > 1_025)
    throw new Error("Windows termination identity set is too large.");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$items=([Console]::In.ReadToEnd()|ConvertFrom-Json)",
    "$failures=0",
    "foreach($item in $items){try{$process=Get-Process -Id ([int]$item.pid) -ErrorAction SilentlyContinue;if(-not $process){continue};$actual=[string][int64]([math]::Floor($process.StartTime.ToUniversalTime().ToFileTimeUtc()/10000));if($actual -ne [string]$item.startedAt){[Console]::Error.WriteLine(('identity mismatch '+$item.pid+' expected '+$item.startedAt+' actual '+$actual));$failures+=1;continue};$process.Kill();$process.WaitForExit(1000)|Out-Null;if(-not $process.HasExited){[Console]::Error.WriteLine(('process remained alive '+$item.pid));$failures+=1}}catch{[Console]::Error.WriteLine($_.Exception.Message);$failures+=1}}",
    "if($failures -gt 0){exit 1}else{exit 0}",
  ].join(";");
  await runPowerShell(script, false, 15_000, JSON.stringify(identities));
}

export async function terminateWindowsProcessTreeSnapshot(
  snapshot: WindowsProcessTreeSnapshot,
) {
  await terminateWindowsIdentities([
    ...(snapshot.root ? [snapshot.root] : []),
    ...snapshot.descendants,
  ]);
  if (!snapshot.root || process.platform !== "win32") return;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const followup = await snapshotWindowsProcessTree(snapshot.root.pid);
  if (followup.root && followup.root.startedAt !== snapshot.root.startedAt)
    throw new Error(
      "Windows root PID was reused during process-tree termination.",
    );
  await terminateWindowsIdentities([
    ...(followup.root ? [followup.root] : []),
    ...followup.descendants,
  ]);
}
