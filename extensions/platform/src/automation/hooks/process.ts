import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";

const GRACEFUL_EXIT_MS = 300;
const FORCE_EXIT_MS = 1_000;
const PIPE_CLOSE_MS = 750;
const TASKKILL_WAIT_MS = 1_000;
const DEFAULT_SPILL_CAP_BYTES = 16 * 1024 * 1024;

type NativeChild = ChildProcessByStdio<null, Readable, Readable>;

export interface HookProcessOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: Buffer;
}

export interface HookProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly outputCapBytes: number;
  readonly spillCapBytes?: number;
  readonly signal?: AbortSignal;
  readonly onSpill?: (
    output: HookProcessOutputChunk,
  ) => void | PromiseLike<void>;
}

export interface HookProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly totalBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly spillLimitExceeded: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly killed: boolean;
}

export interface HookProcessRunner {
  run(request: HookProcessRequest): Promise<HookProcessResult>;
  shutdown(deadlineMs: number): Promise<void>;
}

interface ActiveProcess {
  readonly child: NativeChild;
  readonly exited: Promise<void>;
  readonly closed: Promise<void>;
  readonly stopPumping: Promise<void>;
  readonly forceSettled: Promise<void>;
  readonly done: Promise<void>;
  resolveStopPumping(): void;
  resolveForceSettled(): void;
  resolveDone(): void;
  exitedObserved: boolean;
  closedObserved: boolean;
  killRequested: boolean;
  pumpingStopped: boolean;
  termination?: Promise<void>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function waitAtMost(promise: Promise<unknown>, milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function validateRequest(request: HookProcessRequest) {
  if (!request.executable) throw new TypeError("executable must not be empty");
  if (!request.cwd) throw new TypeError("cwd must not be empty");
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 0 ||
    request.timeoutMs > 2_147_483_647
  ) {
    throw new TypeError("timeoutMs must be a non-negative 32-bit safe integer");
  }
  if (
    !Number.isSafeInteger(request.outputCapBytes) ||
    request.outputCapBytes < 0
  ) {
    throw new TypeError("outputCapBytes must be a non-negative safe integer");
  }
  if (
    request.spillCapBytes !== undefined &&
    (!Number.isSafeInteger(request.spillCapBytes) || request.spillCapBytes < 0)
  ) {
    throw new TypeError("spillCapBytes must be a non-negative safe integer");
  }
}

function signalDirectly(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // Process may already have exited.
  }
}

function signalPosixGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already have exited or failed to form. Fall back to child.
    }
  }
  signalDirectly(child, signal);
}

function runTaskkill(pid: number, force: boolean) {
  return new Promise<void>((resolve) => {
    let settled = false;
    let killer: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    try {
      killer = spawn(
        "taskkill.exe",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    } catch {
      resolve();
      return;
    }
    timer = setTimeout(() => {
      signalDirectly(killer, "SIGKILL");
      finish();
    }, TASKKILL_WAIT_MS);
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

function terminate(entry: ActiveProcess) {
  if (entry.termination) return entry.termination;
  entry.killRequested ||= !entry.exitedObserved;
  entry.pumpingStopped = true;
  entry.resolveStopPumping();
  entry.termination = (async () => {
    if (entry.closedObserved) return;
    const { child } = entry;
    if (process.platform === "win32" && child.pid) {
      await runTaskkill(child.pid, false);
      await waitAtMost(entry.exited, GRACEFUL_EXIT_MS);
      if (!entry.exitedObserved) {
        await runTaskkill(child.pid, true);
        await waitAtMost(entry.exited, FORCE_EXIT_MS);
      }
      if (!entry.exitedObserved) signalDirectly(child, "SIGKILL");
    } else {
      signalPosixGroup(child, "SIGTERM");
      await waitAtMost(entry.exited, GRACEFUL_EXIT_MS);
      if (!entry.exitedObserved) {
        signalPosixGroup(child, "SIGKILL");
        await waitAtMost(entry.exited, FORCE_EXIT_MS);
      }
    }
    await waitAtMost(entry.closed, PIPE_CLOSE_MS);
    if (!entry.closedObserved) {
      child.stdout.destroy();
      child.stderr.destroy();
      entry.resolveForceSettled();
    }
  })();
  return entry.termination;
}

export function createHookProcessRunner(): HookProcessRunner {
  const active = new Set<ActiveProcess>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const run = async (request: HookProcessRequest) => {
    validateRequest(request);
    if (shuttingDown) throw new Error("Hook process runner is shut down");
    request.signal?.throwIfAborted();

    const hasExplicitPath = Object.keys(request.env).some(
      (key) => key.toLowerCase() === "path",
    );
    const env = {
      ...(process.platform === "win32" && !hasExplicitPath ? { PATH: "" } : {}),
      ...request.env,
    };
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const exited = deferred();
    const closed = deferred();
    const stopPumping = deferred();
    const forceSettled = deferred();
    const done = deferred();
    const entry: ActiveProcess = {
      child,
      exited: exited.promise,
      closed: closed.promise,
      stopPumping: stopPumping.promise,
      forceSettled: forceSettled.promise,
      done: done.promise,
      resolveStopPumping: stopPumping.resolve,
      resolveForceSettled: forceSettled.resolve,
      resolveDone: done.resolve,
      exitedObserved: false,
      closedObserved: false,
      killRequested: false,
      pumpingStopped: false,
    };
    active.add(entry);

    child.once("exit", () => {
      entry.exitedObserved = true;
      exited.resolve();
    });
    child.once("close", () => {
      entry.closedObserved = true;
      entry.exitedObserved = true;
      exited.resolve();
      closed.resolve();
    });

    let captureRemaining = request.outputCapBytes;
    let spillRemaining = request.spillCapBytes ?? DEFAULT_SPILL_CAP_BYTES;
    let spillLimitExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapturedBytes = 0;
    let stderrCapturedBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const pump = async (stream: "stdout" | "stderr", readable: Readable) => {
      for await (const value of readable) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (stream === "stdout") stdoutBytes += chunk.length;
        else stderrBytes += chunk.length;

        if (captureRemaining > 0) {
          const captured = Buffer.from(
            chunk.subarray(0, Math.min(captureRemaining, chunk.length)),
          );
          captureRemaining -= captured.length;
          if (stream === "stdout") {
            stdoutChunks.push(captured);
            stdoutCapturedBytes += captured.length;
          } else {
            stderrChunks.push(captured);
            stderrCapturedBytes += captured.length;
          }
        }

        if (request.onSpill && !entry.pumpingStopped) {
          const spillChunk = Buffer.from(
            chunk.subarray(0, Math.min(spillRemaining, chunk.length)),
          );
          spillRemaining -= spillChunk.length;
          if (spillChunk.length > 0) {
            await Promise.race([
              Promise.resolve(request.onSpill({ stream, chunk: spillChunk })),
              entry.stopPumping,
            ]);
          }
          if (spillChunk.length < chunk.length) {
            spillLimitExceeded = true;
            void terminate(entry);
            break;
          }
        }
      }
    };

    const stdoutPump = pump("stdout", child.stdout);
    const stderrPump = pump("stderr", child.stderr);
    const pumps = Promise.all([stdoutPump, stderrPump]);
    const outcome = Promise.race([
      new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      entry.forceSettled.then(() => ({ code: null, signal: null })),
    ]);
    const spillFailure = pumps.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    );
    const abort = () => void terminate(entry);
    const timeout = setTimeout(abort, request.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      let settled;
      try {
        settled = await Promise.race([outcome, spillFailure]);
        await pumps;
      } catch (error) {
        await terminate(entry);
        throw error;
      }
      const totalBytes = stdoutBytes + stderrBytes;
      return {
        stdout: Buffer.concat(stdoutChunks, stdoutCapturedBytes).toString(
          "utf8",
        ),
        stderr: Buffer.concat(stderrChunks, stderrCapturedBytes).toString(
          "utf8",
        ),
        totalBytes,
        stdoutBytes,
        stderrBytes,
        truncated: totalBytes > stdoutCapturedBytes + stderrCapturedBytes,
        stdoutTruncated: stdoutBytes > stdoutCapturedBytes,
        stderrTruncated: stderrBytes > stderrCapturedBytes,
        spillLimitExceeded,
        code: settled.code,
        signal: settled.signal,
        killed: entry.killRequested,
      } satisfies HookProcessResult;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      active.delete(entry);
      entry.resolveDone();
    }
  };

  const shutdown = (deadlineMs: number) => {
    if (shutdownPromise) return shutdownPromise;
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 0 ||
      deadlineMs > 2_147_483_647
    ) {
      return Promise.reject(
        new TypeError("deadlineMs must be a non-negative 32-bit safe integer"),
      );
    }
    shuttingDown = true;
    shutdownPromise = (async () => {
      const entries = [...active];
      for (const entry of entries) void terminate(entry);
      await waitAtMost(
        Promise.all(entries.map((entry) => entry.done)),
        deadlineMs,
      );
      for (const entry of active) {
        if (process.platform === "win32" && entry.child.pid) {
          void runTaskkill(entry.child.pid, true);
        } else {
          signalPosixGroup(entry.child, "SIGKILL");
        }
      }
    })();
    return shutdownPromise;
  };

  return { run, shutdown };
}
