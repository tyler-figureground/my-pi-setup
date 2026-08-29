import { isDeepStrictEqual } from "node:util";
import type { NamedProfileExecutionPort } from "../../platform/src/automation/hooks/adapters.ts";
import { sanitizeSessionText } from "../../platform/src/messaging/index.ts";
import type {
  ProfileCatalog,
  ResolvedAgentProfile,
} from "../../platform/src/profiles/index.ts";
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

const ERROR_MAX_BYTES = 1_000;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const PROFILE_DIGEST = /^[a-f0-9]{64}$/;
const CANCEL_DRAIN_MS = 6_000;

function boundUtf8(text: string, maxBytes: number) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text)
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function safeMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return boundUtf8(sanitizeSessionText(message), ERROR_MAX_BYTES);
}

function hasExactDataFields(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  return (
    keys.length === fields.length &&
    keys.every(
      (key) =>
        fields.includes(key) &&
        "value" in descriptors[key]! &&
        descriptors[key]!.enumerable,
    )
  );
}

function revalidationRequestIsValid(
  request: Parameters<NamedProfileExecutionPort["revalidateProfile"]>[0],
) {
  return (
    hasExactDataFields(request, [
      "name",
      "contentDigest",
      "catalogGeneration",
      "source",
      "cwd",
      "signal",
    ]) &&
    PROFILE_NAME.test(request.name) &&
    PROFILE_DIGEST.test(request.contentDigest) &&
    Number.isSafeInteger(request.catalogGeneration) &&
    request.catalogGeneration >= 1 &&
    hasExactDataFields(request.source, ["scope", "path"]) &&
    ["managed", "user", "project"].includes(request.source.scope) &&
    typeof request.source.path === "string" &&
    request.source.path.length > 0 &&
    request.source.path.length <= 32_768 &&
    !request.source.path.includes("\0") &&
    typeof request.cwd === "string" &&
    request.cwd.length > 0 &&
    request.cwd.length <= 32_768 &&
    !request.cwd.includes("\0") &&
    request.signal instanceof AbortSignal
  );
}

function runRequestIsValid(
  request: Parameters<NamedProfileExecutionPort["run"]>[0],
) {
  return (
    hasExactDataFields(request, [
      "profile",
      "prompt",
      "cwd",
      "signal",
      "deadlineMs",
      "outputCapBytes",
    ]) &&
    !!request.profile &&
    typeof request.profile === "object" &&
    typeof request.prompt === "string" &&
    Buffer.byteLength(request.prompt) > 0 &&
    Buffer.byteLength(request.prompt) <= 1024 * 1024 &&
    !request.prompt.includes("\0") &&
    typeof request.cwd === "string" &&
    request.cwd.length > 0 &&
    request.cwd.length <= 32_768 &&
    !request.cwd.includes("\0") &&
    request.signal instanceof AbortSignal &&
    Number.isSafeInteger(request.deadlineMs) &&
    request.deadlineMs > Date.now() &&
    request.deadlineMs <= Date.now() + 86_400_000 &&
    Number.isSafeInteger(request.outputCapBytes) &&
    request.outputCapBytes >= 1 &&
    request.outputCapBytes <= OUTPUT_MAX_BYTES
  );
}

function abortWait<const T extends string>(signal: AbortSignal, result: T) {
  let listener: (() => void) | undefined;
  const promise = new Promise<T>((resolve) => {
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
      if (listener) signal.removeEventListener("abort", listener);
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
  manager: NamedProfileSubagentManager,
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameIdentity(
  profile: ResolvedAgentProfile,
  identity: ResolvedAgentProfile["identity"],
) {
  return (
    profile.identity.name === identity.name &&
    profile.identity.contentDigest === identity.contentDigest &&
    profile.identity.catalogGeneration === identity.catalogGeneration &&
    profile.identity.source.scope === identity.source.scope &&
    profile.identity.source.path === identity.source.path
  );
}

function profileCanRun(profile: ResolvedAgentProfile) {
  if (profile.policy.role !== "subagent" && profile.policy.role !== "review") {
    return false;
  }
  switch (profile.defaults.backend) {
    case "pi":
      compilePiExecutionPolicy(profile.policy);
      return true;
    case "claude":
      compileClaudeExecutionPolicy(profile.policy);
      return true;
    case "codex":
      return compileCodexExecutionPolicy(profile.policy).ok;
  }
}

export interface NamedProfileSubagentManager {
  spawn(
    backend: BackendName,
    task: SpawnTask,
    signal?: AbortSignal,
  ): Promise<SubagentSnapshot>;
  waitFor(ids: readonly string[]): Promise<void>;
  get(id: string): Promise<SubagentSnapshot | undefined>;
  cancel(ids: readonly string[]): Promise<unknown>;
}

export interface NamedProfileExecutionContext {
  readonly cwd: string;
  readonly catalogProjectMatches: boolean;
  readonly projectTrusted: boolean;
  readonly parent: ParentContext;
}

export interface NamedProfileExecutionOptions {
  readonly profiles: () => ProfileCatalog | undefined;
  readonly manager: () => Promise<NamedProfileSubagentManager>;
  readonly context: (cwd: string) => Promise<NamedProfileExecutionContext>;
  readonly generation: () => number;
  readonly lifecycleSignal: () => AbortSignal;
}

export function createNamedProfileExecutionPort(
  options: NamedProfileExecutionOptions,
): NamedProfileExecutionPort {
  let sequence = 0;

  const currentProfile = (identity: ResolvedAgentProfile["identity"]) => {
    const profiles = options.profiles();
    if (!profiles) throw new Error("Named Agent Profiles are unavailable.");
    if (profiles.inspect().generation !== identity.catalogGeneration) {
      throw new Error("Named Agent Profile generation is stale.");
    }
    const resolution = profiles.resolve(identity.name);
    if (!resolution.ok || !sameIdentity(resolution.value, identity)) {
      throw new Error("Named Agent Profile identity changed.");
    }
    if (!profileCanRun(resolution.value)) {
      throw new Error("Named Agent Profile policy cannot be enforced.");
    }
    return resolution.value;
  };

  const trustedContext = async (cwd: string, profile: ResolvedAgentProfile) => {
    const context = await options.context(cwd);
    const trusted =
      context.catalogProjectMatches &&
      (profile.identity.source.scope !== "project" || context.projectTrusted);
    return { context, trusted };
  };

  return {
    async revalidateProfile(request) {
      if (!revalidationRequestIsValid(request)) {
        throw new TypeError("Named Profile revalidation request is invalid.");
      }
      const generation = options.generation();
      if (
        options.lifecycleSignal().aborted ||
        options.generation() !== generation
      ) {
        throw new Error("Named Profile execution is shutting down.");
      }
      if (request.signal.aborted) {
        throw new Error("Named Profile revalidation was cancelled.");
      }
      try {
        const identity = {
          name: request.name,
          contentDigest: request.contentDigest,
          catalogGeneration: request.catalogGeneration,
          source: request.source,
        };
        const current = currentProfile(identity);
        const { trusted } = await trustedContext(request.cwd, current);
        const latest = currentProfile(identity);
        if (
          request.signal.aborted ||
          options.lifecycleSignal().aborted ||
          options.generation() !== generation
        ) {
          throw new Error(
            request.signal.aborted
              ? "Named Profile revalidation was cancelled."
              : "Named Profile execution is shutting down.",
          );
        }
        return {
          trusted,
          contentDigest: latest.identity.contentDigest,
        };
      } catch (error) {
        throw new Error(
          safeMessage(error) || "Named Profile revalidation failed.",
        );
      }
    },
    async run(request) {
      if (!runRequestIsValid(request)) {
        throw new TypeError("Named Profile execution request is invalid.");
      }
      const generation = options.generation();
      if (
        options.lifecycleSignal().aborted ||
        options.generation() !== generation
      ) {
        throw new Error("Named Profile execution is shutting down.");
      }
      if (request.signal.aborted) {
        throw new Error("Named Profile execution was cancelled.");
      }
      const lifecycleSignal = options.lifecycleSignal();
      const isShuttingDown = () =>
        lifecycleSignal.aborted || options.generation() !== generation;
      const callerAbort = abortWait(request.signal, "cancelled");
      const lifecycleAbort = abortWait(lifecycleSignal, "shutting_down");
      const requestedTimeout = request.deadlineMs - Date.now();
      const profileTimeout = request.profile.policy.limits.timeoutMs;
      const timeout = timeoutWait(
        Math.max(
          0,
          Math.min(requestedTimeout, profileTimeout ?? requestedTimeout),
        ),
      );
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
      const interrupted = (
        reason: "cancelled" | "shutting_down" | "timed_out",
      ) => {
        if (isShuttingDown() || reason === "shutting_down") {
          return new Error("Named Profile execution is shutting down.");
        }
        if (reason === "cancelled") {
          return new Error("Named Profile execution was cancelled.");
        }
        return new Error("Named Profile execution deadline was exceeded.");
      };
      try {
        const resolved = currentProfile(request.profile.identity);
        if (!isDeepStrictEqual(request.profile, resolved)) {
          throw new Error("Named Agent Profile policy changed.");
        }
        const initialContext = await Promise.race([
          trustedContext(request.cwd, resolved).then((value) => ({
            kind: "ready" as const,
            value,
          })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (initialContext.kind === "interrupted") {
          throw interrupted(initialContext.reason);
        }
        if (!initialContext.value.trusted) {
          throw new Error("Named Agent Profile trust changed.");
        }
        const profile = deepFreeze(structuredClone(resolved));
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
          throw interrupted(managerResult.reason);
        }
        const manager = managerResult.manager;
        const current = currentProfile(profile.identity);
        const latestContext = await Promise.race([
          trustedContext(request.cwd, current).then((value) => ({
            kind: "ready" as const,
            value,
          })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (latestContext.kind === "interrupted") {
          throw interrupted(latestContext.reason);
        }
        const currentAtSpawn = currentProfile(profile.identity);
        if (
          !isDeepStrictEqual(profile, current) ||
          !isDeepStrictEqual(profile, currentAtSpawn) ||
          !latestContext.value.trusted ||
          isShuttingDown()
        ) {
          throw new Error("Named Agent Profile changed before execution.");
        }
        const task = {
          origin: "model",
          prompt: request.prompt,
          title: `Hook agent ${profile.identity.name} ${++sequence}`,
          cwd: latestContext.value.context.cwd,
          model: profile.defaults.model,
          reasoningEffort: profile.defaults.effort,
          profile: profile.identity,
          execution: profile.policy,
          parent: latestContext.value.context.parent,
        } satisfies SpawnTask;
        const spawn = manager.spawn(
          profile.defaults.backend,
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
          throw interrupted(spawnResult.reason);
        }
        const started = spawnResult.started;
        if (isShuttingDown()) {
          await drainCancellation(manager, started.id);
          throw interrupted("shutting_down");
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
          throw interrupted(
            waitResult.kind === "interrupted"
              ? waitResult.reason
              : "shutting_down",
          );
        }
        const get = manager.get(started.id);
        const getResult = await Promise.race([
          get.then((settled) => ({ kind: "settled" as const, settled })),
          interruption.then((reason) => ({
            kind: "interrupted" as const,
            reason,
          })),
        ]);
        if (getResult.kind === "interrupted" || isShuttingDown()) {
          await drainCancellation(manager, started.id);
          throw interrupted(
            getResult.kind === "interrupted"
              ? getResult.reason
              : "shutting_down",
          );
        }
        const settled = getResult.settled;
        if (!settled || settled.status !== "done") {
          throw new Error(
            settled?.errorText ?? "Named Profile child did not settle.",
          );
        }
        currentProfile(profile.identity);
        return {
          output: boundUtf8(
            sanitizeSessionText(settled.finalText),
            request.outputCapBytes,
          ),
        };
      } catch (error) {
        if (isShuttingDown()) {
          throw new Error("Named Profile execution is shutting down.");
        }
        if (interruptionReason) throw interrupted(interruptionReason);
        throw new Error(
          safeMessage(error) || "Named Profile execution failed.",
        );
      } finally {
        callerAbort.dispose();
        lifecycleAbort.dispose();
        timeout.dispose();
      }
    },
  };
}
