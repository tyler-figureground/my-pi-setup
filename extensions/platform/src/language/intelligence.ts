import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Position,
  Range,
  ServerCapabilities,
} from "vscode-languageserver-protocol";
import {
  canonicalPathKey,
  normalizeCanonicalPath,
} from "../../../shared/child-session.ts";
import { failure, success, type JsonObject } from "../core/result.ts";
import type {
  LanguageDocumentUpdate,
  LanguageDiscovery,
  LanguageErrorCode,
  LanguageIntelligence,
  LanguageIntelligenceOptions,
  LanguageLimits,
  LanguageOutcome,
  LanguageQuery,
  LanguageQueryResult,
  LanguageServerConnection,
  LanguageServerDefinition,
  LanguageSynchronization,
  MappedLanguagePath,
  NormalizedCall,
  NormalizedDiagnostic,
  NormalizedHover,
  NormalizedLanguageItem,
  NormalizedLocation,
  NormalizedSymbol,
} from "./model.ts";

export const DEFAULT_LANGUAGE_LIMITS: LanguageLimits = Object.freeze({
  maxServers: 4,
  maxServersPerQuery: 2,
  maxDiagnosticFiles: 32,
  maxOpenDocumentsPerServer: 64,
  maxFileBytes: 2 * 1024 * 1024,
  maxResultItems: 200,
  maxResponseBytes: 50 * 1024,
  maxStderrBytes: 64 * 1024,
  startupTimeoutMs: 15_000,
  requestTimeoutMs: 20_000,
  maxCrashesPerWindow: 3,
  crashWindowMs: 60_000,
});
const RESTART_BACKOFF_MS = [50, 200, 500] as const;
const MAX_COMMAND_ARGUMENTS = 64;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_COMMAND_ENVIRONMENT_ENTRIES = 64;
const MAX_SERVER_CONFIG_BYTES = 64 * 1024;
const MAX_SELECTORS = 32;
const MAX_EXTENSIONS_PER_SELECTOR = 32;

class LanguageTimeoutError extends Error {
  readonly phase: "startup" | "request";
  readonly timeoutMs: number;

  constructor(phase: "startup" | "request", timeoutMs: number) {
    super(`Language ${phase} timed out after ${timeoutMs}ms`);
    this.name = "LanguageTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

interface DocumentSnapshot {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly uri: string;
  readonly languageId: string;
  text: string;
  version: number;
}

function languageFailure(
  code: LanguageErrorCode,
  message: string,
  retryable = false,
  details?: JsonObject,
) {
  return failure({ code, message, retryable, ...(details ? { details } : {}) });
}

function resolveLimits(input: Partial<LanguageLimits> | undefined) {
  const limits = { ...DEFAULT_LANGUAGE_LIMITS, ...input };
  for (const [name, hardCeiling] of Object.entries(DEFAULT_LANGUAGE_LIMITS)) {
    const value = limits[name as keyof LanguageLimits];
    if (!Number.isSafeInteger(value) || value < 0 || value > hardCeiling) {
      throw new TypeError(
        `${name} must be a non-negative safe integer no greater than ${hardCeiling}`,
      );
    }
  }
  return limits;
}

function validateServerDefinition(definition: LanguageServerDefinition) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(definition.id)) {
    throw new TypeError(
      "Language server ID must contain 1-64 letters, numbers, dots, underscores, or hyphens",
    );
  }
  if (
    !definition.command.executable ||
    Buffer.byteLength(definition.command.executable, "utf8") > 4_096
  ) {
    throw new TypeError("Language server executable must contain 1-4096 bytes");
  }
  const args = definition.command.args ?? [];
  if (args.length > MAX_COMMAND_ARGUMENTS) {
    throw new TypeError(
      `Language server commands accept at most ${MAX_COMMAND_ARGUMENTS} arguments`,
    );
  }
  const commandBytes = [definition.command.executable, ...args].reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  );
  if (commandBytes > MAX_COMMAND_BYTES) {
    throw new TypeError(
      `Language server command exceeds ${MAX_COMMAND_BYTES} byte limit`,
    );
  }
  const environment = Object.entries(definition.command.env ?? {});
  if (environment.length > MAX_COMMAND_ENVIRONMENT_ENTRIES) {
    throw new TypeError(
      `Language server environment accepts at most ${MAX_COMMAND_ENVIRONMENT_ENTRIES} entries`,
    );
  }
  for (const [name, value] of environment) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      Buffer.byteLength(value, "utf8") > 8_192
    ) {
      throw new TypeError(
        `Invalid or oversized language server environment entry: ${name}`,
      );
    }
  }
  if (
    definition.selectors.length === 0 ||
    definition.selectors.length > MAX_SELECTORS
  ) {
    throw new TypeError(
      `Language servers require 1-${MAX_SELECTORS} selectors`,
    );
  }
  for (const selector of definition.selectors) {
    if (
      !selector.languageId ||
      Buffer.byteLength(selector.languageId, "utf8") > 64
    ) {
      throw new TypeError("Language selector IDs must contain 1-64 bytes");
    }
    if (
      selector.extensions.length === 0 ||
      selector.extensions.length > MAX_EXTENSIONS_PER_SELECTOR
    ) {
      throw new TypeError(
        `Language selectors require 1-${MAX_EXTENSIONS_PER_SELECTOR} extensions`,
      );
    }
    for (const extension of selector.extensions) {
      if (!/^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/u.test(extension)) {
        throw new TypeError(
          `Invalid language selector extension: ${extension}`,
        );
      }
    }
  }
  if (definition.queries.length === 0) {
    throw new TypeError("Language servers require at least one query route");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify({
      initializationOptions: definition.initializationOptions,
      settings: definition.settings,
    });
  } catch (error) {
    throw new TypeError(
      `Language server initialization config must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERVER_CONFIG_BYTES) {
    throw new TypeError(
      `Language server initialization config exceeds ${MAX_SERVER_CONFIG_BYTES} byte limit`,
    );
  }
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  phase: "startup" | "request",
) {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParent = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      controller.abort(parentSignal?.reason);
      reject(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    parentSignal?.addEventListener("abort", abort, { once: true });
    removeParent = () => parentSignal?.removeEventListener("abort", abort);
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new LanguageTimeoutError(phase, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([
    operation(controller.signal),
    timeout,
    interrupted,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    removeParent();
  });
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let remove = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  return Promise.race([promise, aborted]).finally(remove);
}

function isInside(root: string, candidate: string) {
  const relation = path.relative(root, candidate);
  return (
    relation === "" ||
    (!path.isAbsolute(relation) &&
      relation !== ".." &&
      !relation.startsWith(`..${path.sep}`))
  );
}

function canonicalCandidate(candidate: string) {
  let existing = candidate;
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.push(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  return normalizeCanonicalPath(
    path.join(canonicalExisting, ...missingSegments.reverse()),
  );
}

function projectRoot(options: LanguageIntelligenceOptions) {
  if (options.project.kind === "git") {
    if (options.project.bare || !options.project.currentWorktree) {
      throw new TypeError("Language intelligence requires a working tree");
    }
    return options.project.currentWorktree;
  }
  return options.project.canonicalCwd;
}

function severity(value: number | undefined): NormalizedDiagnostic["severity"] {
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "information";
  if (value === 4) return "hint";
  return "unknown";
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function position(value: unknown): Position | undefined {
  const candidate = record(value);
  return candidate &&
    Number.isSafeInteger(candidate.line) &&
    Number.isSafeInteger(candidate.character)
    ? { line: Number(candidate.line), character: Number(candidate.character) }
    : undefined;
}

function range(value: unknown): Range | undefined {
  const candidate = record(value);
  const start = position(candidate?.start);
  const end = position(candidate?.end);
  return start && end ? { start, end } : undefined;
}

const symbolKinds = [
  "unknown",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
] as const;

function symbolKind(value: unknown) {
  return typeof value === "number"
    ? (symbolKinds[value] ?? "unknown")
    : "unknown";
}

function capabilitySupported(
  capabilities: ServerCapabilities,
  kind: LanguageQuery["kind"],
) {
  if (kind === "diagnostics") return true;
  if (kind === "documentSymbols")
    return Boolean(capabilities.documentSymbolProvider);
  if (kind === "workspaceSymbols")
    return Boolean(capabilities.workspaceSymbolProvider);
  if (kind === "definition") return Boolean(capabilities.definitionProvider);
  if (kind === "references") return Boolean(capabilities.referencesProvider);
  if (kind === "implementations")
    return Boolean(capabilities.implementationProvider);
  if (kind === "hover") return Boolean(capabilities.hoverProvider);
  return Boolean(capabilities.callHierarchyProvider);
}

function itemSortKey(item: NormalizedLanguageItem) {
  return JSON.stringify(item);
}

function deterministicItems(items: readonly NormalizedLanguageItem[]) {
  const unique = new Map(items.map((item) => [itemSortKey(item), item]));
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, item]) => item);
}

export function createLanguageIntelligence(
  options: LanguageIntelligenceOptions,
): LanguageIntelligence {
  const limits = resolveLimits(options.limits);
  if (options.servers.length > limits.maxServers) {
    throw new TypeError(
      `At most ${limits.maxServers} language servers are allowed`,
    );
  }
  const servers = structuredClone(options.servers);
  const ids = new Set<string>();
  for (const server of servers) {
    validateServerDefinition(server);
    if (!server.id || ids.has(server.id)) {
      throw new TypeError("Language server IDs must be non-empty and unique");
    }
    ids.add(server.id);
  }
  const discovery: LanguageDiscovery = {
    advisory: true,
    authority: "repository-native-checks",
    servers: servers.map((server) => ({
      id: server.id,
      languages: [
        ...new Set(server.selectors.map(({ languageId }) => languageId)),
      ].sort(),
      extensions: [
        ...new Set(server.selectors.flatMap(({ extensions }) => extensions)),
      ].sort(),
      queries: [...new Set(server.queries)],
    })),
  };

  const root = normalizeCanonicalPath(projectRoot(options));
  const slotResources = new Map(
    servers.map((definition) => {
      const documents = new Map<string, DocumentSnapshot>();
      let nextDocumentVersion = 0;
      let versionlessDiagnostics = false;
      const unsafeVersionlessDiagnostics = new Set<string>();
      const diagnostics = new Map<
        string,
        {
          readonly generation: number;
          readonly version: number;
          readonly items: readonly NormalizedDiagnostic[];
        }
      >();
      let connection: LanguageServerConnection | undefined;
      const retiredConnections = new Set<LanguageServerConnection>();
      let connecting: Promise<LanguageServerConnection> | undefined;
      let startupController: AbortController | undefined;
      let closing = false;
      let generations = 0;
      const crashTimes: number[] = [];
      const slotController = new AbortController();

      const operationSignal = (signal?: AbortSignal) =>
        signal
          ? AbortSignal.any([signal, slotController.signal])
          : slotController.signal;

      const currentCrashCount = () => {
        const cutoff = Date.now() - limits.crashWindowMs;
        while ((crashTimes[0] ?? Infinity) < cutoff) crashTimes.shift();
        return crashTimes.length;
      };

      const ensureConnection = (signal?: AbortSignal) => {
        const activeSignal = operationSignal(signal);
        activeSignal.throwIfAborted();
        if (connection) return Promise.resolve(connection);
        if (connecting) return waitForSignal(connecting, activeSignal);
        const crashCount = currentCrashCount();
        if (crashCount >= limits.maxCrashesPerWindow) {
          return Promise.reject(
            new Error(
              `Language server ${definition.id} crash circuit is open after ${crashCount} crashes`,
            ),
          );
        }
        const controller = new AbortController();
        startupController = controller;
        const abort = () => controller.abort(slotController.signal.reason);
        slotController.signal.addEventListener("abort", abort, { once: true });
        connecting = withDeadline(
          (startupSignal) => {
            const pending = options.adapter.connect(
              {
                definition,
                rootPath: root,
                stderrLimitBytes: limits.maxStderrBytes,
              },
              startupSignal,
            );
            void pending.then(
              (lateConnection) => {
                if (startupSignal.aborted || closing) {
                  void lateConnection.close();
                }
              },
              () => {},
            );
            return pending;
          },
          limits.startupTimeoutMs,
          controller.signal,
          "startup",
        )
          .then((started) => {
            if (closing) {
              void started.close();
              throw new Error("Language server slot is closing");
            }
            connection = started;
            generations++;
            diagnostics.clear();
            started.onNotification((method, params) => {
              if (connection !== started || closing) return;
              if (method !== "textDocument/publishDiagnostics") return;
              const publication = record(params);
              if (
                typeof publication?.uri !== "string" ||
                !Array.isArray(publication.diagnostics)
              ) {
                return;
              }
              let absolutePath: string;
              try {
                absolutePath = canonicalCandidate(
                  fileURLToPath(publication.uri),
                );
              } catch {
                return;
              }
              const mappedPath = isInside(root, absolutePath)
                ? {
                    kind: "project" as const,
                    path: path
                      .relative(root, absolutePath)
                      .replaceAll("\\", "/"),
                  }
                : {
                    kind: "external" as const,
                    path: absolutePath,
                    uri: publication.uri,
                  };
              const diagnosticKey = canonicalPathKey(absolutePath);
              const document = documents.get(diagnosticKey);
              if (!document) return;
              if (
                typeof publication.version === "number" &&
                publication.version !== document.version
              )
                return;
              if (publication.version === undefined) {
                versionlessDiagnostics = true;
                if (document.version > 1) {
                  unsafeVersionlessDiagnostics.add(diagnosticKey);
                  return;
                }
              } else {
                unsafeVersionlessDiagnostics.delete(diagnosticKey);
              }
              if (
                !diagnostics.has(diagnosticKey) &&
                diagnostics.size >= limits.maxDiagnosticFiles
              ) {
                return;
              }
              diagnostics.set(diagnosticKey, {
                generation: generations,
                version:
                  typeof publication.version === "number"
                    ? publication.version
                    : (document?.version ?? 0),
                items: normalizeDiagnosticItems(
                  publication.diagnostics,
                  mappedPath,
                ),
              });
            });
            started.onClose(() => {
              if (connection !== started) return;
              connection = undefined;
              retiredConnections.add(started);
              if (!closing) crashTimes.push(Date.now());
            });
            return Promise.resolve()
              .then(async () => {
                if (generations === 1) return;
                for (const document of documents.values()) {
                  await started.notify("textDocument/didOpen", {
                    textDocument: {
                      uri: document.uri,
                      languageId: document.languageId,
                      version: document.version,
                      text: document.text,
                    },
                  });
                }
              })
              .then(() => started);
          })
          .finally(() => {
            slotController.signal.removeEventListener("abort", abort);
            if (startupController === controller) startupController = undefined;
            connecting = undefined;
          });
        return waitForSignal(connecting, activeSignal);
      };

      const slot = {
        signal: slotController.signal,
        definition,
        documents,
        nextDocumentVersion: () => ++nextDocumentVersion,
        hasUnsafeDiagnostics: (key: string) =>
          unsafeVersionlessDiagnostics.has(key),
        hasAnyUnsafeDiagnostics: () => unsafeVersionlessDiagnostics.size > 0,
        markDiagnosticsChanged: (key: string) => {
          if (versionlessDiagnostics) unsafeVersionlessDiagnostics.add(key);
        },
        diagnostics,
        ensureConnection,
        async run<T>(
          operation: (active: LanguageServerConnection) => Promise<T>,
          signal?: AbortSignal,
        ) {
          for (let attempt = 0; ; attempt++) {
            const active = await ensureConnection(signal);
            try {
              return await operation(active);
            } catch (error) {
              const crashed = connection !== active;
              if (!crashed) throw error;
              const crashCount = currentCrashCount();
              if (crashCount >= limits.maxCrashesPerWindow) {
                throw new Error(
                  `Language server ${definition.id} crash circuit is open after ${crashCount} crashes`,
                  { cause: error },
                );
              }
              if (attempt >= 1) throw error;
              const delay =
                RESTART_BACKOFF_MS[
                  Math.min(crashCount - 1, RESTART_BACKOFF_MS.length - 1)
                ] ?? 0;
              if (delay > 0) {
                await new Promise<void>((resolve, reject) => {
                  const finish = () => {
                    signal?.removeEventListener("abort", abort);
                    resolve();
                  };
                  const timer = setTimeout(finish, delay);
                  const abort = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", abort);
                    reject(signal?.reason);
                  };
                  signal?.addEventListener("abort", abort, { once: true });
                });
              }
            }
          }
        },
        async notify(
          operation: (active: LanguageServerConnection) => Promise<void>,
          signal?: AbortSignal,
        ) {
          const active = await ensureConnection(signal);
          try {
            await operation(active);
          } catch (error) {
            if (connection === active) throw error;
            const crashCount = currentCrashCount();
            if (crashCount >= limits.maxCrashesPerWindow) {
              throw new Error(
                `Language server ${definition.id} crash circuit is open after ${crashCount} crashes`,
                { cause: error },
              );
            }
            const delay =
              RESTART_BACKOFF_MS[
                Math.min(crashCount - 1, RESTART_BACKOFF_MS.length - 1)
              ] ?? 0;
            if (delay > 0) {
              await new Promise<void>((resolve, reject) => {
                const finish = () => {
                  signal?.removeEventListener("abort", abort);
                  resolve();
                };
                const timer = setTimeout(finish, delay);
                const abort = () => {
                  clearTimeout(timer);
                  signal?.removeEventListener("abort", abort);
                  reject(signal?.reason);
                };
                signal?.addEventListener("abort", abort, { once: true });
              });
            }
            await ensureConnection(signal);
          }
        },
        async close(signal?: AbortSignal) {
          if (closing) return;
          closing = true;
          slotController.abort(
            new Error(`Language server slot ${definition.id} is shutting down`),
          );
          startupController?.abort(
            new Error(`Language server slot ${definition.id} is shutting down`),
          );
          const active =
            connection ?? (await connecting?.catch(() => undefined));
          if (active) {
            for (const document of documents.values()) {
              void active
                .notify("textDocument/didClose", {
                  textDocument: { uri: document.uri },
                })
                .catch(() => undefined);
            }
          }
          const connections = new Set([
            ...retiredConnections,
            ...(active ? [active] : []),
          ]);
          try {
            for (const candidate of connections) await candidate.close(signal);
          } finally {
            connection = undefined;
            retiredConnections.clear();
          }
        },
      };
      const resource = {
        id: `language:${definition.id}:${canonicalPathKey(root)}`,
        closeTimeoutMs: 25_000,
        async start() {
          return {
            value: slot,
            close: ({ signal }: { signal: AbortSignal }) => slot.close(signal),
          };
        },
      };
      return [definition.id, resource] as const;
    }),
  );

  const resolveDocumentPath = (input: string) => {
    if (!input) throw new TypeError("Document path must not be empty");
    const lexicalPath = normalizeCanonicalPath(
      path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input),
    );
    const absolutePath = canonicalCandidate(lexicalPath);
    if (!isInside(root, absolutePath)) {
      throw new TypeError(
        `Document path is outside current worktree: ${input}`,
      );
    }
    return {
      absolutePath,
      relativePath: path.relative(root, absolutePath).replaceAll("\\", "/"),
      uri: pathToFileURL(absolutePath).href,
    };
  };

  const mapUri = (uri: string): MappedLanguagePath | undefined => {
    let absolutePath: string;
    try {
      absolutePath = canonicalCandidate(fileURLToPath(uri));
    } catch {
      return { kind: "external", path: uri, uri };
    }
    return isInside(root, absolutePath)
      ? {
          kind: "project",
          path: path.relative(root, absolutePath).replaceAll("\\", "/"),
        }
      : { kind: "external", path: absolutePath, uri };
  };

  const normalizeLocations = (value: unknown) => {
    const candidates = Array.isArray(value) ? value : value ? [value] : [];
    return candidates.flatMap((candidate): NormalizedLocation[] => {
      const item = record(candidate);
      if (!item) return [];
      const uri = typeof item.uri === "string" ? item.uri : item.targetUri;
      const itemRange = range(item.range ?? item.targetRange);
      if (typeof uri !== "string" || !itemRange) return [];
      const mapped = mapUri(uri);
      if (!mapped) return [];
      const targetSelectionRange = range(item.targetSelectionRange);
      return [
        {
          type: "location",
          path: mapped,
          range: itemRange,
          ...(targetSelectionRange ? { targetSelectionRange } : {}),
        },
      ];
    });
  };

  const normalizeSymbols = (
    value: unknown,
    defaultUri?: string,
    inheritedContainer?: string,
  ): NormalizedSymbol[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate): NormalizedSymbol[] => {
      const item = record(candidate);
      if (!item || typeof item.name !== "string") return [];
      const location = record(item.location);
      const uri =
        typeof location?.uri === "string"
          ? location.uri
          : typeof item.uri === "string"
            ? item.uri
            : defaultUri;
      if (!uri) return [];
      const mapped = mapUri(uri);
      if (!mapped) return [];
      const itemRange = range(location?.range ?? item.range);
      const selectionRange = range(item.selectionRange);
      const containerName =
        typeof item.containerName === "string"
          ? item.containerName
          : inheritedContainer;
      const normalized: NormalizedSymbol = {
        type: "symbol",
        name: item.name,
        kind: symbolKind(item.kind),
        path: mapped,
        ...(itemRange ? { range: itemRange } : {}),
        ...(selectionRange ? { selectionRange } : {}),
        ...(containerName ? { containerName } : {}),
      };
      return [normalized, ...normalizeSymbols(item.children, uri, item.name)];
    });
  };

  const hoverContents = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value))
      return value.map(hoverContents).filter(Boolean).join("\n\n");
    const item = record(value);
    return typeof item?.value === "string" ? item.value : "";
  };

  const normalizeHover = (value: unknown): NormalizedHover[] => {
    const item = record(value);
    if (!item) return [];
    const contents = hoverContents(item.contents);
    if (!contents) return [];
    const itemRange = range(item.range);
    return [
      { type: "hover", contents, ...(itemRange ? { range: itemRange } : {}) },
    ];
  };

  const normalizeDiagnosticItems = (
    value: unknown,
    mappedPath: MappedLanguagePath,
  ): NormalizedDiagnostic[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate): NormalizedDiagnostic[] => {
      const item = record(candidate);
      const itemRange = range(item?.range);
      if (!item || !itemRange) return [];
      const code =
        typeof item.code === "string" || typeof item.code === "number"
          ? String(item.code)
          : undefined;
      return [
        {
          type: "diagnostic",
          path: mappedPath,
          range: itemRange,
          severity: severity(
            typeof item.severity === "number" ? item.severity : undefined,
          ),
          ...(code === undefined ? {} : { code }),
          ...(typeof item.source === "string" ? { source: item.source } : {}),
          message: hoverContents(item.message),
        },
      ];
    });
  };

  const normalizeCalls = (
    value: unknown,
    direction: "incoming" | "outgoing",
  ): NormalizedCall[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate): NormalizedCall[] => {
      const wrapper = record(candidate);
      const item = record(
        direction === "incoming" ? wrapper?.from : wrapper?.to,
      );
      const uri = item?.uri;
      const itemRange = range(item?.range);
      const selectionRange = range(item?.selectionRange);
      if (
        typeof item?.name !== "string" ||
        typeof uri !== "string" ||
        !itemRange ||
        !selectionRange
      ) {
        return [];
      }
      const mapped = mapUri(uri);
      if (!mapped) return [];
      const rangesValue = wrapper?.fromRanges;
      const callRanges = Array.isArray(rangesValue)
        ? rangesValue
            .map(range)
            .filter((item): item is Range => item !== undefined)
        : [];
      return [
        {
          type: "call",
          direction,
          name: item.name,
          kind: symbolKind(item.kind),
          path: mapped,
          range: itemRange,
          selectionRange,
          callRanges,
        },
      ];
    });
  };

  const matchingDefinitions = (
    documentPath: string,
    kind?: LanguageQuery["kind"],
  ) => {
    const extension = path.extname(documentPath).toLowerCase();
    return servers.filter(
      (definition) =>
        (kind === undefined || definition.queries.includes(kind)) &&
        definition.selectors.some((selector) =>
          selector.extensions.some(
            (candidate) => candidate.toLowerCase() === extension,
          ),
        ),
    );
  };

  const acquireSlot = async (definition: LanguageServerDefinition) => {
    const resource = slotResources.get(definition.id);
    if (!resource)
      throw new Error(`Missing language server slot: ${definition.id}`);
    return options.lifecycle.acquire(resource);
  };

  const synchronize = async (
    updates: readonly LanguageDocumentUpdate[],
    signal?: AbortSignal,
  ): Promise<LanguageOutcome<LanguageSynchronization>> => {
    try {
      signal?.throwIfAborted();
      const synchronized: Array<LanguageSynchronization["documents"][number]> =
        [];
      for (const update of updates) {
        const documentPath = resolveDocumentPath(update.path);
        const definitions = matchingDefinitions(documentPath.absolutePath);
        if (definitions.length === 0) {
          return languageFailure(
            "unsupported_capability",
            `No language server is configured for ${documentPath.relativePath}`,
          );
        }
        for (const definition of definitions) {
          const slot = await acquireSlot(definition);
          const key = canonicalPathKey(documentPath.absolutePath);
          const current = slot.documents.get(key);
          if (update.kind === "open") {
            if (current) {
              if (current.text !== update.text)
                return languageFailure(
                  "invalid_input",
                  `Document is already open with different content: ${update.path}`,
                );
              synchronized.push({
                path: current.relativePath,
                state: "open",
                version: current.version,
              });
              continue;
            }
            if (slot.documents.size >= limits.maxOpenDocumentsPerServer) {
              const oldest = slot.documents.entries().next().value as
                [string, DocumentSnapshot] | undefined;
              if (!oldest)
                return languageFailure(
                  "invalid_input",
                  "Open document limit reached",
                );
              slot.documents.delete(oldest[0]);
              slot.diagnostics.delete(oldest[0]);
              await slot.notify(
                (connection) =>
                  connection.notify("textDocument/didClose", {
                    textDocument: { uri: oldest[1].uri },
                  }),
                signal,
              );
            }
            if (Buffer.byteLength(update.text, "utf8") > limits.maxFileBytes) {
              return languageFailure(
                "invalid_input",
                `Document exceeds ${limits.maxFileBytes} byte limit`,
              );
            }
            const selector = definition.selectors.find((candidate) =>
              candidate.extensions.some(
                (extension) =>
                  extension.toLowerCase() ===
                  path.extname(documentPath.absolutePath).toLowerCase(),
              ),
            );
            const snapshot: DocumentSnapshot = {
              ...documentPath,
              languageId:
                update.languageId ?? selector?.languageId ?? "plaintext",
              text: update.text,
              version: slot.nextDocumentVersion(),
            };
            slot.documents.set(key, snapshot);
            try {
              await slot.notify(
                (connection) =>
                  connection.notify("textDocument/didOpen", {
                    textDocument: {
                      uri: snapshot.uri,
                      languageId: snapshot.languageId,
                      version: snapshot.version,
                      text: snapshot.text,
                    },
                  }),
                signal,
              );
            } catch (error) {
              slot.documents.delete(key);
              throw error;
            }
            synchronized.push({
              path: snapshot.relativePath,
              state: "open",
              version: snapshot.version,
            });
          } else if (update.kind === "change") {
            if (!current) {
              return languageFailure(
                "invalid_input",
                `Document is not open: ${update.path}`,
              );
            }
            if (current.text === update.text) {
              slot.documents.delete(key);
              slot.documents.set(key, current);
              synchronized.push({
                path: current.relativePath,
                state: "open",
                version: current.version,
              });
              continue;
            }
            if (Buffer.byteLength(update.text, "utf8") > limits.maxFileBytes) {
              return languageFailure(
                "invalid_input",
                `Document exceeds ${limits.maxFileBytes} byte limit`,
              );
            }
            const previous = {
              text: current.text,
              version: current.version,
              diagnostics: slot.diagnostics.get(key),
            };
            current.version = slot.nextDocumentVersion();
            current.text = update.text;
            slot.markDiagnosticsChanged(key);
            slot.diagnostics.delete(key);
            try {
              await slot.notify(
                (connection) =>
                  connection.notify("textDocument/didChange", {
                    textDocument: {
                      uri: current.uri,
                      version: current.version,
                    },
                    contentChanges: [{ text: current.text }],
                  }),
                signal,
              );
            } catch (error) {
              current.version = previous.version;
              current.text = previous.text;
              if (previous.diagnostics)
                slot.diagnostics.set(key, previous.diagnostics);
              throw error;
            }
            slot.documents.delete(key);
            slot.documents.set(key, current);
            synchronized.push({
              path: current.relativePath,
              state: "open",
              version: current.version,
            });
          } else {
            if (!current) {
              synchronized.push({
                path: documentPath.relativePath,
                state: "closed",
                version: slot.nextDocumentVersion(),
              });
              continue;
            }
            const priorDiagnostics = slot.diagnostics.get(key);
            slot.documents.delete(key);
            slot.diagnostics.delete(key);
            try {
              await slot.notify(
                (connection) =>
                  connection.notify("textDocument/didClose", {
                    textDocument: { uri: current.uri },
                  }),
                signal,
              );
            } catch (error) {
              slot.documents.set(key, current);
              if (priorDiagnostics) {
                slot.diagnostics.set(key, priorDiagnostics);
              }
              throw error;
            }
            synchronized.push({
              path: current.relativePath,
              state: "closed",
              version: current.version,
            });
          }
        }
      }
      return success({
        advisory: true,
        authority: "repository-native-checks",
        documents: synchronized,
      });
    } catch (error) {
      if (signal?.aborted)
        return languageFailure(
          "cancelled",
          "Language synchronization cancelled",
        );
      if (error instanceof LanguageTimeoutError) {
        return languageFailure("startup_timeout", error.message, true, {
          timeoutMs: error.timeoutMs,
        });
      }
      if (!(error instanceof TypeError)) {
        return languageFailure(
          "server_unavailable",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      return languageFailure(
        "invalid_input",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const query = async (
    request: LanguageQuery,
    signal?: AbortSignal,
  ): Promise<LanguageOutcome<LanguageQueryResult>> => {
    try {
      signal?.throwIfAborted();
      const requestDeadline = Date.now() + limits.requestTimeoutMs;
      const requestedPath =
        "path" in request && request.path
          ? resolveDocumentPath(request.path)
          : undefined;
      const definitions = requestedPath
        ? matchingDefinitions(requestedPath.absolutePath, request.kind)
        : servers.filter((definition) =>
            definition.queries.includes(request.kind),
          );
      if (definitions.length === 0) {
        return languageFailure(
          "unsupported_capability",
          `No server supports ${request.kind}`,
        );
      }
      const items: NormalizedLanguageItem[] = [];
      const serverIds: string[] = [];
      for (const definition of definitions.slice(
        0,
        limits.maxServersPerQuery,
      )) {
        const slot = await acquireSlot(definition);
        const querySignal = signal
          ? AbortSignal.any([signal, slot.signal])
          : slot.signal;
        const supported = await slot.run(
          async (connection) =>
            capabilitySupported(connection.capabilities, request.kind),
          querySignal,
        );
        if (!supported) continue;
        const serverRequest = (method: string, params: unknown) => {
          const remainingMs = Math.max(0, requestDeadline - Date.now());
          return withDeadline(
            (requestSignal) =>
              slot.run(
                (connection) =>
                  connection.request(method, params, requestSignal),
                requestSignal,
              ),
            remainingMs,
            querySignal,
            "request",
          ).catch((error) => {
            if (error instanceof LanguageTimeoutError) {
              throw new LanguageTimeoutError(
                "request",
                limits.requestTimeoutMs,
              );
            }
            throw error;
          });
        };
        serverIds.push(definition.id);
        if (request.kind === "diagnostics") {
          if (!requestedPath && slot.hasAnyUnsafeDiagnostics())
            return languageFailure(
              "unsupported_capability",
              `Language server ${definition.id} has changed documents with unversioned diagnostics; query a versioned server or use the repository-native check.`,
              false,
              { serverId: definition.id },
            );
          const supportsPull = await slot.run(
            async (connection) =>
              Boolean(connection.capabilities.diagnosticProvider),
            querySignal,
          );
          if (requestedPath && supportsPull) {
            const response = record(
              await serverRequest("textDocument/diagnostic", {
                textDocument: { uri: requestedPath.uri },
              }),
            );
            items.push(
              ...normalizeDiagnosticItems(response?.items, {
                kind: "project",
                path: requestedPath.relativePath,
              }),
            );
          } else if (requestedPath) {
            const diagnosticKey = canonicalPathKey(requestedPath.absolutePath);
            if (slot.hasUnsafeDiagnostics(diagnosticKey))
              return languageFailure(
                "unsupported_capability",
                `Language server ${definition.id} publishes unversioned diagnostics after document changes; use the repository-native check.`,
                false,
                { serverId: definition.id, path: requestedPath.relativePath },
              );
            items.push(...(slot.diagnostics.get(diagnosticKey)?.items ?? []));
          } else {
            for (const published of slot.diagnostics.values())
              items.push(...published.items);
          }
          continue;
        }
        if (request.kind === "workspaceSymbols") {
          const response = await serverRequest("workspace/symbol", {
            query: request.query,
          });
          items.push(...normalizeSymbols(response));
          continue;
        }
        if (!requestedPath) continue;
        const textDocument = { uri: requestedPath.uri };
        if (request.kind === "documentSymbols") {
          const response = await serverRequest("textDocument/documentSymbol", {
            textDocument,
          });
          items.push(...normalizeSymbols(response, requestedPath.uri));
          continue;
        }
        const textPosition = { textDocument, position: request.position };
        if (request.kind === "definition") {
          items.push(
            ...normalizeLocations(
              await serverRequest("textDocument/definition", textPosition),
            ),
          );
        } else if (request.kind === "references") {
          items.push(
            ...normalizeLocations(
              await serverRequest("textDocument/references", {
                ...textPosition,
                context: { includeDeclaration: true },
              }),
            ),
          );
        } else if (request.kind === "implementations") {
          items.push(
            ...normalizeLocations(
              await serverRequest("textDocument/implementation", textPosition),
            ),
          );
        } else if (request.kind === "hover") {
          items.push(
            ...normalizeHover(
              await serverRequest("textDocument/hover", textPosition),
            ),
          );
        } else if (request.kind === "callHierarchy") {
          const prepared = await serverRequest(
            "textDocument/prepareCallHierarchy",
            textPosition,
          );
          const preparedItems = Array.isArray(prepared)
            ? prepared.slice(0, limits.maxResultItems)
            : [];
          for (const item of preparedItems) {
            const method =
              request.direction === "incoming"
                ? "callHierarchy/incomingCalls"
                : "callHierarchy/outgoingCalls";
            items.push(
              ...normalizeCalls(
                await serverRequest(method, { item }),
                request.direction,
              ),
            );
          }
        }
      }
      if (serverIds.length === 0) {
        return languageFailure(
          "unsupported_capability",
          `Configured language servers do not support ${request.kind}`,
          false,
          { kind: request.kind, serverIds: definitions.map(({ id }) => id) },
        );
      }
      const normalized = deterministicItems(items);
      const boundedItems = normalized.slice(0, limits.maxResultItems);
      let truncated = boundedItems.length < normalized.length;
      const value: LanguageQueryResult & {
        items: NormalizedLanguageItem[];
        truncated: boolean;
        artifact?: {
          id: string;
          size: number;
          mediaType: "application/json";
        };
      } = {
        advisory: true,
        authority: "repository-native-checks",
        kind: request.kind,
        serverIds,
        items: boundedItems,
        truncated,
      };
      while (
        value.items.length > 0 &&
        Buffer.byteLength(JSON.stringify(value), "utf8") >
          limits.maxResponseBytes
      ) {
        boundedItems.pop();
        truncated = true;
        value.truncated = truncated;
      }
      if (value.truncated) {
        if (!options.artifacts) {
          return languageFailure(
            "artifact_unavailable",
            "A complete language result requires an ArtifactStore",
            false,
          );
        }
        signal?.throwIfAborted();
        const completeBody = JSON.stringify({
          advisory: true,
          authority: "repository-native-checks",
          kind: request.kind,
          serverIds,
          items: normalized,
        });
        const stored = await options.artifacts.put({
          body: completeBody,
          filename: `language-${request.kind}.json`,
          mediaType: "application/json",
          metadata: {
            source: "language-intelligence",
            advisory: true,
            authority: "repository-native-checks",
            kind: request.kind,
            serverIds,
          },
        });
        signal?.throwIfAborted();
        if (!stored.ok) {
          return languageFailure(
            "artifact_unavailable",
            `Could not persist complete language result: ${stored.error.message}`,
            stored.error.retryable,
            { artifactError: stored.error.code },
          );
        }
        value.artifact = {
          id: stored.value.id,
          size: stored.value.size,
          mediaType: "application/json",
        };
        while (
          value.items.length > 0 &&
          Buffer.byteLength(JSON.stringify(value), "utf8") >
            limits.maxResponseBytes
        ) {
          boundedItems.pop();
        }
      }
      if (
        Buffer.byteLength(JSON.stringify(value), "utf8") >
        limits.maxResponseBytes
      ) {
        return languageFailure(
          "response_too_large",
          `Language response metadata exceeds ${limits.maxResponseBytes} byte limit`,
          false,
          { maxBytes: limits.maxResponseBytes },
        );
      }
      return success(value);
    } catch (error) {
      if (signal?.aborted)
        return languageFailure("cancelled", "Language query cancelled");
      if (error instanceof LanguageTimeoutError) {
        return languageFailure(
          error.phase === "startup" ? "startup_timeout" : "request_timeout",
          error.message,
          true,
          { timeoutMs: error.timeoutMs },
        );
      }
      if (error instanceof TypeError) {
        return languageFailure("invalid_input", error.message);
      }
      return languageFailure(
        "server_unavailable",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  };

  return {
    async discover() {
      return { ok: true, value: structuredClone(discovery) };
    },
    synchronize,
    query,
  };
}
