import {
  spawn as nativeSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import path from "node:path";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  DidChangeConfigurationNotification,
  ExitNotification,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  type InitializeParams,
} from "vscode-languageserver-protocol";
import type {
  LanguageServerConnection,
  LanguageServerAdapter,
  StdioLanguageServerAdapterOptions,
} from "./model.ts";

const GRACEFUL_EXIT_MS = 500;
const FORCE_EXIT_MS = 1_000;
const TASKKILL_WAIT_MS = 1_000;
const MAX_PROTOCOL_HEADER_BYTES = 8 * 1024;
const MAX_PROTOCOL_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_TRAFFIC_BYTES = 64 * 1024 * 1024;

class BoundedProtocolStream extends Transform {
  #header = Buffer.alloc(0);
  #bodyRemaining = 0;
  #traffic = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    try {
      this.#traffic += chunk.length;
      if (this.#traffic > MAX_PROTOCOL_TRAFFIC_BYTES)
        throw new Error("Language-server protocol traffic limit exceeded.");
      let pending = chunk;
      while (pending.length > 0) {
        if (this.#bodyRemaining > 0) {
          const size = Math.min(this.#bodyRemaining, pending.length);
          this.push(pending.subarray(0, size));
          pending = pending.subarray(size);
          this.#bodyRemaining -= size;
          continue;
        }
        this.#header = Buffer.concat([this.#header, pending]);
        const separator = this.#header.indexOf("\r\n\r\n");
        if (separator < 0) {
          if (this.#header.length > MAX_PROTOCOL_HEADER_BYTES)
            throw new Error("Language-server protocol header limit exceeded.");
          pending = Buffer.alloc(0);
          continue;
        }
        const frameHeader = this.#header.subarray(0, separator + 4);
        pending = this.#header.subarray(separator + 4);
        this.#header = Buffer.alloc(0);
        if (frameHeader.length > MAX_PROTOCOL_HEADER_BYTES)
          throw new Error("Language-server protocol header limit exceeded.");
        const header = frameHeader.toString("ascii");
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(
          header,
        );
        if (!match)
          throw new Error("Language-server frame has no Content-Length.");
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_FRAME_BYTES)
          throw new Error(
            `Language-server frame exceeds ${MAX_PROTOCOL_FRAME_BYTES} bytes.`,
          );
        this.push(frameHeader);
        this.#bodyRemaining = length;
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function waitAtMost(promise: Promise<unknown>, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
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

function signalDirectly(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

function signalPosixGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may not exist. Fall back to direct child signaling.
    }
  }
  signalDirectly(child, signal);
}

function terminateWindowsDescendants(rootPid: number) {
  return new Promise<number[]>((resolve) => {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$all=@(Get-CimInstance Win32_Process)",
      `$frontier=@(${rootPid})`,
      "$targets=@()",
      "while($frontier.Count -gt 0){$next=@();foreach($parent in $frontier){$children=@($all|Where-Object {$_.ParentProcessId -eq $parent});$targets+=$children;$next+=@($children|ForEach-Object {$_.ProcessId})};$frontier=$next}",
      "$targets=@($targets|Sort-Object CreationDate -Descending)",
      "foreach($target in $targets){Invoke-CimMethod -InputObject $target -MethodName Terminate|Out-Null}",
      "Start-Sleep -Milliseconds 200",
      "$remaining=@($targets|Where-Object {$id=$_.ProcessId;$created=$_.CreationDate;@(Get-CimInstance Win32_Process -Filter ('ProcessId='+$id)|Where-Object {$_.CreationDate -eq $created}).Count -gt 0}|ForEach-Object {$_.ProcessId})",
      "$remaining -join ','",
    ].join(";");
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(
        stdout
          .trim()
          .split(",")
          .filter(Boolean)
          .map(Number)
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      );
    };
    let process: ChildProcess;
    try {
      process = nativeSpawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      );
      process.stdout?.setEncoding("utf8");
      process.stdout?.on("data", (chunk) => {
        if (stdout.length < 16 * 1024) stdout += chunk;
      });
    } catch {
      resolve([]);
      return;
    }
    timer = setTimeout(() => {
      signalDirectly(process, "SIGKILL");
      finish();
    }, 15_000);
    process.once("error", finish);
    process.once("close", finish);
  });
}

function runTaskkill(pid: number, force: boolean) {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    let killer: ChildProcess;
    try {
      killer = nativeSpawn(
        "taskkill.exe",
        ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
        { shell: false, stdio: "ignore", windowsHide: true },
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

const INHERITED_ENVIRONMENT = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "LANG",
    "LC_ALL",
  ].map((name) => name.toUpperCase()),
);

function languageServerEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && INHERITED_ENVIRONMENT.has(name.toUpperCase()))
      environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides ?? {}))
    environment[name] = value;
  return environment;
}

function commandInvocation(executable: string, args: readonly string[]) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return {
      executable,
      args: [...args],
      windowsVerbatimArguments: false,
    };
  }
  const tokens = [executable, ...args].map((value) => {
    if (/[%!\r\n\0]/u.test(value)) {
      throw new TypeError(
        "Windows batch language-server arguments cannot contain %, !, or control characters",
      );
    }
    return `"${value.replaceAll('"', '""')}"`;
  });
  const command = tokens.join(" ");
  return {
    executable: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

function sendRequest<R>(
  operation: (token: CancellationTokenSource["token"]) => Promise<R>,
  signal?: AbortSignal,
  canCancel: () => boolean = () => true,
) {
  signal?.throwIfAborted();
  const cancellation = new CancellationTokenSource();
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      try {
        if (canCancel()) cancellation.cancel();
      } catch {
        // Connection may already be closed by a protocol-bound violation.
      }
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal?.removeEventListener("abort", abort);
  });
  return Promise.race([operation(cancellation.token), aborted]).finally(() => {
    removeAbort();
    cancellation.dispose();
  });
}

export function createStdioLanguageServerAdapter(
  options: StdioLanguageServerAdapterOptions = {},
) {
  const spawnProcess = options.spawn ?? nativeSpawn;
  return {
    async connect({ definition, rootPath, stderrLimitBytes }, signal) {
      signal.throwIfAborted();
      const invocation = commandInvocation(
        definition.command.executable,
        definition.command.args ?? [],
      );
      const child: ChildProcessWithoutNullStreams = spawnProcess(
        invocation.executable,
        invocation.args,
        {
          cwd: rootPath,
          detached: process.platform !== "win32",
          env: languageServerEnvironment(definition.command.env),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        },
      );
      if (child.pid) options.onSpawn?.(child.pid, definition.id);

      const processClosed = deferred();
      let processClosedObserved = false;
      child.once("close", () => {
        processClosedObserved = true;
        processClosed.resolve();
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;
      child.stderr.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        stderrChunks.push(Buffer.from(chunk));
        stderrBytes += chunk.length;
        while (stderrBytes > stderrLimitBytes && stderrChunks.length > 0) {
          const first = stderrChunks[0];
          if (!first) break;
          const excess = stderrBytes - stderrLimitBytes;
          if (first.length <= excess) {
            stderrChunks.shift();
            stderrBytes -= first.length;
          } else {
            stderrChunks[0] = first.subarray(excess);
            stderrBytes -= excess;
          }
        }
      });

      const protocolStream = new BoundedProtocolStream();
      child.stdout.pipe(protocolStream);
      protocolStream.once("error", () => {
        if (process.platform === "win32" && child.pid) {
          void terminateWindowsDescendants(child.pid).then(() =>
            runTaskkill(child.pid!, true),
          );
        } else {
          signalPosixGroup(child, "SIGKILL");
        }
      });
      const rpc = createMessageConnection(
        new StreamMessageReader(protocolStream),
        new StreamMessageWriter(child.stdin),
      );
      const closeHandlers = new Set<() => void>();
      let closeNotified = false;
      const notifyClose = () => {
        if (closeNotified) return;
        closeNotified = true;
        for (const handler of closeHandlers) handler();
      };
      rpc.onClose(notifyClose);
      child.once("close", notifyClose);
      const rejectDynamicCapability = () => {
        throw new ResponseError(
          ErrorCodes.MethodNotFound,
          "Dynamic capability registration is unsupported; configure static routes.",
        );
      };
      rpc.onRequest("client/registerCapability", rejectDynamicCapability);
      rpc.onRequest("client/unregisterCapability", rejectDynamicCapability);
      rpc.onRequest("window/workDoneProgress/create", () => null);
      rpc.onRequest("workspace/workspaceFolders", () => [
        { uri: pathToFileURL(rootPath).href, name: path.basename(rootPath) },
      ]);
      rpc.onRequest("workspace/configuration", (params: unknown) => {
        const candidate =
          typeof params === "object" && params !== null
            ? (params as Readonly<Record<string, unknown>>)
            : undefined;
        const items = Array.isArray(candidate?.items) ? candidate.items : [];
        return items.map((item) => {
          const request =
            typeof item === "object" && item !== null
              ? (item as Readonly<Record<string, unknown>>)
              : undefined;
          return typeof request?.section === "string"
            ? (definition.settings?.[request.section] ?? null)
            : (definition.settings ?? null);
        });
      });
      rpc.listen();

      let closing: Promise<void> | undefined;
      const terminate = async () => {
        if (process.platform === "win32" && child.pid) {
          const remaining = await terminateWindowsDescendants(child.pid);
          for (const pid of remaining) await runTaskkill(pid, true);
          if (!processClosedObserved) await runTaskkill(child.pid, true);
          await waitAtMost(processClosed.promise, FORCE_EXIT_MS);
        } else {
          await waitAtMost(processClosed.promise, GRACEFUL_EXIT_MS);
          if (processClosedObserved) return;
          signalPosixGroup(child, "SIGTERM");
          await waitAtMost(processClosed.promise, GRACEFUL_EXIT_MS);
          if (!processClosedObserved) {
            signalPosixGroup(child, "SIGKILL");
            await waitAtMost(processClosed.promise, FORCE_EXIT_MS);
          }
        }
        if (!processClosedObserved) signalDirectly(child, "SIGKILL");
      };

      const initialization: InitializeParams = {
        processId: process.pid,
        clientInfo: { name: "pi-language-intelligence" },
        rootPath,
        rootUri: pathToFileURL(rootPath).href,
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: {
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: true,
            },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
        workspaceFolders: [
          {
            uri: pathToFileURL(rootPath).href,
            name: path.basename(rootPath),
          },
        ],
        initializationOptions: definition.initializationOptions,
      };

      try {
        const initialized = await sendRequest(
          (token) =>
            rpc.sendRequest(InitializeRequest.type, initialization, token),
          signal,
          () => !closeNotified,
        );
        await rpc.sendNotification(InitializedNotification.type, {});
        if (definition.settings) {
          await rpc.sendNotification(DidChangeConfigurationNotification.type, {
            settings: definition.settings,
          });
        }

        const publicConnection: LanguageServerConnection = {
          capabilities: initialized.capabilities,
          request(method, params, requestSignal) {
            return sendRequest(
              (token) => rpc.sendRequest<unknown>(method, params, token),
              requestSignal,
              () => !closeNotified,
            );
          },
          notify(method, params) {
            return rpc.sendNotification(method, params);
          },
          onNotification(handler) {
            const disposable = rpc.onNotification(handler);
            return () => disposable.dispose();
          },
          onClose(handler) {
            closeHandlers.add(handler);
            if (closeNotified) queueMicrotask(handler);
            return () => closeHandlers.delete(handler);
          },
          close(closeSignal) {
            if (closing) return closing;
            closing = (async () => {
              try {
                await sendRequest(
                  (token) => rpc.sendRequest(ShutdownRequest.type, token),
                  closeSignal,
                  () => !closeNotified,
                );
                if (process.platform !== "win32")
                  await rpc.sendNotification(ExitNotification.type);
              } catch {
                // A crashed or cancelled server still needs tree termination.
              }
              await terminate();
              rpc.dispose();
              child.stdin.destroy();
              child.stdout.unpipe(protocolStream);
              protocolStream.destroy();
              child.stdout.destroy();
              child.stderr.destroy();
              notifyClose();
            })();
            return closing;
          },
        };
        return publicConnection;
      } catch (error) {
        await terminate();
        rpc.dispose();
        if (stderrBytes === 0) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; language-server stderr omitted (${stderrBytes} captured bytes)`,
          { cause: error },
        );
      }
    },
  } satisfies LanguageServerAdapter;
}
