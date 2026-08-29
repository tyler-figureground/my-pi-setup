import { createHash } from "node:crypto";
import type { ResolvedAgentProfile } from "../../../../shared/agent-profile.ts";
import { defaultPlatformSchedulerConfiguration } from "./config.ts";
import {
  nextOccurrence,
  normalizeSchedule,
  resolveMissedRun,
} from "./calendar.ts";
import {
  createSchedulerPersistence,
  scheduleCommandDigest,
  type PersistedSchedule,
} from "./persistence.ts";
import type {
  HostAuthority,
  PinnedScheduleProfile,
  ScheduleChangeReceipt,
  ScheduleErrorCode,
  ScheduleOutcome,
  SchedulePolicy,
  ScheduleSnapshot,
  SchedulerHostAuthorityOptions,
  SchedulerOptions,
} from "./model.ts";

export type {
  HostAuthority,
  HostAuthorityError,
  HostAuthorityRequest,
  ResultDelivery,
  ResultDeliveryError,
  ResultDeliveryRequest,
  ScheduleChangeReceipt,
  ScheduleCommand,
  ScheduleError,
  ScheduleInspection,
  ScheduleOccurrenceSnapshot,
  SchedulePolicy,
  ScheduleQuery,
  ScheduleSnapshot,
  Scheduler,
  SchedulerClock,
  SchedulerHostAuthorityOptions,
  SchedulerOptions,
  SchedulerRuntime,
} from "./model.ts";
export type {
  CalendarSearchOptions,
  CronSchedule,
  CronScheduleInput,
  IntervalSchedule,
  IntervalScheduleInput,
  MissedRunPolicy,
  OneShotSchedule,
  OneShotScheduleInput,
  Schedule,
  ScheduleInput,
} from "./model.ts";
export {
  nextOccurrence,
  normalizeSchedule,
  resolveMissedRun,
} from "./calendar.ts";
export { createSessionBrokerScheduleDelivery } from "./delivery.ts";

const ID = /^[a-z][a-z0-9-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CREDENTIAL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROMPT_MAX_BYTES = 256 * 1024;
const COMMAND_TYPES = new Set([
  "create",
  "replace",
  "pause",
  "resume",
  "run-now",
  "delete",
]);
const SCHEDULE_STATES = new Set(["active", "paused", "blocked", "deleted"]);
const DEFINITION_COMMAND_KEYS = new Set([
  "type",
  "requestId",
  "id",
  "expectedRevision",
  "scope",
  "schedule",
  "missedRunPolicy",
  "profileName",
  "prompt",
  "credentialReferences",
  "policy",
]);
const CONTROL_COMMAND_KEYS = new Set([
  "type",
  "requestId",
  "id",
  "expectedRevision",
]);
const QUERY_KEYS = new Set([
  "id",
  "state",
  "includeHistory",
  "afterId",
  "limit",
]);

type DataValues = Readonly<Record<string, unknown>>;

function exactDataValues(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: readonly string[] = [],
): DataValues | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function decodeStringArray(value: unknown) {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
      )
    )
      return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length =
      lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 32
    )
      return null;
    const output: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string"
      )
        return null;
      output.push(descriptor.value);
    }
    if (keys.length !== length + 1) return null;
    return output;
  } catch {
    return null;
  }
}

function decodeScheduleInput(value: unknown) {
  const discriminator = exactDataValues(
    value,
    new Set(["kind", "at", "anchor", "everyMs", "expression", "timeZone"]),
    ["kind"],
  );
  if (!discriminator) return null;
  if (discriminator.kind === "one-shot") {
    const fields = exactDataValues(value, new Set(["kind", "at"]), [
      "kind",
      "at",
    ]);
    if (!fields || typeof fields.at !== "string") return null;
    return { kind: "one-shot" as const, at: fields.at };
  }
  if (discriminator.kind === "interval") {
    const fields = exactDataValues(
      value,
      new Set(["kind", "anchor", "everyMs"]),
      ["kind", "anchor", "everyMs"],
    );
    if (
      !fields ||
      typeof fields.anchor !== "string" ||
      typeof fields.everyMs !== "number"
    )
      return null;
    return {
      kind: "interval" as const,
      anchor: fields.anchor,
      everyMs: fields.everyMs,
    };
  }
  if (discriminator.kind === "cron") {
    const fields = exactDataValues(
      value,
      new Set(["kind", "expression", "timeZone"]),
      ["kind", "expression", "timeZone"],
    );
    if (
      !fields ||
      typeof fields.expression !== "string" ||
      typeof fields.timeZone !== "string"
    )
      return null;
    return {
      kind: "cron" as const,
      expression: fields.expression,
      timeZone: fields.timeZone,
    };
  }
  return null;
}

function decodePolicy(value: unknown) {
  if (value === undefined) return undefined;
  const fields = exactDataValues(
    value,
    new Set(["timeoutMs", "maxRetries", "maxOutputBytes"]),
  );
  if (!fields) return null;
  if (
    (fields.timeoutMs !== undefined && typeof fields.timeoutMs !== "number") ||
    (fields.maxRetries !== undefined &&
      typeof fields.maxRetries !== "number") ||
    (fields.maxOutputBytes !== undefined &&
      typeof fields.maxOutputBytes !== "number")
  )
    return null;
  return {
    ...(fields.timeoutMs === undefined ? {} : { timeoutMs: fields.timeoutMs }),
    ...(fields.maxRetries === undefined
      ? {}
      : { maxRetries: fields.maxRetries }),
    ...(fields.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: fields.maxOutputBytes }),
  };
}

function decodeScheduleCommand(
  value: unknown,
): import("./model.ts").ScheduleCommand | null {
  const discriminator = exactDataValues(value, DEFINITION_COMMAND_KEYS, [
    "type",
  ]);
  if (!discriminator || typeof discriminator.type !== "string") return null;
  const definition =
    discriminator.type === "create" || discriminator.type === "replace";
  const fields = exactDataValues(
    value,
    definition ? DEFINITION_COMMAND_KEYS : CONTROL_COMMAND_KEYS,
    definition
      ? [
          "type",
          "requestId",
          "id",
          "expectedRevision",
          "scope",
          "schedule",
          "missedRunPolicy",
          "profileName",
          "prompt",
        ]
      : ["type", "requestId", "id", "expectedRevision"],
  );
  if (
    !fields ||
    !COMMAND_TYPES.has(String(fields.type)) ||
    typeof fields.requestId !== "string" ||
    typeof fields.id !== "string" ||
    typeof fields.expectedRevision !== "number"
  )
    return null;
  if (!definition)
    return fields as unknown as import("./model.ts").ScheduleCommand;
  const schedule = decodeScheduleInput(fields.schedule);
  const policy = decodePolicy(fields.policy);
  const credentialReferences =
    fields.credentialReferences === undefined
      ? undefined
      : decodeStringArray(fields.credentialReferences);
  if (
    !schedule ||
    policy === null ||
    credentialReferences === null ||
    (fields.scope !== "session" && fields.scope !== "durable") ||
    (fields.missedRunPolicy !== "skip" &&
      fields.missedRunPolicy !== "run-once") ||
    typeof fields.profileName !== "string" ||
    typeof fields.prompt !== "string"
  )
    return null;
  return {
    type: fields.type as "create" | "replace",
    requestId: fields.requestId,
    id: fields.id,
    expectedRevision: fields.expectedRevision,
    scope: fields.scope,
    schedule,
    missedRunPolicy: fields.missedRunPolicy,
    profileName: fields.profileName,
    prompt: fields.prompt,
    ...(credentialReferences === undefined ? {} : { credentialReferences }),
    ...(policy === undefined ? {} : { policy }),
  };
}

function decodeExecutorOutcome(value: unknown) {
  const outcome = exactDataValues(value, new Set(["ok", "value", "error"]), [
    "ok",
  ]);
  if (!outcome) return null;
  if (outcome.ok === true) {
    const completion = exactDataValues(
      outcome.value,
      new Set(["status", "output", "outputBytes", "sessionId"]),
      ["status", "output", "outputBytes"],
    );
    if (
      !completion ||
      completion.status !== "completed" ||
      typeof completion.output !== "string" ||
      typeof completion.outputBytes !== "number" ||
      !Number.isSafeInteger(completion.outputBytes) ||
      completion.outputBytes < 0 ||
      (completion.sessionId !== undefined &&
        typeof completion.sessionId !== "string")
    )
      return null;
    return {
      ok: true as const,
      value: {
        status: "completed" as const,
        output: completion.output,
        outputBytes: completion.outputBytes,
        ...(completion.sessionId === undefined
          ? {}
          : { sessionId: completion.sessionId }),
      },
    };
  }
  if (outcome.ok !== false) return null;
  const failure = exactDataValues(
    outcome.error,
    new Set(["code", "message", "retryable"]),
    ["code", "message", "retryable"],
  );
  if (
    !failure ||
    typeof failure.code !== "string" ||
    typeof failure.message !== "string" ||
    typeof failure.retryable !== "boolean"
  )
    return null;
  return {
    ok: false as const,
    error: {
      code: failure.code,
      message: sanitizeUntrustedText(failure.message).slice(0, 1_000),
      retryable: failure.retryable,
    },
  };
}

function decodeScheduleQuery(value: unknown) {
  const fields = exactDataValues(value, QUERY_KEYS);
  if (!fields) return null;
  if (
    (fields.id !== undefined && typeof fields.id !== "string") ||
    (fields.state !== undefined && typeof fields.state !== "string") ||
    (fields.includeHistory !== undefined &&
      typeof fields.includeHistory !== "boolean") ||
    (fields.afterId !== undefined && typeof fields.afterId !== "string") ||
    (fields.limit !== undefined && typeof fields.limit !== "number")
  )
    return null;
  return fields as import("./model.ts").ScheduleQuery;
}

function scheduleFailure(
  code: ScheduleErrorCode,
  message: string,
  retryable = false,
): ScheduleOutcome<never> {
  return { ok: false, error: { code, message, retryable } };
}

function storageFailure(message = "Scheduler state is unavailable.") {
  return scheduleFailure("storage_failed", message, true);
}

function sameProfile(
  profile: ResolvedAgentProfile,
  expected: PinnedScheduleProfile,
) {
  return (
    profile.identity.name === expected.name &&
    profile.identity.contentDigest === expected.contentDigest &&
    profile.identity.source.scope === expected.source.scope &&
    profile.identity.source.path === expected.source.path &&
    profile.policy.role === "scheduled"
  );
}

function boundUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const characters = Array.from(
    Buffer.from(value).subarray(0, maxBytes).toString("utf8"),
  );
  while (Buffer.byteLength(characters.join("")) > maxBytes) characters.pop();
  return characters.join("");
}

function sanitizeUntrustedText(message: string) {
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      "",
    )
    .replace(
      /((?:authorization|cookie|password|secret|token|api[-_]?key|credential)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bbearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[REDACTED]")
    .slice(0, 1_000_000);
}

function initialOccurrence(
  schedule: import("./model.ts").Schedule,
  policy: import("./model.ts").MissedRunPolicy,
  nowMs: number,
) {
  const now = new Date(nowMs).toISOString();
  const first =
    schedule.kind === "one-shot"
      ? schedule.at
      : schedule.kind === "interval"
        ? schedule.anchor
        : nextOccurrence(schedule, new Date(nowMs - 1).toISOString());
  if (!first || Date.parse(first) >= nowMs) return first;
  const missed = resolveMissedRun(schedule, first, now, policy);
  return missed.occurrenceAt ?? missed.nextAt;
}

function pinnedProfile(profile: ResolvedAgentProfile): PinnedScheduleProfile {
  return {
    name: profile.identity.name,
    contentDigest: profile.identity.contentDigest,
    source: profile.identity.source,
  };
}

function publicSnapshot(
  schedule: PersistedSchedule,
  includeHistory = true,
): ScheduleSnapshot {
  const {
    credentialReferences: _credentialReferences,
    pendingRunNow: _pendingRunNow,
    ...snapshot
  } = schedule;
  const sanitizeOccurrence = (
    occurrence: ScheduleSnapshot["currentOccurrence"],
  ) =>
    occurrence?.error
      ? {
          ...occurrence,
          error: {
            code: sanitizeUntrustedText(occurrence.error.code).slice(0, 128),
            message: sanitizeUntrustedText(occurrence.error.message).slice(
              0,
              1_000,
            ),
          },
        }
      : occurrence;
  return {
    ...snapshot,
    binding: {
      ...snapshot.binding,
      cwd: sanitizeUntrustedText(snapshot.binding.cwd).slice(0, 4_096),
      creatorSessionId: sanitizeUntrustedText(
        snapshot.binding.creatorSessionId,
      ).slice(0, 512),
      resultRoute: {
        kind: "session",
        sessionId: sanitizeUntrustedText(
          snapshot.binding.resultRoute.sessionId,
        ).slice(0, 512),
      },
    },
    profile: {
      ...snapshot.profile,
      source: {
        ...snapshot.profile.source,
        path: sanitizeUntrustedText(snapshot.profile.source.path).slice(
          0,
          4_096,
        ),
      },
    },
    currentOccurrence: sanitizeOccurrence(snapshot.currentOccurrence),
    recentOccurrences: includeHistory
      ? snapshot.recentOccurrences.map((occurrence) =>
          sanitizeOccurrence(occurrence)!,
        )
      : [],
    ...(snapshot.blockedReason === undefined
      ? {}
      : {
          blockedReason: sanitizeUntrustedText(snapshot.blockedReason).slice(
            0,
            1_000,
          ),
        }),
  };
}

export function deterministicOccurrenceId(
  scheduleId: string,
  revision: number,
  kind: "regular" | "run-now",
  identity: string,
  projectId = "",
) {
  return createHash("sha256")
    .update(`${projectId}\0${scheduleId}\0${revision}\0${kind}\0${identity}`)
    .digest("hex");
}

function validatePolicy(
  input: Partial<SchedulePolicy> | undefined,
  defaultTimeoutMs: number,
) {
  const policy = {
    timeoutMs: input?.timeoutMs ?? defaultTimeoutMs,
    maxRetries: input?.maxRetries ?? 2,
    maxOutputBytes: input?.maxOutputBytes ?? 1024 * 1024,
  };
  if (
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1_000 ||
    policy.timeoutMs > 60 * 60 * 1_000 ||
    !Number.isSafeInteger(policy.maxRetries) ||
    policy.maxRetries < 0 ||
    policy.maxRetries > 5 ||
    !Number.isSafeInteger(policy.maxOutputBytes) ||
    policy.maxOutputBytes < 1 ||
    policy.maxOutputBytes > 16 * 1024 * 1024
  )
    return null;
  return policy;
}

export function createSchedulerHostAuthority(
  options: SchedulerHostAuthorityOptions,
) {
  return {
    async authorize(request) {
      const resolved = await options.projects.resolve(request.cwd);
      if (
        !resolved.ok ||
        resolved.value.projectId !== request.projectId ||
        resolved.value.canonicalCwd !== request.cwd
      ) {
        return {
          ok: false as const,
          error: {
            code: "project_denied" as const,
            message: "Scheduled project identity is unavailable or changed.",
            retryable: false,
          },
        };
      }
      if (!(await options.projectTrusted(resolved.value))) {
        return {
          ok: false as const,
          error: {
            code: "trust_denied" as const,
            message: "Scheduled project is not trusted.",
            retryable: false,
          },
        };
      }
      if (!(await options.credentialsAvailable(request.credentialReferences))) {
        return {
          ok: false as const,
          error: {
            code: "credential_denied" as const,
            message: "Scheduled credential references are unavailable.",
            retryable: false,
          },
        };
      }
      const profile = options.profiles.resolve(request.profileName);
      if (!profile.ok || profile.value.policy.role !== "scheduled") {
        return {
          ok: false as const,
          error: {
            code: "profile_denied" as const,
            message: "Scheduled Agent Profile is unavailable.",
            retryable: false,
          },
        };
      }
      return {
        ok: true as const,
        value: {
          project: resolved.value,
          projectTrusted: true,
          profile: profile.value,
        },
      };
    },
  } satisfies HostAuthority;
}

export function createSystemSchedulerClock() {
  return {
    now: Date.now,
    arm(at: number, wake: () => void) {
      const timeout = setTimeout(wake, Math.max(0, at - Date.now()));
      timeout.unref?.();
      return () => clearTimeout(timeout);
    },
  };
}

export async function createScheduler(options: SchedulerOptions) {
  const configuration = {
    ...defaultPlatformSchedulerConfiguration,
    ...options.configuration,
  };
  const retention = {
    maxOccurrences: options.retention?.maxOccurrences ?? 50,
    maxInspection: options.retention?.maxInspection ?? 100,
    maxRequestReceipts: options.retention?.maxRequestReceipts ?? 1_000,
  };
  if (
    !Number.isSafeInteger(configuration.maxSchedules) ||
    configuration.maxSchedules < 1 ||
    configuration.maxSchedules > 1_000 ||
    !Number.isSafeInteger(configuration.maxConcurrent) ||
    configuration.maxConcurrent < 1 ||
    configuration.maxConcurrent > 4 ||
    !Number.isSafeInteger(configuration.defaultTimeoutMs) ||
    configuration.defaultTimeoutMs < 1_000 ||
    configuration.defaultTimeoutMs > 60 * 60 * 1_000 ||
    !Number.isSafeInteger(configuration.leaseTtlMs) ||
    configuration.leaseTtlMs < 10_000 ||
    configuration.leaseTtlMs > 5 * 60 * 1_000 ||
    !Number.isSafeInteger(retention.maxOccurrences) ||
    retention.maxOccurrences < 1 ||
    retention.maxOccurrences > 1_000 ||
    !Number.isSafeInteger(retention.maxInspection) ||
    retention.maxInspection < 1 ||
    retention.maxInspection > 1_000 ||
    !Number.isSafeInteger(retention.maxRequestReceipts) ||
    retention.maxRequestReceipts < 1 ||
    retention.maxRequestReceipts > 1_000 ||
    options.binding.cwd !== options.binding.project.canonicalCwd ||
    options.binding.creatorSessionId.length < 1 ||
    options.binding.creatorSessionId.length > 512 ||
    options.binding.resultRoute.kind !== "session" ||
    options.binding.resultRoute.sessionId.length < 1 ||
    options.binding.resultRoute.sessionId.length > 512 ||
    options.ownerId.length < 1 ||
    options.ownerId.length > 512
  )
    return scheduleFailure(
      "invalid_request",
      "Scheduler host options are invalid.",
    );
  const persistence = createSchedulerPersistence(
    options.state,
    options.binding.project.projectId,
  );
  const loadDefinitions = async () => {
    const entries: { value: PersistedSchedule; version: number }[] = [];
    let afterId: string | undefined;
    while (entries.length <= configuration.maxSchedules) {
      const pageLimit = Math.min(
        100,
        configuration.maxSchedules + 1 - entries.length,
      );
      const page = await persistence.definitions(afterId, pageLimit);
      if (!page.ok) return { ok: false as const, capacity: false };
      entries.push(...page.value);
      if (page.value.length < pageLimit) break;
      afterId = page.value.at(-1)?.value.id;
      if (!afterId) return { ok: false as const, capacity: false };
    }
    if (entries.length > configuration.maxSchedules)
      return { ok: false as const, capacity: true };
    return { ok: true as const, value: entries };
  };
  const loaded = await loadDefinitions();
  if (!loaded.ok)
    return loaded.capacity
      ? scheduleFailure("capacity_exceeded", "Schedule capacity is reached.")
      : storageFailure();

  const schedules = new Map<
    string,
    { value: PersistedSchedule; version: number }
  >();
  const pendingRecovery = new Map<
    string,
    { readonly kind: "execute" | "deliver"; readonly at: number }
  >();
  for (const entry of loaded.value) {
    if (
      entry.value.scope === "durable" ||
      entry.value.binding.creatorSessionId === options.binding.creatorSessionId
    )
      schedules.set(entry.value.id, entry);
  }
  for (const [id, entry] of schedules) {
    const occurrence = entry.value.currentOccurrence;
    if (
      !occurrence ||
      !["claimed", "retry-wait", "running", "completed", "failed"].includes(
        occurrence.state,
      )
    )
      continue;
    const lease = await persistence.occurrenceLease(occurrence.id);
    if (!lease.ok) return storageFailure();
    const recoveryAt =
      lease.value?.owner !== null &&
      lease.value !== null &&
      lease.value.expiresAt > options.clock.now()
        ? lease.value.expiresAt + 1
        : options.clock.now();
    if (occurrence.state === "claimed" || occurrence.state === "retry-wait") {
      pendingRecovery.set(id, { kind: "execute", at: recoveryAt });
      continue;
    }
    if (occurrence.state === "completed" || occurrence.state === "failed") {
      if (occurrence.resultArtifact && occurrence.delivered !== true)
        pendingRecovery.set(id, { kind: "deliver", at: recoveryAt });
      continue;
    }
    if (recoveryAt > options.clock.now()) {
      pendingRecovery.set(id, { kind: "execute", at: recoveryAt });
      continue;
    }
    const message = "Execution outcome is unknown after claimant loss.";
    const blocked: PersistedSchedule = {
      ...entry.value,
      state: "blocked",
      blockedReason: message,
      currentOccurrence: {
        ...occurrence,
        state: "unknown",
        error: { code: "unknown", message },
      },
    };
    const persisted = await persistence.updateRuntime({
      transactionId: `scheduler.unknown:${occurrence.id}:${entry.version}`,
      schedule: blocked,
      expectedVersion: entry.version,
    });
    if (!persisted.ok) return storageFailure();
    schedules.set(id, {
      value: blocked,
      version: persistence.definitionVersion(
        persisted.value,
        id,
        entry.version + 1,
      ),
    });
  }

  let closed = false;
  let cancelWake: (() => void) | undefined;
  let wakeBusy = false;
  let wakeAgain = false;
  const activeTasks = new Set<Promise<void>>();
  const activeDeliveries = new Set<Promise<unknown>>();
  const occurrenceDeliveries = new Map<string, Promise<unknown>>();
  const occurrenceTasks = new Map<string, Promise<void>>();
  const scheduleGenerations = new Map<string, number>();
  const activeClaims = new Map<
    string,
    {
      readonly scheduleId: string;
      readonly fence: number;
      readonly controller: AbortController;
      readonly generation: number;
      renewAt: number;
      timeoutAt?: number;
      timeout?: () => void;
    }
  >();

  const boundedAwait = async (
    tasks: readonly (Promise<unknown> | undefined)[],
  ) => {
    const pending = tasks.filter(
      (task): task is Promise<unknown> => task !== undefined,
    );
    if (pending.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 500);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  };

  const generationFor = (scheduleId: string) =>
    scheduleGenerations.get(scheduleId) ?? 0;
  const sealGeneration = (scheduleId: string) =>
    scheduleGenerations.set(scheduleId, generationFor(scheduleId) + 1);
  const claimIsCurrent = (
    scheduleId: string,
    occurrenceId: string,
    fence: number,
  ) => {
    const claim = activeClaims.get(occurrenceId);
    return (
      claim?.scheduleId === scheduleId &&
      claim.fence === fence &&
      claim.generation === generationFor(scheduleId)
    );
  };

  const deliver = (
    request: Parameters<SchedulerOptions["delivery"]["deliver"]>[0],
  ) => {
    const task = Promise.resolve()
      .then(() => options.delivery.deliver(request))
      .catch(() => ({
        ok: false as const,
        error: {
          code: "delivery_failed" as const,
          message: "Schedule result delivery failed.",
          retryable: true,
        },
      }));
    activeDeliveries.add(task);
    occurrenceDeliveries.set(request.occurrenceId, task);
    const remove = () => {
      activeDeliveries.delete(task);
      if (occurrenceDeliveries.get(request.occurrenceId) === task)
        occurrenceDeliveries.delete(request.occurrenceId);
    };
    void task.then(remove, remove);
    return task;
  };

  const recordVersion = persistence.definitionVersion;

  const refresh = async (id: string) => {
    const loadedDefinition = await persistence.definition(id);
    if (!loadedDefinition.ok) return null;
    if (!loadedDefinition.value) {
      schedules.delete(id);
      return null;
    }
    schedules.set(id, loadedDefinition.value);
    return loadedDefinition.value;
  };

  const occurrenceResource = persistence.occurrenceResource;
  const arm = () => {
    cancelWake?.();
    cancelWake = undefined;
    if (closed) return;
    const earliest = [
      ...[...schedules.values()]
        .map(({ value }) => value)
        .filter(({ state }) => state === "active")
        .flatMap(({ nextAt, pendingRunNow }) => [
          ...(nextAt ? [Date.parse(nextAt)] : []),
          ...(pendingRunNow ? [Date.parse(pendingRunNow.dueAt)] : []),
        ]),
      ...[...activeClaims.values()].flatMap(({ renewAt, timeoutAt }) => [
        renewAt,
        ...(timeoutAt === undefined ? [] : [timeoutAt]),
      ]),
      ...[...pendingRecovery.values()].map(({ at }) => at),
    ]
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (earliest === undefined) return;
    cancelWake = options.clock.arm(earliest, () => {
      cancelWake = undefined;
      void wake();
    });
  };

  async function completeSuccessful(
    scheduleId: string,
    occurrenceId: string,
    fence: number,
    output: string,
  ) {
    let entry = await refresh(scheduleId);
    if (
      closed ||
      !entry ||
      entry.value.state !== "active" ||
      entry.value.currentOccurrence?.id !== occurrenceId ||
      !claimIsCurrent(scheduleId, occurrenceId, fence)
    )
      return;
    const current = entry.value.currentOccurrence;
    const boundedOutput = boundUtf8(
      sanitizeUntrustedText(output),
      entry.value.policy.maxOutputBytes,
    );
    const artifact = await options.artifacts.put({
      body: boundedOutput,
      filename: "scheduled-agent.txt",
      mediaType: "text/plain; charset=utf-8",
      metadata: { kind: "scheduled-agent-text" },
    });
    if (
      !artifact.ok ||
      closed ||
      !claimIsCurrent(scheduleId, occurrenceId, fence)
    )
      return;
    const artifactReference = {
      id: artifact.value.id,
      sha256: artifact.value.sha256,
      size: artifact.value.size,
      ...(artifact.value.mediaType
        ? { mediaType: artifact.value.mediaType }
        : {}),
    };
    const completedAt = new Date(options.clock.now()).toISOString();
    const completedOccurrence = {
      ...current,
      state: "completed" as const,
      completedAt,
      resultArtifact: artifactReference,
      delivered: false,
    };
    const completedSchedule: PersistedSchedule = {
      ...entry.value,
      currentOccurrence: completedOccurrence,
    };
    const committed = await persistence.updateFenced({
      transactionId: `scheduler.complete:${occurrenceId}:${fence}`,
      schedule: completedSchedule,
      expectedVersion: entry.version,
      resource: occurrenceResource(occurrenceId),
      owner: options.ownerId,
      fence,
      ttlMs: configuration.leaseTtlMs,
    });
    if (!committed.ok) return;
    entry = {
      value: completedSchedule,
      version: recordVersion(committed.value, scheduleId, entry.version + 1),
    };
    schedules.set(scheduleId, entry);

    if (closed || !claimIsCurrent(scheduleId, occurrenceId, fence)) return;
    const delivered = await deliver({
      deliveryId: occurrenceId,
      route: entry.value.binding.resultRoute,
      scheduleId,
      occurrenceId,
      artifact: artifactReference,
    });
    if (!delivered.ok) {
      await persistence.releaseLease({
        transactionId: `scheduler.delivery-release:${occurrenceId}:${fence}`,
        resource: occurrenceResource(occurrenceId),
        owner: options.ownerId,
        fence,
      });
      activeClaims.delete(occurrenceId);
      pendingRecovery.set(scheduleId, {
        kind: "deliver",
        at: options.clock.now() + 1_000,
      });
      arm();
      return;
    }
    if (closed || !claimIsCurrent(scheduleId, occurrenceId, fence)) return;
    const latest = await refresh(scheduleId);
    if (
      !latest ||
      latest.value.state !== "active" ||
      latest.value.currentOccurrence?.id !== occurrenceId ||
      latest.value.currentOccurrence.state !== "completed"
    )
      return;
    const history = [
      ...latest.value.recentOccurrences,
      { ...latest.value.currentOccurrence, delivered: true },
    ].slice(-retention.maxOccurrences);
    const settled: PersistedSchedule = {
      ...latest.value,
      currentOccurrence: null,
      recentOccurrences: history,
    };
    const released = await persistence.releaseOccurrence({
      transactionId: `scheduler.release:${occurrenceId}:${fence}`,
      schedule: settled,
      expectedVersion: latest.version,
      resource: occurrenceResource(occurrenceId),
      owner: options.ownerId,
      fence,
    });
    if (!released.ok) return;
    schedules.set(scheduleId, {
      value: settled,
      version: recordVersion(released.value, scheduleId, latest.version + 1),
    });
    activeClaims.delete(occurrenceId);
  }

  async function completeFailed(
    scheduleId: string,
    occurrenceId: string,
    fence: number,
    code: string,
    artifactBody?: string,
  ) {
    let entry = await refresh(scheduleId);
    if (
      closed ||
      !entry ||
      entry.value.state !== "active" ||
      entry.value.currentOccurrence?.id !== occurrenceId ||
      !claimIsCurrent(scheduleId, occurrenceId, fence)
    )
      return;
    const failureCodes = new Set([
      "invalid_request",
      "profile_denied",
      "backend_unavailable",
      "timed_out",
      "output_bounded",
      "run_failed",
      "cancelled",
      "shutting_down",
    ]);
    const safeCode = failureCodes.has(code) ? code : "run_failed";
    const messages: Record<string, string> = {
      timed_out: "Scheduled occurrence timed out.",
      output_bounded: "Scheduled occurrence exceeded its output bound.",
      backend_unavailable: "Scheduled backend is unavailable.",
      cancelled: "Scheduled occurrence was cancelled.",
      run_failed: "Scheduled occurrence failed.",
    };
    const message = messages[safeCode] ?? "Scheduled occurrence failed.";
    const source = artifactBody ?? JSON.stringify({ code: safeCode, message });
    const body = boundUtf8(
      sanitizeUntrustedText(source),
      entry.value.policy.maxOutputBytes,
    );
    const artifact = await options.artifacts.put({
      body,
      filename: "scheduled-agent.txt",
      mediaType: "text/plain; charset=utf-8",
      metadata: { kind: "scheduled-agent-text" },
    });
    if (
      !artifact.ok ||
      closed ||
      !claimIsCurrent(scheduleId, occurrenceId, fence)
    )
      return;
    const artifactReference = {
      id: artifact.value.id,
      sha256: artifact.value.sha256,
      size: artifact.value.size,
      ...(artifact.value.mediaType
        ? { mediaType: artifact.value.mediaType }
        : {}),
    };
    const failed = {
      ...entry.value.currentOccurrence,
      state: "failed" as const,
      completedAt: new Date(options.clock.now()).toISOString(),
      resultArtifact: artifactReference,
      delivered: false,
      error: { code: safeCode, message },
    };
    const pending: PersistedSchedule = {
      ...entry.value,
      currentOccurrence: failed,
    };
    const committed = await persistence.updateFenced({
      transactionId: `scheduler.failed:${occurrenceId}:${fence}:${code}`,
      schedule: pending,
      expectedVersion: entry.version,
      resource: occurrenceResource(occurrenceId),
      owner: options.ownerId,
      fence,
      ttlMs: configuration.leaseTtlMs,
    });
    if (!committed.ok) return;
    entry = {
      value: pending,
      version: recordVersion(committed.value, scheduleId, entry.version + 1),
    };
    schedules.set(scheduleId, entry);
    if (closed || !claimIsCurrent(scheduleId, occurrenceId, fence)) return;
    const delivered = await deliver({
      deliveryId: occurrenceId,
      route: entry.value.binding.resultRoute,
      scheduleId,
      occurrenceId,
      artifact: artifactReference,
    });
    if (!delivered.ok) {
      await persistence.releaseLease({
        transactionId: `scheduler.delivery-release:${occurrenceId}:${fence}`,
        resource: occurrenceResource(occurrenceId),
        owner: options.ownerId,
        fence,
      });
      activeClaims.delete(occurrenceId);
      pendingRecovery.set(scheduleId, {
        kind: "deliver",
        at: options.clock.now() + 1_000,
      });
      arm();
      return;
    }
    if (closed || !claimIsCurrent(scheduleId, occurrenceId, fence)) return;
    const latest = await refresh(scheduleId);
    if (
      !latest ||
      latest.value.state !== "active" ||
      latest.value.currentOccurrence?.id !== occurrenceId ||
      latest.value.currentOccurrence.state !== "failed"
    )
      return;
    const settled: PersistedSchedule = {
      ...latest.value,
      currentOccurrence: null,
      recentOccurrences: [
        ...latest.value.recentOccurrences,
        { ...latest.value.currentOccurrence, delivered: true },
      ].slice(-retention.maxOccurrences),
    };
    const released = await persistence.releaseOccurrence({
      transactionId: `scheduler.release-failed:${occurrenceId}:${fence}`,
      schedule: settled,
      expectedVersion: latest.version,
      resource: occurrenceResource(occurrenceId),
      owner: options.ownerId,
      fence,
    });
    if (!released.ok) return;
    schedules.set(scheduleId, {
      value: settled,
      version: recordVersion(released.value, scheduleId, latest.version + 1),
    });
    activeClaims.delete(occurrenceId);
  }

  async function blockOccurrence(
    scheduleId: string,
    occurrenceId: string,
    fence: number,
    code: "authority_denied" | "profile_changed" | "artifact_failed",
    reason: string,
  ) {
    const entry = await refresh(scheduleId);
    if (
      closed ||
      !entry ||
      entry.value.currentOccurrence?.id !== occurrenceId ||
      !claimIsCurrent(scheduleId, occurrenceId, fence)
    )
      return;
    const message = sanitizeUntrustedText(reason).slice(0, 1_000);
    const failed = {
      ...entry.value.currentOccurrence,
      state: "failed" as const,
      completedAt: new Date(options.clock.now()).toISOString(),
      error: { code, message },
    };
    const blocked: PersistedSchedule = {
      ...entry.value,
      state: "blocked",
      blockedReason: message,
      currentOccurrence: null,
      recentOccurrences: [...entry.value.recentOccurrences, failed].slice(
        -retention.maxOccurrences,
      ),
    };
    const released = await persistence.releaseOccurrence({
      transactionId: `scheduler.block:${occurrenceId}:${fence}:${code}`,
      schedule: blocked,
      expectedVersion: entry.version,
      resource: occurrenceResource(occurrenceId),
      owner: options.ownerId,
      fence,
    });
    if (!released.ok) return;
    schedules.set(scheduleId, {
      value: blocked,
      version: recordVersion(released.value, scheduleId, entry.version + 1),
    });
    activeClaims.delete(occurrenceId);
  }

  async function executeOccurrence(
    scheduleId: string,
    occurrenceId: string,
    fence: number,
  ) {
    let entry = await refresh(scheduleId);
    if (
      closed ||
      !entry ||
      entry.value.state !== "active" ||
      entry.value.currentOccurrence?.id !== occurrenceId ||
      !claimIsCurrent(scheduleId, occurrenceId, fence)
    )
      return;
    const prompt = await options.artifacts.get(entry.value.promptArtifact.id);
    if (!prompt.ok) {
      await blockOccurrence(
        scheduleId,
        occurrenceId,
        fence,
        "artifact_failed",
        "Pinned prompt Artifact is unavailable.",
      );
      return;
    }
    const promptText = new TextDecoder().decode(prompt.value.body);
    const initialAttempt = entry.value.currentOccurrence.attempt + 1;

    for (let attempt = initialAttempt; ; attempt += 1) {
      entry = await refresh(scheduleId);
      if (
        closed ||
        !entry ||
        entry.value.state !== "active" ||
        entry.value.currentOccurrence?.id !== occurrenceId ||
        !claimIsCurrent(scheduleId, occurrenceId, fence)
      )
        return;
      const authority = await options.authority.authorize({
        projectId: entry.value.binding.projectId,
        cwd: entry.value.binding.cwd,
        profileName: entry.value.profile.name,
        expectedProfile: entry.value.profile,
        credentialReferences: entry.value.credentialReferences,
      });
      if (closed) return;
      if (
        !authority.ok ||
        !authority.value.projectTrusted ||
        authority.value.project.projectId !== entry.value.binding.projectId ||
        authority.value.project.canonicalCwd !== entry.value.binding.cwd
      ) {
        await blockOccurrence(
          scheduleId,
          occurrenceId,
          fence,
          "authority_denied",
          "Project, trust, or credential authority is unavailable.",
        );
        return;
      }
      if (!sameProfile(authority.value.profile, entry.value.profile)) {
        await blockOccurrence(
          scheduleId,
          occurrenceId,
          fence,
          "profile_changed",
          "Pinned Agent Profile changed.",
        );
        return;
      }

      entry = await refresh(scheduleId);
      if (
        closed ||
        !entry ||
        entry.value.state !== "active" ||
        entry.value.currentOccurrence?.id !== occurrenceId ||
        !claimIsCurrent(scheduleId, occurrenceId, fence)
      )
        return;
      const running: PersistedSchedule = {
        ...entry.value,
        currentOccurrence: {
          ...entry.value.currentOccurrence,
          state: "running",
          attempt,
          startedAt: new Date(options.clock.now()).toISOString(),
        },
      };
      const markedRunning = await persistence.updateFenced({
        transactionId: `scheduler.running:${occurrenceId}:${fence}:${attempt}`,
        schedule: running,
        expectedVersion: entry.version,
        resource: occurrenceResource(occurrenceId),
        owner: options.ownerId,
        fence,
        ttlMs: configuration.leaseTtlMs,
      });
      if (!markedRunning.ok || closed) return;
      schedules.set(scheduleId, {
        value: running,
        version: recordVersion(
          markedRunning.value,
          scheduleId,
          entry.version + 1,
        ),
      });
      const claim = activeClaims.get(occurrenceId);
      if (!claim) return;
      claim.timeoutAt = options.clock.now() + running.policy.timeoutMs;
      const timedOut = new Promise<
        Awaited<ReturnType<typeof options.executor.run>>
      >((resolve) => {
        claim.timeout = () =>
          resolve({
            ok: false,
            error: {
              code: "timed_out",
              message: "Scheduled occurrence timed out.",
              retryable: false,
            },
          });
      });
      arm();
      const rawOutcome = await Promise.race([
        Promise.resolve().then(() =>
          options.executor.run(
            {
              occurrenceId,
              prompt: promptText,
              cwd: running.binding.cwd,
              projectId: running.binding.projectId,
              profile: authority.value.profile,
              timeoutMs: running.policy.timeoutMs,
              maxOutputBytes: running.policy.maxOutputBytes,
            },
            claim.controller.signal,
          ),
        ),
        timedOut,
      ]).catch(() => null);
      const outcome = decodeExecutorOutcome(rawOutcome) ?? {
        ok: false as const,
        error: {
          code: "run_failed",
          message: "Scheduled executor returned an invalid outcome.",
          retryable: false,
        },
      };
      claim.timeout = undefined;
      claim.timeoutAt = undefined;
      if (outcome.ok) {
        if (
          outcome.value.outputBytes > running.policy.maxOutputBytes ||
          Buffer.byteLength(outcome.value.output) >
            running.policy.maxOutputBytes
        ) {
          await completeFailed(
            scheduleId,
            occurrenceId,
            fence,
            "output_bounded",
            outcome.value.output,
          );
        } else {
          await completeSuccessful(
            scheduleId,
            occurrenceId,
            fence,
            outcome.value.output,
          );
        }
        return;
      }
      // ScheduledAgentOutcome cannot prove that no child was spawned. Replaying any
      // executor failure could duplicate external side effects.
      await completeFailed(scheduleId, occurrenceId, fence, outcome.error.code);
      return;
    }
  }

  function startExecution(
    scheduleId: string,
    occurrenceId: string,
    fence: number,
  ) {
    const task = executeOccurrence(scheduleId, occurrenceId, fence).finally(
      () => {
        activeTasks.delete(task);
        occurrenceTasks.delete(occurrenceId);
        arm();
        if (!closed) void wake();
      },
    );
    activeTasks.add(task);
    occurrenceTasks.set(occurrenceId, task);
  }

  async function recoverExecution(scheduleId: string) {
    const entry = await refresh(scheduleId);
    const occurrence = entry?.value.currentOccurrence;
    if (!entry || !occurrence || entry.value.state !== "active") return;
    if (occurrence.state === "running") {
      const lease = await persistence.occurrenceLease(occurrence.id);
      if (!lease.ok) return;
      if (
        lease.value?.owner !== null &&
        lease.value !== null &&
        lease.value.expiresAt > options.clock.now()
      ) {
        pendingRecovery.set(scheduleId, {
          kind: "execute",
          at: lease.value.expiresAt + 1,
        });
        return;
      }
      const message = "Execution outcome is unknown after claimant loss.";
      const blocked: PersistedSchedule = {
        ...entry.value,
        state: "blocked",
        blockedReason: message,
        currentOccurrence: {
          ...occurrence,
          state: "unknown",
          error: { code: "unknown", message },
        },
      };
      const persisted = await persistence.updateRuntime({
        transactionId: `scheduler.unknown:${occurrence.id}:${entry.version}`,
        schedule: blocked,
        expectedVersion: entry.version,
      });
      if (persisted.ok)
        schedules.set(scheduleId, {
          value: blocked,
          version: recordVersion(
            persisted.value,
            scheduleId,
            entry.version + 1,
          ),
        });
      return;
    }
    if (occurrence.state !== "claimed" && occurrence.state !== "retry-wait")
      return;
    const transaction = await persistence.claimOccurrence({
      transactionId: `scheduler.recover:${occurrence.id}:${options.ownerId}:${entry.version}`,
      schedule: entry.value,
      expectedVersion: entry.version,
      resource: occurrenceResource(occurrence.id),
      owner: options.ownerId,
      ttlMs: configuration.leaseTtlMs,
    });
    if (!transaction.ok) {
      await refresh(scheduleId);
      return;
    }
    const lease = transaction.value.leases.find(
      ({ resource }) => resource === occurrenceResource(occurrence.id),
    );
    if (!lease) return;
    schedules.set(scheduleId, {
      value: entry.value,
      version: recordVersion(transaction.value, scheduleId, entry.version + 1),
    });
    activeClaims.set(occurrence.id, {
      scheduleId,
      fence: lease.fence,
      controller: new AbortController(),
      generation: generationFor(scheduleId),
      renewAt:
        options.clock.now() +
        Math.max(1, Math.floor(configuration.leaseTtlMs / 3)),
    });
    startExecution(scheduleId, occurrence.id, lease.fence);
  }

  async function recoverDelivery(scheduleId: string) {
    const entry = await refresh(scheduleId);
    const occurrence = entry?.value.currentOccurrence;
    if (
      !entry ||
      !occurrence ||
      (occurrence.state !== "completed" && occurrence.state !== "failed") ||
      !occurrence.resultArtifact ||
      occurrence.delivered === true
    )
      return;
    const transaction = await persistence.claimOccurrence({
      transactionId: `scheduler.delivery-claim:${occurrence.id}:${options.ownerId}:${entry.version}`,
      schedule: entry.value,
      expectedVersion: entry.version,
      resource: occurrenceResource(occurrence.id),
      owner: options.ownerId,
      ttlMs: configuration.leaseTtlMs,
    });
    if (!transaction.ok) {
      const lease = await persistence.occurrenceLease(occurrence.id);
      if (
        lease.ok &&
        lease.value?.owner !== null &&
        lease.value !== null &&
        lease.value.expiresAt > options.clock.now()
      )
        pendingRecovery.set(scheduleId, {
          kind: "deliver",
          at: lease.value.expiresAt + 1,
        });
      return;
    }
    const lease = transaction.value.leases.find(
      ({ resource }) => resource === occurrenceResource(occurrence.id),
    );
    if (!lease) return;
    const claimedVersion = recordVersion(
      transaction.value,
      scheduleId,
      entry.version + 1,
    );
    schedules.set(scheduleId, { value: entry.value, version: claimedVersion });
    if (closed) return;
    const delivered = await deliver({
      deliveryId: occurrence.id,
      route: entry.value.binding.resultRoute,
      scheduleId,
      occurrenceId: occurrence.id,
      artifact: occurrence.resultArtifact,
    });
    if (!delivered.ok) {
      await persistence.releaseLease({
        transactionId: `scheduler.delivery-release:${occurrence.id}:${lease.fence}`,
        resource: occurrenceResource(occurrence.id),
        owner: options.ownerId,
        fence: lease.fence,
      });
      pendingRecovery.set(scheduleId, {
        kind: "deliver",
        at: options.clock.now() + 1_000,
      });
      arm();
      return;
    }
    if (closed) return;
    const latest = await refresh(scheduleId);
    if (
      !latest ||
      latest.value.state !== "active" ||
      latest.value.currentOccurrence?.id !== occurrence.id ||
      latest.value.currentOccurrence.delivered === true
    )
      return;
    const settled: PersistedSchedule = {
      ...latest.value,
      currentOccurrence: null,
      recentOccurrences: [
        ...latest.value.recentOccurrences,
        { ...latest.value.currentOccurrence, delivered: true },
      ].slice(-retention.maxOccurrences),
    };
    const released = await persistence.releaseOccurrence({
      transactionId: `scheduler.delivery-complete:${occurrence.id}:${lease.fence}`,
      schedule: settled,
      expectedVersion: latest.version,
      resource: occurrenceResource(occurrence.id),
      owner: options.ownerId,
      fence: lease.fence,
    });
    if (released.ok)
      schedules.set(scheduleId, {
        value: settled,
        version: recordVersion(released.value, scheduleId, latest.version + 1),
      });
  }

  async function recoverPending() {
    const ready = [...pendingRecovery.entries()]
      .filter(([, recovery]) => recovery.at <= options.clock.now())
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [scheduleId, recovery] of ready) {
      pendingRecovery.delete(scheduleId);
      if (recovery.kind === "execute") await recoverExecution(scheduleId);
      else await recoverDelivery(scheduleId);
    }
  }

  async function claimDue(entry: {
    value: PersistedSchedule;
    version: number;
  }) {
    const latest = await refresh(entry.value.id);
    if (!latest) return;
    entry = latest;
    if (
      closed ||
      entry.value.state !== "active" ||
      entry.value.currentOccurrence !== null
    )
      return;
    const nowMs = options.clock.now();
    const manual =
      entry.value.pendingRunNow &&
      Date.parse(entry.value.pendingRunNow.dueAt) <= nowMs
        ? entry.value.pendingRunNow
        : undefined;
    const regularDue =
      entry.value.nextAt && Date.parse(entry.value.nextAt) <= nowMs
        ? entry.value.nextAt
        : undefined;
    if (!manual && !regularDue) return;

    let dueAt: string;
    let kind: "regular" | "run-now";
    let occurrenceId: string;
    let nextAt = entry.value.nextAt;
    if (manual) {
      dueAt = manual.dueAt;
      kind = "run-now";
      occurrenceId = manual.id;
    } else {
      dueAt = regularDue!;
      kind = "regular";
      const missed = resolveMissedRun(
        entry.value.schedule,
        dueAt,
        new Date(nowMs).toISOString(),
        entry.value.missedRunPolicy,
      );
      nextAt = missed.nextAt;
      if (!missed.occurrenceAt) {
        const skipped: PersistedSchedule = { ...entry.value, nextAt };
        const advanced = await persistence.updateRuntime({
          transactionId: `scheduler.skip:${entry.value.id}:${dueAt}`,
          schedule: skipped,
          expectedVersion: entry.version,
        });
        if (advanced.ok)
          schedules.set(entry.value.id, {
            value: skipped,
            version: recordVersion(
              advanced.value,
              entry.value.id,
              entry.version + 1,
            ),
          });
        else await refresh(entry.value.id);
        return;
      }
      occurrenceId = deterministicOccurrenceId(
        entry.value.id,
        entry.value.revision,
        "regular",
        dueAt,
        options.binding.project.projectId,
      );
    }
    const claimedAt = new Date(nowMs).toISOString();
    const claimed: PersistedSchedule = {
      ...entry.value,
      nextAt,
      ...(manual ? { pendingRunNow: undefined } : {}),
      currentOccurrence: {
        id: occurrenceId,
        kind,
        dueAt,
        state: "claimed",
        attempt: 0,
        claimedAt,
      },
    };
    const transaction = await persistence.claimOccurrence({
      transactionId: `scheduler.claim:${occurrenceId}:${options.ownerId}:${entry.version}`,
      schedule: claimed,
      expectedVersion: entry.version,
      resource: occurrenceResource(occurrenceId),
      owner: options.ownerId,
      ttlMs: configuration.leaseTtlMs,
    });
    if (!transaction.ok) {
      await refresh(entry.value.id);
      return;
    }
    const lease = transaction.value.leases.find(
      ({ resource }) => resource === occurrenceResource(occurrenceId),
    );
    if (!lease) return;
    schedules.set(entry.value.id, {
      value: claimed,
      version: recordVersion(
        transaction.value,
        entry.value.id,
        entry.version + 1,
      ),
    });
    activeClaims.set(occurrenceId, {
      scheduleId: entry.value.id,
      fence: lease.fence,
      controller: new AbortController(),
      generation: generationFor(entry.value.id),
      renewAt:
        options.clock.now() +
        Math.max(1, Math.floor(configuration.leaseTtlMs / 3)),
    });
    startExecution(entry.value.id, occurrenceId, lease.fence);
  }

  async function renewActiveClaims() {
    const now = options.clock.now();
    for (const [occurrenceId, claim] of activeClaims) {
      if (claim.timeoutAt !== undefined && claim.timeoutAt <= now) {
        claim.controller.abort(new Error("Scheduled occurrence timed out."));
        claim.timeout?.();
        claim.timeoutAt = undefined;
      }
      if (claim.renewAt > now) continue;
      const entry = await refresh(claim.scheduleId);
      if (
        !entry ||
        entry.value.currentOccurrence?.id !== occurrenceId ||
        claim.generation !== generationFor(claim.scheduleId)
      ) {
        claim.controller.abort(
          new Error("Scheduled occurrence is no longer active."),
        );
        activeClaims.delete(occurrenceId);
        continue;
      }
      const renewed = await persistence.updateFenced({
        transactionId: `scheduler.renew:${occurrenceId}:${claim.fence}:${entry.version}`,
        schedule: entry.value,
        expectedVersion: entry.version,
        resource: occurrenceResource(occurrenceId),
        owner: options.ownerId,
        fence: claim.fence,
        ttlMs: configuration.leaseTtlMs,
      });
      if (!renewed.ok) {
        claim.controller.abort(
          new Error("Scheduled occurrence lease was lost."),
        );
        activeClaims.delete(occurrenceId);
        const message = "Execution outcome is unknown after lease loss.";
        const blocked: PersistedSchedule = {
          ...entry.value,
          state: "blocked",
          blockedReason: message,
          currentOccurrence: {
            ...entry.value.currentOccurrence,
            state: "unknown",
            error: { code: "unknown", message },
          },
        };
        const marked = await persistence.updateRuntime({
          transactionId: `scheduler.lease-lost:${occurrenceId}:${entry.version}`,
          schedule: blocked,
          expectedVersion: entry.version,
        });
        if (marked.ok)
          schedules.set(claim.scheduleId, {
            value: blocked,
            version: recordVersion(
              marked.value,
              claim.scheduleId,
              entry.version + 1,
            ),
          });
        else await refresh(claim.scheduleId);
        continue;
      }
      schedules.set(claim.scheduleId, {
        value: entry.value,
        version: recordVersion(
          renewed.value,
          claim.scheduleId,
          entry.version + 1,
        ),
      });
      claim.renewAt =
        now + Math.max(1, Math.floor(configuration.leaseTtlMs / 3));
    }
  }

  async function wake() {
    if (closed) return;
    if (wakeBusy) {
      wakeAgain = true;
      return;
    }
    wakeBusy = true;
    try {
      do {
        await renewActiveClaims();
        await recoverPending();
        wakeAgain = false;
        const due = [...schedules.values()]
          .filter(
            ({ value }) =>
              value.state === "active" &&
              value.currentOccurrence === null &&
              ((value.pendingRunNow &&
                Date.parse(value.pendingRunNow.dueAt) <= options.clock.now()) ||
                (value.nextAt &&
                  Date.parse(value.nextAt) <= options.clock.now())),
          )
          .sort((left, right) => left.value.id.localeCompare(right.value.id));
        for (const entry of due) {
          if (activeTasks.size >= configuration.maxConcurrent) break;
          await claimDue(entry);
        }
      } while (wakeAgain && !closed);
    } finally {
      wakeBusy = false;
      arm();
    }
  }

  await recoverPending();
  arm();

  const recoverCommittedRequest = async (requestId: string, digest: string) => {
    const request = await persistence.request(requestId);
    if (!request.ok) return storageFailure();
    if (!request.value) return null;
    if (request.value.value.digest !== digest)
      return scheduleFailure(
        "invalid_request",
        "Request identifier was already used for different intent.",
      );
    return {
      ok: true as const,
      value: {
        schedule: request.value.value.schedule,
        replayed: true,
      } satisfies ScheduleChangeReceipt,
    };
  };

  const scheduler = {
    async change(
      input: Parameters<import("./model.ts").Scheduler["change"]>[0],
    ) {
      if (closed) return scheduleFailure("closed", "Scheduler is closed.");
      const command = decodeScheduleCommand(input);
      if (
        !command ||
        !COMMAND_TYPES.has(command.type) ||
        !REQUEST_ID.test(command.requestId) ||
        !ID.test(command.id) ||
        !Number.isSafeInteger(command.expectedRevision) ||
        command.expectedRevision < 0
      )
        return scheduleFailure(
          "invalid_request",
          "Schedule command is invalid.",
        );

      const digest = scheduleCommandDigest(command);
      const previousRequest = await persistence.request(command.requestId);
      if (!previousRequest.ok) return storageFailure();
      if (previousRequest.value) {
        if (previousRequest.value.value.digest !== digest)
          return scheduleFailure(
            "invalid_request",
            "Request identifier was already used for different intent.",
          );
        return {
          ok: true as const,
          value: {
            schedule: previousRequest.value.value.schedule,
            replayed: true,
          } satisfies ScheduleChangeReceipt,
        };
      }
      const requestCapacity = await persistence.requestCapacity(
        retention.maxRequestReceipts,
      );
      if (!requestCapacity.ok) return storageFailure();
      if (requestCapacity.value.full)
        return scheduleFailure(
          "capacity_exceeded",
          "Schedule request receipt capacity is reached.",
        );

      const latest = await persistence.definition(command.id);
      if (!latest.ok) return storageFailure();
      if (latest.value) schedules.set(command.id, latest.value);
      else schedules.delete(command.id);

      if (command.type === "replace") {
        const existing = schedules.get(command.id);
        if (!existing)
          return scheduleFailure("not_found", "Schedule does not exist.");
        if (command.expectedRevision !== existing.value.revision)
          return scheduleFailure(
            "revision_conflict",
            "Schedule revision changed.",
          );
        if (existing.value.currentOccurrence !== null)
          return scheduleFailure(
            "invalid_request",
            "A running Schedule cannot be replaced.",
          );
        if (
          (command.scope !== "session" && command.scope !== "durable") ||
          (command.missedRunPolicy !== "skip" &&
            command.missedRunPolicy !== "run-once") ||
          typeof command.prompt !== "string" ||
          command.prompt.length === 0 ||
          Buffer.byteLength(command.prompt) > PROMPT_MAX_BYTES ||
          !ID.test(command.profileName)
        )
          return scheduleFailure(
            "invalid_request",
            "Schedule definition is invalid.",
          );
        const credentialReferences = [...(command.credentialReferences ?? [])];
        if (
          credentialReferences.length > 32 ||
          new Set(credentialReferences).size !== credentialReferences.length ||
          credentialReferences.some(
            (reference) => !CREDENTIAL_REFERENCE.test(reference),
          )
        )
          return scheduleFailure(
            "invalid_request",
            "Credential references are invalid.",
          );
        const policy = validatePolicy(
          command.policy,
          configuration.defaultTimeoutMs,
        );
        if (!policy)
          return scheduleFailure(
            "invalid_request",
            "Schedule policy is outside safety bounds.",
          );
        let normalized;
        try {
          normalized = normalizeSchedule(command.schedule);
        } catch {
          return scheduleFailure(
            "invalid_request",
            "Schedule calendar is invalid.",
          );
        }
        const authority = await options.authority.authorize({
          projectId: existing.value.binding.projectId,
          cwd: existing.value.binding.cwd,
          profileName: command.profileName,
          credentialReferences,
        });
        if (
          !authority.ok ||
          !authority.value.projectTrusted ||
          authority.value.project.projectId !==
            existing.value.binding.projectId ||
          authority.value.project.canonicalCwd !== existing.value.binding.cwd ||
          authority.value.profile.identity.name !== command.profileName ||
          authority.value.profile.policy.role !== "scheduled"
        )
          return scheduleFailure(
            "authority_denied",
            "Schedule authority was denied.",
          );
        const prompt = await options.artifacts.put({
          body: command.prompt,
          filename: "scheduled-agent.txt",
          mediaType: "text/plain; charset=utf-8",
          metadata: { kind: "scheduled-agent-text" },
        });
        if (!prompt.ok)
          return scheduleFailure(
            "artifact_failed",
            "Schedule prompt could not be stored.",
            prompt.error.retryable,
          );
        const replaced: PersistedSchedule = {
          id: command.id,
          revision: existing.value.revision + 1,
          scope: command.scope,
          state: "active",
          schedule: normalized,
          missedRunPolicy: command.missedRunPolicy,
          nextAt: initialOccurrence(
            normalized,
            command.missedRunPolicy,
            options.clock.now(),
          ),
          binding: existing.value.binding,
          profile: pinnedProfile(authority.value.profile),
          promptArtifact: {
            id: prompt.value.id,
            sha256: prompt.value.sha256,
            size: prompt.value.size,
            ...(prompt.value.mediaType
              ? { mediaType: prompt.value.mediaType }
              : {}),
          },
          policy,
          credentialReferenceCount: credentialReferences.length,
          credentialReferences,
          currentOccurrence: null,
          recentOccurrences: existing.value.recentOccurrences,
        };
        const committed = await persistence.commitDefinition({
          requestId: command.requestId,
          digest,
          schedule: replaced,
          expectedVersion: existing.version,
        });
        if (!committed.ok) {
          const replay = await recoverCommittedRequest(
            command.requestId,
            digest,
          );
          if (replay) return replay;
          if (committed.error.code === "VERSION_CONFLICT")
            return scheduleFailure(
              "revision_conflict",
              "Schedule revision changed.",
            );
          return storageFailure();
        }
        schedules.set(command.id, {
          value: replaced,
          version: recordVersion(
            committed.value,
            command.id,
            existing.version + 1,
          ),
        });
        arm();
        return {
          ok: true as const,
          value: {
            schedule: publicSnapshot(replaced),
            replayed: committed.value.replayed,
          },
        };
      }

      if (command.type !== "create") {
        const existing = schedules.get(command.id);
        if (!existing)
          return scheduleFailure("not_found", "Schedule does not exist.");
        if (command.expectedRevision !== existing.value.revision)
          return scheduleFailure(
            "revision_conflict",
            "Schedule revision changed.",
          );

        if (command.type === "pause" || command.type === "delete")
          sealGeneration(command.id);
        let updated: PersistedSchedule = {
          ...existing.value,
          revision: existing.value.revision + 1,
        };
        if (command.type === "pause") {
          const current = existing.value.currentOccurrence;
          const cancelled = current
            ? {
                ...current,
                state: "failed" as const,
                completedAt: new Date(options.clock.now()).toISOString(),
                error: {
                  code: "cancelled",
                  message: "Scheduled occurrence was cancelled by pause.",
                },
              }
            : undefined;
          updated = {
            ...updated,
            state: "paused",
            currentOccurrence: null,
            ...(cancelled
              ? {
                  recentOccurrences: [
                    ...existing.value.recentOccurrences,
                    cancelled,
                  ].slice(-retention.maxOccurrences),
                }
              : {}),
          };
        } else if (command.type === "resume") {
          updated = { ...updated, state: "active" };
        } else if (command.type === "run-now") {
          if (existing.value.state !== "active" || existing.value.pendingRunNow)
            return scheduleFailure(
              "invalid_request",
              "Schedule cannot accept another run-now occurrence.",
            );
          const dueAt = new Date(options.clock.now()).toISOString();
          updated = {
            ...updated,
            pendingRunNow: {
              id: deterministicOccurrenceId(
                command.id,
                updated.revision,
                "run-now",
                command.requestId,
                options.binding.project.projectId,
              ),
              dueAt,
            },
          };
        } else if (command.type === "delete") {
          const current = existing.value.currentOccurrence;
          const cancelled = current
            ? {
                ...current,
                state: "failed" as const,
                completedAt: new Date(options.clock.now()).toISOString(),
                error: {
                  code: "cancelled",
                  message: "Scheduled occurrence was cancelled by deletion.",
                },
              }
            : undefined;
          const deleted = publicSnapshot({
            ...updated,
            state: "deleted",
            nextAt: null,
            pendingRunNow: undefined,
            currentOccurrence: null,
            ...(cancelled
              ? {
                  recentOccurrences: [
                    ...existing.value.recentOccurrences,
                    cancelled,
                  ].slice(-retention.maxOccurrences),
                }
              : {}),
          });
          const committed = await persistence.commitDelete({
            requestId: command.requestId,
            digest,
            schedule: deleted,
            expectedVersion: existing.version,
          });
          if (!committed.ok) {
            const replay = await recoverCommittedRequest(
              command.requestId,
              digest,
            );
            if (replay) return replay;
            if (committed.error.code === "VERSION_CONFLICT")
              return scheduleFailure(
                "revision_conflict",
                "Schedule revision changed.",
              );
            return storageFailure();
          }
          schedules.delete(command.id);
          const currentTask = current
            ? occurrenceTasks.get(current.id)
            : undefined;
          const currentDelivery = current
            ? occurrenceDeliveries.get(current.id)
            : undefined;
          if (current) {
            const claim = activeClaims.get(current.id);
            if (claim) {
              claim.controller.abort(
                new Error("Scheduled occurrence was deleted."),
              );
              activeClaims.delete(current.id);
              await persistence.releaseLease({
                transactionId: `scheduler.delete-release:${command.requestId}`,
                resource: occurrenceResource(current.id),
                owner: options.ownerId,
                fence: claim.fence,
              });
            }
          }
          await boundedAwait([currentTask, currentDelivery]);
          arm();
          return {
            ok: true as const,
            value: { schedule: deleted, replayed: committed.value.replayed },
          };
        }

        const committed = await persistence.commitDefinition({
          requestId: command.requestId,
          digest,
          schedule: updated,
          expectedVersion: existing.version,
        });
        if (!committed.ok) {
          const replay = await recoverCommittedRequest(
            command.requestId,
            digest,
          );
          if (replay) return replay;
          if (committed.error.code === "VERSION_CONFLICT")
            return scheduleFailure(
              "revision_conflict",
              "Schedule revision changed.",
            );
          return storageFailure();
        }
        schedules.set(command.id, {
          value: updated,
          version: recordVersion(
            committed.value,
            command.id,
            existing.version + 1,
          ),
        });
        if (command.type === "pause" && existing.value.currentOccurrence) {
          const occurrenceId = existing.value.currentOccurrence.id;
          const currentTask = occurrenceTasks.get(occurrenceId);
          const currentDelivery = occurrenceDeliveries.get(occurrenceId);
          const claim = activeClaims.get(occurrenceId);
          if (claim) {
            claim.controller.abort(
              new Error("Scheduled occurrence was paused."),
            );
            activeClaims.delete(occurrenceId);
            await persistence.releaseLease({
              transactionId: `scheduler.pause-release:${command.requestId}`,
              resource: occurrenceResource(occurrenceId),
              owner: options.ownerId,
              fence: claim.fence,
            });
          }
          await boundedAwait([currentTask, currentDelivery]);
        }
        arm();
        return {
          ok: true as const,
          value: {
            schedule: publicSnapshot(updated),
            replayed: committed.value.replayed,
          },
        };
      }
      if (command.expectedRevision !== 0)
        return scheduleFailure(
          "revision_conflict",
          "Create requires expected revision zero.",
        );
      if (schedules.has(command.id))
        return scheduleFailure("already_exists", "Schedule already exists.");
      const currentDefinitions = await loadDefinitions();
      if (!currentDefinitions.ok) {
        if (currentDefinitions.capacity)
          return scheduleFailure(
            "capacity_exceeded",
            "Schedule capacity is reached.",
          );
        return storageFailure();
      }
      for (const entry of currentDefinitions.value) {
        if (
          entry.value.scope === "durable" ||
          entry.value.binding.creatorSessionId ===
            options.binding.creatorSessionId
        )
          schedules.set(entry.value.id, entry);
      }
      if (currentDefinitions.value.length >= configuration.maxSchedules)
        return scheduleFailure(
          "capacity_exceeded",
          "Schedule capacity is reached.",
        );
      if (
        (command.scope !== "session" && command.scope !== "durable") ||
        (command.missedRunPolicy !== "skip" &&
          command.missedRunPolicy !== "run-once") ||
        typeof command.prompt !== "string" ||
        command.prompt.length === 0 ||
        Buffer.byteLength(command.prompt) > PROMPT_MAX_BYTES ||
        !ID.test(command.profileName)
      )
        return scheduleFailure(
          "invalid_request",
          "Schedule definition is invalid.",
        );
      const credentialReferences = [...(command.credentialReferences ?? [])];
      if (
        credentialReferences.length > 32 ||
        new Set(credentialReferences).size !== credentialReferences.length ||
        credentialReferences.some(
          (reference) => !CREDENTIAL_REFERENCE.test(reference),
        )
      )
        return scheduleFailure(
          "invalid_request",
          "Credential references are invalid.",
        );
      const policy = validatePolicy(
        command.policy,
        configuration.defaultTimeoutMs,
      );
      if (!policy)
        return scheduleFailure(
          "invalid_request",
          "Schedule policy is outside safety bounds.",
        );

      let normalized;
      try {
        normalized = normalizeSchedule(command.schedule);
      } catch {
        return scheduleFailure(
          "invalid_request",
          "Schedule calendar is invalid.",
        );
      }
      const authority = await options.authority.authorize({
        projectId: options.binding.project.projectId,
        cwd: options.binding.cwd,
        profileName: command.profileName,
        credentialReferences,
      });
      if (
        !authority.ok ||
        !authority.value.projectTrusted ||
        authority.value.project.projectId !==
          options.binding.project.projectId ||
        authority.value.project.canonicalCwd !== options.binding.cwd ||
        authority.value.profile.identity.name !== command.profileName ||
        authority.value.profile.policy.role !== "scheduled"
      )
        return scheduleFailure(
          "authority_denied",
          "Schedule authority was denied.",
        );

      const prompt = await options.artifacts.put({
        body: command.prompt,
        filename: "scheduled-agent.txt",
        mediaType: "text/plain; charset=utf-8",
        metadata: { kind: "scheduled-agent-text" },
      });
      if (!prompt.ok)
        return scheduleFailure(
          "artifact_failed",
          "Schedule prompt could not be stored.",
          prompt.error.retryable,
        );

      const persisted: PersistedSchedule = {
        id: command.id,
        revision: 1,
        scope: command.scope,
        state: "active",
        schedule: normalized,
        missedRunPolicy: command.missedRunPolicy,
        nextAt: initialOccurrence(
          normalized,
          command.missedRunPolicy,
          options.clock.now(),
        ),
        binding: {
          projectId: options.binding.project.projectId,
          cwd: options.binding.cwd,
          creatorSessionId: options.binding.creatorSessionId,
          resultRoute: options.binding.resultRoute,
          executionRole: "scheduled",
        },
        profile: pinnedProfile(authority.value.profile),
        promptArtifact: {
          id: prompt.value.id,
          sha256: prompt.value.sha256,
          size: prompt.value.size,
          ...(prompt.value.mediaType
            ? { mediaType: prompt.value.mediaType }
            : {}),
        },
        policy,
        credentialReferenceCount: credentialReferences.length,
        credentialReferences,
        currentOccurrence: null,
        recentOccurrences: [],
      };
      const committed = await persistence.commitDefinition({
        requestId: command.requestId,
        digest,
        schedule: persisted,
        expectedVersion: null,
      });
      if (!committed.ok) {
        const replay = await recoverCommittedRequest(command.requestId, digest);
        if (replay) return replay;
        if (committed.error.code === "VERSION_CONFLICT")
          return scheduleFailure("already_exists", "Schedule already exists.");
        return storageFailure();
      }
      schedules.set(command.id, { value: persisted, version: 1 });
      arm();
      return {
        ok: true as const,
        value: { schedule: publicSnapshot(persisted), replayed: false },
      };
    },

    async inspect(input: import("./model.ts").ScheduleQuery = {}) {
      if (closed) return scheduleFailure("closed", "Scheduler is closed.");
      const query = decodeScheduleQuery(input);
      if (!query)
        return scheduleFailure(
          "invalid_request",
          "Inspection query is invalid.",
        );
      const currentDefinitions = await loadDefinitions();
      if (!currentDefinitions.ok) return storageFailure();
      const persistedIds = new Set(
        currentDefinitions.value.map(({ value }) => value.id),
      );
      for (const id of schedules.keys()) {
        if (!persistedIds.has(id)) schedules.delete(id);
      }
      for (const entry of currentDefinitions.value) {
        if (
          entry.value.scope === "durable" ||
          entry.value.binding.creatorSessionId ===
            options.binding.creatorSessionId
        )
          schedules.set(entry.value.id, entry);
      }
      const limit = query.limit ?? retention.maxInspection;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > retention.maxInspection ||
        (query.id !== undefined && !ID.test(query.id)) ||
        (query.afterId !== undefined && !ID.test(query.afterId)) ||
        (query.state !== undefined && !SCHEDULE_STATES.has(query.state))
      )
        return scheduleFailure(
          "invalid_request",
          "Inspection query is invalid.",
        );
      let selected = [...schedules.values()]
        .map(({ value }) => value)
        .sort((left, right) => left.id.localeCompare(right.id));
      if (query.id) selected = selected.filter(({ id }) => id === query.id);
      if (query.state)
        selected = selected.filter(({ state }) => state === query.state);
      if (query.afterId)
        selected = selected.filter(({ id }) => id > query.afterId!);
      const page = selected.slice(0, limit);
      return {
        ok: true as const,
        value: {
          schedules: page.map((value) =>
            publicSnapshot(value, query.includeHistory === true),
          ),
          ...(selected.length > page.length && page.at(-1)
            ? { nextCursor: page.at(-1)!.id }
            : {}),
          closed: false,
        },
      };
    },
  } satisfies import("./model.ts").Scheduler;

  return {
    ok: true as const,
    value: {
      scheduler,
      async close() {
        if (closed) return;
        closed = true;
        for (const id of schedules.keys()) sealGeneration(id);
        cancelWake?.();
        cancelWake = undefined;
        for (const claim of activeClaims.values())
          claim.controller.abort(new Error("Scheduler closed."));
        await boundedAwait([...activeTasks, ...activeDeliveries]);
        await persistence.cleanupSession(
          options.binding.creatorSessionId,
          retention.maxRequestReceipts,
        );
      },
    },
  };
}
