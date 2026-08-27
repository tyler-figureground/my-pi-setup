import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ExecutionRole } from "../../../shared/execution-role.ts";
import type {
  ArtifactMetadata,
  ArtifactStore,
  StoredArtifact,
} from "../core/artifacts/index.ts";
import type { LifecycleSupervisor } from "../core/lifecycle/supervisor.ts";
import type { StateRecord, StateStore } from "../core/persistence/index.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import {
  failure,
  success,
  type JsonObject,
  type ModuleError,
  type Outcome,
} from "../core/result.ts";

const PRESENCE_COLLECTION = "session-broker.presence";
const MESSAGE_COLLECTION = "session-broker.messages";
const REQUEST_COLLECTION = "session-broker.requests";
const MAILBOX_COLLECTION = "session-broker.mailboxes";
const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DURABLE_RECEIPT_BYTES = 2 * 1024;
const CLOSE_DRAIN_TIMEOUT_MS = 250;
const MAX_DELIVERY_OPTIONS_BYTES = 16 * 1024;
const MAX_DELIVERY_OPTIONS_DEPTH = 16;
const MAX_DELIVERY_OPTIONS_NODES = 1_024;
const MAX_OUTBOUND_SCAN_RECORDS = 10_000;
const REDACTED = "[REDACTED]";
const secretField =
  /^(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token)$/i;
const secretAssignment =
  /(\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi;
const bearerSecret = /(\bbearer\s+)[a-z0-9._~+\-/]+=*/gi;
const knownSecret =
  /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/gi;
const privateKey =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi;
const proofSecrets = new WeakMap<object, Uint8Array>();

declare const hostSessionProofBrand: unique symbol;

export interface HostSessionProof {
  readonly [hostSessionProofBrand]: "HostSessionProof";
}

export interface SessionExposure {
  readonly discoverableBy: "none" | "same-project" | "local-user";
  readonly acceptsFrom: "none" | "same-project" | "local-user";
}

export interface HostSessionBinding {
  readonly piSessionId: string;
  readonly proof: HostSessionProof;
  readonly executionRole: ExecutionRole;
  readonly project: ResolvedProjectIdentity;
  readonly cwd: string;
  readonly exposure: SessionExposure;
}

export interface SessionCapabilityDescriptor {
  readonly id: string;
  readonly version: number;
  readonly parameters?: JsonObject;
}

export interface SessionRuntimeSnapshot {
  readonly name?: string;
  readonly status: "idle" | "running" | "waiting" | "stopping";
  readonly capabilities: readonly SessionCapabilityDescriptor[];
}

export interface DeliveryDirective {
  readonly mode: string;
  readonly version: number;
  readonly options?: JsonObject;
}

export interface SessionAddress {
  readonly piSessionId: string;
  readonly expectedIncarnation?: string;
}

export interface SessionSummary {
  readonly address: SessionAddress;
  readonly incarnation: string;
  readonly executionRole: ExecutionRole;
  readonly projectId: string;
  readonly cwd: string;
  readonly name?: string;
  readonly status: SessionRuntimeSnapshot["status"] | "offline";
  readonly capabilities: readonly SessionCapabilityDescriptor[];
  readonly lastHeartbeatAt: number;
  readonly visibleBecause: "same-project" | "local-user";
}

export interface MessageEnvelope {
  readonly id: string;
  readonly mailboxPosition: number;
  readonly sender: {
    readonly piSessionId: string;
    readonly incarnation: string;
    readonly executionRole: ExecutionRole;
    readonly projectId: string;
    readonly name?: string;
  };
  readonly recipient: { readonly piSessionId: string };
  readonly sentAt: number;
  readonly summary: string;
  readonly body: ArtifactMetadata;
  readonly delivery: DeliveryDirective;
  readonly trust: "untrusted";
  readonly authority: "none";
}

export interface SendMessageRequest {
  readonly requestId: string;
  readonly recipients: readonly SessionAddress[];
  readonly summary: string;
  readonly body:
    | {
        readonly kind: "text";
        readonly text: string;
        readonly mediaType?: string;
      }
    | {
        readonly kind: "bytes";
        readonly bytes: Uint8Array;
        readonly mediaType: string;
      };
  readonly delivery?: DeliveryDirective;
}

export interface SendMessageReceipt {
  readonly requestId: string;
  readonly body: ArtifactMetadata;
  readonly deliveries: readonly {
    readonly recipient: SessionAddress;
    readonly messageId: string;
    readonly mailboxPosition: number;
    readonly state: "queued" | "delivered";
  }[];
  readonly replayed: boolean;
}

export interface MessageQuery {
  readonly direction?: "inbound" | "outbound";
  readonly afterPosition?: number;
  readonly limit?: number;
  readonly state?: "queued" | "claimed" | "delivered" | "failed" | "expired";
}

export interface MessageSummary {
  readonly envelope: MessageEnvelope;
  readonly state: "queued" | "claimed" | "delivered" | "failed" | "expired";
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly lastErrorCode?: string;
}

export type SessionBrokerErrorCode =
  | "invalid_request"
  | "identity_held"
  | "identity_lost"
  | "recipient_not_found"
  | "recipient_incarnation_changed"
  | "recipient_hidden"
  | "capability_unavailable"
  | "cross_project_denied"
  | "message_too_large"
  | "mailbox_full"
  | "artifact_failed"
  | "storage_failed"
  | "delivery_failed"
  | "cancelled"
  | "shutting_down";

export type SessionBrokerError = ModuleError<SessionBrokerErrorCode>;
export type SessionBrokerResult<T> = Outcome<T, SessionBrokerError>;

export interface SessionBroker {
  discover(input?: {
    readonly project?: "current" | "all-visible";
    readonly status?: "online" | "all";
    readonly capability?: string;
    readonly limit?: number;
  }): Promise<SessionBrokerResult<readonly SessionSummary[]>>;
  send(
    request: SendMessageRequest,
    signal?: AbortSignal,
  ): Promise<SessionBrokerResult<SendMessageReceipt>>;
  messages(
    query?: MessageQuery,
  ): Promise<SessionBrokerResult<readonly MessageSummary[]>>;
  close(
    reason: "quit" | "reload" | "new" | "resume" | "fork",
  ): Promise<SessionBrokerResult<void>>;
}

/** @internal Delivery boundary shared with host adapters. */
export interface RuntimeDelivery {
  readonly envelope: MessageEnvelope;
  readonly renderedContent: string;
}

/** @internal Delivery boundary shared with host adapters. */
export interface DeliveryReceipt {
  readonly state: "accepted" | "already-present";
  readonly durableReceipt: string;
}

/** @internal Delivery boundary shared with host adapters. */
export type SessionDeliveryError = ModuleError<
  | "unsupported_mode"
  | "temporarily_unavailable"
  | "permanently_unavailable"
  | "cancelled"
>;

/** @internal Delivery boundary shared with host adapters. */
export interface SessionDeliveryAdapter {
  snapshot(): SessionRuntimeSnapshot;
  subscribe(listener: (snapshot: SessionRuntimeSnapshot) => void): () => void;
  deliverOnce(
    delivery: RuntimeDelivery,
    signal?: AbortSignal,
  ): Promise<Outcome<DeliveryReceipt, SessionDeliveryError>>;
}

export interface SessionBrokerModule {
  attach(
    binding: HostSessionBinding,
    delivery: SessionDeliveryAdapter,
  ): Promise<SessionBrokerResult<SessionBroker>>;
}

export interface SessionBrokerLimits {
  readonly maxRecipients: number;
  readonly maxSummaryBytes: number;
  readonly maxBodyBytes: number;
  readonly maxInlineBodyBytes: number;
  readonly maxPendingPerRecipient: number;
  readonly maxQueryLimit: number;
  readonly heartbeatMs: number;
  readonly sessionTtlMs: number;
  readonly deliveryClaimTtlMs: number;
  readonly maxDeliveryAttempts: number;
}

export interface SessionBrokerModuleOptions {
  readonly state: StateStore;
  readonly artifacts: ArtifactStore;
  readonly lifecycle: LifecycleSupervisor;
  readonly clock?: () => number;
  readonly id?: () => string;
  readonly limits?: Partial<SessionBrokerLimits>;
}

const DEFAULT_LIMITS: SessionBrokerLimits = Object.freeze({
  maxRecipients: 32,
  maxSummaryBytes: 512,
  maxBodyBytes: 1024 * 1024,
  maxInlineBodyBytes: 32 * 1024,
  maxPendingPerRecipient: 1_000,
  maxQueryLimit: 100,
  heartbeatMs: 5_000,
  sessionTtlMs: 20_000,
  deliveryClaimTtlMs: 10_000,
  maxDeliveryAttempts: 5,
});

interface PresenceRecord {
  readonly incarnation: string;
  readonly proofVerifier: string;
  readonly executionRole: ExecutionRole;
  readonly projectId: string;
  readonly cwd: string;
  readonly exposure: SessionExposure;
  readonly snapshot: SessionRuntimeSnapshot;
  readonly lastHeartbeatAt: number;
  readonly online: boolean;
}

interface PersistedMessage {
  readonly envelope: Omit<MessageEnvelope, "mailboxPosition">;
  readonly recipientProjectId: string;
  readonly state: MessageSummary["state"];
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly lastErrorCode?: string;
  readonly durableReceipt?: string;
}

interface PersistedRequest {
  readonly fingerprint: string;
  readonly body: ArtifactMetadata;
  readonly deliveries: readonly {
    readonly recipient: SessionAddress;
    readonly messageId: string;
  }[];
}

interface PersistedMailbox {
  readonly pending: number;
}

function brokerFailure(
  code: SessionBrokerErrorCode,
  message: string,
  retryable = false,
  details?: JsonObject,
) {
  return failure({
    code,
    message,
    retryable,
    ...(details === undefined ? {} : { details }),
  });
}

function leaseResource(piSessionId: string) {
  return `session-broker.session:${piSessionId}`;
}

function presenceMetadata(presence: PresenceRecord): JsonObject {
  return JSON.parse(JSON.stringify(presence)) as JsonObject;
}

function messageMetadata(message: PersistedMessage): JsonObject {
  return JSON.parse(JSON.stringify(message)) as JsonObject;
}

function requestMetadata(request: PersistedRequest): JsonObject {
  return JSON.parse(JSON.stringify(request)) as JsonObject;
}

function mailboxMetadata(mailbox: PersistedMailbox): JsonObject {
  return JSON.parse(JSON.stringify(mailbox)) as JsonObject;
}

function parsePresence(record: StateRecord) {
  return record.metadata as unknown as PresenceRecord;
}

function parseMessage(record: StateRecord) {
  return record.metadata as unknown as PersistedMessage;
}

function parseRequest(record: StateRecord) {
  return record.metadata as unknown as PersistedRequest;
}

function parseMailbox(record: StateRecord) {
  return record.metadata as unknown as PersistedMailbox;
}

function mailboxStream(piSessionId: string) {
  return `session-broker.mailbox:${piSessionId}`;
}

function deliveryLeaseResource(piSessionId: string, position: number) {
  return `session-broker.delivery:${piSessionId}:${position}`;
}

function capUtf8(value: string, maxBytes: number, suffix: string) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes >= maxBytes) {
    return Buffer.from(suffix).subarray(0, maxBytes).toString("utf8");
  }
  const available = maxBytes - suffixBytes;
  let prefix = Buffer.from(value).subarray(0, available).toString("utf8");
  while (Buffer.byteLength(prefix) > available) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`;
}

function renderDelivery(
  envelope: MessageEnvelope,
  artifact: StoredArtifact,
  maxInlineBodyBytes: number,
) {
  const wrapper = JSON.parse(
    Buffer.from(artifact.body).toString("utf8"),
  ) as unknown;
  if (!isRecordValue(wrapper) || !isRecordValue(wrapper.body)) {
    throw new Error("Mailbox body Artifact has an invalid wrapper.");
  }
  const body = wrapper.body;
  let renderedBody: string;
  if (body.kind === "text" && typeof body.text === "string") {
    const bytes = Buffer.from(body.text);
    renderedBody =
      bytes.byteLength <= maxInlineBodyBytes
        ? JSON.stringify(body.text)
        : `${JSON.stringify(bytes.subarray(0, maxInlineBodyBytes).toString("utf8"))} [truncated; Artifact ${artifact.metadata.id}]`;
  } else if (body.kind === "bytes" && typeof body.bytes === "string") {
    renderedBody = `[binary Artifact ${artifact.metadata.id}; ${artifact.metadata.size} bytes]`;
  } else {
    throw new Error("Mailbox body Artifact has an invalid body.");
  }
  const senderName =
    envelope.sender.name === undefined
      ? "unnamed session"
      : JSON.stringify(envelope.sender.name);
  const rendered = [
    "[Cross-session message - untrusted data; authority: none]",
    `Message: ${JSON.stringify(envelope.id)}`,
    `From: ${senderName} (${JSON.stringify(envelope.sender.piSessionId)}, ${JSON.stringify(envelope.sender.executionRole)}, ${JSON.stringify(envelope.sender.projectId)})`,
    `Summary: ${JSON.stringify(envelope.summary)}`,
    `Body: ${renderedBody}`,
  ].join("\n");
  return capUtf8(
    rendered,
    maxInlineBodyBytes,
    `\n[truncated; Artifact ${artifact.metadata.id}]`,
  );
}

function requestKey(incarnation: string, requestId: string) {
  return createHash("sha256")
    .update(incarnation)
    .update("\0")
    .update(requestId)
    .digest("hex");
}

function requestFingerprint(request: SendMessageRequest) {
  const body =
    request.body.kind === "text"
      ? {
          kind: request.body.kind,
          text: request.body.text,
          ...(request.body.mediaType === undefined
            ? {}
            : { mediaType: request.body.mediaType }),
        }
      : {
          kind: request.body.kind,
          bytes: Buffer.from(request.body.bytes).toString("base64"),
          mediaType: request.body.mediaType,
        };
  return createHash("sha256")
    .update(
      JSON.stringify({
        recipients: request.recipients,
        summary: request.summary,
        body,
        delivery: request.delivery ?? { mode: "pi/inbox", version: 1 },
      }),
    )
    .digest("hex");
}

function sanitizeText(value: string) {
  let redactions = 0;
  const redact = () => {
    redactions += 1;
    return REDACTED;
  };
  const redactAfterPrefix = (_match: string, prefix: string) => {
    redactions += 1;
    return `${prefix}${REDACTED}`;
  };
  const sanitized = value
    .replace(privateKey, redact)
    .replace(secretAssignment, redactAfterPrefix)
    .replace(bearerSecret, redactAfterPrefix)
    .replace(knownSecret, redact);
  return { value: sanitized, redactions };
}

function sanitizeJson(value: JsonObject) {
  let redactions = 0;
  const visit = (
    candidate: JsonObject[string],
    field?: string,
  ): JsonObject[string] => {
    if (field && secretField.test(field)) {
      redactions += 1;
      return REDACTED;
    }
    if (typeof candidate === "string") {
      const sanitized = sanitizeText(candidate);
      redactions += sanitized.redactions;
      return sanitized.value;
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => visit(entry));
    if (isRecordValue(candidate)) {
      return Object.fromEntries(
        Object.entries(candidate).map(([key, entry]) => [
          key,
          visit(entry, key),
        ]),
      );
    }
    return candidate;
  };
  return { value: visit(value) as JsonObject, redactions };
}

function sanitizeSendRequest(request: SendMessageRequest) {
  const summary = sanitizeText(request.summary);
  const body =
    request.body.kind === "text" ? sanitizeText(request.body.text) : undefined;
  const options = request.delivery?.options
    ? sanitizeJson(request.delivery.options)
    : undefined;
  return {
    request: {
      ...request,
      summary: summary.value,
      body:
        request.body.kind === "text"
          ? { ...request.body, text: body!.value }
          : request.body,
      ...(request.delivery
        ? {
            delivery: {
              ...request.delivery,
              ...(options ? { options: options.value } : {}),
            },
          }
        : {}),
    },
    redactions:
      summary.redactions + (body?.redactions ?? 0) + (options?.redactions ?? 0),
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isValidDeliveryReceipt(value: unknown): value is DeliveryReceipt {
  return (
    isRecordValue(value) &&
    hasOnlyKeys(value, ["state", "durableReceipt"]) &&
    (value.state === "accepted" || value.state === "already-present") &&
    typeof value.durableReceipt === "string" &&
    value.durableReceipt.length > 0 &&
    Buffer.byteLength(value.durableReceipt) <= MAX_DURABLE_RECEIPT_BYTES &&
    !value.durableReceipt.includes("\0")
  );
}

function isBoundedJsonValue(value: unknown) {
  let bytes = 0;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (
      nodes > MAX_DELIVERY_OPTIONS_NODES ||
      depth > MAX_DELIVERY_OPTIONS_DEPTH
    ) {
      return false;
    }
    if (candidate === null || typeof candidate === "boolean") return true;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (typeof candidate === "string") {
      bytes += Buffer.byteLength(candidate);
      return bytes <= MAX_DELIVERY_OPTIONS_BYTES;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length) return false;
      return candidate.every((entry) => visit(entry, depth + 1));
    }
    if (!isRecordValue(candidate)) return false;
    for (const [key, entry] of Object.entries(candidate)) {
      bytes += Buffer.byteLength(key);
      if (bytes > MAX_DELIVERY_OPTIONS_BYTES || !visit(entry, depth + 1)) {
        return false;
      }
    }
    return true;
  };
  return visit(value, 0);
}

function validateSendRequest(request: unknown, limits: SessionBrokerLimits) {
  if (
    !isRecordValue(request) ||
    !hasOnlyKeys(request, [
      "requestId",
      "recipients",
      "summary",
      "body",
      "delivery",
    ]) ||
    typeof request.requestId !== "string" ||
    request.requestId.length === 0 ||
    Buffer.byteLength(request.requestId) > 256 ||
    typeof request.summary !== "string" ||
    request.summary.length === 0 ||
    !Array.isArray(request.recipients) ||
    request.recipients.length === 0 ||
    request.recipients.length > limits.maxRecipients
  ) {
    return brokerFailure("invalid_request", "Message request is invalid.");
  }
  if (Buffer.byteLength(request.summary) > limits.maxSummaryBytes) {
    return brokerFailure(
      "message_too_large",
      "Message summary exceeds the configured byte limit.",
    );
  }

  const recipientIds = new Set<string>();
  for (const candidate of request.recipients) {
    if (
      !isRecordValue(candidate) ||
      !hasOnlyKeys(candidate, ["piSessionId", "expectedIncarnation"]) ||
      typeof candidate.piSessionId !== "string" ||
      candidate.piSessionId.length === 0 ||
      Buffer.byteLength(candidate.piSessionId) > 512 ||
      (candidate.expectedIncarnation !== undefined &&
        (typeof candidate.expectedIncarnation !== "string" ||
          candidate.expectedIncarnation.length === 0)) ||
      recipientIds.has(candidate.piSessionId)
    ) {
      return brokerFailure(
        "invalid_request",
        "Message recipients must be unique explicit session addresses.",
      );
    }
    recipientIds.add(candidate.piSessionId);
  }

  if (!isRecordValue(request.body)) {
    return brokerFailure("invalid_request", "Message body is invalid.");
  }
  let bodyBytes: number;
  if (request.body.kind === "text") {
    if (
      !hasOnlyKeys(request.body, ["kind", "text", "mediaType"]) ||
      typeof request.body.text !== "string" ||
      (request.body.mediaType !== undefined &&
        (typeof request.body.mediaType !== "string" ||
          request.body.mediaType.length === 0 ||
          Buffer.byteLength(request.body.mediaType) > 256))
    ) {
      return brokerFailure("invalid_request", "Text message body is invalid.");
    }
    bodyBytes = Buffer.byteLength(request.body.text);
  } else if (request.body.kind === "bytes") {
    if (
      !hasOnlyKeys(request.body, ["kind", "bytes", "mediaType"]) ||
      !(request.body.bytes instanceof Uint8Array) ||
      typeof request.body.mediaType !== "string" ||
      request.body.mediaType.length === 0 ||
      Buffer.byteLength(request.body.mediaType) > 256
    ) {
      return brokerFailure(
        "invalid_request",
        "Binary message body is invalid.",
      );
    }
    bodyBytes = request.body.bytes.byteLength;
  } else {
    return brokerFailure("invalid_request", "Message body kind is invalid.");
  }
  if (bodyBytes > limits.maxBodyBytes) {
    return brokerFailure(
      "message_too_large",
      "Message body exceeds the configured byte limit.",
    );
  }

  if (request.delivery !== undefined) {
    if (
      !isRecordValue(request.delivery) ||
      !hasOnlyKeys(request.delivery, ["mode", "version", "options"]) ||
      !["pi/inbox", "pi/follow-up", "pi/steer", "pi/when-idle"].includes(
        String(request.delivery.mode),
      ) ||
      request.delivery.version !== 1 ||
      (request.delivery.options !== undefined &&
        (!isRecordValue(request.delivery.options) ||
          !isBoundedJsonValue(request.delivery.options)))
    ) {
      return brokerFailure(
        "invalid_request",
        "Message delivery directive is invalid.",
      );
    }
  }
  return success(undefined);
}

function snapshotSendRequest(request: SendMessageRequest): SendMessageRequest {
  return {
    requestId: request.requestId,
    recipients: request.recipients.map((recipient) => ({
      piSessionId: recipient.piSessionId,
      ...(recipient.expectedIncarnation === undefined
        ? {}
        : { expectedIncarnation: recipient.expectedIncarnation }),
    })),
    summary: request.summary,
    body:
      request.body.kind === "text"
        ? {
            kind: "text",
            text: request.body.text,
            ...(request.body.mediaType === undefined
              ? {}
              : { mediaType: request.body.mediaType }),
          }
        : {
            kind: "bytes",
            bytes: request.body.bytes.slice(),
            mediaType: request.body.mediaType,
          },
    ...(request.delivery === undefined
      ? {}
      : {
          delivery: {
            mode: request.delivery.mode,
            version: request.delivery.version,
            ...(request.delivery.options === undefined
              ? {}
              : { options: structuredClone(request.delivery.options) }),
          },
        }),
  };
}

function snapshotHostSessionBinding(
  binding: HostSessionBinding,
): HostSessionBinding {
  return {
    piSessionId: binding.piSessionId,
    proof: binding.proof,
    executionRole: binding.executionRole,
    project: structuredClone(binding.project),
    cwd: binding.cwd,
    exposure: { ...binding.exposure },
  };
}

function snapshotRuntimeSnapshot(snapshot: SessionRuntimeSnapshot) {
  return {
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    status: snapshot.status,
    capabilities: snapshot.capabilities.map((capability) => ({
      id: capability.id,
      version: capability.version,
      ...(capability.parameters === undefined
        ? {}
        : { parameters: structuredClone(capability.parameters) }),
    })),
  };
}

async function record(state: StateStore, collection: string, key: string) {
  const queried = await state.query({ type: "record", collection, key });
  if (!queried.ok) return queried;
  if (queried.value.type !== "record") {
    return failure({
      code: "STORAGE_FAILED" as const,
      message: "StateStore returned an unexpected query result.",
      retryable: false,
    });
  }
  return success(queried.value.record);
}

async function findMailboxEvent(
  state: StateStore,
  piSessionId: string,
  messageId: string,
) {
  let afterPosition = 0;
  while (true) {
    const queried = await state.query({
      type: "events",
      stream: mailboxStream(piSessionId),
      afterPosition,
      limit: 100,
    });
    if (!queried.ok) return queried;
    if (queried.value.type !== "events") {
      return failure({
        code: "STORAGE_FAILED" as const,
        message: "StateStore returned an unexpected query result.",
        retryable: false,
      });
    }
    const found = queried.value.events.find(
      ({ eventId }) => eventId === messageId,
    );
    if (found) return success(found);
    const last = queried.value.events.at(-1);
    if (!last || queried.value.events.length < 100) return success(null);
    afterPosition = last.position;
  }
}

async function settleWithin(
  promise: Promise<unknown> | undefined,
  timeoutMs: number,
) {
  if (!promise) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export function issueHostSessionProof(): HostSessionProof {
  const proof = Object.freeze({}) as HostSessionProof;
  proofSecrets.set(proof, randomBytes(32));
  return proof;
}

export function createSessionBrokerModule(
  options: SessionBrokerModuleOptions,
): SessionBrokerModule {
  const clock = options.clock ?? Date.now;
  const id = options.id ?? randomUUID;
  const configuredLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const limits: SessionBrokerLimits = {
    ...configuredLimits,
    maxRecipients: Math.min(32, configuredLimits.maxRecipients),
    maxSummaryBytes: Math.min(512, configuredLimits.maxSummaryBytes),
    maxBodyBytes: Math.min(1024 * 1024, configuredLimits.maxBodyBytes),
    maxInlineBodyBytes: Math.min(
      32 * 1024,
      configuredLimits.maxInlineBodyBytes,
    ),
    maxPendingPerRecipient: Math.min(
      1_000,
      configuredLimits.maxPendingPerRecipient,
    ),
    maxQueryLimit: Math.min(100, configuredLimits.maxQueryLimit),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  const attachedPumps = new Map<string, () => void>();

  return {
    async attach(binding, delivery) {
      binding = snapshotHostSessionBinding(binding);
      const secret =
        typeof binding.proof === "object" && binding.proof !== null
          ? proofSecrets.get(binding.proof)
          : undefined;
      if (!secret || !binding.piSessionId || !binding.project.projectId) {
        return brokerFailure(
          "invalid_request",
          "Host session binding is invalid.",
        );
      }
      if (binding.executionRole !== "parent") {
        return brokerFailure(
          "invalid_request",
          "Only Parent sessions may own a SessionBroker.",
        );
      }

      const proofVerifier = createHash("sha256").update(secret).digest("hex");
      const incarnation = createHash("sha256")
        .update(secret)
        .update(id())
        .digest("hex");
      const owner = proofVerifier;
      const snapshot = snapshotRuntimeSnapshot(delivery.snapshot());
      const presence: PresenceRecord = {
        incarnation,
        proofVerifier,
        executionRole: binding.executionRole,
        projectId: binding.project.projectId,
        cwd: binding.cwd,
        exposure: binding.exposure,
        snapshot,
        lastHeartbeatAt: clock(),
        online: true,
      };
      const prior = await record(
        options.state,
        PRESENCE_COLLECTION,
        binding.piSessionId,
      );
      if (!prior.ok) {
        return brokerFailure(
          "storage_failed",
          prior.error.message,
          prior.error.retryable,
        );
      }
      const registered = await options.state.transact({
        transactionId: `session-broker.attach:${id()}`,
        operations: [
          {
            type: "claim-lease",
            resource: leaseResource(binding.piSessionId),
            owner,
            ttlMs: limits.sessionTtlMs,
            metadata: { incarnation },
          },
          {
            type: "put-record",
            collection: PRESENCE_COLLECTION,
            key: binding.piSessionId,
            metadata: presenceMetadata(presence),
            expectedVersion: prior.value?.version ?? null,
          },
        ],
      });
      if (!registered.ok) {
        if (registered.error.code === "LEASE_HELD") {
          return brokerFailure(
            "identity_held",
            "Logical session is owned by another live incarnation.",
            true,
          );
        }
        return brokerFailure(
          "storage_failed",
          registered.error.message,
          registered.error.retryable,
        );
      }
      const fence = registered.value.leases[0]?.fence;
      if (fence === undefined) {
        return brokerFailure(
          "storage_failed",
          "Session lease registration returned no fence.",
        );
      }

      let closed = false;
      let identityLost = false;
      let closeResult: Promise<SessionBrokerResult<void>> | undefined;
      let unsubscribe = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let refreshes = Promise.resolve();
      const activeSends = new Map<string, Promise<void>>();

      const verifyIdentity = async () => {
        const queried = await options.state.query({
          type: "lease",
          resource: leaseResource(binding.piSessionId),
        });
        if (!queried.ok) {
          return brokerFailure(
            "storage_failed",
            queried.error.message,
            queried.error.retryable,
          );
        }
        if (
          identityLost ||
          queried.value.type !== "lease" ||
          queried.value.lease?.owner !== owner ||
          queried.value.lease.fence !== fence ||
          queried.value.lease.expiresAt <= clock()
        ) {
          return brokerFailure(
            "identity_lost",
            "Session ownership fence is no longer current.",
          );
        }
        return success(undefined);
      };

      const refreshPresence = async (nextSnapshot: SessionRuntimeSnapshot) => {
        if (closed || identityLost) return;
        const current = await record(
          options.state,
          PRESENCE_COLLECTION,
          binding.piSessionId,
        );
        if (
          !current.ok ||
          !current.value ||
          parsePresence(current.value).incarnation !== incarnation
        ) {
          identityLost = true;
          return;
        }
        const next: PresenceRecord = {
          ...parsePresence(current.value),
          snapshot: nextSnapshot,
          lastHeartbeatAt: clock(),
          online: true,
        };
        const refreshed = await options.state.transact({
          transactionId: `session-broker.heartbeat:${incarnation}:${id()}`,
          operations: [
            {
              type: "renew-lease",
              resource: leaseResource(binding.piSessionId),
              owner,
              fence,
              ttlMs: limits.sessionTtlMs,
              metadata: { incarnation },
            },
            {
              type: "put-record",
              collection: PRESENCE_COLLECTION,
              key: binding.piSessionId,
              metadata: presenceMetadata(next),
              expectedVersion: current.value.version,
            },
          ],
        });
        if (!refreshed.ok && refreshed.error.code === "LEASE_LOST") {
          identityLost = true;
        }
      };

      const queuePresenceRefresh = (nextSnapshot: SessionRuntimeSnapshot) => {
        const ownedSnapshot = snapshotRuntimeSnapshot(nextSnapshot);
        refreshes = refreshes.then(() => refreshPresence(ownedSnapshot));
      };

      const resolveRecipient = async (address: SessionAddress) => {
        const found = await record(
          options.state,
          PRESENCE_COLLECTION,
          address.piSessionId,
        );
        if (!found.ok) {
          return brokerFailure(
            "storage_failed",
            found.error.message,
            found.error.retryable,
          );
        }
        if (!found.value) {
          return brokerFailure(
            "recipient_not_found",
            `Recipient ${JSON.stringify(address.piSessionId)} is unknown.`,
          );
        }
        const recipient = parsePresence(found.value);
        if (
          address.expectedIncarnation !== undefined &&
          address.expectedIncarnation !== recipient.incarnation
        ) {
          return brokerFailure(
            "recipient_incarnation_changed",
            `Recipient ${JSON.stringify(address.piSessionId)} has a new incarnation.`,
          );
        }
        const sameProject = recipient.projectId === binding.project.projectId;
        if (recipient.exposure.acceptsFrom === "none") {
          return brokerFailure(
            "recipient_hidden",
            `Recipient ${JSON.stringify(address.piSessionId)} does not accept messages.`,
          );
        }
        if (recipient.exposure.acceptsFrom === "same-project" && !sameProject) {
          return brokerFailure(
            "cross_project_denied",
            `Recipient ${JSON.stringify(address.piSessionId)} does not accept cross-project messages.`,
          );
        }
        return success(recipient);
      };

      const pumpController = new AbortController();
      const claimOwner = `${owner}:${incarnation}`;
      let pumpPromise: Promise<void> | undefined;

      const finishDelivery = async (
        messageId: string,
        position: number,
        expectedVersion: number,
        claimedMessage: PersistedMessage,
        claimFence: number,
        nextState: PersistedMessage["state"],
        lastErrorCode?: string,
        durableReceipt?: string,
      ) => {
        if (closed || identityLost) return false;
        const terminal =
          nextState === "delivered" ||
          nextState === "failed" ||
          nextState === "expired";
        const mailbox = terminal
          ? await record(options.state, MAILBOX_COLLECTION, binding.piSessionId)
          : undefined;
        if (mailbox && (!mailbox.ok || !mailbox.value)) return false;
        const finished: PersistedMessage = {
          envelope: claimedMessage.envelope,
          recipientProjectId: claimedMessage.recipientProjectId,
          state: nextState,
          attempts: claimedMessage.attempts,
          ...(claimedMessage.lastAttemptAt === undefined
            ? {}
            : { lastAttemptAt: claimedMessage.lastAttemptAt }),
          ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
          ...(durableReceipt === undefined ? {} : { durableReceipt }),
        };
        const result = await options.state.transact({
          transactionId: `session-broker.delivery-finish:${incarnation}:${messageId}:${id()}`,
          operations: [
            {
              type: "renew-lease",
              resource: leaseResource(binding.piSessionId),
              owner,
              fence,
              ttlMs: limits.sessionTtlMs,
              metadata: { incarnation },
            },
            {
              type: "put-record",
              collection: MESSAGE_COLLECTION,
              key: messageId,
              metadata: messageMetadata(finished),
              expectedVersion,
            },
            ...(mailbox?.ok && mailbox.value
              ? [
                  {
                    type: "put-record" as const,
                    collection: MAILBOX_COLLECTION,
                    key: binding.piSessionId,
                    metadata: mailboxMetadata({
                      pending: Math.max(
                        0,
                        parseMailbox(mailbox.value).pending - 1,
                      ),
                    }),
                    expectedVersion: mailbox.value.version,
                  },
                ]
              : []),
            {
              type: "release-lease",
              resource: deliveryLeaseResource(binding.piSessionId, position),
              owner: claimOwner,
              fence: claimFence,
            },
          ],
        });
        if (!result.ok && result.error.code === "LEASE_LOST") {
          identityLost = true;
        }
        return result.ok;
      };

      const pumpMailbox = async () => {
        let afterPosition = 0;
        while (!closed && !identityLost) {
          const page = await options.state.query({
            type: "events",
            stream: mailboxStream(binding.piSessionId),
            afterPosition,
            limit: 64,
          });
          if (!page.ok || page.value.type !== "events") return;
          if (page.value.events.length === 0) return;

          for (const event of page.value.events) {
            afterPosition = event.position;
            const found = await record(
              options.state,
              MESSAGE_COLLECTION,
              event.eventId,
            );
            if (!found.ok || !found.value) return;
            const pending = parseMessage(found.value);
            if (
              pending.state === "delivered" ||
              pending.state === "failed" ||
              pending.state === "expired"
            ) {
              continue;
            }

            const attemptedAt = clock();
            const attemptsExhausted =
              pending.attempts >= limits.maxDeliveryAttempts;
            const claimedMessage: PersistedMessage = {
              ...pending,
              state: "claimed",
              attempts: attemptsExhausted
                ? pending.attempts
                : pending.attempts + 1,
              ...(attemptsExhausted ? {} : { lastAttemptAt: attemptedAt }),
            };
            const claim = await options.state.transact({
              transactionId: `session-broker.delivery-claim:${incarnation}:${event.eventId}:${id()}`,
              operations: [
                {
                  type: "renew-lease",
                  resource: leaseResource(binding.piSessionId),
                  owner,
                  fence,
                  ttlMs: limits.sessionTtlMs,
                  metadata: { incarnation },
                },
                {
                  type: "claim-lease",
                  resource: deliveryLeaseResource(
                    binding.piSessionId,
                    event.position,
                  ),
                  owner: claimOwner,
                  ttlMs: limits.deliveryClaimTtlMs,
                  metadata: { incarnation, messageId: event.eventId },
                },
                {
                  type: "put-record",
                  collection: MESSAGE_COLLECTION,
                  key: event.eventId,
                  metadata: messageMetadata(claimedMessage),
                  expectedVersion: found.value.version,
                },
              ],
            });
            if (!claim.ok) {
              if (claim.error.code === "LEASE_LOST") identityLost = true;
              return;
            }
            const claimFence = claim.value.leases.find(
              ({ resource }) =>
                resource ===
                deliveryLeaseResource(binding.piSessionId, event.position),
            )?.fence;
            const claimedRecord = claim.value.records.find(
              ({ collection, key }) =>
                collection === MESSAGE_COLLECTION && key === event.eventId,
            );
            if (claimFence === undefined || !claimedRecord) return;

            if (attemptsExhausted) {
              const exhausted = await finishDelivery(
                event.eventId,
                event.position,
                claimedRecord.version,
                claimedMessage,
                claimFence,
                "failed",
                claimedMessage.lastErrorCode ?? "delivery_attempts_exhausted",
              );
              if (!exhausted) return;
              continue;
            }

            if (
              claimedMessage.recipientProjectId !== binding.project.projectId
            ) {
              const quarantined = await finishDelivery(
                event.eventId,
                event.position,
                claimedRecord.version,
                claimedMessage,
                claimFence,
                "failed",
                "recipient_project_changed",
              );
              if (!quarantined) return;
              continue;
            }

            const artifact = await options.artifacts.get(
              claimedMessage.envelope.body.id,
            );
            if (!artifact.ok) {
              const expired = artifact.error.code === "artifact_expired";
              const terminal =
                expired ||
                claimedMessage.attempts >= limits.maxDeliveryAttempts;
              await finishDelivery(
                event.eventId,
                event.position,
                claimedRecord.version,
                claimedMessage,
                claimFence,
                expired ? "expired" : terminal ? "failed" : "queued",
                expired ? "artifact_expired" : "artifact_failed",
              );
              if (!terminal) return;
              continue;
            }

            const envelope: MessageEnvelope = {
              ...claimedMessage.envelope,
              mailboxPosition: event.position,
            };
            let delivered: Outcome<DeliveryReceipt, SessionDeliveryError>;
            try {
              delivered = await delivery.deliverOnce(
                {
                  envelope,
                  renderedContent: renderDelivery(
                    envelope,
                    artifact.value,
                    limits.maxInlineBodyBytes,
                  ),
                },
                pumpController.signal,
              );
            } catch (error) {
              delivered = failure({
                code: "temporarily_unavailable",
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
              });
            }
            if (delivered.ok) {
              if (!isValidDeliveryReceipt(delivered.value)) {
                const terminal =
                  claimedMessage.attempts >= limits.maxDeliveryAttempts;
                const rejected = await finishDelivery(
                  event.eventId,
                  event.position,
                  claimedRecord.version,
                  claimedMessage,
                  claimFence,
                  terminal ? "failed" : "queued",
                  "invalid_delivery_receipt",
                );
                if (!rejected || !terminal) return;
                continue;
              }
              const acknowledged = await finishDelivery(
                event.eventId,
                event.position,
                claimedRecord.version,
                claimedMessage,
                claimFence,
                "delivered",
                undefined,
                delivered.value.durableReceipt,
              );
              if (!acknowledged) return;
              continue;
            }

            const terminal =
              claimedMessage.attempts >= limits.maxDeliveryAttempts;
            const released = await finishDelivery(
              event.eventId,
              event.position,
              claimedRecord.version,
              claimedMessage,
              claimFence,
              terminal ? "failed" : "queued",
              delivered.error.code,
            );
            if (!released || !terminal) return;
          }
        }
      };

      const queuePump = () => {
        if (closed || identityLost || pumpPromise) return;
        pumpPromise = pumpMailbox().finally(() => {
          pumpPromise = undefined;
        });
        void pumpPromise.catch(() => undefined);
      };

      const close = (reason: Parameters<SessionBroker["close"]>[0]) => {
        if (closeResult) return closeResult;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        if (attachedPumps.get(binding.piSessionId) === queuePump) {
          attachedPumps.delete(binding.piSessionId);
        }
        pumpController.abort(new Error("Session broker is closing."));
        closeResult = (async () => {
          await refreshes;
          await settleWithin(pumpPromise, CLOSE_DRAIN_TIMEOUT_MS);
          const current = await record(
            options.state,
            PRESENCE_COLLECTION,
            binding.piSessionId,
          );
          if (!current.ok) {
            return brokerFailure(
              "storage_failed",
              current.error.message,
              current.error.retryable,
            );
          }
          if (!current.value) {
            return brokerFailure("identity_lost", "Session presence is lost.");
          }
          const currentPresence = parsePresence(current.value);
          const stopped: PresenceRecord = {
            ...currentPresence,
            snapshot: { ...currentPresence.snapshot, status: "stopping" },
            lastHeartbeatAt: clock(),
            online: false,
          };
          const released = await options.state.transact({
            transactionId: `session-broker.close:${incarnation}:${reason}`,
            operations: [
              {
                type: "put-record",
                collection: PRESENCE_COLLECTION,
                key: binding.piSessionId,
                metadata: presenceMetadata(stopped),
                expectedVersion: current.value.version,
              },
              {
                type: "release-lease",
                resource: leaseResource(binding.piSessionId),
                owner,
                fence,
              },
            ],
          });
          if (!released.ok) {
            if (released.error.code === "LEASE_LOST") {
              return brokerFailure(
                "identity_lost",
                "Session ownership fence is no longer current.",
              );
            }
            return brokerFailure(
              "storage_failed",
              released.error.message,
              released.error.retryable,
            );
          }
          return success(undefined);
        })();
        return closeResult;
      };

      const broker: SessionBroker = {
        async discover(input = {}) {
          if (closed) {
            return brokerFailure(
              "shutting_down",
              "Session broker is shutting down.",
            );
          }
          const identity = await verifyIdentity();
          if (!identity.ok) return identity;
          const limit = input.limit ?? 25;
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > limits.maxQueryLimit
          ) {
            return brokerFailure(
              "invalid_request",
              "Discovery limit is outside the supported range.",
            );
          }
          const queried = await options.state.query({
            type: "records",
            collection: PRESENCE_COLLECTION,
            limit: 1_000,
          });
          if (!queried.ok) {
            return brokerFailure(
              "storage_failed",
              queried.error.message,
              queried.error.retryable,
            );
          }
          if (queried.value.type !== "records") {
            return brokerFailure(
              "storage_failed",
              "StateStore returned an unexpected query result.",
            );
          }
          const now = clock();
          const summaries = queried.value.records
            .map((candidate) => ({
              piSessionId: candidate.key,
              presence: parsePresence(candidate),
            }))
            .filter(({ presence: candidate }) => {
              if (candidate.exposure.discoverableBy === "none") return false;
              const sameProject =
                candidate.projectId === binding.project.projectId;
              if (
                candidate.exposure.discoverableBy === "same-project" &&
                !sameProject
              ) {
                return false;
              }
              if ((input.project ?? "current") === "current" && !sameProject) {
                return false;
              }
              const online =
                candidate.online &&
                now - candidate.lastHeartbeatAt < limits.sessionTtlMs;
              if ((input.status ?? "online") === "online" && !online) {
                return false;
              }
              if (
                input.capability &&
                !candidate.snapshot.capabilities.some(
                  (capability) => capability.id === input.capability,
                )
              ) {
                return false;
              }
              return true;
            })
            .sort((left, right) =>
              left.piSessionId.localeCompare(right.piSessionId),
            )
            .slice(0, limit)
            .map(({ piSessionId, presence: candidate }): SessionSummary => {
              const sameProject =
                candidate.projectId === binding.project.projectId;
              const online =
                candidate.online &&
                now - candidate.lastHeartbeatAt < limits.sessionTtlMs;
              return {
                address: { piSessionId },
                incarnation: candidate.incarnation,
                executionRole: candidate.executionRole,
                projectId: candidate.projectId,
                cwd: candidate.cwd,
                ...(candidate.snapshot.name === undefined
                  ? {}
                  : { name: candidate.snapshot.name }),
                status: online ? candidate.snapshot.status : "offline",
                capabilities: candidate.snapshot.capabilities,
                lastHeartbeatAt: candidate.lastHeartbeatAt,
                visibleBecause: sameProject ? "same-project" : "local-user",
              };
            });
          return success(summaries);
        },
        async send(request, signal) {
          if (closed) {
            return brokerFailure(
              "shutting_down",
              "Session broker is shutting down.",
            );
          }
          if (signal?.aborted) {
            return brokerFailure("cancelled", "Message send was cancelled.");
          }
          const valid = validateSendRequest(request, limits);
          if (!valid.ok) return valid;
          request = snapshotSendRequest(request);
          const fingerprint = requestFingerprint(request);
          const sanitized = sanitizeSendRequest(request);
          request = sanitized.request;
          const sendKey = request.requestId;
          const previousSend = activeSends.get(sendKey) ?? Promise.resolve();
          let releaseLane = () => {};
          const lane = new Promise<void>((resolve) => {
            releaseLane = resolve;
          });
          activeSends.set(sendKey, lane);
          await previousSend;
          try {
            if (signal?.aborted) {
              return brokerFailure("cancelled", "Message send was cancelled.");
            }
            const identity = await verifyIdentity();
            if (!identity.ok) return identity;
            const persistedKey = requestKey(incarnation, request.requestId);
            const priorRequest = await record(
              options.state,
              REQUEST_COLLECTION,
              persistedKey,
            );
            if (!priorRequest.ok) {
              return brokerFailure(
                "storage_failed",
                priorRequest.error.message,
                priorRequest.error.retryable,
              );
            }
            if (priorRequest.value) {
              const persisted = parseRequest(priorRequest.value);
              if (persisted.fingerprint !== fingerprint) {
                return brokerFailure(
                  "invalid_request",
                  "Host request ID was already used for different content.",
                );
              }
              const renewed = await options.state.transact({
                transactionId: `session-broker.replay:${incarnation}:${persistedKey}:${id()}`,
                operations: [
                  {
                    type: "renew-lease",
                    resource: leaseResource(binding.piSessionId),
                    owner,
                    fence,
                    ttlMs: limits.sessionTtlMs,
                    metadata: { incarnation },
                  },
                ],
              });
              if (!renewed.ok) {
                if (renewed.error.code === "LEASE_LOST") {
                  identityLost = true;
                  return brokerFailure(
                    "identity_lost",
                    "Session ownership fence is no longer current.",
                  );
                }
                return brokerFailure(
                  "storage_failed",
                  renewed.error.message,
                  renewed.error.retryable,
                );
              }
              const deliveries: SendMessageReceipt["deliveries"][number][] = [];
              for (const item of persisted.deliveries) {
                const mailboxEvent = await findMailboxEvent(
                  options.state,
                  item.recipient.piSessionId,
                  item.messageId,
                );
                if (!mailboxEvent.ok) {
                  return brokerFailure(
                    "storage_failed",
                    mailboxEvent.error.message,
                    mailboxEvent.error.retryable,
                  );
                }
                const event = mailboxEvent.value;
                if (!event) {
                  return brokerFailure(
                    "storage_failed",
                    `Idempotent mailbox receipt ${JSON.stringify(item.messageId)} is missing.`,
                  );
                }
                const storedMessage = await record(
                  options.state,
                  MESSAGE_COLLECTION,
                  item.messageId,
                );
                if (!storedMessage.ok || !storedMessage.value) {
                  return brokerFailure(
                    "storage_failed",
                    storedMessage.ok
                      ? `Idempotent message ${JSON.stringify(item.messageId)} is missing.`
                      : storedMessage.error.message,
                    storedMessage.ok ? false : storedMessage.error.retryable,
                  );
                }
                deliveries.push({
                  recipient: item.recipient,
                  messageId: item.messageId,
                  mailboxPosition: event.position,
                  state: "queued",
                });
              }
              return success({
                requestId: request.requestId,
                body: persisted.body,
                deliveries,
                replayed: true,
              });
            }
            const deliveryDirective = request.delivery ?? {
              mode: "pi/inbox",
              version: 1,
            };
            const recipients: PresenceRecord[] = [];
            for (const address of request.recipients) {
              const recipient = await resolveRecipient(address);
              if (!recipient.ok) return recipient;
              const capabilityId = `pi.delivery/${deliveryDirective.mode.replace(/^pi\//, "")}`;
              if (
                !recipient.value.snapshot.capabilities.some(
                  (capability) =>
                    (capability.id === capabilityId ||
                      capability.id === deliveryDirective.mode) &&
                    capability.version === deliveryDirective.version,
                )
              ) {
                return brokerFailure(
                  "capability_unavailable",
                  `Recipient does not advertise ${deliveryDirective.mode} v${deliveryDirective.version}.`,
                );
              }
              recipients.push(recipient.value);
            }

            const mailboxes: Array<{
              readonly record: StateRecord | null;
              readonly pending: number;
            }> = [];
            for (const address of request.recipients) {
              const mailbox = await record(
                options.state,
                MAILBOX_COLLECTION,
                address.piSessionId,
              );
              if (!mailbox.ok) {
                return brokerFailure(
                  "storage_failed",
                  mailbox.error.message,
                  mailbox.error.retryable,
                );
              }
              const pending = mailbox.value
                ? parseMailbox(mailbox.value).pending
                : 0;
              if (pending >= limits.maxPendingPerRecipient) {
                return brokerFailure(
                  "mailbox_full",
                  `Recipient ${JSON.stringify(address.piSessionId)} mailbox is full.`,
                  true,
                );
              }
              mailboxes.push({ record: mailbox.value, pending });
            }

            const groupId = id();
            const wrappedBody = JSON.stringify({
              version: 1,
              messageGroupId: groupId,
              body:
                request.body.kind === "text"
                  ? {
                      kind: "text",
                      text: request.body.text,
                      mediaType: request.body.mediaType ?? "text/plain",
                    }
                  : {
                      kind: "bytes",
                      bytes: Buffer.from(request.body.bytes).toString("base64"),
                      mediaType: request.body.mediaType,
                    },
            });
            const artifact = await options.artifacts.put({
              body: wrappedBody,
              mediaType: "application/vnd.pi.session-message+json",
              metadata: {
                format: "pi.session-message-body",
                version: 1,
                classification:
                  sanitized.redactions > 0 ? "sanitized" : "secret-scanned",
                redactions: sanitized.redactions,
              },
              expiresAt: clock() + ARTIFACT_RETENTION_MS,
            });
            if (!artifact.ok) {
              return brokerFailure(
                "artifact_failed",
                artifact.error.message,
                artifact.error.retryable,
              );
            }

            const senderPresence = await record(
              options.state,
              PRESENCE_COLLECTION,
              binding.piSessionId,
            );
            if (!senderPresence.ok) {
              return brokerFailure(
                "storage_failed",
                senderPresence.error.message,
                senderPresence.error.retryable,
              );
            }
            if (!senderPresence.value) {
              return brokerFailure(
                "identity_lost",
                "Session presence is lost.",
              );
            }
            const currentSender = parsePresence(senderPresence.value);
            const sentAt = clock();
            const messages = request.recipients.map((address, index) => {
              const messageId = id();
              const message: PersistedMessage = {
                envelope: {
                  id: messageId,
                  sender: {
                    piSessionId: binding.piSessionId,
                    incarnation,
                    executionRole: binding.executionRole,
                    projectId: binding.project.projectId,
                    ...(currentSender.snapshot.name === undefined
                      ? {}
                      : { name: currentSender.snapshot.name }),
                  },
                  recipient: { piSessionId: address.piSessionId },
                  sentAt,
                  summary: request.summary,
                  body: artifact.value,
                  delivery: deliveryDirective,
                  trust: "untrusted",
                  authority: "none",
                },
                recipientProjectId: recipients[index]!.projectId,
                state: "queued",
                attempts: 0,
              };
              return {
                address,
                recipient: recipients[index]!,
                mailbox: mailboxes[index]!,
                message,
              };
            });
            const persistedRequest: PersistedRequest = {
              fingerprint,
              body: artifact.value,
              deliveries: messages.map(({ address, message }) => ({
                recipient: address,
                messageId: message.envelope.id,
              })),
            };
            const committed = await options.state.transact({
              transactionId: `session-broker.send:${incarnation}:${requestKey(incarnation, request.requestId)}`,
              operations: [
                {
                  type: "renew-lease",
                  resource: leaseResource(binding.piSessionId),
                  owner,
                  fence,
                  ttlMs: limits.sessionTtlMs,
                  metadata: { incarnation },
                },
                ...messages.flatMap(({ address, mailbox, message }) => [
                  {
                    type: "put-record" as const,
                    collection: MESSAGE_COLLECTION,
                    key: message.envelope.id,
                    metadata: messageMetadata(message),
                    expectedVersion: null,
                  },
                  {
                    type: "append-event" as const,
                    stream: mailboxStream(address.piSessionId),
                    eventId: message.envelope.id,
                    eventType: "mailbox.message-enqueued",
                    metadata: { messageId: message.envelope.id },
                  },
                  {
                    type: "put-record" as const,
                    collection: MAILBOX_COLLECTION,
                    key: address.piSessionId,
                    metadata: mailboxMetadata({
                      pending: mailbox.pending + 1,
                    }),
                    expectedVersion: mailbox.record?.version ?? null,
                  },
                ]),
                {
                  type: "put-record",
                  collection: REQUEST_COLLECTION,
                  key: persistedKey,
                  metadata: requestMetadata(persistedRequest),
                  expectedVersion: null,
                },
              ],
            });
            if (!committed.ok) {
              if (committed.error.code === "LEASE_LOST") {
                identityLost = true;
                return brokerFailure(
                  "identity_lost",
                  "Session ownership fence is no longer current.",
                );
              }
              return brokerFailure(
                "storage_failed",
                committed.error.message,
                committed.error.retryable,
              );
            }
            for (const address of request.recipients) {
              attachedPumps.get(address.piSessionId)?.();
            }
            return success({
              requestId: request.requestId,
              body: artifact.value,
              deliveries: messages.map(({ address, message }, index) => ({
                recipient: address,
                messageId: message.envelope.id,
                mailboxPosition: committed.value.events[index]!.position,
                state: "queued" as const,
              })),
              replayed: false,
            });
          } finally {
            releaseLane();
            if (activeSends.get(sendKey) === lane) {
              activeSends.delete(sendKey);
            }
          }
        },
        async messages(query = {}) {
          if (closed) {
            return brokerFailure(
              "shutting_down",
              "Session broker is shutting down.",
            );
          }
          const identity = await verifyIdentity();
          if (!identity.ok) return identity;
          const limit = query.limit ?? 25;
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > limits.maxQueryLimit ||
            (query.afterPosition !== undefined &&
              (!Number.isSafeInteger(query.afterPosition) ||
                query.afterPosition < 0))
          ) {
            return brokerFailure(
              "invalid_request",
              "Message query is outside the supported range.",
            );
          }
          if ((query.direction ?? "inbound") === "outbound") {
            const messageRecords: StateRecord[] = [];
            let afterKey: string | undefined;
            while (true) {
              const queriedRecords = await options.state.query({
                type: "records",
                collection: MESSAGE_COLLECTION,
                ...(afterKey === undefined ? {} : { afterKey }),
                limit: 1_000,
              });
              if (!queriedRecords.ok) {
                return brokerFailure(
                  "storage_failed",
                  queriedRecords.error.message,
                  queriedRecords.error.retryable,
                );
              }
              if (queriedRecords.value.type !== "records") {
                return brokerFailure(
                  "storage_failed",
                  "StateStore returned an unexpected query result.",
                );
              }
              messageRecords.push(...queriedRecords.value.records);
              const last = queriedRecords.value.records.at(-1);
              if (!last || queriedRecords.value.records.length < 1_000) break;
              if (messageRecords.length >= MAX_OUTBOUND_SCAN_RECORDS) {
                return brokerFailure(
                  "invalid_request",
                  `Outbound inspection is limited to ${MAX_OUTBOUND_SCAN_RECORDS} persisted messages.`,
                );
              }
              afterKey = last.key;
            }
            const outbound: MessageSummary[] = [];
            for (const messageRecord of messageRecords) {
              const message = parseMessage(messageRecord);
              if (
                message.envelope.sender.piSessionId !== binding.piSessionId ||
                (query.state && query.state !== message.state)
              ) {
                continue;
              }
              const mailboxEvent = await findMailboxEvent(
                options.state,
                message.envelope.recipient.piSessionId,
                message.envelope.id,
              );
              if (!mailboxEvent.ok) {
                return brokerFailure(
                  "storage_failed",
                  mailboxEvent.error.message,
                  mailboxEvent.error.retryable,
                );
              }
              const event = mailboxEvent.value;
              if (!event || event.sequence <= (query.afterPosition ?? 0)) {
                continue;
              }
              outbound.push({
                envelope: {
                  ...message.envelope,
                  mailboxPosition: event.sequence,
                },
                state: message.state,
                attempts: message.attempts,
                ...(message.lastAttemptAt === undefined
                  ? {}
                  : { lastAttemptAt: message.lastAttemptAt }),
                ...(message.lastErrorCode === undefined
                  ? {}
                  : { lastErrorCode: message.lastErrorCode }),
              });
            }
            outbound.sort(
              (left, right) =>
                left.envelope.mailboxPosition - right.envelope.mailboxPosition,
            );
            return success(outbound.slice(0, limit));
          }
          const queried = await options.state.query({
            type: "events",
            stream: mailboxStream(binding.piSessionId),
            afterPosition: query.afterPosition,
            limit,
          });
          if (!queried.ok) {
            return brokerFailure(
              "storage_failed",
              queried.error.message,
              queried.error.retryable,
            );
          }
          if (queried.value.type !== "events") {
            return brokerFailure(
              "storage_failed",
              "StateStore returned an unexpected query result.",
            );
          }
          const summaries: MessageSummary[] = [];
          for (const event of queried.value.events) {
            const found = await record(
              options.state,
              MESSAGE_COLLECTION,
              event.eventId,
            );
            if (!found.ok) {
              return brokerFailure(
                "storage_failed",
                found.error.message,
                found.error.retryable,
              );
            }
            if (!found.value) {
              return brokerFailure(
                "storage_failed",
                `Mailbox message ${JSON.stringify(event.eventId)} is missing.`,
              );
            }
            const message = parseMessage(found.value);
            if (message.recipientProjectId !== binding.project.projectId) {
              continue;
            }
            if (query.state && query.state !== message.state) continue;
            summaries.push({
              envelope: {
                ...message.envelope,
                mailboxPosition: event.position,
              },
              state: message.state,
              attempts: message.attempts,
              ...(message.lastAttemptAt === undefined
                ? {}
                : { lastAttemptAt: message.lastAttemptAt }),
              ...(message.lastErrorCode === undefined
                ? {}
                : { lastErrorCode: message.lastErrorCode }),
            });
          }
          return success(summaries);
        },
        close,
      };

      unsubscribe = delivery.subscribe((nextSnapshot) => {
        queuePresenceRefresh(nextSnapshot);
        queuePump();
      });
      heartbeat = setInterval(() => {
        queuePresenceRefresh(delivery.snapshot());
        queuePump();
      }, limits.heartbeatMs);
      heartbeat.unref?.();

      try {
        await options.lifecycle.acquire({
          id: `session-broker:${binding.piSessionId}:${incarnation}`,
          async start() {
            return {
              value: undefined,
              async close({ reason }) {
                const outcome = await close(reason);
                if (!outcome.ok) throw new Error(outcome.error.message);
              },
            };
          },
        });
      } catch (error) {
        await close("quit");
        return brokerFailure(
          "shutting_down",
          error instanceof Error ? error.message : String(error),
        );
      }
      attachedPumps.set(binding.piSessionId, queuePump);
      queuePump();
      return success(broker);
    },
  };
}
