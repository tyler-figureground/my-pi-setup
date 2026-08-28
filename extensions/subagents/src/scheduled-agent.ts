import path from "node:path";
import { sanitizeSessionText } from "../../platform/src/messaging/index.ts";
import type {
  ScheduledAgentExecutor,
  ScheduledAgentFailure,
  ScheduledAgentRequest,
} from "../../shared/scheduled-agent.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentSnapshot,
} from "./domain.ts";
import {
  compileClaudeExecutionPolicy,
  compileCodexExecutionPolicy,
  compilePiExecutionPolicy,
} from "./profile-policy.ts";

const PROMPT_MAX_BYTES = 256 * 1_024;
const OUTPUT_MAX_BYTES = 16 * 1_024 * 1_024;
const TIMEOUT_MAX_MS = 60 * 60 * 1_000;
const PATH_MAX_BYTES = 32 * 1_024;
const PROJECT_ID_MAX_BYTES = 1_024;
const OCCURRENCE_ID = /^[a-f0-9]{64}$/;
const FORBIDDEN_OVERRIDES = [
  "role",
  "tools",
  "model",
  "trust",
  "projectTrusted",
  "execution",
  "workspace",
  "credentials",
  "credentialReferences",
  "reasoningEffort",
] as const;
const ERROR_MAX_BYTES = 1_000;
const CANCEL_DRAIN_MS = 6_000;

function boundUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  return bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function redact(text: string) {
  return sanitizeSessionText(text);
}

function safeMessage(message: string) {
  return boundUtf8(redact(message), ERROR_MAX_BYTES);
}

function abortWait<const T extends string>(
  signal: AbortSignal | undefined,
  result: T,
) {
  let listener: (() => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve(result);
      return;
    }
    listener = () => resolve(result);
    signal.addEventListener("abort", listener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (listener) signal?.removeEventListener("abort", listener);
    },
  };
}

function timeoutWait(timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), timeoutMs);
    }),
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

async function drainCancellation(
  manager: ScheduledSubagentManager,
  childId: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      manager.cancel([childId]).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CANCEL_DRAIN_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failure(
  code: ScheduledAgentFailure["code"],
  message: string,
  retryable = false,
) {
  return { ok: false as const, error: { code, message, retryable } };
}

function isPlainData(value: unknown) {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return true;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate !== "object" || depth > 32 || ++nodes > 4_096) {
      return false;
    }
    if (active.has(candidate)) return false;
    const prototype = Object.getPrototypeOf(candidate);
    if (
      !Array.isArray(candidate) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return false;
    }
    if (Object.getOwnPropertySymbols(candidate).length > 0) return false;
    active.add(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(candidate) && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    active.delete(candidate);
    return true;
  };
  return visit(value, 0);
}

function requestIsValid(request: ScheduledAgentRequest) {
  if (!isPlainData(request) || !request || typeof request !== "object") {
    return false;
  }
  const keys = Object.keys(request);
  if (
    keys.length !== 7 ||
    !keys.every((key) =>
      [
        "occurrenceId",
        "prompt",
        "cwd",
        "projectId",
        "profile",
        "timeoutMs",
        "maxOutputBytes",
      ].includes(key),
    )
  ) {
    return false;
  }
  return (
    OCCURRENCE_ID.test(request.occurrenceId) &&
    typeof request.prompt === "string" &&
    Buffer.byteLength(request.prompt) > 0 &&
    Buffer.byteLength(request.prompt) <= PROMPT_MAX_BYTES &&
    typeof request.cwd === "string" &&
    path.isAbsolute(request.cwd) &&
    !request.cwd.includes("\0") &&
    Buffer.byteLength(request.cwd) <= PATH_MAX_BYTES &&
    typeof request.projectId === "string" &&
    !request.projectId.includes("\0") &&
    Buffer.byteLength(request.projectId) > 0 &&
    Buffer.byteLength(request.projectId) <= PROJECT_ID_MAX_BYTES &&
    Number.isSafeInteger(request.timeoutMs) &&
    request.timeoutMs >= 1_000 &&
    request.timeoutMs <= TIMEOUT_MAX_MS &&
    Number.isSafeInteger(request.maxOutputBytes) &&
    request.maxOutputBytes >= 1 &&
    request.maxOutputBytes <= OUTPUT_MAX_BYTES &&
    FORBIDDEN_OVERRIDES.every((key) => !Object.hasOwn(request, key))
  );
}

function profileCanRun(request: ScheduledAgentRequest) {
  if (request.profile.policy.role !== "scheduled") return false;
  switch (request.profile.defaults.backend) {
    case "pi":
      compilePiExecutionPolicy(request.profile.policy);
      return true;
    case "claude":
      compileClaudeExecutionPolicy(request.profile.policy);
      return true;
    case "codex":
      return compileCodexExecutionPolicy(request.profile.policy).ok;
  }
}

export interface ScheduledSubagentManager {
  spawn(
    backend: BackendName,
    task: SpawnTask,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot>;
  waitFor(ids: readonly string[]): Promise<void>;
  get(id: string): Promise<SubagentSnapshot | undefined>;
  cancel(ids: readonly string[]): Promise<unknown>;
}

export interface ScheduledAgentExecutorOptions {
  readonly manager: () => Promise<ScheduledSubagentManager>;
  readonly parent: (request: ScheduledAgentRequest) => ParentContext;
  readonly generation: () => number;
  readonly lifecycleSignal: () => AbortSignal;
}

export function createScheduledAgentExecutor(
  options: ScheduledAgentExecutorOptions,
) {
  return {
    async run(request, signal?: AbortSignal) {
      const generation = options.generation();
      const lifecycleSignal = options.lifecycleSignal();
      const isShuttingDown = () =>
        lifecycleSignal.aborted || options.generation() !== generation;
      const shuttingDown = () =>
        failure(
          "shutting_down",
          "Scheduled Agent executor is shutting down.",
          true,
        );
      if (isShuttingDown()) return shuttingDown();
      if (!requestIsValid(request)) {
        return failure(
          "invalid_request",
          "Scheduled Agent request is outside host safety bounds.",
        );
      }
      request = structuredClone(request);
      try {
        if (!profileCanRun(request)) {
          return failure(
            "profile_denied",
            "Scheduled Agent profile policy cannot be enforced.",
          );
        }
      } catch {
        return failure(
          "profile_denied",
          "Scheduled Agent profile policy cannot be enforced.",
        );
      }
      if (signal?.aborted) {
        return failure("cancelled", "Scheduled Agent execution was cancelled.");
      }
      const callerAbort = abortWait(signal, "cancelled");
      const lifecycleAbort = abortWait(lifecycleSignal, "shutting_down");
      const timeout = timeoutWait(request.timeoutMs);
      const operation = new AbortController();
      let interruptionReason:
        "cancelled" | "shutting_down" | "timed_out" | undefined;
      const interruption = Promise.race([
        callerAbort.promise,
        lifecycleAbort.promise,
        timeout.promise,
      ]).then((reason) => {
        interruptionReason = reason;
        operation.abort();
        return reason;
      });
      const interruptionOutcome = (
        reason: "cancelled" | "shutting_down" | "timed_out",
      ) => {
        if (isShuttingDown() || reason === "shutting_down") {
          return shuttingDown();
        }
        if (reason === "cancelled") {
          return failure(
            "cancelled",
            "Scheduled Agent execution was cancelled.",
          );
        }
        return failure(
          "timed_out",
          `Scheduled Agent execution timed out after ${request.timeoutMs} ms.`,
          true,
        );
      };
      try {
        const managerResult = await Promise.race([
          options
            .manager()
            .then((manager) => ({ kind: "ready" as const, manager })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (managerResult.kind === "interrupted") {
          return interruptionOutcome(managerResult.reason);
        }
        const manager = managerResult.manager;
        if (isShuttingDown()) return shuttingDown();
        const task = {
          origin: "model",
          prompt: request.prompt,
          title: `Scheduled occurrence ${request.occurrenceId}`,
          cwd: request.cwd,
          model: request.profile.defaults.model,
          reasoningEffort: request.profile.defaults.effort,
          profile: request.profile.identity,
          execution: request.profile.policy,
          parent: options.parent(request),
        } satisfies SpawnTask;
        const spawn = manager.spawn(
          request.profile.defaults.backend,
          task,
          operation.signal,
        );
        const spawnResult = await Promise.race([
          spawn.then((started) => ({ kind: "started" as const, started })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (spawnResult.kind === "interrupted") {
          void spawn
            .then((started) => drainCancellation(manager, started.id))
            .catch(() => undefined);
          return interruptionOutcome(spawnResult.reason);
        }
        const started = spawnResult.started;
        if (isShuttingDown()) {
          await drainCancellation(manager, started.id);
          return shuttingDown();
        }
        const wait = manager.waitFor([started.id]);
        const waitResult = await Promise.race([
          wait.then(() => ({ kind: "settled" as const })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (waitResult.kind === "interrupted" || isShuttingDown()) {
          await drainCancellation(manager, started.id);
          return interruptionOutcome(
            waitResult.kind === "interrupted"
              ? waitResult.reason
              : "shutting_down",
          );
        }
        const settled = await manager.get(started.id);
        if (!settled || settled.status !== "done") {
          return {
            ok: false,
            error: {
              code: "run_failed",
              message: safeMessage(
                settled?.errorText ?? "Scheduled child did not settle.",
              ),
              retryable: true,
            },
          };
        }
        const output = redact(settled.finalText);
        const outputBytes = Buffer.byteLength(output);
        if (outputBytes > request.maxOutputBytes) {
          return failure(
            "output_bounded",
            `Scheduled Agent output exceeded ${request.maxOutputBytes} bytes.`,
          );
        }
        return {
          ok: true,
          value: {
            status: "completed",
            output,
            outputBytes,
            ...(settled.meta.nativeSessionId
              ? {
                  sessionId: boundUtf8(
                    redact(settled.meta.nativeSessionId),
                    256,
                  ),
                }
              : {}),
          },
        };
      } catch (error) {
        if (isShuttingDown()) return shuttingDown();
        if (interruptionReason) return interruptionOutcome(interruptionReason);
        const message = safeMessage(
          error instanceof Error ? error.message : String(error),
        );
        if (
          /\bbackend\b.*\b(?:not available|unavailable|unknown)\b/i.test(
            message,
          )
        ) {
          return failure("backend_unavailable", message, true);
        }
        return failure(
          "run_failed",
          message || "Scheduled Agent failed.",
          true,
        );
      } finally {
        callerAbort.dispose();
        lifecycleAbort.dispose();
        timeout.dispose();
      }
    },
  } satisfies ScheduledAgentExecutor;
}
