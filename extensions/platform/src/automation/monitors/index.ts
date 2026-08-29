import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { success } from "../../core/result.ts";
import type { LifecycleHandle } from "../../core/lifecycle/supervisor.ts";
import type {
  TriggerBinding,
  TriggerSourcePublisher,
} from "../triggers/model.ts";
import type {
  MonitorChangeReceipt,
  MonitorCommand,
  MonitorErrorCode,
  MonitorOpenOutcome,
  MonitorRegistryOptions,
  MonitorSnapshot,
  MonitorSourceLease,
} from "./model.ts";
import { defaultPlatformMonitorConfiguration } from "./config.ts";
import { hasExactKeys, isPlainData } from "../triggers/validation.ts";

export type * from "./model.ts";
export type * from "./filesystem-source.ts";
export type * from "./poll-source.ts";
export type * from "./sources.ts";
export type * from "./terminal-source.ts";
export type * from "./websocket-source.ts";
export {
  decodeMonitorConfiguration,
  defaultPlatformMonitorConfiguration,
} from "./config.ts";
export { createSessionBrokerMonitorDelivery } from "./delivery.ts";
export { createFileSystemMonitorSourceFactory } from "./filesystem-source.ts";
export {
  createJsonPollAdapter,
  createPollMonitorSourceFactory,
} from "./poll-source.ts";
export { createProductionMonitorSourceFactory } from "./sources.ts";
export { createTerminalMonitorSourceFactory } from "./terminal-source.ts";
export { createWebSocketMonitorSourceFactory } from "./websocket-source.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COMMAND_TYPES = new Set([
  "create",
  "replace",
  "pause",
  "resume",
  "stop",
  "delete",
]);

interface ActiveMonitor {
  value: MonitorSnapshot;
  fence: number;
  recordVersion?: number;
  publisher?: TriggerSourcePublisher;
  handle?: LifecycleHandle<MonitorSourceLease>;
  readonly callbacks: Set<Promise<void>>;
}

function monitorFailure(
  code: MonitorErrorCode,
  message: string,
  retryable = false,
) {
  return { ok: false as const, error: { code, message, retryable } };
}

function commandDigest(command: MonitorCommand) {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function snapshotCommand(value: unknown) {
  if (!isPlainData(value, { maxDepth: 16, maxNodes: 2_048 })) return undefined;
  try {
    return structuredClone(value) as MonitorCommand;
  } catch {
    return undefined;
  }
}

function authorityAllowed(value: unknown) {
  if (!isPlainData(value, { maxDepth: 3, maxNodes: 8 })) return false;
  const outcome = value as Record<string, unknown>;
  if (
    !hasExactKeys(outcome, ["ok", "value"]) ||
    Object.keys(outcome).length !== 2 ||
    outcome.ok !== true ||
    !outcome.value ||
    typeof outcome.value !== "object"
  )
    return false;
  const allowed = outcome.value as Record<string, unknown>;
  return (
    hasExactKeys(allowed, ["allowed"]) &&
    Object.keys(allowed).length === 1 &&
    allowed.allowed === true
  );
}

function deadline(operation: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<"elapsed">((resolve) => {
    timer = setTimeout(() => resolve("elapsed"), milliseconds);
    timer.unref?.();
  });
  return Promise.race([
    operation.then(() => "settled" as const),
    elapsed,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function storedDefinition(value: MonitorSnapshot) {
  return {
    id: value.id,
    revision: value.revision,
    scope: value.scope,
    state: value.state,
    source: value.source,
    ...(value.matcher ? { matcher: value.matcher } : {}),
    delivery: value.delivery,
  } satisfies import("./model.ts").MonitorDefinition;
}

function hasForbiddenPollInput(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "string")
    return /^(?:https?|wss?):\/\//i.test(value) || containsSensitiveText(value);
  if (Array.isArray(value))
    return value.some((item) => hasForbiddenPollInput(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /^(?:url|uri|command|shell|headers?|authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)$/i.test(
        key,
      ) || hasForbiddenPollInput(item, depth + 1),
  );
}

function containsSensitiveText(value: string) {
  return (
    /\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)\b\s*[:=]/i.test(
      value,
    ) ||
    /\bbearer\s+[a-z0-9._~+\-/]+=*/i.test(value) ||
    /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/i.test(
      value,
    ) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+(?::[^\s/@]*)?@/i.test(value)
  );
}

function validDefinition(
  command: Extract<MonitorCommand, { type: "create" | "replace" }>,
  pollMinimumMs: number,
  allowedWebSocketOrigins: readonly string[],
) {
  if (
    !hasExactKeys(command as unknown as Record<string, unknown>, [
      "type",
      "requestId",
      "id",
      "expectedRevision",
      "scope",
      "source",
      "matcher",
      "delivery",
    ])
  )
    return false;
  if (
    !["session", "durable"].includes(command.scope) ||
    !command.source ||
    typeof command.source !== "object" ||
    !["terminal", "file", "poll", "websocket"].includes(command.source.kind) ||
    command.delivery?.kind !== "session" ||
    !IDENTIFIER.test(command.delivery.sessionId)
  )
    return false;
  const matcher = command.matcher;
  if (
    matcher !== undefined &&
    (typeof matcher !== "object" ||
      (matcher.kind !== "literal" && matcher.kind !== "field") ||
      !hasExactKeys(
        matcher as unknown as Record<string, unknown>,
        matcher.kind === "literal"
          ? ["kind", "value", "field"]
          : ["kind", "field", "equals"],
      ) ||
      (matcher.kind === "literal" &&
        (typeof matcher.value !== "string" ||
          matcher.value.length === 0 ||
          Buffer.byteLength(matcher.value) > 4_096 ||
          containsSensitiveText(matcher.value) ||
          (matcher.field !== undefined && !IDENTIFIER.test(matcher.field)))) ||
      (matcher.kind === "field" &&
        (!IDENTIFIER.test(matcher.field) ||
          (!["string", "number", "boolean"].includes(typeof matcher.equals) &&
            matcher.equals !== null) ||
          (typeof matcher.equals === "string" &&
            containsSensitiveText(matcher.equals)))))
  )
    return false;
  if (command.source.kind === "terminal") {
    return (
      hasExactKeys(command.source as unknown as Record<string, unknown>, [
        "kind",
        "terminalId",
        "framing",
      ]) &&
      command.scope === "session" &&
      IDENTIFIER.test(command.source.terminalId) &&
      (command.source.framing === undefined ||
        command.source.framing === "line" ||
        command.source.framing === "chunk")
    );
  }
  if (command.source.kind === "poll") {
    return (
      hasExactKeys(command.source as unknown as Record<string, unknown>, [
        "kind",
        "adapter",
        "intervalMs",
        "input",
        "credentialReference",
      ]) &&
      IDENTIFIER.test(command.source.adapter) &&
      Number.isSafeInteger(command.source.intervalMs) &&
      command.source.intervalMs >= pollMinimumMs &&
      !hasForbiddenPollInput(command.source.input) &&
      (command.source.credentialReference === undefined ||
        /^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(
          command.source.credentialReference,
        ))
    );
  }
  if (command.source.kind === "file") {
    return (
      hasExactKeys(command.source as unknown as Record<string, unknown>, [
        "kind",
        "root",
        "recursive",
      ]) &&
      typeof command.source.root === "string" &&
      command.source.root.length > 0 &&
      Buffer.byteLength(command.source.root) <= 32 * 1024 &&
      (command.source.recursive === undefined ||
        typeof command.source.recursive === "boolean")
    );
  }
  if (command.source.kind === "websocket") {
    try {
      const url = new URL(command.source.url);
      return (
        hasExactKeys(command.source as unknown as Record<string, unknown>, [
          "kind",
          "url",
          "credentialReference",
        ]) &&
        ["ws:", "wss:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        ![...url.searchParams.keys()].some((key) =>
          /^(?:authorization|password|secret|token|api[-_]?key|credential)$/i.test(
            key,
          ),
        ) &&
        allowedWebSocketOrigins.includes(url.origin) &&
        (command.source.credentialReference === undefined ||
          /^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/.test(
            command.source.credentialReference,
          ))
      );
    } catch {
      return false;
    }
  }
  return true;
}

export async function createMonitorRegistry(
  options: MonitorRegistryOptions,
): Promise<MonitorOpenOutcome> {
  let closed = false;
  let closePromise:
    Promise<import("./model.ts").MonitorCloseReport> | undefined;
  let generation = 0;
  let registryGeneration = 1;
  const mutationController = new AbortController();
  const monitors = new Map<string, ActiveMonitor>();
  const requests = new Map<
    string,
    { digest: string; receipt: MonitorChangeReceipt }
  >();
  const durableReceipts = new Map<
    string,
    { version: number; updatedAt: number }
  >();
  const configuration =
    options.configuration ?? defaultPlatformMonitorConfiguration;
  const maxActive = options.limits?.maxActive ?? configuration.maxActive;
  const maxRemote = configuration.maxRemote;
  const maxInspection = options.limits?.maxInspection ?? 128;
  const batchWindowMs =
    options.limits?.batchWindowMs ?? configuration.batchWindowMs;
  const maxBatchCount = options.limits?.maxBatchCount ?? 64;
  const maxEvidenceBytes = options.limits?.maxEvidenceBytes ?? 256 * 1024;
  const pollMinimumMs =
    options.limits?.pollMinimumMs ?? configuration.pollMinimumMs;
  const maxReceipts =
    options.limits?.maxReceipts ?? Math.min(512, maxActive * 4);
  const callbackDrainMs = options.limits?.callbackDrainMs ?? 1_000;
  const closeDrainMs = options.limits?.closeDrainMs ?? 5_000;
  const namespace = createHash("sha256")
    .update(options.binding.projectId)
    .digest("hex");
  const definitionCollection = `monitor.definitions.${namespace}`;
  const requestCollection = `monitor.requests.${namespace}`;
  const quarantineCollection = `monitor.quarantine.${namespace}`;
  const transactionId = (kind: string, requestId: string) =>
    `monitor:${namespace}:${kind}:${createHash("sha256").update(requestId).digest("hex")}`;
  if (
    !IDENTIFIER.test(options.ownerId) ||
    !IDENTIFIER.test(options.binding.projectId) ||
    !IDENTIFIER.test(options.binding.sessionId) ||
    typeof options.binding.cwd !== "string" ||
    options.binding.cwd.length === 0 ||
    !Number.isSafeInteger(maxActive) ||
    maxActive < 1 ||
    maxActive > 128 ||
    !Number.isSafeInteger(maxRemote) ||
    maxRemote < 0 ||
    maxRemote > Math.min(16, maxActive) ||
    !Number.isSafeInteger(maxInspection) ||
    maxInspection < 1 ||
    maxInspection > 1_000 ||
    !Number.isSafeInteger(batchWindowMs) ||
    batchWindowMs < 1 ||
    batchWindowMs > 60_000 ||
    !Number.isSafeInteger(maxBatchCount) ||
    maxBatchCount < 1 ||
    maxBatchCount > 1_000 ||
    !Number.isSafeInteger(maxEvidenceBytes) ||
    maxEvidenceBytes < 1_024 ||
    maxEvidenceBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(pollMinimumMs) ||
    pollMinimumMs < 1 ||
    !Number.isSafeInteger(maxReceipts) ||
    maxReceipts < 1 ||
    maxReceipts > 4_096 ||
    !Number.isSafeInteger(callbackDrainMs) ||
    callbackDrainMs < 0 ||
    callbackDrainMs > 10_000 ||
    !Number.isSafeInteger(closeDrainMs) ||
    closeDrainMs < 0 ||
    closeDrainMs > 30_000
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_options",
        message: "MonitorRegistry options are outside safety bounds.",
        retryable: false,
      },
    };
  }

  const persist = async (
    entry: ActiveMonitor,
    value: MonitorSnapshot,
    requestId: string,
    digest: string,
    expectedVersion: number | null,
  ) => {
    if (value.scope !== "durable") return success(undefined);
    if (!options.state)
      return monitorFailure(
        "storage_failed",
        "Durable Monitor storage is unavailable.",
      );
    const definition = storedDefinition(value);
    const receiptToEvict =
      durableReceipts.size >= maxReceipts && !durableReceipts.has(requestId)
        ? [...durableReceipts.entries()].sort(
            ([leftId, left], [rightId, right]) =>
              left.updatedAt - right.updatedAt || leftId.localeCompare(rightId),
          )[0]
        : undefined;
    const committed = await options.state.transact({
      transactionId: transactionId("change", requestId),
      operations: [
        {
          type: "put-record",
          collection: definitionCollection,
          key: value.id,
          expectedVersion,
          metadata: JSON.parse(
            JSON.stringify({
              schemaVersion: 1,
              projectId: options.binding.projectId,
              cwd: options.binding.cwd,
              definition,
            }),
          ),
        },
        ...(receiptToEvict
          ? [
              {
                type: "delete-record" as const,
                collection: requestCollection,
                key: receiptToEvict[0],
                expectedVersion: receiptToEvict[1].version,
              },
            ]
          : []),
        {
          type: "put-record",
          collection: requestCollection,
          key: requestId,
          expectedVersion: null,
          metadata: {
            schemaVersion: 1,
            projectId: options.binding.projectId,
            digest,
            monitorId: value.id,
            revision: value.revision,
            definition: JSON.parse(JSON.stringify(definition)),
          },
        },
      ],
    });
    if (!committed.ok)
      return monitorFailure(
        committed.error.code === "VERSION_CONFLICT"
          ? "revision_conflict"
          : "storage_failed",
        "Durable Monitor definition could not be stored.",
        committed.error.retryable,
      );
    entry.recordVersion =
      committed.value.records.find(
        ({ collection, key }) =>
          collection === definitionCollection && key === value.id,
      )?.version ?? entry.recordVersion;
    if (receiptToEvict) {
      durableReceipts.delete(receiptToEvict[0]);
      requests.delete(receiptToEvict[0]);
    }
    const receiptRecord = committed.value.records.find(
      ({ collection, key }) =>
        collection === requestCollection && key === requestId,
    );
    if (receiptRecord)
      durableReceipts.set(requestId, {
        version: receiptRecord.version,
        updatedAt: receiptRecord.updatedAt,
      });
    return success(undefined);
  };

  const quarantine = async (
    collection: string,
    record: {
      readonly key: string;
      readonly version: number;
      readonly metadata: import("../../core/result.ts").JsonObject;
    },
    reason: string,
  ) => {
    if (!options.state) return success(undefined);
    let digest: string;
    try {
      digest = createHash("sha256")
        .update(JSON.stringify(record.metadata))
        .digest("hex");
    } catch {
      digest = createHash("sha256").update("unreadable").digest("hex");
    }
    const quarantined = await options.state.transact({
      transactionId: transactionId(
        "quarantine",
        `${collection}:${record.key}:${record.version}`,
      ),
      operations: [
        {
          type: "delete-record",
          collection,
          key: record.key,
          expectedVersion: record.version,
        },
        {
          type: "put-record",
          collection: quarantineCollection,
          key: createHash("sha256")
            .update(`${collection}\0${record.key}\0${record.version}`)
            .digest("hex"),
          expectedVersion: null,
          metadata: {
            schemaVersion: 1,
            projectId: options.binding.projectId,
            sourceCollection: collection,
            sourceKey: boundUtf8(record.key, 256),
            sourceVersion: record.version,
            reason: boundUtf8(reason, 256),
            digest,
          },
        },
      ],
    });
    return quarantined.ok
      ? success(undefined)
      : monitorFailure(
          "storage_failed",
          "Invalid Monitor state could not be quarantined.",
          quarantined.error.retryable,
        );
  };

  const removePersisted = async (
    entry: ActiveMonitor,
    requestId: string,
    digest: string,
    deleted: MonitorSnapshot,
  ) => {
    if (entry.value.scope !== "durable") return success(undefined);
    if (!options.state || !entry.recordVersion)
      return monitorFailure(
        "storage_failed",
        "Durable Monitor storage is unavailable.",
      );
    const receiptToEvict =
      durableReceipts.size >= maxReceipts && !durableReceipts.has(requestId)
        ? [...durableReceipts.entries()].sort(
            ([leftId, left], [rightId, right]) =>
              left.updatedAt - right.updatedAt || leftId.localeCompare(rightId),
          )[0]
        : undefined;
    const committed = await options.state.transact({
      transactionId: transactionId("delete", requestId),
      operations: [
        {
          type: "delete-record",
          collection: definitionCollection,
          key: entry.value.id,
          expectedVersion: entry.recordVersion,
        },
        ...(receiptToEvict
          ? [
              {
                type: "delete-record" as const,
                collection: requestCollection,
                key: receiptToEvict[0],
                expectedVersion: receiptToEvict[1].version,
              },
            ]
          : []),
        {
          type: "put-record",
          collection: requestCollection,
          key: requestId,
          expectedVersion: null,
          metadata: {
            schemaVersion: 1,
            projectId: options.binding.projectId,
            digest,
            monitorId: entry.value.id,
            revision: deleted.revision,
            definition: JSON.parse(JSON.stringify(storedDefinition(deleted))),
          },
        },
      ],
    });
    if (!committed.ok)
      return monitorFailure(
        committed.error.code === "VERSION_CONFLICT"
          ? "revision_conflict"
          : "storage_failed",
        "Durable Monitor definition could not be deleted.",
        committed.error.retryable,
      );
    if (receiptToEvict) {
      durableReceipts.delete(receiptToEvict[0]);
      requests.delete(receiptToEvict[0]);
    }
    const receiptRecord = committed.value.records.find(
      ({ collection, key }) =>
        collection === requestCollection && key === requestId,
    );
    if (receiptRecord)
      durableReceipts.set(requestId, {
        version: receiptRecord.version,
        updatedAt: receiptRecord.updatedAt,
      });
    return success(undefined);
  };

  const rollbackPersisted = async (
    entry: ActiveMonitor,
    prior: MonitorSnapshot | undefined,
    requestId: string,
    operation: "change" | "delete",
    priorVersion: number | null,
  ) => {
    if ((prior ?? entry.value).scope !== "durable") return true;
    if (!options.state) return false;
    const receipt = durableReceipts.get(requestId);
    const operations: import("../../core/persistence/state-store.ts").StateMutation[] =
      [];
    if (operation === "delete") {
      if (!prior) return false;
      operations.push({
        type: "put-record",
        collection: definitionCollection,
        key: prior.id,
        expectedVersion: null,
        metadata: JSON.parse(
          JSON.stringify({
            schemaVersion: 1,
            projectId: options.binding.projectId,
            cwd: options.binding.cwd,
            definition: storedDefinition(prior),
          }),
        ),
      });
    } else if (prior) {
      operations.push({
        type: "put-record",
        collection: definitionCollection,
        key: prior.id,
        expectedVersion: entry.recordVersion,
        metadata: JSON.parse(
          JSON.stringify({
            schemaVersion: 1,
            projectId: options.binding.projectId,
            cwd: options.binding.cwd,
            definition: storedDefinition(prior),
          }),
        ),
      });
    } else if (entry.recordVersion) {
      operations.push({
        type: "delete-record",
        collection: definitionCollection,
        key: entry.value.id,
        expectedVersion: entry.recordVersion,
      });
    }
    if (receipt) {
      operations.push({
        type: "delete-record",
        collection: requestCollection,
        key: requestId,
        expectedVersion: receipt.version,
      });
    }
    const rolledBack = await options.state.transact({
      transactionId: transactionId("rollback", requestId),
      operations,
    });
    if (!rolledBack.ok) return false;
    durableReceipts.delete(requestId);
    requests.delete(requestId);
    entry.recordVersion = prior
      ? (rolledBack.value.records.find(
          ({ collection, key }) =>
            collection === definitionCollection && key === prior.id,
        )?.version ??
        priorVersion ??
        undefined)
      : undefined;
    return true;
  };

  const redactString = (value: string) =>
    value
      .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(
        /(\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/(\bbearer\s+)[a-z0-9._~+\-/]+=*/gi, "$1[REDACTED]")
      .replace(
        /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/gi,
        "[REDACTED]",
      )
      .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+(?::[^\s/@]*)?@/gi,
        "$1[REDACTED]@",
      );

  const boundUtf8 = (value: string, maxBytes: number) => {
    if (Buffer.byteLength(value) <= maxBytes) return value;
    let bounded = Buffer.from(value).subarray(0, maxBytes).toString("utf8");
    while (Buffer.byteLength(bounded) > maxBytes)
      bounded = bounded.slice(0, -1);
    return bounded;
  };

  const redact = (
    value: unknown,
    budget = { nodes: 0, bytes: 0, seen: new WeakSet<object>() },
    depth = 0,
  ): import("../../core/result.ts").JsonValue => {
    budget.nodes += 1;
    if (depth > 12 || budget.nodes > 1_024 || budget.bytes >= 48 * 1024)
      return "[TRUNCATED]";
    if (typeof value === "string") {
      const bounded = boundUtf8(
        redactString(value),
        Math.min(8 * 1024, 48 * 1024 - budget.bytes),
      );
      budget.bytes += Buffer.byteLength(bounded);
      return bounded;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (!value || typeof value !== "object") return "[UNSUPPORTED]";
    if (isProxy(value)) return "[UNREADABLE]";
    if (budget.seen.has(value)) return "[CYCLE]";
    budget.seen.add(value);
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return "[UNREADABLE]";
    }
    if (Array.isArray(value)) {
      const output: import("../../core/result.ts").JsonValue[] = [];
      const length = Math.min(
        Number.isSafeInteger(descriptors.length?.value)
          ? descriptors.length!.value
          : 0,
        256,
      );
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        output.push(
          descriptor && "value" in descriptor
            ? redact(descriptor.value, budget, depth + 1)
            : "[ACCESSOR]",
        );
      }
      return output;
    }
    const output = Object.create(null) as Record<
      string,
      import("../../core/result.ts").JsonValue
    >;
    const entries = Object.entries(descriptors).filter(
      ([, descriptor]) => descriptor.enumerable,
    );
    for (const [rawKey, descriptor] of entries.slice(0, 256)) {
      const key = boundUtf8(redactString(rawKey), 256);
      budget.bytes += Buffer.byteLength(key);
      if (budget.nodes > 1_024 || budget.bytes >= 48 * 1024) break;
      if (
        /^(?:__proto__|prototype|constructor|authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)$/i.test(
          key,
        )
      ) {
        output[key] = "[REDACTED]";
      } else {
        output[key] =
          "value" in descriptor
            ? redact(descriptor.value, budget, depth + 1)
            : "[ACCESSOR]";
      }
    }
    return output;
  };

  const fieldValue = (
    payload: import("../../core/result.ts").JsonObject,
    field: string,
  ) => {
    let value: unknown = payload;
    for (const part of field.split(".")) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };

  const matches = (
    entry: ActiveMonitor,
    payload: import("../../core/result.ts").JsonObject,
  ) => {
    const matcher = entry.value.matcher;
    if (!matcher) return true;
    if (matcher.kind === "field")
      return fieldValue(payload, matcher.field) === matcher.equals;
    const candidate = matcher.field
      ? fieldValue(payload, matcher.field)
      : JSON.stringify(payload);
    return typeof candidate === "string" && candidate.includes(matcher.value);
  };

  const deliver = async (
    entry: ActiveMonitor,
    expectedRevision: number,
    delivery: import("../triggers/model.ts").TriggerDelivery,
  ) => {
    if (
      closed ||
      entry.value.state !== "active" ||
      entry.value.revision !== expectedRevision
    )
      return;
    const envelope = {
      monitorId: entry.value.id,
      revision: expectedRevision,
      trust: "untrusted" as const,
      authority: "none" as const,
      events: delivery.events.map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
    };
    let body = JSON.stringify(envelope);
    if (Buffer.byteLength(body) > maxEvidenceBytes) {
      body = JSON.stringify({
        monitorId: entry.value.id,
        revision: expectedRevision,
        trust: "untrusted",
        authority: "none",
        eventCount: envelope.events.length,
        evidenceDigest: createHash("sha256").update(body).digest("hex"),
        truncated: true,
      });
    }
    const evidence = await options.artifacts.put({
      body,
      filename: "monitor-evidence.json",
      mediaType: "application/json",
      metadata: {
        kind: "monitor-evidence",
        monitorId: entry.value.id,
        revision: expectedRevision,
        eventCount: delivery.events.length,
        trust: "untrusted",
        authority: "none",
      },
    });
    if (
      !evidence.ok ||
      closed ||
      entry.value.state !== "active" ||
      entry.value.revision !== expectedRevision
    ) {
      entry.value = {
        ...entry.value,
        dropped: entry.value.dropped + 1,
        lastError: "Monitor evidence could not be delivered.",
      };
      return;
    }
    const deliveryId = createHash("sha256")
      .update(
        `${entry.value.id}\0${expectedRevision}\0${delivery.events.map(({ id }) => id).join("\0")}`,
      )
      .digest("hex");
    if (delivery.signal.aborted) return;
    const rawResult = await options.delivery.deliver(
      {
        deliveryId,
        route: entry.value.delivery,
        monitorId: entry.value.id,
        revision: expectedRevision,
        summary: `Monitor ${entry.value.id} matched ${delivery.events.length} untrusted event(s).`,
        evidence: evidence.value,
        trust: "untrusted",
        authority: "none",
      },
      delivery.signal,
    );
    if (
      closed ||
      entry.value.state !== "active" ||
      entry.value.revision !== expectedRevision
    )
      return;
    const result = isPlainData(rawResult, { maxDepth: 4, maxNodes: 16 })
      ? structuredClone(rawResult)
      : undefined;
    if (
      !result ||
      !result.ok ||
      !hasExactKeys(result as unknown as Record<string, unknown>, [
        "ok",
        "value",
      ]) ||
      Object.keys(result).length !== 2 ||
      !hasExactKeys(result.value as unknown as Record<string, unknown>, [
        "state",
      ]) ||
      Object.keys(result.value).length !== 1 ||
      (result.value.state !== "delivered" && result.value.state !== "offline")
    ) {
      entry.value = {
        ...entry.value,
        dropped: entry.value.dropped + 1,
        lastError: "Monitor delivery failed.",
      };
      return;
    }
    entry.value = {
      ...entry.value,
      deliveries: entry.value.deliveries + 1,
      lastEventAt: delivery.events.at(-1)?.occurredAt,
      ...(result.value.state === "offline"
        ? { lastError: "Monitor delivery is queued offline." }
        : {}),
    };
  };

  const bindings = () =>
    [...monitors.values()]
      .filter(({ value }) => value.state === "active")
      .map((entry) => {
        const revision = entry.value.revision;
        return {
          id: `monitor:${entry.value.id}`,
          eventTypes: [`monitor:${entry.value.id}`],
          batch: { maxCount: maxBatchCount, maxWaitMs: batchWindowMs },
          deliver(delivery) {
            const task = deliver(entry, revision, delivery);
            entry.callbacks.add(task);
            void task.finally(() => entry.callbacks.delete(task));
            return task;
          },
        } satisfies TriggerBinding;
      });

  const reconcile = async () => {
    generation += 1;
    return options.triggers.engine.reconcile({
      ownerId: options.ownerId,
      generation,
      bindings: bindings(),
    });
  };

  const quiesce = async (entry: ActiveMonitor) => {
    if (entry.callbacks.size === 0) return 0;
    const drained = await deadline(
      Promise.allSettled([...entry.callbacks]),
      callbackDrainMs,
    );
    if (drained === "settled") return 0;
    const unresolved = entry.callbacks.size;
    entry.value = {
      ...entry.value,
      dropped: entry.value.dropped + unresolved,
      unresolved: entry.value.unresolved + unresolved,
      lastError: "Monitor callback drain deadline elapsed.",
    };
    return unresolved;
  };

  const initial = await reconcile();
  if (!initial.ok) {
    return {
      ok: false,
      error: {
        code: "trigger_failed",
        message: "Monitor TriggerEngine binding failed.",
        retryable: initial.error.retryable,
      },
    };
  }

  const start = async (entry: ActiveMonitor) => {
    if (closed) return monitorFailure("closed", "MonitorRegistry is closed.");
    const startGeneration = registryGeneration;
    const definition = structuredClone(entry.value);
    const bound = options.triggers.bindSource({
      kind: `monitor-${definition.source.kind}`,
      id: definition.id,
      projectId: options.binding.projectId,
      sessionId: options.binding.sessionId,
      trust: "untrusted",
      metadata: { revision: definition.revision },
    });
    if (!bound.ok)
      return monitorFailure("source_failed", "Monitor source binding failed.");
    entry.publisher = bound.value;
    const fence = ++entry.fence;
    entry.handle = options.lifecycle.acquireHandle({
      id: `monitor.source:${options.ownerId}:${definition.id}`,
      async start(signal) {
        const lease = await options.sources.open(
          definition,
          (event) => {
            let fields: PropertyDescriptorMap;
            try {
              if (!event || typeof event !== "object" || isProxy(event)) return;
              fields = Object.getOwnPropertyDescriptors(event);
            } catch {
              return;
            }
            const sourceTypeDescriptor = fields.type;
            const payloadDescriptor = fields.payload;
            const causedByDescriptor = fields.causedByMonitorId;
            if (
              !sourceTypeDescriptor ||
              !("value" in sourceTypeDescriptor) ||
              typeof sourceTypeDescriptor.value !== "string" ||
              !payloadDescriptor ||
              !("value" in payloadDescriptor) ||
              closed ||
              entry.fence !== fence ||
              entry.value.state !== "active" ||
              (causedByDescriptor &&
                "value" in causedByDescriptor &&
                causedByDescriptor.value === entry.value.id)
            )
              return;
            const data = redact(payloadDescriptor.value);
            if (!data || typeof data !== "object" || Array.isArray(data))
              return;
            const boundedData =
              data as import("../../core/result.ts").JsonObject;
            if (!matches(entry, boundedData)) return;
            const sourceType = boundUtf8(
              redactString(sourceTypeDescriptor.value),
              256,
            );
            let payload: import("../../core/result.ts").JsonObject = {
              sourceType,
              data: boundedData,
            };
            const encoded = JSON.stringify(payload);
            if (Buffer.byteLength(encoded) > 60 * 1024) {
              payload = {
                sourceType,
                truncated: true,
                dataDigest: createHash("sha256").update(encoded).digest("hex"),
              };
            }
            const publisher = entry.publisher;
            if (!publisher) return;
            const task = publisher
              .publish({
                type: `monitor:${entry.value.id}`,
                payload,
              })
              .then((published) => {
                if (
                  published.ok ||
                  closed ||
                  entry.fence !== fence ||
                  entry.value.state !== "active"
                )
                  return;
                entry.value = {
                  ...entry.value,
                  dropped: entry.value.dropped + 1,
                  lastError: `Monitor trigger publish failed: ${published.error.code}.`,
                };
              })
              .catch(() => {
                if (
                  closed ||
                  entry.fence !== fence ||
                  entry.value.state !== "active"
                )
                  return;
                entry.value = {
                  ...entry.value,
                  dropped: entry.value.dropped + 1,
                  lastError: "Monitor trigger publish failed.",
                };
              });
            entry.callbacks.add(task);
            void task.finally(() => entry.callbacks.delete(task));
          },
          signal,
        );
        if (
          closed ||
          startGeneration !== registryGeneration ||
          entry.fence !== fence ||
          signal.aborted
        ) {
          await lease.close();
          throw new Error("Monitor source authority expired during startup.");
        }
        return { value: lease, close: () => lease.close() };
      },
    });
    try {
      await entry.handle.value;
      if (
        closed ||
        startGeneration !== registryGeneration ||
        entry.fence !== fence
      ) {
        await entry.handle.release().catch(() => undefined);
        entry.handle = undefined;
        return monitorFailure("closed", "MonitorRegistry is closed.");
      }
      return success(undefined);
    } catch {
      entry.handle = undefined;
      return monitorFailure(
        "source_failed",
        "Monitor source could not start.",
        true,
      );
    }
  };

  const restoreRuntime = async (
    entry: ActiveMonitor,
    prior: MonitorSnapshot,
  ) => {
    entry.fence += 1;
    await entry.handle?.release().catch(() => undefined);
    entry.handle = undefined;
    entry.value = prior;
    const rebound = await reconcile();
    if (!rebound.ok) return false;
    if (prior.state !== "active") return true;
    const restarted = await start(entry);
    return restarted.ok;
  };

  if (options.state) {
    const loaded = await options.state.query({
      type: "records",
      collection: definitionCollection,
      limit: maxActive + 1,
    });
    if (!loaded.ok || loaded.value.type !== "records") {
      return {
        ok: false,
        error: {
          code: "storage_failed",
          message: "Durable Monitor definitions could not be loaded.",
          retryable: !loaded.ok && loaded.error.retryable,
        },
      };
    }
    if (loaded.value.records.length > maxActive) {
      return {
        ok: false,
        error: {
          code: "storage_failed",
          message: "Durable Monitor definitions exceed the configured bound.",
          retryable: false,
        },
      };
    }
    for (const record of loaded.value.records) {
      const persisted = record.metadata as unknown as {
        readonly schemaVersion?: unknown;
        readonly projectId?: unknown;
        readonly cwd?: unknown;
        readonly definition?: unknown;
      };
      const definition = persisted.definition as
        Partial<MonitorSnapshot> | undefined;
      if (
        !isPlainData(record.metadata, { maxDepth: 16, maxNodes: 2_048 }) ||
        !hasExactKeys(record.metadata, [
          "schemaVersion",
          "projectId",
          "cwd",
          "definition",
        ]) ||
        Object.keys(record.metadata).length !== 4 ||
        persisted.schemaVersion !== 1 ||
        persisted.projectId !== options.binding.projectId ||
        typeof persisted.cwd !== "string" ||
        persisted.cwd.length === 0 ||
        Buffer.byteLength(persisted.cwd) > 32 * 1024 ||
        !definition ||
        !isPlainData(definition, { maxDepth: 16, maxNodes: 2_048 }) ||
        !hasExactKeys(definition as Record<string, unknown>, [
          "id",
          "revision",
          "scope",
          "state",
          "source",
          "matcher",
          "delivery",
        ]) ||
        typeof definition.id !== "string" ||
        !IDENTIFIER.test(definition.id) ||
        definition.id !== record.key ||
        definition.scope !== "durable" ||
        typeof definition.revision !== "number" ||
        !Number.isSafeInteger(definition.revision) ||
        (definition.revision ?? 0) < 1 ||
        !["active", "paused", "stopped", "blocked"].includes(
          definition.state ?? "",
        ) ||
        !definition.source ||
        !definition.delivery
      ) {
        const quarantined = await quarantine(
          definitionCollection,
          record,
          "definition-schema-invalid",
        );
        if (!quarantined.ok) {
          return {
            ok: false,
            error: {
              code: "storage_failed",
              message: quarantined.error.message,
              retryable: quarantined.error.retryable,
            },
          };
        }
        continue;
      }
      const command = {
        type: "create" as const,
        requestId: "restore-validation",
        id: definition.id,
        expectedRevision: 0,
        scope: "durable" as const,
        source: definition.source,
        ...(definition.matcher ? { matcher: definition.matcher } : {}),
        delivery: definition.delivery,
      };
      if (
        !validDefinition(
          command,
          pollMinimumMs,
          configuration.allowedWebSocketOrigins,
        )
      ) {
        const quarantined = await quarantine(
          definitionCollection,
          record,
          "definition-value-invalid",
        );
        if (!quarantined.ok) {
          return {
            ok: false,
            error: {
              code: "storage_failed",
              message: quarantined.error.message,
              retryable: quarantined.error.retryable,
            },
          };
        }
        continue;
      }
      let value: MonitorSnapshot = {
        ...structuredClone(storedDefinition(definition as MonitorSnapshot)),
        deliveries: 0,
        dropped: 0,
        unresolved: 0,
      };
      if (value.state === "active") {
        const authority = await options.authority.authorize({
          definition: value,
          phase: "restore",
          projectId: options.binding.projectId,
          cwd: options.binding.cwd,
        });
        if (
          persisted.cwd !== options.binding.cwd ||
          !authorityAllowed(authority)
        ) {
          value = {
            ...value,
            state: "blocked",
            blockedReason: "Durable Monitor authority requires revalidation.",
          };
        }
      }
      monitors.set(value.id, {
        value,
        fence: 0,
        recordVersion: record.version,
        callbacks: new Set(),
      });
    }
    if (monitors.size > 0) {
      const restoredBindings = await reconcile();
      if (!restoredBindings.ok) {
        return {
          ok: false,
          error: {
            code: "trigger_failed",
            message: "Restored Monitor trigger bindings failed.",
            retryable: restoredBindings.error.retryable,
          },
        };
      }
      for (const entry of monitors.values()) {
        if (entry.value.state !== "active") continue;
        const started = await start(entry);
        if (!started.ok) {
          entry.value = {
            ...entry.value,
            state: "blocked",
            blockedReason:
              "Durable Monitor source failed restart revalidation.",
          };
        }
      }
    }
    const loadedRequests = await options.state.query({
      type: "records",
      collection: requestCollection,
      limit: maxReceipts + 1,
    });
    if (!loadedRequests.ok || loadedRequests.value.type !== "records") {
      return {
        ok: false,
        error: {
          code: "storage_failed",
          message: "Durable Monitor receipts could not be loaded.",
          retryable: !loadedRequests.ok && loadedRequests.error.retryable,
        },
      };
    }
    const receiptRecords = [...loadedRequests.value.records].sort(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.key.localeCompare(right.key),
    );
    for (const overflow of receiptRecords.slice(maxReceipts)) {
      const removed = await options.state.transact({
        transactionId: transactionId(
          "receipt-retention",
          `${overflow.key}:${overflow.version}`,
        ),
        operations: [
          {
            type: "delete-record",
            collection: requestCollection,
            key: overflow.key,
            expectedVersion: overflow.version,
          },
        ],
      });
      if (!removed.ok) {
        return {
          ok: false,
          error: {
            code: "storage_failed",
            message: "Durable Monitor receipt retention failed.",
            retryable: removed.error.retryable,
          },
        };
      }
    }
    {
      for (const record of receiptRecords.slice(0, maxReceipts)) {
        const metadata = record.metadata as unknown as {
          readonly schemaVersion?: unknown;
          readonly projectId?: unknown;
          readonly digest?: unknown;
          readonly monitorId?: unknown;
          readonly revision?: unknown;
          readonly definition?: unknown;
        };
        const receiptDefinition = metadata.definition as
          Partial<MonitorSnapshot> | undefined;
        if (
          !isPlainData(record.metadata, { maxDepth: 16, maxNodes: 2_048 }) ||
          !hasExactKeys(record.metadata, [
            "schemaVersion",
            "projectId",
            "digest",
            "monitorId",
            "revision",
            "definition",
          ]) ||
          Object.keys(record.metadata).length !== 6 ||
          metadata.schemaVersion !== 1 ||
          metadata.projectId !== options.binding.projectId ||
          typeof metadata.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(metadata.digest) ||
          typeof metadata.monitorId !== "string" ||
          typeof metadata.revision !== "number" ||
          !Number.isSafeInteger(metadata.revision) ||
          !IDENTIFIER.test(record.key) ||
          !receiptDefinition ||
          !isPlainData(receiptDefinition, { maxDepth: 16, maxNodes: 2_048 }) ||
          !hasExactKeys(receiptDefinition as Record<string, unknown>, [
            "id",
            "revision",
            "scope",
            "state",
            "source",
            "matcher",
            "delivery",
          ]) ||
          receiptDefinition.id !== metadata.monitorId ||
          receiptDefinition.revision !== metadata.revision ||
          receiptDefinition.scope !== "durable" ||
          !receiptDefinition.source ||
          !receiptDefinition.delivery ||
          !["active", "paused", "stopped", "blocked", "deleted"].includes(
            receiptDefinition.state ?? "",
          )
        ) {
          const quarantined = await quarantine(
            requestCollection,
            record,
            "receipt-schema-invalid",
          );
          if (!quarantined.ok) {
            return {
              ok: false,
              error: {
                code: "storage_failed",
                message: quarantined.error.message,
                retryable: quarantined.error.retryable,
              },
            };
          }
          continue;
        }
        const validationCommand = {
          type: "create" as const,
          requestId: "receipt-validation",
          id: metadata.monitorId,
          expectedRevision: 0,
          scope: "durable" as const,
          source: receiptDefinition.source,
          ...(receiptDefinition.matcher
            ? { matcher: receiptDefinition.matcher }
            : {}),
          delivery: receiptDefinition.delivery,
        };
        if (
          !validDefinition(
            validationCommand,
            pollMinimumMs,
            configuration.allowedWebSocketOrigins,
          )
        ) {
          const quarantined = await quarantine(
            requestCollection,
            record,
            "receipt-value-invalid",
          );
          if (!quarantined.ok) {
            return {
              ok: false,
              error: {
                code: "storage_failed",
                message: quarantined.error.message,
                retryable: quarantined.error.retryable,
              },
            };
          }
          continue;
        }
        const receipt: MonitorSnapshot = {
          ...structuredClone(
            storedDefinition(receiptDefinition as MonitorSnapshot),
          ),
          deliveries: 0,
          dropped: 0,
          unresolved: 0,
        };
        requests.set(record.key, {
          digest: metadata.digest,
          receipt: { monitor: receipt, replayed: false },
        });
        durableReceipts.set(record.key, {
          version: record.version,
          updatedAt: record.updatedAt,
        });
      }
    }
  }

  const rememberReceipt = (
    requestId: string,
    digest: string,
    receipt: MonitorChangeReceipt,
  ) => {
    while (requests.size >= maxReceipts && !requests.has(requestId)) {
      const oldest = requests.keys().next().value;
      if (typeof oldest !== "string") break;
      requests.delete(oldest);
    }
    requests.set(requestId, { digest, receipt });
  };

  let mutationTail = Promise.resolve();
  const serializeMutation = async <T>(operation: () => Promise<T>) => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const registry = {
    change(input: MonitorCommand) {
      const command = snapshotCommand(input);
      if (!command)
        return Promise.resolve(
          monitorFailure("invalid_request", "Monitor command is invalid."),
        );
      const acceptedGeneration = registryGeneration;
      return serializeMutation(async () => {
        const stale = () => closed || acceptedGeneration !== registryGeneration;
        const staleAfterCommit = async (
          entry: ActiveMonitor,
          prior: MonitorSnapshot | undefined,
          operation: "change" | "delete",
          priorVersion: number | null,
        ) => {
          await rollbackPersisted(
            entry,
            prior,
            command.requestId,
            operation,
            priorVersion,
          );
          return monitorFailure("closed", "MonitorRegistry is closed.");
        };
        if (stale())
          return monitorFailure("closed", "MonitorRegistry is closed.");
        if (
          !COMMAND_TYPES.has(command.type) ||
          !IDENTIFIER.test(command.requestId) ||
          !IDENTIFIER.test(command.id) ||
          !Number.isSafeInteger(command.expectedRevision) ||
          command.expectedRevision < 0
        )
          return monitorFailure(
            "invalid_request",
            "Monitor command is invalid.",
          );
        if (
          command.type !== "create" &&
          command.type !== "replace" &&
          !hasExactKeys(command as unknown as Record<string, unknown>, [
            "type",
            "requestId",
            "id",
            "expectedRevision",
          ])
        )
          return monitorFailure(
            "invalid_request",
            "Monitor command is invalid.",
          );
        const digest = commandDigest(command);
        const prior = requests.get(command.requestId);
        if (prior) {
          if (prior.digest !== digest)
            return monitorFailure(
              "invalid_request",
              "Request identifier was already used for different intent.",
            );
          return success({ ...prior.receipt, replayed: true });
        }
        if (command.type === "replace") {
          const entry = monitors.get(command.id);
          if (!entry)
            return monitorFailure("not_found", "Monitor does not exist.");
          if (command.expectedRevision !== entry.value.revision)
            return monitorFailure(
              "revision_conflict",
              "Monitor revision changed.",
            );
          if (
            !validDefinition(
              command,
              pollMinimumMs,
              configuration.allowedWebSocketOrigins,
            )
          )
            return monitorFailure(
              "invalid_request",
              "Monitor definition is invalid.",
            );
          if (command.scope === "durable" && !options.state)
            return monitorFailure(
              "storage_failed",
              "Durable Monitor storage is unavailable.",
            );
          if (entry.value.scope === "durable" && command.scope === "session") {
            return monitorFailure(
              "invalid_request",
              "Replacing a durable Monitor with session scope requires delete then create.",
            );
          }
          if (
            (command.source.kind === "poll" ||
              command.source.kind === "websocket") &&
            entry.value.source.kind !== "poll" &&
            entry.value.source.kind !== "websocket" &&
            [...monitors.values()].filter(
              ({ value }) =>
                value.source.kind === "poll" ||
                value.source.kind === "websocket",
            ).length >= maxRemote
          )
            return monitorFailure(
              "capacity_exceeded",
              "Remote Monitor capacity is reached.",
            );
          const priorValue = structuredClone(entry.value);
          const candidate: MonitorSnapshot = {
            id: command.id,
            revision: entry.value.revision + 1,
            scope: command.scope,
            state: "active",
            source: structuredClone(command.source),
            ...(command.matcher
              ? { matcher: structuredClone(command.matcher) }
              : {}),
            delivery: structuredClone(command.delivery),
            deliveries: entry.value.deliveries,
            dropped: entry.value.dropped,
            unresolved: entry.value.unresolved,
          };
          const authority = await options.authority.authorize({
            definition: candidate,
            phase: "replace",
            projectId: options.binding.projectId,
            cwd: options.binding.cwd,
          });
          if (closed || acceptedGeneration !== registryGeneration)
            return monitorFailure("closed", "MonitorRegistry is closed.");
          if (!authorityAllowed(authority))
            return monitorFailure(
              "authority_denied",
              "Monitor authority was denied.",
            );
          const priorVersion = entry.recordVersion ?? null;
          const persisted = await persist(
            entry,
            candidate,
            command.requestId,
            digest,
            command.scope === "durable" ? priorVersion : null,
          );
          if (!persisted.ok) return persisted;
          if (closed || acceptedGeneration !== registryGeneration) {
            await rollbackPersisted(
              entry,
              priorValue,
              command.requestId,
              "change",
              priorVersion,
            );
            return monitorFailure("closed", "MonitorRegistry is closed.");
          }
          entry.fence += 1;
          entry.value = { ...entry.value, state: "paused" };
          const sealed = await reconcile();
          if (!sealed.ok) {
            entry.value = priorValue;
            await reconcile();
            const rolledBack = await rollbackPersisted(
              entry,
              priorValue,
              command.requestId,
              "change",
              priorVersion,
            );
            return rolledBack
              ? monitorFailure(
                  "source_failed",
                  "Monitor trigger binding failed.",
                  true,
                )
              : monitorFailure(
                  "storage_failed",
                  "Monitor runtime failed and durable rollback was incomplete.",
                );
          }
          if (stale())
            return staleAfterCommit(entry, priorValue, "change", priorVersion);
          await quiesce(entry);
          if (stale())
            return staleAfterCommit(entry, priorValue, "change", priorVersion);
          try {
            await entry.handle?.release();
            entry.handle = undefined;
          } catch {
            entry.value = {
              ...priorValue,
              state: "blocked",
              blockedReason:
                "Prior Monitor source close outcome is unresolved.",
            };
            await reconcile();
            await rollbackPersisted(
              entry,
              priorValue,
              command.requestId,
              "change",
              priorVersion,
            );
            return monitorFailure(
              "source_failed",
              "Monitor source could not close.",
              true,
            );
          }
          if (stale())
            return staleAfterCommit(entry, priorValue, "change", priorVersion);
          entry.value = candidate;
          const rebound = await reconcile();
          if (!rebound.ok) {
            const restored = await restoreRuntime(entry, priorValue);
            const rolledBack = await rollbackPersisted(
              entry,
              priorValue,
              command.requestId,
              "change",
              priorVersion,
            );
            return restored && rolledBack
              ? monitorFailure(
                  "source_failed",
                  "Monitor trigger binding failed.",
                  true,
                )
              : monitorFailure(
                  "storage_failed",
                  "Monitor runtime failed and recovery was incomplete.",
                );
          }
          if (stale())
            return staleAfterCommit(entry, priorValue, "change", priorVersion);
          const started = await start(entry);
          if (!started.ok) {
            const restored = await restoreRuntime(entry, priorValue);
            const rolledBack = await rollbackPersisted(
              entry,
              priorValue,
              command.requestId,
              "change",
              priorVersion,
            );
            return restored && rolledBack
              ? started
              : monitorFailure(
                  "storage_failed",
                  "Monitor source failed and recovery was incomplete.",
                );
          }
          if (stale())
            return staleAfterCommit(entry, priorValue, "change", priorVersion);
          const receipt = {
            monitor: structuredClone(entry.value),
            replayed: false,
          };
          rememberReceipt(command.requestId, digest, receipt);
          return success(receipt);
        }
        if (command.type !== "create") {
          const entry = monitors.get(command.id);
          if (!entry)
            return monitorFailure("not_found", "Monitor does not exist.");
          if (command.expectedRevision !== entry.value.revision)
            return monitorFailure(
              "revision_conflict",
              "Monitor revision changed.",
            );
          if (
            command.type !== "pause" &&
            command.type !== "resume" &&
            command.type !== "stop" &&
            command.type !== "delete"
          )
            return monitorFailure(
              "invalid_request",
              "Monitor command is not implemented.",
            );
          const priorVersion = entry.recordVersion ?? null;
          if (
            command.type === "pause" ||
            command.type === "stop" ||
            command.type === "delete"
          ) {
            if (command.type === "pause" && entry.value.state !== "active")
              return monitorFailure(
                "invalid_request",
                "Only an active Monitor can be paused.",
              );
            if (
              command.type === "stop" &&
              entry.value.state !== "active" &&
              entry.value.state !== "paused" &&
              entry.value.state !== "blocked"
            )
              return monitorFailure(
                "invalid_request",
                "Monitor cannot be stopped from its current state.",
              );
            const priorValue = structuredClone(entry.value);
            const candidate: MonitorSnapshot = {
              ...entry.value,
              revision: entry.value.revision + 1,
              state:
                command.type === "pause"
                  ? "paused"
                  : command.type === "stop"
                    ? "stopped"
                    : "deleted",
            };
            const persisted =
              command.type === "delete"
                ? await removePersisted(
                    entry,
                    command.requestId,
                    digest,
                    candidate,
                  )
                : await persist(
                    entry,
                    candidate,
                    command.requestId,
                    digest,
                    priorVersion,
                  );
            if (!persisted.ok) return persisted;
            if (closed || acceptedGeneration !== registryGeneration) {
              await rollbackPersisted(
                entry,
                priorValue,
                command.requestId,
                command.type === "delete" ? "delete" : "change",
                priorVersion,
              );
              return monitorFailure("closed", "MonitorRegistry is closed.");
            }
            entry.fence += 1;
            entry.value = candidate;
            const reconciled = await reconcile();
            if (!reconciled.ok) {
              entry.value = priorValue;
              await reconcile();
              const rolledBack = await rollbackPersisted(
                entry,
                priorValue,
                command.requestId,
                command.type === "delete" ? "delete" : "change",
                priorVersion,
              );
              return rolledBack
                ? monitorFailure(
                    "source_failed",
                    "Monitor trigger binding failed.",
                    true,
                  )
                : monitorFailure(
                    "storage_failed",
                    "Monitor runtime failed and durable rollback was incomplete.",
                  );
            }
            if (stale())
              return staleAfterCommit(
                entry,
                priorValue,
                command.type === "delete" ? "delete" : "change",
                priorVersion,
              );
            await quiesce(entry);
            if (stale())
              return staleAfterCommit(
                entry,
                priorValue,
                command.type === "delete" ? "delete" : "change",
                priorVersion,
              );
            try {
              await entry.handle?.release();
              entry.handle = undefined;
            } catch {
              entry.value = {
                ...priorValue,
                state: "blocked",
                blockedReason:
                  "Prior Monitor source close outcome is unresolved.",
              };
              await reconcile();
              await rollbackPersisted(
                entry,
                priorValue,
                command.requestId,
                command.type === "delete" ? "delete" : "change",
                priorVersion,
              );
              return monitorFailure(
                "source_failed",
                "Monitor source could not close.",
                true,
              );
            }
            if (stale())
              return staleAfterCommit(
                entry,
                priorValue,
                command.type === "delete" ? "delete" : "change",
                priorVersion,
              );
            if (command.type === "delete") {
              const deleted = structuredClone(entry.value);
              monitors.delete(command.id);
              const receipt = { monitor: deleted, replayed: false };
              rememberReceipt(command.requestId, digest, receipt);
              return success(receipt);
            }
          } else {
            if (
              entry.value.state !== "paused" &&
              entry.value.state !== "blocked"
            )
              return monitorFailure(
                "invalid_request",
                "Only a paused or blocked Monitor can resume.",
              );
            const priorValue = structuredClone(entry.value);
            const { blockedReason: _blockedReason, ...current } = entry.value;
            const candidate: MonitorSnapshot = {
              ...current,
              revision: entry.value.revision + 1,
              state: "active",
            };
            const authority = await options.authority.authorize({
              definition: candidate,
              phase: "resume",
              projectId: options.binding.projectId,
              cwd: options.binding.cwd,
            });
            if (closed || acceptedGeneration !== registryGeneration)
              return monitorFailure("closed", "MonitorRegistry is closed.");
            if (!authorityAllowed(authority))
              return monitorFailure(
                "authority_denied",
                "Monitor authority was denied.",
              );
            const persisted = await persist(
              entry,
              candidate,
              command.requestId,
              digest,
              priorVersion,
            );
            if (!persisted.ok) return persisted;
            if (closed || acceptedGeneration !== registryGeneration) {
              await rollbackPersisted(
                entry,
                priorValue,
                command.requestId,
                "change",
                priorVersion,
              );
              return monitorFailure("closed", "MonitorRegistry is closed.");
            }
            entry.value = candidate;
            const reconciled = await reconcile();
            if (!reconciled.ok) {
              entry.value = priorValue;
              await reconcile();
              const rolledBack = await rollbackPersisted(
                entry,
                priorValue,
                command.requestId,
                "change",
                priorVersion,
              );
              return rolledBack
                ? monitorFailure(
                    "source_failed",
                    "Monitor trigger binding failed.",
                    true,
                  )
                : monitorFailure(
                    "storage_failed",
                    "Monitor runtime failed and durable rollback was incomplete.",
                  );
            }
            if (stale())
              return staleAfterCommit(
                entry,
                priorValue,
                "change",
                priorVersion,
              );
            const started = await start(entry);
            if (!started.ok) {
              const restored = await restoreRuntime(entry, priorValue);
              const rolledBack = await rollbackPersisted(
                entry,
                priorValue,
                command.requestId,
                "change",
                priorVersion,
              );
              return restored && rolledBack
                ? started
                : monitorFailure(
                    "storage_failed",
                    "Monitor source failed and recovery was incomplete.",
                  );
            }
            if (stale())
              return staleAfterCommit(
                entry,
                priorValue,
                "change",
                priorVersion,
              );
          }
          const receipt = {
            monitor: structuredClone(entry.value),
            replayed: false,
          };
          rememberReceipt(command.requestId, digest, receipt);
          return success(receipt);
        }
        if (command.expectedRevision !== 0)
          return monitorFailure(
            "revision_conflict",
            "Create requires expected revision zero.",
          );
        if (monitors.has(command.id))
          return monitorFailure("already_exists", "Monitor already exists.");
        if (monitors.size >= maxActive)
          return monitorFailure(
            "capacity_exceeded",
            "Monitor capacity is reached.",
          );
        if (
          (command.source.kind === "poll" ||
            command.source.kind === "websocket") &&
          [...monitors.values()].filter(
            ({ value }) =>
              value.source.kind === "poll" || value.source.kind === "websocket",
          ).length >= maxRemote
        )
          return monitorFailure(
            "capacity_exceeded",
            "Remote Monitor capacity is reached.",
          );
        if (
          !validDefinition(
            command,
            pollMinimumMs,
            configuration.allowedWebSocketOrigins,
          )
        )
          return monitorFailure(
            "invalid_request",
            "Monitor definition is invalid.",
          );
        if (command.scope === "durable" && !options.state)
          return monitorFailure(
            "storage_failed",
            "Durable Monitor storage is unavailable.",
          );
        const value: MonitorSnapshot = {
          id: command.id,
          revision: 1,
          scope: command.scope,
          state: "active",
          source: structuredClone(command.source),
          ...(command.matcher
            ? { matcher: structuredClone(command.matcher) }
            : {}),
          delivery: structuredClone(command.delivery),
          deliveries: 0,
          dropped: 0,
          unresolved: 0,
        };
        const authority = await options.authority.authorize({
          definition: value,
          phase: "create",
          projectId: options.binding.projectId,
          cwd: options.binding.cwd,
        });
        if (closed || acceptedGeneration !== registryGeneration)
          return monitorFailure("closed", "MonitorRegistry is closed.");
        if (!authorityAllowed(authority))
          return monitorFailure(
            "authority_denied",
            "Monitor authority was denied.",
          );
        const entry: ActiveMonitor = { value, fence: 0, callbacks: new Set() };
        const persisted = await persist(
          entry,
          value,
          command.requestId,
          digest,
          null,
        );
        if (!persisted.ok) return persisted;
        if (closed || acceptedGeneration !== registryGeneration) {
          await rollbackPersisted(
            entry,
            undefined,
            command.requestId,
            "change",
            null,
          );
          return monitorFailure("closed", "MonitorRegistry is closed.");
        }
        monitors.set(command.id, entry);
        const reconciled = await reconcile();
        if (!reconciled.ok) {
          monitors.delete(command.id);
          const rolledBack = await rollbackPersisted(
            entry,
            undefined,
            command.requestId,
            "change",
            null,
          );
          return rolledBack
            ? monitorFailure(
                "source_failed",
                "Monitor trigger binding failed.",
                true,
              )
            : monitorFailure(
                "storage_failed",
                "Monitor runtime failed and durable rollback was incomplete.",
              );
        }
        if (stale()) return staleAfterCommit(entry, undefined, "change", null);
        const started = await start(entry);
        if (!started.ok) {
          entry.fence += 1;
          await entry.handle?.release().catch(() => undefined);
          monitors.delete(command.id);
          await reconcile();
          const rolledBack = await rollbackPersisted(
            entry,
            undefined,
            command.requestId,
            "change",
            null,
          );
          return rolledBack
            ? started
            : monitorFailure(
                "storage_failed",
                "Monitor source failed and durable rollback was incomplete.",
              );
        }
        if (stale()) return staleAfterCommit(entry, undefined, "change", null);
        const receipt = { monitor: structuredClone(value), replayed: false };
        rememberReceipt(command.requestId, digest, receipt);
        return success(receipt);
      });
    },
    async inspect(
      input: {
        id?: string;
        state?: MonitorSnapshot["state"];
        afterId?: string;
        limit?: number;
      } = {},
    ) {
      if (closed) return monitorFailure("closed", "MonitorRegistry is closed.");
      if (
        !isPlainData(input, { maxDepth: 2, maxNodes: 8 }) ||
        !hasExactKeys(input as Record<string, unknown>, [
          "id",
          "state",
          "afterId",
          "limit",
        ])
      )
        return monitorFailure(
          "invalid_request",
          "Inspection query is invalid.",
        );
      const query = structuredClone(input);
      const limit = query.limit ?? maxInspection;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > maxInspection ||
        (query.state !== undefined &&
          !["active", "paused", "stopped", "blocked", "deleted"].includes(
            query.state,
          )) ||
        (query.id !== undefined && !IDENTIFIER.test(query.id)) ||
        (query.afterId !== undefined && !IDENTIFIER.test(query.afterId))
      )
        return monitorFailure(
          "invalid_request",
          "Inspection query is invalid.",
        );
      let selected = [...monitors.values()]
        .map(({ value }) => structuredClone(value))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (query.id) selected = selected.filter(({ id }) => id === query.id);
      if (query.state)
        selected = selected.filter(({ state }) => state === query.state);
      if (query.afterId)
        selected = selected.filter(({ id }) => id > query.afterId!);
      const page = selected.slice(0, limit);
      return success({
        monitors: page,
        closed: false,
        ...(selected.length > page.length && page.at(-1)
          ? { nextCursor: page.at(-1)!.id }
          : {}),
      });
    },
  } satisfies import("./model.ts").MonitorRegistry;

  return success({
    registry,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      registryGeneration += 1;
      mutationController.abort(new Error("MonitorRegistry closed."));
      const lane = mutationTail;
      const entries = [...monitors.values()];
      for (const entry of entries) entry.fence += 1;
      monitors.clear();
      closePromise = (async () => {
        await deadline(lane, closeDrainMs);
        await reconcile();
        const releases = entries.map(async (entry) => {
          await entry.handle?.release();
          entry.handle = undefined;
          await quiesce(entry);
        });
        await deadline(Promise.allSettled(releases), closeDrainMs);
        const unresolvedSources = entries.filter(
          (entry) => entry.handle !== undefined,
        ).length;
        const unresolvedCallbacks = entries.reduce(
          (total, entry) => total + entry.callbacks.size,
          0,
        );
        return {
          dropped: entries.reduce(
            (total, entry) =>
              total +
              entry.value.dropped +
              Math.max(0, entry.callbacks.size - entry.value.unresolved),
            0,
          ),
          unresolvedCallbacks,
          unresolvedSources,
        };
      })();
      return closePromise;
    },
  });
}
