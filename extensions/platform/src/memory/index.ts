import { createHash, randomUUID } from "node:crypto";
import { EXECUTION_ROLES } from "../../../shared/execution-role.ts";
import {
  failure,
  success,
  type JsonObject,
  type JsonValue,
} from "../core/result.ts";
import {
  coreMemoryKinds,
  type HostMemoryBinding,
  type HostMemoryBindingAssertion,
  type HostMemoryBindingFactoryOptions,
  type MemoryCitation,
  type MemoryCitationInput,
  type MemoryRecord,
  type MemoryScopeSelector,
  type MemoryStoreErrorCode,
  type MemoryStoreModuleOptions,
  type MemoryStoreResult,
} from "./model.ts";
import { contradictionClaim, isConservativeNearDuplicate } from "./analysis.ts";

const supportedKinds = new Set(
  Object.values(coreMemoryKinds).map(({ id, version }) => `${id}\0${version}`),
);

interface IssuedHostMemoryBinding {
  readonly assertion: HostMemoryBindingAssertion;
  readonly revalidate?: HostMemoryBindingFactoryOptions["revalidate"];
}

const issuedHostMemoryBindings = new WeakMap<object, IssuedHostMemoryBinding>();

function validBoundText(value: unknown, maxBytes = 2_048) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maxBytes &&
    !value.includes("\0")
  );
}

function validHostBindingAssertion(
  value: unknown,
): value is HostMemoryBindingAssertion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(binding, [
      "executionRole",
      "project",
      "workspace",
      "ingress",
      "sessionId",
      "sourceEntryId",
    ]) ||
    !EXECUTION_ROLES.includes(
      binding.executionRole as (typeof EXECUTION_ROLES)[number],
    ) ||
    !["direct-user", "model-proposal", "automatic-proposal", "import"].includes(
      String(binding.ingress),
    ) ||
    (binding.sessionId !== undefined && !validBoundText(binding.sessionId)) ||
    (binding.sourceEntryId !== undefined &&
      !validBoundText(binding.sourceEntryId))
  )
    return false;
  const project = binding.project as Record<string, unknown> | undefined;
  if (
    project !== undefined &&
    (!project ||
      (project.kind !== "git" && project.kind !== "non-git") ||
      !validBoundText(project.projectId) ||
      !validBoundText(project.requestedCwd, 32 * 1024) ||
      !validBoundText(project.canonicalCwd, 32 * 1024) ||
      typeof project.cwdWasAliased !== "boolean")
  )
    return false;
  const workspace = binding.workspace as Record<string, unknown> | undefined;
  if (workspace === undefined) return true;
  const owner = workspace.owner as Record<string, unknown> | undefined;
  const snapshot = workspace.snapshot as Record<string, unknown> | undefined;
  return !!(
    project &&
    validBoundText(workspace.workspaceId) &&
    owner &&
    validBoundText(owner.sessionId) &&
    validBoundText(owner.agentId) &&
    Number.isSafeInteger(workspace.fence) &&
    Number(workspace.fence) > 0 &&
    Number.isSafeInteger(workspace.expiresAt) &&
    snapshot &&
    snapshot.state === "leased" &&
    snapshot.workspaceId === workspace.workspaceId &&
    snapshot.projectId === project.projectId
  );
}

function sameHostAuthority(
  issued: HostMemoryBindingAssertion,
  current: HostMemoryBindingAssertion,
) {
  return (
    issued.executionRole === current.executionRole &&
    issued.ingress === current.ingress &&
    issued.sessionId === current.sessionId &&
    issued.sourceEntryId === current.sourceEntryId &&
    issued.project?.projectId === current.project?.projectId &&
    issued.project?.canonicalCwd === current.project?.canonicalCwd &&
    issued.workspace?.workspaceId === current.workspace?.workspaceId &&
    issued.workspace?.owner.sessionId === current.workspace?.owner.sessionId &&
    issued.workspace?.owner.agentId === current.workspace?.owner.agentId &&
    issued.workspace?.fence === current.workspace?.fence &&
    issued.workspace?.snapshot.projectId ===
      current.workspace?.snapshot.projectId
  );
}

export function createHostMemoryBindingFactory(
  options: HostMemoryBindingFactoryOptions = {},
) {
  return {
    issue(assertion: HostMemoryBindingAssertion): HostMemoryBinding {
      if (!validHostBindingAssertion(assertion))
        throw new TypeError("Host Memory binding assertion is invalid.");
      if (assertion.workspace && !options.revalidate)
        throw new TypeError(
          "Workspace Memory binding requires a host revalidator.",
        );
      const capability = Object.freeze({});
      issuedHostMemoryBindings.set(capability, {
        assertion: structuredClone(assertion),
        ...(options.revalidate ? { revalidate: options.revalidate } : {}),
      });
      return capability as HostMemoryBinding;
    },
  };
}

function memoryFailure(
  code: MemoryStoreErrorCode,
  message: string,
  retryable = false,
): MemoryStoreResult<never> {
  return failure({ code, message, retryable });
}

function resolveScope(
  binding: HostMemoryBindingAssertion,
  selector: MemoryScopeSelector,
  now: number,
) {
  if (selector !== "user" && selector !== "project" && selector !== "workspace")
    return memoryFailure("invalid_request", "Memory scope is invalid.");
  if (selector === "user") return success({ kind: "user" as const });
  if (!binding.project)
    return memoryFailure(
      "scope_unavailable",
      "Current project identity is unavailable.",
    );
  if (selector === "project")
    return success({
      kind: "project" as const,
      projectId: binding.project.projectId,
    });
  if (!binding.workspace)
    return memoryFailure(
      "scope_unavailable",
      "Verified Guarded Workspace is unavailable.",
    );
  if (binding.workspace.snapshot.projectId !== binding.project.projectId)
    return memoryFailure(
      "project_mismatch",
      "Guarded Workspace does not belong to current project.",
    );
  if (
    binding.workspace.expiresAt <= now ||
    binding.workspace.snapshot.state !== "leased"
  )
    return memoryFailure(
      "workspace_lease_lost",
      "Guarded Workspace lease is no longer current.",
    );
  return success({
    kind: "workspace" as const,
    projectId: binding.project.projectId,
    workspaceId: binding.workspace.workspaceId,
  });
}

function canAccessMemory(
  binding: HostMemoryBindingAssertion,
  memory: MemoryRecord,
  now: number,
) {
  if (memory.scope.kind === "user") return success(undefined);
  if (!binding.project || binding.project.projectId !== memory.scope.projectId)
    return memoryFailure("memory_not_found", "Memory was not found.");
  if (memory.scope.kind === "project") return success(undefined);
  if (
    !binding.workspace ||
    binding.workspace.workspaceId !== memory.scope.workspaceId
  )
    return memoryFailure("memory_not_found", "Memory was not found.");
  if (
    binding.workspace.expiresAt <= now ||
    binding.workspace.snapshot.state !== "leased"
  )
    return memoryFailure(
      "workspace_lease_lost",
      "Guarded Workspace lease is no longer current.",
    );
  return success(undefined);
}

function normalizedContent(content: string) {
  return content.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 1_000 &&
      value.every((item) => isJsonValue(item, depth + 1))
    );
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1_000 &&
    entries.every(
      ([key, item]) => key.length <= 256 && isJsonValue(item, depth + 1),
    )
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]) {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function validRequestId(value: unknown, exactCanaries: readonly string[]) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 512 &&
    !value.includes("\0") &&
    safePersistedText(value, exactCanaries)
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

interface BundleMemory {
  readonly kind: { readonly id: string; readonly version: number };
  readonly content: string;
  readonly citations: readonly {
    readonly kind: string;
    readonly locator: JsonObject;
    readonly excerpt?: string;
  }[];
  readonly expiresAt?: number;
}

function parseBundleMemory(value: unknown): BundleMemory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (!kind || typeof kind !== "object" || Array.isArray(kind))
    return undefined;
  const kindRecord = kind as Record<string, unknown>;
  if (
    typeof kindRecord.id !== "string" ||
    typeof kindRecord.version !== "number" ||
    !Number.isSafeInteger(kindRecord.version) ||
    typeof record.content !== "string"
  )
    return undefined;
  const citations: BundleMemory["citations"][number][] = [];
  if (record.citations !== undefined) {
    if (!Array.isArray(record.citations) || record.citations.length > 16)
      return undefined;
    for (const citation of record.citations) {
      if (!citation || typeof citation !== "object" || Array.isArray(citation))
        return undefined;
      const citationRecord = citation as Record<string, unknown>;
      if (
        typeof citationRecord.kind !== "string" ||
        !isJsonObject(citationRecord.locator) ||
        (citationRecord.excerpt !== undefined &&
          typeof citationRecord.excerpt !== "string")
      )
        return undefined;
      citations.push({
        kind: citationRecord.kind,
        locator: citationRecord.locator,
        ...(typeof citationRecord.excerpt === "string"
          ? { excerpt: citationRecord.excerpt }
          : {}),
      });
    }
  }
  if (
    record.expiresAt !== undefined &&
    (typeof record.expiresAt !== "number" ||
      !Number.isSafeInteger(record.expiresAt))
  )
    return undefined;
  return {
    kind: { id: kindRecord.id, version: kindRecord.version },
    content: record.content,
    citations,
    ...(typeof record.expiresAt === "number"
      ? { expiresAt: record.expiresAt }
      : {}),
  };
}

function sameScope(
  left: import("./model.ts").MemoryRecord["scope"],
  right: import("./model.ts").MemoryRecord["scope"],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function candidateLimit(options: MemoryStoreModuleOptions) {
  return Math.min(options.limits?.maxCandidateIds ?? 500, 64);
}

const secretCitationField =
  /^(?:authorization|cookie|password|passwd|secret|session|bearer|oauth|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)$/i;

function sanitizeCitationJson(
  value: JsonValue,
  exactCanaries: readonly string[],
  field?: string,
): MemoryStoreResult<JsonValue> {
  if (field && !safePersistedText(field, exactCanaries))
    return memoryFailure(
      "secret_redaction_failed",
      "Memory citation key contains sensitive data.",
    );
  if (field && secretCitationField.test(field)) return success("[REDACTED]");
  if (typeof value === "string") {
    const scanned = redactMemoryContent(value, exactCanaries);
    return scanned.ok ? success(scanned.value.content) : scanned;
  }
  if (Array.isArray(value)) {
    const sanitized: JsonValue[] = [];
    for (const item of value) {
      const result = sanitizeCitationJson(item, exactCanaries);
      if (!result.ok) return result;
      sanitized.push(result.value);
    }
    return success(sanitized);
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = sanitizeCitationJson(item, exactCanaries, key);
      if (!result.ok) return result;
      sanitized[key] = result.value;
    }
    return success(sanitized);
  }
  return success(value);
}

function sanitizeCitationInputs(
  citations: readonly MemoryCitationInput[] | undefined,
  maxCitations: number,
  maxBytes: number,
  exactCanaries: readonly string[],
) {
  if (!citations) return success(undefined);
  if (citations.length === 0)
    return success([] as readonly MemoryCitationInput[]);
  if (citations.length > maxCitations)
    return memoryFailure("invalid_request", "Memory citations are invalid.");
  const sanitized: MemoryCitationInput[] = [];
  for (const citation of citations) {
    if (
      !citation ||
      typeof citation.kind !== "string" ||
      !citation.kind ||
      Buffer.byteLength(citation.kind) > 128 ||
      !safePersistedText(citation.kind, exactCanaries) ||
      !isJsonObject(citation.locator) ||
      (citation.excerpt !== undefined && typeof citation.excerpt !== "string")
    )
      return memoryFailure("invalid_request", "Memory citation is invalid.");
    const locator = sanitizeCitationJson(citation.locator, exactCanaries);
    if (!locator.ok || !isJsonObject(locator.value))
      return locator.ok
        ? memoryFailure(
            "secret_redaction_failed",
            "Memory citation redaction failed.",
          )
        : locator;
    let excerpt: string | undefined;
    if (citation.excerpt !== undefined) {
      const scanned = redactMemoryContent(citation.excerpt, exactCanaries);
      if (!scanned.ok) return scanned;
      excerpt = scanned.value.content;
    }
    sanitized.push({
      kind: citation.kind,
      locator: locator.value,
      ...(excerpt === undefined ? {} : { excerpt }),
    });
  }
  if (Buffer.byteLength(JSON.stringify(sanitized)) > maxBytes)
    return memoryFailure(
      "content_too_large",
      "Memory citations exceed size limit.",
    );
  return success(sanitized as readonly MemoryCitationInput[]);
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const entropyCredentialCandidate = /[A-Za-z0-9][A-Za-z0-9_+\/=-]{31,}/g;

function isHighEntropyCredential(value: string) {
  if (value.length > 4 * 1024) return false;
  if (
    value.includes("/") &&
    /(?:^|\/)(?:users|home|tmp|temp|appdata|documents|\.worktrees)(?:\/|$)/i.test(
      value,
    )
  )
    return false;
  if (/^[0-9a-f]+$/i.test(value)) return false;
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    return false;
  const categoryCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_+\/=-]/].filter(
    (pattern) => pattern.test(value),
  ).length;
  if (categoryCount < 2) return false;
  const bytes = Buffer.from(value);
  const frequencies = new Map<number, number>();
  for (const byte of bytes)
    frequencies.set(byte, (frequencies.get(byte) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4.5;
}

function redactMemoryContent(
  content: string,
  exactCanaries: readonly string[] = [],
) {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content))
    return memoryFailure(
      "secret_redaction_failed",
      "Memory contains a private-key block that cannot be stored safely.",
    );
  const patterns = [
    ...exactCanaries.map((canary) => ({
      kind: "exact-canary",
      pattern: new RegExp(escapeRegularExpression(canary), "g"),
    })),
    { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{20,255}\b/g },
    { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
    { kind: "openai-token", pattern: /\bsk-[A-Za-z0-9_-]{20,255}\b/g },
    { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
    {
      kind: "jwt",
      pattern:
        /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    },
    {
      kind: "url-credentials",
      pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
    },
    {
      kind: "authorization",
      pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    },
    {
      kind: "named-secret",
      pattern:
        /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi,
    },
  ];
  const matches: { kind: string; start: number; end: number }[] = [];
  for (const { kind, pattern } of patterns) {
    for (const match of content.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (
        matches.some(
          (candidate) => start < candidate.end && end > candidate.start,
        )
      )
        continue;
      matches.push({ kind, start, end });
    }
  }
  for (const match of content.matchAll(entropyCredentialCandidate)) {
    const start = match.index;
    const end = start + match[0].length;
    if (
      !isHighEntropyCredential(match[0]) ||
      matches.some(
        (candidate) => start < candidate.end && end > candidate.start,
      )
    )
      continue;
    matches.push({ kind: "high-entropy-credential", start, end });
  }
  matches.sort((left, right) => left.start - right.start);
  let redacted = content;
  for (const match of [...matches].reverse())
    redacted = `${redacted.slice(0, match.start)}[REDACTED]${redacted.slice(match.end)}`;
  return success({ content: redacted, redactions: matches });
}

function safePersistedText(value: string, exactCanaries: readonly string[]) {
  const scanned = redactMemoryContent(value, exactCanaries);
  return scanned.ok && scanned.value.redactions.length === 0;
}

function safePersistedStructure(
  value: unknown,
  exactCanaries: readonly string[],
  depth = 0,
): boolean {
  if (depth > 32) return false;
  if (typeof value === "string") return safePersistedText(value, exactCanaries);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  )
    return true;
  if (Array.isArray(value))
    return value.every((item) =>
      safePersistedStructure(item, exactCanaries, depth + 1),
    );
  if (typeof value !== "object") return false;
  return Object.entries(value).every(
    ([key, item]) =>
      safePersistedText(key, exactCanaries) &&
      safePersistedStructure(item, exactCanaries, depth + 1),
  );
}

export function createMemoryStoreModule(
  options: MemoryStoreModuleOptions,
): import("./model.ts").MemoryStoreModule {
  const clock = options.clock ?? Date.now;
  const id = options.id ?? randomUUID;
  const exactCanaries = [...new Set(options.secretCanaries ?? [])];
  if (
    exactCanaries.some(
      (canary) =>
        typeof canary !== "string" ||
        !canary ||
        Buffer.byteLength(canary) > 4 * 1024 ||
        canary.includes("\0"),
    )
  )
    throw new TypeError("Memory secret canaries are invalid.");
  return {
    bind(capability: HostMemoryBinding) {
      const issued =
        capability && typeof capability === "object"
          ? issuedHostMemoryBindings.get(capability)
          : undefined;
      if (!issued)
        throw new TypeError(
          "MemoryStore.bind requires a host-issued Memory capability.",
        );
      let binding = issued.assertion;
      const refreshBinding = async () => {
        const current = issued.revalidate
          ? await issued.revalidate(structuredClone(issued.assertion))
          : issued.assertion;
        if (!current || !validHostBindingAssertion(current))
          return memoryFailure(
            "scope_unavailable",
            "Host Memory authority is no longer valid.",
          );
        if (!sameHostAuthority(issued.assertion, current))
          return memoryFailure(
            issued.assertion.workspace
              ? "workspace_lease_lost"
              : "scope_unavailable",
            issued.assertion.workspace
              ? "Guarded Workspace lease is no longer current."
              : "Host Memory authority changed.",
          );
        if (!safePersistedText(JSON.stringify(current), exactCanaries))
          return memoryFailure(
            "secret_redaction_failed",
            "Host Memory binding contains sensitive data.",
          );
        binding = structuredClone(current);
        const purged = await options.persistence.purgeExpired(clock());
        if (!purged.ok)
          return memoryFailure(
            "storage_failed",
            "Expired Memory cleanup failed.",
            purged.error.retryable,
          );
        return success(undefined);
      };
      return {
        async remember(
          request: Parameters<import("./model.ts").MemoryStore["remember"]>[0],
        ) {
          const authority = await refreshBinding();
          if (!authority.ok) return authority;
          if (
            !request ||
            typeof request !== "object" ||
            !hasOnlyKeys(request, [
              "requestId",
              "kind",
              "scope",
              "content",
              "citations",
              "expiresAt",
              "attributes",
            ]) ||
            !validRequestId(request.requestId, exactCanaries) ||
            !request.kind ||
            typeof request.kind.id !== "string" ||
            !Number.isSafeInteger(request.kind.version)
          )
            return memoryFailure(
              "invalid_request",
              "Memory request is invalid.",
            );
          if (
            !supportedKinds.has(`${request.kind.id}\0${request.kind.version}`)
          )
            return memoryFailure(
              "unsupported_kind",
              "Memory kind is not supported.",
            );
          const now = clock();
          const scope = resolveScope(binding, request.scope, now);
          if (!scope.ok) return scope;
          if (
            request.attributes !== undefined &&
            (!isJsonObject(request.attributes) ||
              Object.keys(request.attributes).length > 0)
          )
            return memoryFailure(
              "invalid_request",
              "Memory kind does not support attributes.",
            );
          if (
            request.expiresAt !== undefined &&
            (!Number.isSafeInteger(request.expiresAt) ||
              request.expiresAt <= now)
          )
            return memoryFailure(
              "invalid_request",
              "Memory expiry is invalid.",
            );
          if (
            request.kind.id === coreMemoryKinds.ephemeralNote.id &&
            request.expiresAt === undefined
          )
            return memoryFailure(
              "invalid_request",
              "Ephemeral Memory requires expiry.",
            );
          if (typeof request.content !== "string")
            return memoryFailure(
              "invalid_request",
              "Memory content is invalid.",
            );
          const scanned = redactMemoryContent(request.content, exactCanaries);
          if (!scanned.ok) return scanned;
          const content = scanned.value.content.trim();
          if (
            Buffer.byteLength(content) >
            (options.limits?.maxContentBytes ?? 16 * 1024)
          )
            return memoryFailure(
              "content_too_large",
              "Memory content exceeds size limit.",
            );
          if (!content || content === "[REDACTED]")
            return memoryFailure(
              "content_empty_after_redaction",
              "Memory content is empty after redaction.",
            );
          const sanitizedCitations = sanitizeCitationInputs(
            request.citations,
            (options.limits?.maxCitations ?? 16) - 1,
            options.limits?.maxCitationBytes ?? 4 * 1024,
            exactCanaries,
          );
          if (!sanitizedCitations.ok) return sanitizedCitations;
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify({
                kind: request.kind,
                scope: scope.value,
                content,
                citations: sanitizedCitations.value ?? [],
                expiresAt: request.expiresAt ?? null,
                attributes: request.attributes ?? null,
              }),
            )
            .digest("hex");
          const priorReceipt = await options.persistence.getReceipt(
            request.requestId,
          );
          if (!priorReceipt.ok)
            return memoryFailure(
              "storage_failed",
              "Memory receipt lookup failed.",
              priorReceipt.error.retryable,
            );
          if (priorReceipt.value) {
            if (
              priorReceipt.value.operation !== "remember" ||
              priorReceipt.value.fingerprint !== fingerprint ||
              typeof priorReceipt.value.memoryId !== "string"
            )
              return memoryFailure(
                "invalid_request",
                "Memory request ID was already used for different intent.",
              );
            const prior = await options.persistence.get(
              priorReceipt.value.memoryId,
            );
            if (!prior.ok || !prior.value)
              return memoryFailure(
                "storage_failed",
                "Memory idempotency receipt is inconsistent.",
                true,
              );
            return success({
              state:
                priorReceipt.value.state ??
                (prior.value.memory.status === "active"
                  ? "created"
                  : "review-required"),
              memory: prior.value.memory,
              ...(priorReceipt.value.duplicateOf
                ? { duplicateOf: priorReceipt.value.duplicateOf }
                : {}),
              contradictionIds: prior.value.memory.relationships
                .filter(({ kind }) => kind === "pi/contradicts")
                .map(({ targetId }) => targetId),
              redactions: scanned.value.redactions,
              replayed: true,
            } as const);
          }
          const normalized = normalizedContent(content);
          const candidates = await options.persistence.findCandidates(
            scope.value,
            request.kind,
            candidateLimit(options),
          );
          if (!candidates.ok)
            return memoryFailure(
              "storage_failed",
              "Memory candidate lookup failed.",
              candidates.error.retryable,
            );
          const claim = contradictionClaim(content);
          const liveCandidates = candidates.value.filter(
            ({ memory }) =>
              memory.expiresAt === undefined || memory.expiresAt > now,
          );
          const duplicate = liveCandidates.find((candidate) => {
            const otherClaim = contradictionClaim(candidate.memory.content);
            if (
              claim &&
              otherClaim?.subject === claim.subject &&
              otherClaim.value !== claim.value
            )
              return false;
            return (
              candidate.normalizedContent === normalized ||
              isConservativeNearDuplicate(
                candidate.normalizedContent,
                normalized,
              )
            );
          });
          if (duplicate) {
            if (
              binding.ingress === "direct-user" &&
              duplicate.memory.status === "review"
            ) {
              const authorityBeforeTakeover = await refreshBinding();
              if (!authorityBeforeTakeover.ok) return authorityBeforeTakeover;
              const takeover: MemoryRecord = {
                ...duplicate.memory,
                revision: duplicate.memory.revision + 1,
                provenance: {
                  ingress: "direct-user",
                  ...(binding.sessionId
                    ? { sessionId: binding.sessionId }
                    : {}),
                  executionRole: binding.executionRole,
                },
                confidence: 1,
                status: "active",
                relationships: [],
                updatedAt: now,
              };
              if (!safePersistedStructure(takeover, exactCanaries))
                return memoryFailure(
                  "secret_redaction_failed",
                  "Memory contains sensitive metadata.",
                );
              const updated = await options.persistence.update(
                {
                  ...duplicate,
                  memory: takeover,
                  revisions: [...duplicate.revisions, takeover],
                },
                duplicate.memory.revision,
                {
                  requestId: request.requestId,
                  operation: "remember",
                  fingerprint,
                  memoryId: takeover.id,
                  state: "created",
                  revision: takeover.revision,
                },
                [],
              );
              if (!updated.ok) {
                const raced = await options.persistence.getReceipt(
                  request.requestId,
                );
                if (
                  raced.ok &&
                  raced.value?.operation === "remember" &&
                  raced.value.fingerprint === fingerprint &&
                  raced.value.memoryId === takeover.id
                ) {
                  const replayed = await options.persistence.get(takeover.id);
                  if (replayed.ok && replayed.value)
                    return success({
                      state: raced.value.state ?? "created",
                      memory: replayed.value.memory,
                      contradictionIds: replayed.value.memory.relationships
                        .filter(({ kind }) => kind === "pi/contradicts")
                        .map(({ targetId }) => targetId),
                      redactions: scanned.value.redactions,
                      replayed: true,
                    } as const);
                }
                if (raced.ok && raced.value)
                  return memoryFailure(
                    "invalid_request",
                    "Memory request ID was already used for different intent.",
                  );
                return memoryFailure(
                  "storage_failed",
                  "Memory persistence failed.",
                  updated.error.retryable,
                );
              }
              return success({
                state: "created" as const,
                memory: updated.value.memory,
                contradictionIds: updated.value.memory.relationships
                  .filter(({ kind }) => kind === "pi/contradicts")
                  .map(({ targetId }) => targetId),
                redactions: scanned.value.redactions,
                replayed: false,
              });
            }
            const receipt = {
              requestId: request.requestId,
              operation: "remember" as const,
              fingerprint,
              memoryId: duplicate.memory.id,
              state: "duplicate" as const,
              duplicateOf: duplicate.memory.id,
            };
            const authorityBeforeReceipt = await refreshBinding();
            if (!authorityBeforeReceipt.ok) return authorityBeforeReceipt;
            const saved = await options.persistence.saveReceipt(receipt);
            if (!saved.ok)
              return saved.error.code === "revision_conflict"
                ? memoryFailure(
                    "invalid_request",
                    "Memory request ID was already used for different intent.",
                  )
                : memoryFailure(
                    "storage_failed",
                    "Memory persistence failed.",
                    saved.error.retryable,
                  );
            return success({
              state: saved.value.receipt.state ?? "duplicate",
              memory: duplicate.memory,
              ...(saved.value.receipt.duplicateOf
                ? { duplicateOf: saved.value.receipt.duplicateOf }
                : {}),
              contradictionIds: duplicate.memory.relationships
                .filter(({ kind }) => kind === "pi/contradicts")
                .map(({ targetId }) => targetId),
              redactions: scanned.value.redactions,
              replayed: saved.value.replayed,
            });
          }
          const contradictionIds =
            binding.ingress === "direct-user" && claim
              ? liveCandidates
                  .filter((candidate) => {
                    if (candidate.memory.status !== "active") return false;
                    const other = contradictionClaim(candidate.memory.content);
                    return (
                      other?.subject === claim.subject &&
                      other.value !== claim.value
                    );
                  })
                  .map(({ memory }) => memory.id)
              : [];
          const memoryId = id();
          const citations: MemoryCitation[] = [
            ...(sanitizedCitations.value ?? []).map((citation) => ({
              id: id(),
              kind: citation.kind,
              locator: structuredClone(citation.locator),
              ...(citation.excerpt === undefined
                ? {}
                : { excerpt: citation.excerpt }),
              recordedAt: now,
              trust: "untrusted" as const,
            })),
            {
              id: id(),
              kind: "session-entry",
              locator: {
                ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
                ...(binding.sourceEntryId
                  ? { entryId: binding.sourceEntryId }
                  : {}),
              },
              recordedAt: now,
              trust: "untrusted" as const,
            },
          ];
          const memory: MemoryRecord = {
            id: memoryId,
            revision: 1,
            kind: { ...request.kind },
            scope: scope.value,
            content,
            citations,
            provenance: {
              ingress: binding.ingress,
              ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
              executionRole: binding.executionRole,
            },
            confidence: binding.ingress === "direct-user" ? 1 : 0.5,
            status: binding.ingress === "direct-user" ? "active" : "review",
            relationships: contradictionIds.map((targetId) => ({
              kind: "pi/contradicts" as const,
              targetId,
            })),
            createdAt: now,
            updatedAt: now,
            ...(request.expiresAt === undefined
              ? {}
              : { expiresAt: request.expiresAt }),
            trust: "untrusted",
            authority: "none",
          };
          if (!safePersistedStructure(memory, exactCanaries))
            return memoryFailure(
              "secret_redaction_failed",
              "Memory contains sensitive metadata.",
            );
          const authorityBeforeCreate = await refreshBinding();
          if (!authorityBeforeCreate.ok) return authorityBeforeCreate;
          const stored = await options.persistence.create(
            {
              memory,
              normalizedContent: normalized,
              contentDigest: createHash("sha256")
                .update(normalized)
                .digest("hex"),
              revisions: [memory],
            },
            {
              requestId: request.requestId,
              operation: "remember",
              fingerprint,
              memoryId,
              state: memory.status === "active" ? "created" : "review-required",
              revision: memory.revision,
            },
            contradictionIds,
            candidateLimit(options),
          );
          if (!stored.ok)
            return stored.error.code === "revision_conflict"
              ? memoryFailure(
                  "invalid_request",
                  "Memory request ID was already used for different intent.",
                )
              : memoryFailure(
                  "storage_failed",
                  "Memory creation failed.",
                  stored.error.retryable,
                );
          if (!stored.value.created)
            return success({
              state: stored.value.receipt.state ?? "duplicate",
              memory: stored.value.existing.memory,
              ...(stored.value.receipt.duplicateOf
                ? { duplicateOf: stored.value.receipt.duplicateOf }
                : {}),
              contradictionIds: stored.value.existing.memory.relationships
                .filter(({ kind }) => kind === "pi/contradicts")
                .map(({ targetId }) => targetId),
              redactions: scanned.value.redactions,
              replayed: stored.value.replayed,
            });
          return success({
            state: memory.status === "active" ? "created" : "review-required",
            memory,
            contradictionIds,
            redactions: scanned.value.redactions,
            replayed: false,
          } as const);
        },
        async inspect(
          request: Parameters<import("./model.ts").MemoryStore["inspect"]>[0],
        ) {
          const authority = await refreshBinding();
          if (!authority.ok) return authority;
          if (!request || typeof request !== "object")
            return memoryFailure(
              "invalid_request",
              "Memory inspection is invalid.",
            );
          if (!("id" in request)) {
            if (
              !hasOnlyKeys(request, [
                "scope",
                "status",
                "kind",
                "cursor",
                "limit",
              ]) ||
              (request.scope !== undefined &&
                !["user", "project", "workspace"].includes(request.scope)) ||
              (request.status !== undefined &&
                request.status !== "active" &&
                request.status !== "review")
            )
              return memoryFailure(
                "invalid_request",
                "Memory inspection is invalid.",
              );
            const limit = request.limit ?? 25;
            if (
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > (options.limits?.maxInspectLimit ?? 100) ||
              (request.cursor !== undefined &&
                (typeof request.cursor !== "string" ||
                  !request.cursor ||
                  Buffer.byteLength(request.cursor) > 512))
            )
              return memoryFailure(
                "invalid_request",
                "Memory inspection page is invalid.",
              );
            if (
              request.kind &&
              !supportedKinds.has(`${request.kind.id}\0${request.kind.version}`)
            )
              return memoryFailure(
                "unsupported_kind",
                "Memory kind is not supported.",
              );
            const selectors = request.scope
              ? [request.scope]
              : [
                  ...(binding.workspace ? (["workspace"] as const) : []),
                  ...(binding.project ? (["project"] as const) : []),
                  "user" as const,
                ];
            const scopes: MemoryRecord["scope"][] = [];
            for (const selector of selectors) {
              const resolved = resolveScope(binding, selector, clock());
              if (!resolved.ok) return resolved;
              scopes.push(resolved.value);
            }
            const listed = await options.persistence.list({
              scopes,
              ...(request.status ? { status: request.status } : {}),
              ...(request.kind ? { kind: request.kind } : {}),
              ...(request.cursor ? { afterId: request.cursor } : {}),
              limit: limit + 1,
            });
            if (!listed.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                listed.error.retryable,
              );
            const page = listed.value.slice(0, limit);
            return success({
              memories: page.map(({ memory }) => memory),
              ...(listed.value.length > limit && page.length
                ? { nextCursor: page.at(-1)!.memory.id }
                : {}),
            });
          }
          if (
            !hasOnlyKeys(request, ["id", "includeRevisions"]) ||
            typeof request.id !== "string" ||
            !request.id ||
            Buffer.byteLength(request.id) > 512 ||
            (request.includeRevisions !== undefined &&
              typeof request.includeRevisions !== "boolean")
          )
            return memoryFailure(
              "invalid_request",
              "Memory inspection is invalid.",
            );
          const stored = await options.persistence.get(request.id);
          if (!stored.ok)
            return memoryFailure(
              "storage_failed",
              "Memory persistence failed.",
              stored.error.retryable,
            );
          if (!stored.value)
            return memoryFailure("memory_not_found", "Memory was not found.");
          const access = canAccessMemory(binding, stored.value.memory, clock());
          if (!access.ok) return access;
          return success({
            memories: request.includeRevisions
              ? stored.value.revisions
              : [stored.value.memory],
          });
        },
        async search(
          request: Parameters<import("./model.ts").MemoryStore["search"]>[0],
          signal?: AbortSignal,
        ) {
          const authority = await refreshBinding();
          if (!authority.ok) return authority;
          if (signal?.aborted)
            return memoryFailure("cancelled", "Memory search was cancelled.");
          if (
            !request ||
            typeof request !== "object" ||
            !hasOnlyKeys(request, [
              "text",
              "ranking",
              "within",
              "kinds",
              "limit",
              "asOf",
            ]) ||
            (request.ranking !== undefined &&
              request.ranking !== "relevant" &&
              request.ranking !== "recent" &&
              request.ranking !== "exact") ||
            (request.within !== undefined &&
              (!Array.isArray(request.within) ||
                request.within.length > 3 ||
                request.within.some(
                  (scope) =>
                    scope !== "user" &&
                    scope !== "project" &&
                    scope !== "workspace",
                ))) ||
            (request.kinds !== undefined && !Array.isArray(request.kinds)) ||
            typeof request.text !== "string" ||
            !request.text.trim() ||
            Buffer.byteLength(request.text) >
              (options.limits?.maxQueryBytes ?? 2 * 1024)
          )
            return memoryFailure("invalid_request", "Memory query is invalid.");
          const limit = request.limit ?? 8;
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > (options.limits?.maxSearchLimit ?? 20)
          )
            return memoryFailure(
              "invalid_request",
              "Memory search limit is invalid.",
            );
          const selectors = request.within ?? [
            ...(binding.workspace ? (["workspace"] as const) : []),
            ...(binding.project ? (["project"] as const) : []),
            "user" as const,
          ];
          const scopes: import("./model.ts").MemoryRecord["scope"][] = [];
          for (const selector of selectors) {
            const resolved = resolveScope(binding, selector, clock());
            if (!resolved.ok) return resolved;
            if (!scopes.some((scope) => sameScope(scope, resolved.value)))
              scopes.push(resolved.value);
          }
          if (
            request.kinds?.some(
              ({ id, version }) => !supportedKinds.has(`${id}\0${version}`),
            )
          )
            return memoryFailure(
              "unsupported_kind",
              "Memory kind is not supported.",
            );
          const asOf = request.asOf ?? clock();
          if (!Number.isSafeInteger(asOf))
            return memoryFailure(
              "invalid_request",
              "Memory search time is invalid.",
            );
          const candidates = await options.persistence.search({
            text: request.text,
            scopes,
            ...(request.kinds ? { kinds: request.kinds } : {}),
            ranking: request.ranking ?? "relevant",
            limit,
            asOf,
          });
          if (!candidates.ok)
            return memoryFailure(
              "index_unavailable",
              "Memory index is unavailable.",
              candidates.error.retryable,
            );
          const maxExcerptBytes = options.limits?.maxExcerptBytes ?? 1024;
          const maxContextBytes = options.limits?.maxContextBytes ?? 32 * 1024;
          const hits: import("./model.ts").MemoryHit[] = [];
          for (const candidate of candidates.value) {
            const memory = candidate.entry.memory;
            if (
              memory.status !== "active" ||
              (memory.expiresAt !== undefined && memory.expiresAt <= asOf) ||
              !scopes.some((scope) => sameScope(scope, memory.scope))
            )
              continue;
            let excerpt = memory.content;
            while (Buffer.byteLength(excerpt) > maxExcerptBytes)
              excerpt = excerpt.slice(0, -1);
            const hit = {
              memory,
              rank: candidate.score,
              excerpt,
              reasons: candidate.reasons,
            };
            if (
              Buffer.byteLength(
                JSON.stringify(success([...hits, hit] as const)),
              ) > maxContextBytes
            )
              break;
            hits.push(hit);
          }
          return success(hits);
        },
        async change(
          request: Parameters<import("./model.ts").MemoryStore["change"]>[0],
          signal?: AbortSignal,
        ) {
          const authority = await refreshBinding();
          if (!authority.ok) return authority;
          if (signal?.aborted)
            return memoryFailure("cancelled", "Memory change was cancelled.");
          if (
            !request ||
            typeof request !== "object" ||
            !validRequestId(request.requestId, exactCanaries) ||
            typeof request.id !== "string" ||
            !request.id ||
            !["replace", "forget", "promote"].includes(request.type) ||
            (request.expectedRevision !== undefined &&
              (!Number.isSafeInteger(request.expectedRevision) ||
                request.expectedRevision < 1)) ||
            !hasOnlyKeys(
              request,
              request.type === "replace"
                ? [
                    "type",
                    "requestId",
                    "id",
                    "expectedRevision",
                    "content",
                    "citations",
                    "expiresAt",
                  ]
                : request.type === "forget"
                  ? ["type", "requestId", "id", "expectedRevision"]
                  : ["type", "requestId", "id", "expectedRevision"],
            )
          )
            return memoryFailure(
              "invalid_request",
              "Memory change is invalid.",
            );
          if (request.type === "forget") {
            const fingerprint = createHash("sha256")
              .update(
                JSON.stringify({
                  type: request.type,
                  id: request.id,
                  expectedRevision: request.expectedRevision ?? null,
                }),
              )
              .digest("hex");
            const priorReceipt = await options.persistence.getReceipt(
              request.requestId,
            );
            if (!priorReceipt.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                priorReceipt.error.retryable,
              );
            if (priorReceipt.value) {
              if (
                priorReceipt.value.operation !== "forget" ||
                priorReceipt.value.fingerprint !== fingerprint ||
                priorReceipt.value.memoryId !== request.id ||
                priorReceipt.value.forgottenAt === undefined
              )
                return memoryFailure(
                  "invalid_request",
                  "Memory request ID was already used for different intent.",
                );
              return success({
                type: "forget" as const,
                id: request.id,
                forgottenAt: priorReceipt.value.forgottenAt,
                replayed: true,
              });
            }
            const current = await options.persistence.get(request.id);
            if (!current.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                current.error.retryable,
              );
            if (!current.value)
              return memoryFailure("memory_not_found", "Memory was not found.");
            const access = canAccessMemory(
              binding,
              current.value.memory,
              clock(),
            );
            if (!access.ok) return access;
            if (
              request.expectedRevision !== undefined &&
              current.value.memory.revision !== request.expectedRevision
            )
              return memoryFailure(
                "revision_conflict",
                "Memory revision changed.",
              );
            const forgottenAt = clock();
            const authorityBeforeForget = await refreshBinding();
            if (!authorityBeforeForget.ok) return authorityBeforeForget;
            const deleted = await options.persistence.forget(
              request.id,
              request.expectedRevision,
              {
                requestId: request.requestId,
                operation: "forget",
                fingerprint,
                memoryId: request.id,
                forgottenAt,
              },
            );
            if (!deleted.ok) {
              const raced = await options.persistence.getReceipt(
                request.requestId,
              );
              if (
                raced.ok &&
                raced.value?.operation === "forget" &&
                raced.value.fingerprint === fingerprint &&
                raced.value.memoryId === request.id &&
                raced.value.forgottenAt !== undefined
              )
                return success({
                  type: "forget" as const,
                  id: request.id,
                  forgottenAt: raced.value.forgottenAt,
                  replayed: true,
                });
              if (raced.ok && raced.value)
                return memoryFailure(
                  "invalid_request",
                  "Memory request ID was already used for different intent.",
                );
              return deleted.error.code === "revision_conflict"
                ? memoryFailure("revision_conflict", "Memory revision changed.")
                : memoryFailure(
                    "storage_failed",
                    "Memory persistence failed before complete deletion.",
                    deleted.error.retryable,
                  );
            }
            return success({
              type: "forget" as const,
              id: request.id,
              forgottenAt,
              replayed: false,
            });
          }
          if (request.type === "promote" && binding.ingress !== "direct-user")
            return memoryFailure(
              "import_requires_direct_user",
              "Only direct-user ingress can promote reviewed Memory.",
            );
          const current = await options.persistence.get(request.id);
          if (!current.ok)
            return memoryFailure(
              "storage_failed",
              "Memory persistence failed.",
              current.error.retryable,
            );
          if (!current.value)
            return memoryFailure("memory_not_found", "Memory was not found.");
          const access = canAccessMemory(
            binding,
            current.value.memory,
            clock(),
          );
          if (!access.ok) return access;

          let content = current.value.memory.content;
          let sanitizedCitations: readonly MemoryCitationInput[] | undefined;
          if (request.type === "replace") {
            if (typeof request.content !== "string")
              return memoryFailure(
                "invalid_request",
                "Memory content is invalid.",
              );
            const scanned = redactMemoryContent(request.content, exactCanaries);
            if (!scanned.ok) return scanned;
            content = scanned.value.content.trim();
            if (
              Buffer.byteLength(content) >
              (options.limits?.maxContentBytes ?? 16 * 1024)
            )
              return memoryFailure(
                "content_too_large",
                "Memory content exceeds size limit.",
              );
            if (!content || content === "[REDACTED]")
              return memoryFailure(
                "content_empty_after_redaction",
                "Memory content is empty after redaction.",
              );
            const sanitized = sanitizeCitationInputs(
              request.citations,
              (options.limits?.maxCitations ?? 16) - 1,
              options.limits?.maxCitationBytes ?? 4 * 1024,
              exactCanaries,
            );
            if (!sanitized.ok) return sanitized;
            sanitizedCitations = sanitized.value;
            const proposedExpiry =
              request.expiresAt === undefined
                ? current.value.memory.expiresAt
                : request.expiresAt === null
                  ? undefined
                  : request.expiresAt;
            if (
              proposedExpiry !== undefined &&
              (!Number.isSafeInteger(proposedExpiry) ||
                proposedExpiry <= clock())
            )
              return memoryFailure(
                "invalid_request",
                "Memory expiry is invalid.",
              );
            if (
              current.value.memory.kind.id ===
                coreMemoryKinds.ephemeralNote.id &&
              proposedExpiry === undefined
            )
              return memoryFailure(
                "invalid_request",
                "Ephemeral Memory requires expiry.",
              );
          }
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify({
                type: request.type,
                id: request.id,
                expectedRevision: request.expectedRevision,
                content,
                ...(request.type === "replace"
                  ? {
                      citations: sanitizedCitations ?? null,
                      expiresAt: request.expiresAt ?? null,
                    }
                  : {}),
              }),
            )
            .digest("hex");
          const priorReceipt = await options.persistence.getReceipt(
            request.requestId,
          );
          if (!priorReceipt.ok)
            return memoryFailure(
              "storage_failed",
              "Memory persistence failed.",
              priorReceipt.error.retryable,
            );
          if (priorReceipt.value) {
            if (
              priorReceipt.value.operation !== request.type ||
              priorReceipt.value.fingerprint !== fingerprint ||
              priorReceipt.value.memoryId !== request.id
            )
              return memoryFailure(
                "invalid_request",
                "Memory request ID was already used for different intent.",
              );
            const replayedMemory = priorReceipt.value.revision
              ? current.value.revisions.find(
                  ({ revision }) => revision === priorReceipt.value!.revision,
                )
              : current.value.memory;
            if (!replayedMemory)
              return memoryFailure(
                "storage_failed",
                "Memory idempotency receipt is inconsistent.",
                true,
              );
            return success({
              type: request.type,
              memory: replayedMemory,
              replayed: true,
            } as const);
          }
          if (current.value.memory.revision !== request.expectedRevision)
            return memoryFailure(
              "revision_conflict",
              "Memory revision changed.",
            );
          if (
            request.type === "promote" &&
            current.value.memory.status !== "review"
          )
            return memoryFailure(
              "invalid_request",
              "Only reviewed Memory can be promoted.",
            );
          const now = clock();
          const citations =
            request.type === "replace" && sanitizedCitations
              ? [
                  ...sanitizedCitations.map((citation) => ({
                    id: id(),
                    kind: citation.kind,
                    locator: structuredClone(citation.locator),
                    ...(citation.excerpt === undefined
                      ? {}
                      : { excerpt: citation.excerpt }),
                    recordedAt: now,
                    trust: "untrusted" as const,
                  })),
                  {
                    id: id(),
                    kind: "session-entry",
                    locator: {
                      ...(binding.sessionId
                        ? { sessionId: binding.sessionId }
                        : {}),
                      ...(binding.sourceEntryId
                        ? { entryId: binding.sourceEntryId }
                        : {}),
                    },
                    recordedAt: now,
                    trust: "untrusted" as const,
                  },
                ]
              : current.value.memory.citations;
          const expiresAt =
            request.type === "replace"
              ? request.expiresAt === undefined
                ? current.value.memory.expiresAt
                : request.expiresAt === null
                  ? undefined
                  : request.expiresAt
              : current.value.memory.expiresAt;
          let contradictionIds: readonly string[] | undefined;
          if (request.type === "replace") {
            const candidates = await options.persistence.findCandidates(
              current.value.memory.scope,
              current.value.memory.kind,
              candidateLimit(options),
            );
            if (!candidates.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                candidates.error.retryable,
              );
            const claim = contradictionClaim(content);
            contradictionIds = claim
              ? candidates.value
                  .filter((candidate) => {
                    if (
                      candidate.memory.id === current.value!.memory.id ||
                      candidate.memory.status !== "active" ||
                      (candidate.memory.expiresAt !== undefined &&
                        candidate.memory.expiresAt <= now)
                    )
                      return false;
                    const other = contradictionClaim(candidate.memory.content);
                    return (
                      other?.subject === claim.subject &&
                      other.value !== claim.value
                    );
                  })
                  .map(({ memory }) => memory.id)
              : [];
          } else if (request.type === "promote") {
            contradictionIds = [];
          }
          const memory: MemoryRecord = {
            ...current.value.memory,
            revision: current.value.memory.revision + 1,
            content,
            citations,
            status:
              request.type === "promote"
                ? "active"
                : current.value.memory.status,
            relationships:
              contradictionIds?.map((targetId) => ({
                kind: "pi/contradicts" as const,
                targetId,
              })) ?? current.value.memory.relationships,
            updatedAt: now,
            ...(expiresAt === undefined
              ? { expiresAt: undefined }
              : { expiresAt }),
          };
          const normalized = normalizedContent(content);
          const entry = {
            memory,
            normalizedContent: normalized,
            contentDigest: createHash("sha256")
              .update(normalized)
              .digest("hex"),
            revisions: [...current.value.revisions, memory],
          };
          if (!safePersistedStructure(entry, exactCanaries))
            return memoryFailure(
              "secret_redaction_failed",
              "Memory contains sensitive metadata.",
            );
          const authorityBeforeUpdate = await refreshBinding();
          if (!authorityBeforeUpdate.ok) return authorityBeforeUpdate;
          const updated = await options.persistence.update(
            entry,
            request.expectedRevision,
            {
              requestId: request.requestId,
              operation: request.type,
              fingerprint,
              memoryId: request.id,
              revision: memory.revision,
            },
            contradictionIds,
          );
          if (!updated.ok) {
            const raced = await options.persistence.getReceipt(
              request.requestId,
            );
            if (
              raced.ok &&
              raced.value?.operation === request.type &&
              raced.value.fingerprint === fingerprint &&
              raced.value.memoryId === request.id &&
              raced.value.revision !== undefined
            ) {
              const replayed = await options.persistence.get(request.id);
              const replayedMemory = replayed.ok
                ? replayed.value?.revisions.find(
                    ({ revision }) => revision === raced.value!.revision,
                  )
                : undefined;
              if (replayedMemory)
                return success({
                  type: request.type,
                  memory: replayedMemory,
                  replayed: true,
                } as const);
            }
            if (raced.ok && raced.value)
              return memoryFailure(
                "invalid_request",
                "Memory request ID was already used for different intent.",
              );
            return updated.error.code === "revision_conflict"
              ? memoryFailure("revision_conflict", "Memory revision changed.")
              : memoryFailure(
                  "storage_failed",
                  "Memory persistence failed.",
                  updated.error.retryable,
                );
          }
          return success({
            type: request.type,
            memory: updated.value.memory,
            replayed: false,
          } as const);
        },
        async transfer(
          request: Parameters<import("./model.ts").MemoryStore["transfer"]>[0],
          signal?: AbortSignal,
        ) {
          const authority = await refreshBinding();
          if (!authority.ok) return authority;
          if (signal?.aborted)
            return memoryFailure("cancelled", "Memory transfer was cancelled.");
          if (
            !request ||
            typeof request !== "object" ||
            !validRequestId(request.requestId, exactCanaries) ||
            !["export", "preview-import", "commit-import"].includes(
              request.type,
            ) ||
            !hasOnlyKeys(
              request,
              request.type === "export"
                ? ["type", "requestId", "format", "scopes", "kinds"]
                : request.type === "preview-import"
                  ? ["type", "requestId", "artifactId", "format", "targetScope"]
                  : [
                      "type",
                      "requestId",
                      "previewId",
                      "expectedManifestSha256",
                      "collisions",
                    ],
            )
          )
            return memoryFailure(
              "invalid_request",
              "Memory transfer is invalid.",
            );
          const format =
            request.type === "export"
              ? request.format
              : request.type === "preview-import"
                ? (request.format ?? { id: "pi.memory-bundle", version: 1 })
                : { id: "pi.memory-bundle", version: 1 };
          if (
            !format ||
            typeof format !== "object" ||
            format.id !== "pi.memory-bundle" ||
            format.version !== 1
          )
            return memoryFailure(
              "unsupported_format",
              "Memory transfer format is not supported.",
            );

          if (request.type === "export") {
            if (
              (request.scopes !== undefined &&
                (!Array.isArray(request.scopes) ||
                  request.scopes.length > 3 ||
                  request.scopes.some(
                    (scope) =>
                      scope !== "user" &&
                      scope !== "project" &&
                      scope !== "workspace",
                  ))) ||
              (request.kinds !== undefined && !Array.isArray(request.kinds))
            )
              return memoryFailure(
                "invalid_request",
                "Memory export is invalid.",
              );
            const selectors = request.scopes ?? [
              ...(binding.workspace ? (["workspace"] as const) : []),
              ...(binding.project ? (["project"] as const) : []),
              "user" as const,
            ];
            const scopes: MemoryRecord["scope"][] = [];
            for (const selector of selectors) {
              const resolved = resolveScope(binding, selector, clock());
              if (!resolved.ok) return resolved;
              scopes.push(resolved.value);
            }
            if (
              request.kinds?.some(
                ({ id: kindId, version }) =>
                  !supportedKinds.has(`${kindId}\0${version}`),
              )
            )
              return memoryFailure(
                "unsupported_kind",
                "Memory kind is not supported.",
              );
            const fingerprint = createHash("sha256")
              .update(
                JSON.stringify({
                  type: request.type,
                  format,
                  scopes,
                  kinds: request.kinds ?? [],
                }),
              )
              .digest("hex");
            const prior = await options.persistence.getReceipt(
              request.requestId,
            );
            if (!prior.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                prior.error.retryable,
              );
            if (prior.value) {
              if (
                prior.value.operation !== "export" ||
                prior.value.fingerprint !== fingerprint ||
                typeof prior.value.details?.artifactId !== "string" ||
                typeof prior.value.details.count !== "number"
              )
                return memoryFailure(
                  "invalid_request",
                  "Memory request ID was already used for different intent.",
                );
              const artifact = await options.artifacts.get(
                prior.value.details.artifactId,
              );
              if (!artifact.ok)
                return memoryFailure(
                  "artifact_failed",
                  "Memory export Artifact is unavailable.",
                  artifact.error.retryable,
                );
              return success({
                type: "export" as const,
                artifact: artifact.value.metadata,
                count: prior.value.details.count,
                replayed: true,
              });
            }
            const listed = await options.persistence.list({
              scopes,
              status: "active",
              ...(request.kinds?.length === 1
                ? { kind: request.kinds[0] }
                : {}),
              limit: (options.limits?.maxTransferEntries ?? 10_000) + 1,
              asOf: clock(),
            });
            if (!listed.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                listed.error.retryable,
              );
            const selected = request.kinds?.length
              ? listed.value.filter(({ memory }) =>
                  request.kinds!.some(
                    ({ id: kindId, version }) =>
                      memory.kind.id === kindId &&
                      memory.kind.version === version,
                  ),
                )
              : listed.value;
            if (
              selected.length > (options.limits?.maxTransferEntries ?? 10_000)
            )
              return memoryFailure(
                "import_too_large",
                "Memory export has too many entries.",
              );
            const entryLines = selected.map(({ memory }) =>
              JSON.stringify({
                type: "memory",
                kind: memory.kind,
                scope: memory.scope.kind,
                content: memory.content,
                citations: memory.citations.map(
                  ({ kind, locator, excerpt }) => ({
                    kind,
                    locator,
                    ...(excerpt === undefined ? {} : { excerpt }),
                  }),
                ),
                provenance: memory.provenance,
                confidence: memory.confidence,
                createdAt: memory.createdAt,
                updatedAt: memory.updatedAt,
                ...(memory.expiresAt === undefined
                  ? {}
                  : { expiresAt: memory.expiresAt }),
                relationships: memory.relationships,
                trust: "untrusted",
                authority: "none",
              }),
            );
            const manifestSha256 = createHash("sha256")
              .update(entryLines.join("\n"))
              .digest("hex");
            const manifest = JSON.stringify({
              type: "manifest",
              format,
              count: entryLines.length,
              manifestSha256,
            });
            const body = `${manifest}\n${entryLines.join("\n")}${entryLines.length ? "\n" : ""}`;
            if (
              Buffer.byteLength(body) >
              (options.limits?.maxTransferBytes ?? 16 * 1024 * 1024)
            )
              return memoryFailure(
                "import_too_large",
                "Memory export exceeds transfer size limit.",
              );
            const authorityBeforeArtifact = await refreshBinding();
            if (!authorityBeforeArtifact.ok) return authorityBeforeArtifact;
            const artifact = await options.artifacts.put({
              body,
              filename: "memory-bundle-v1.jsonl",
              mediaType: "application/x-ndjson",
              metadata: {
                format: "pi.memory-bundle",
                version: 1,
                manifestSha256,
                warning:
                  "Export is an independent copy; forgetting Memory cannot retract it.",
              },
            });
            if (!artifact.ok)
              return memoryFailure(
                "artifact_failed",
                "Memory export Artifact could not be persisted.",
                artifact.error.retryable,
              );
            if (!safePersistedText(artifact.value.id, exactCanaries))
              return memoryFailure(
                "secret_redaction_failed",
                "Memory export identifier contains sensitive data.",
              );
            const authorityBeforeReceipt = await refreshBinding();
            if (!authorityBeforeReceipt.ok) return authorityBeforeReceipt;
            const saved = await options.persistence.saveReceipt({
              requestId: request.requestId,
              operation: "export",
              fingerprint,
              details: {
                artifactId: artifact.value.id,
                count: selected.length,
              },
            });
            if (!saved.ok)
              return saved.error.code === "revision_conflict"
                ? memoryFailure(
                    "invalid_request",
                    "Memory request ID was already used for different intent.",
                  )
                : memoryFailure(
                    "storage_failed",
                    "Memory export receipt could not be persisted.",
                    saved.error.retryable,
                  );
            return success({
              type: "export" as const,
              artifact: artifact.value,
              count: selected.length,
              replayed: saved.value.replayed,
            });
          }

          if (request.type === "preview-import") {
            if (
              typeof request.artifactId !== "string" ||
              !request.artifactId ||
              Buffer.byteLength(request.artifactId) > 512 ||
              !safePersistedText(request.artifactId, exactCanaries)
            )
              return memoryFailure(
                "invalid_request",
                "Memory import is invalid.",
              );
            const scope = resolveScope(binding, request.targetScope, clock());
            if (!scope.ok) return scope;
            const fingerprint = createHash("sha256")
              .update(
                JSON.stringify({
                  type: request.type,
                  artifactId: request.artifactId,
                  format,
                  scope: scope.value,
                }),
              )
              .digest("hex");
            const prior = await options.persistence.getReceipt(
              request.requestId,
            );
            if (!prior.ok)
              return memoryFailure(
                "storage_failed",
                "Memory persistence failed.",
                prior.error.retryable,
              );
            if (prior.value) {
              const details = prior.value.details;
              if (
                prior.value.operation !== "preview-import" ||
                prior.value.fingerprint !== fingerprint ||
                typeof details?.previewId !== "string" ||
                typeof details.manifestSha256 !== "string" ||
                typeof details.accepted !== "number" ||
                typeof details.duplicates !== "number" ||
                typeof details.contradictions !== "number" ||
                typeof details.unsupportedKinds !== "number" ||
                typeof details.expiresAt !== "number"
              )
                return memoryFailure(
                  "invalid_request",
                  "Memory request ID was already used for different intent.",
                );
              return success({
                type: "preview-import" as const,
                previewId: details.previewId,
                manifestSha256: details.manifestSha256,
                accepted: details.accepted,
                duplicates: details.duplicates,
                contradictions: details.contradictions,
                unsupportedKinds: details.unsupportedKinds,
                expiresAt: details.expiresAt,
                replayed: true,
              });
            }
            const artifact = await options.artifacts.get(request.artifactId);
            if (!artifact.ok)
              return memoryFailure(
                "artifact_failed",
                "Memory import Artifact is unavailable.",
                artifact.error.retryable,
              );
            if (
              artifact.value.body.byteLength >
              (options.limits?.maxTransferBytes ?? 16 * 1024 * 1024)
            )
              return memoryFailure(
                "import_too_large",
                "Memory import exceeds transfer size limit.",
              );
            let decoded: string;
            try {
              decoded = new TextDecoder("utf-8", { fatal: true }).decode(
                artifact.value.body,
              );
            } catch {
              return memoryFailure(
                "import_invalid",
                "Memory import is not valid UTF-8.",
              );
            }
            const lines = decoded.trimEnd().split("\n");
            if (
              lines.length < 1 ||
              lines.length - 1 > (options.limits?.maxTransferEntries ?? 10_000)
            )
              return memoryFailure(
                "import_too_large",
                "Memory import has too many entries.",
              );
            let manifest: unknown;
            try {
              manifest = JSON.parse(lines[0]!);
            } catch {
              return memoryFailure(
                "import_invalid",
                "Memory import manifest is invalid.",
              );
            }
            if (
              !manifest ||
              typeof manifest !== "object" ||
              Array.isArray(manifest)
            )
              return memoryFailure(
                "import_invalid",
                "Memory import manifest is invalid.",
              );
            const manifestRecord = manifest as Record<string, unknown>;
            const calculatedManifest = createHash("sha256")
              .update(lines.slice(1).join("\n"))
              .digest("hex");
            const manifestFormat = manifestRecord.format;
            if (
              manifestRecord.type !== "manifest" ||
              !manifestFormat ||
              typeof manifestFormat !== "object" ||
              Array.isArray(manifestFormat) ||
              (manifestFormat as Record<string, unknown>).id !==
                "pi.memory-bundle" ||
              (manifestFormat as Record<string, unknown>).version !== 1 ||
              manifestRecord.manifestSha256 !== calculatedManifest ||
              manifestRecord.count !== lines.length - 1
            )
              return memoryFailure(
                "import_manifest_changed",
                "Memory import manifest does not match bundle entries.",
              );
            const staged: import("./memory-persistence.ts").StagedMemoryEntry[] =
              [];
            let unsupportedKinds = 0;
            let duplicates = 0;
            let contradictions = 0;
            const now = clock();
            for (const line of lines.slice(1)) {
              let raw: unknown;
              try {
                raw = JSON.parse(line);
              } catch {
                return memoryFailure(
                  "import_invalid",
                  "Memory import entry is invalid.",
                );
              }
              const parsed = parseBundleMemory(raw);
              if (!parsed)
                return memoryFailure(
                  "import_invalid",
                  "Memory import entry is invalid.",
                );
              if (
                !supportedKinds.has(`${parsed.kind.id}\0${parsed.kind.version}`)
              ) {
                unsupportedKinds += 1;
                continue;
              }
              const scanned = redactMemoryContent(
                parsed.content,
                exactCanaries,
              );
              if (!scanned.ok) return scanned;
              const content = scanned.value.content.trim();
              if (
                Buffer.byteLength(content) >
                (options.limits?.maxContentBytes ?? 16 * 1024)
              )
                return memoryFailure(
                  "content_too_large",
                  "Imported Memory content exceeds size limit.",
                );
              if (!content || content === "[REDACTED]")
                return memoryFailure(
                  "content_empty_after_redaction",
                  "Imported Memory is empty after redaction.",
                );
              const importedCitations = sanitizeCitationInputs(
                parsed.citations,
                (options.limits?.maxCitations ?? 16) - 1,
                options.limits?.maxCitationBytes ?? 4 * 1024,
                exactCanaries,
              );
              if (!importedCitations.ok) return importedCitations;
              const normalized = normalizedContent(content);
              const candidates = await options.persistence.findCandidates(
                scope.value,
                parsed.kind,
                candidateLimit(options),
              );
              if (!candidates.ok)
                return memoryFailure(
                  "storage_failed",
                  "Memory persistence failed.",
                  candidates.error.retryable,
                );
              const comparisonCandidates = [
                ...candidates.value,
                ...staged
                  .filter(({ collision }) => !collision)
                  .map(({ entry }) => entry),
              ];
              const claim = contradictionClaim(content);
              const contradictionIds = claim
                ? comparisonCandidates
                    .filter((candidate) => {
                      const other = contradictionClaim(
                        candidate.memory.content,
                      );
                      return (
                        other?.subject === claim.subject &&
                        other.value !== claim.value
                      );
                    })
                    .map(({ memory }) => memory.id)
                : [];
              contradictions += contradictionIds.length > 0 ? 1 : 0;
              const collision = comparisonCandidates.some((candidate) => {
                const other = contradictionClaim(candidate.memory.content);
                if (
                  claim &&
                  other?.subject === claim.subject &&
                  other.value !== claim.value
                )
                  return false;
                return (
                  candidate.normalizedContent === normalized ||
                  isConservativeNearDuplicate(
                    candidate.normalizedContent,
                    normalized,
                  )
                );
              });
              if (collision) duplicates += 1;
              const memoryId = id();
              const citations: MemoryCitation[] = [
                ...(importedCitations.value ?? []).map((citation) => ({
                  id: id(),
                  kind: citation.kind,
                  locator: structuredClone(citation.locator),
                  ...(citation.excerpt === undefined
                    ? {}
                    : { excerpt: citation.excerpt }),
                  recordedAt: now,
                  trust: "untrusted" as const,
                })),
                {
                  id: id(),
                  kind: "artifact",
                  locator: { artifactId: request.artifactId },
                  recordedAt: now,
                  trust: "untrusted" as const,
                },
              ];
              const memory: MemoryRecord = {
                id: memoryId,
                revision: 1,
                kind: parsed.kind,
                scope: scope.value,
                content,
                citations,
                provenance: {
                  ingress: "import",
                  executionRole: binding.executionRole,
                  importedFrom: request.artifactId,
                  ...(binding.sessionId
                    ? { sessionId: binding.sessionId }
                    : {}),
                },
                confidence: 0.75,
                status: "active",
                relationships: contradictionIds.map((targetId) => ({
                  kind: "pi/contradicts",
                  targetId,
                })),
                createdAt: now,
                updatedAt: now,
                ...(parsed.expiresAt === undefined
                  ? {}
                  : { expiresAt: parsed.expiresAt }),
                trust: "untrusted",
                authority: "none",
              };
              staged.push({
                entry: {
                  memory,
                  normalizedContent: normalized,
                  contentDigest: createHash("sha256")
                    .update(normalized)
                    .digest("hex"),
                  revisions: [memory],
                },
                collision,
                contradictionIds,
              });
            }
            const previewId = id();
            const expiresAt = now + 15 * 60 * 1_000;
            const preview = {
              id: previewId,
              manifestSha256: calculatedManifest,
              scope: scope.value,
              entries: staged,
              unsupportedKinds,
              expiresAt,
            };
            if (!safePersistedStructure(preview, exactCanaries))
              return memoryFailure(
                "secret_redaction_failed",
                "Memory import preview contains sensitive metadata.",
              );
            const maxImportPreviewBytes =
              options.limits?.maxImportPreviewBytes ?? 8 * 1024 * 1024;
            if (
              Buffer.byteLength(JSON.stringify(preview)) > maxImportPreviewBytes
            )
              return memoryFailure(
                "import_too_large",
                "Memory import preview exceeds staged-body quota.",
              );
            const details = {
              previewId,
              manifestSha256: calculatedManifest,
              accepted: staged.length - duplicates,
              duplicates,
              contradictions,
              unsupportedKinds,
              expiresAt,
            };
            const authorityBeforePreview = await refreshBinding();
            if (!authorityBeforePreview.ok) return authorityBeforePreview;
            const saved = await options.persistence.savePreview(
              preview,
              {
                requestId: request.requestId,
                operation: "preview-import",
                fingerprint,
                details,
              },
              {
                now,
                maxCount: options.limits?.maxImportPreviewCount ?? 32,
                maxBytes: maxImportPreviewBytes,
              },
            );
            if (!saved.ok) {
              const raced = await options.persistence.getReceipt(
                request.requestId,
              );
              const racedDetails = raced.ok ? raced.value?.details : undefined;
              if (
                raced.ok &&
                raced.value?.operation === "preview-import" &&
                raced.value.fingerprint === fingerprint &&
                typeof racedDetails?.previewId === "string" &&
                typeof racedDetails.manifestSha256 === "string" &&
                typeof racedDetails.accepted === "number" &&
                typeof racedDetails.duplicates === "number" &&
                typeof racedDetails.contradictions === "number" &&
                typeof racedDetails.unsupportedKinds === "number" &&
                typeof racedDetails.expiresAt === "number"
              )
                return success({
                  type: "preview-import" as const,
                  previewId: racedDetails.previewId,
                  manifestSha256: racedDetails.manifestSha256,
                  accepted: racedDetails.accepted,
                  duplicates: racedDetails.duplicates,
                  contradictions: racedDetails.contradictions,
                  unsupportedKinds: racedDetails.unsupportedKinds,
                  expiresAt: racedDetails.expiresAt,
                  replayed: true,
                });
              if (raced.ok && raced.value)
                return memoryFailure(
                  "invalid_request",
                  "Memory request ID was already used for different intent.",
                );
              return memoryFailure(
                "storage_failed",
                "Memory import preview could not be persisted.",
                saved.error.retryable,
              );
            }
            return success({
              type: "preview-import" as const,
              ...details,
              replayed: false,
            });
          }

          if (
            typeof request.previewId !== "string" ||
            !request.previewId ||
            typeof request.expectedManifestSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.expectedManifestSha256) ||
            (request.collisions !== "skip" && request.collisions !== "review")
          )
            return memoryFailure(
              "invalid_request",
              "Memory import is invalid.",
            );
          if (binding.ingress !== "direct-user")
            return memoryFailure(
              "import_requires_direct_user",
              "Only direct-user ingress can commit Memory import.",
            );
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify({
                type: request.type,
                previewId: request.previewId,
                expectedManifestSha256: request.expectedManifestSha256,
                collisions: request.collisions,
              }),
            )
            .digest("hex");
          const prior = await options.persistence.getReceipt(request.requestId);
          if (!prior.ok)
            return memoryFailure(
              "storage_failed",
              "Memory persistence failed.",
              prior.error.retryable,
            );
          if (prior.value) {
            const details = prior.value.details;
            if (
              prior.value.operation !== "commit-import" ||
              prior.value.fingerprint !== fingerprint ||
              typeof details?.imported !== "number" ||
              typeof details.reviewRequired !== "number" ||
              typeof details.skipped !== "number"
            )
              return memoryFailure(
                "invalid_request",
                "Memory request ID was already used for different intent.",
              );
            return success({
              type: "commit-import" as const,
              imported: details.imported,
              reviewRequired: details.reviewRequired,
              skipped: details.skipped,
              replayed: true,
            });
          }
          const preview = await options.persistence.getPreview(
            request.previewId,
            clock(),
          );
          if (!preview.ok)
            return memoryFailure(
              "storage_failed",
              "Memory import preview could not be loaded.",
              preview.error.retryable,
            );
          if (!preview.value)
            return memoryFailure(
              "import_preview_expired",
              "Memory import preview is unavailable.",
            );
          if (preview.value.expiresAt <= clock())
            return memoryFailure(
              "import_preview_expired",
              "Memory import preview has expired.",
            );
          if (preview.value.manifestSha256 !== request.expectedManifestSha256)
            return memoryFailure(
              "import_manifest_changed",
              "Memory import manifest does not match preview.",
            );
          const accessProbe: MemoryRecord = {
            ...preview.value.entries[0]?.entry.memory,
            id: preview.value.entries[0]?.entry.memory.id ?? "preview",
            revision: 1,
            kind:
              preview.value.entries[0]?.entry.memory.kind ??
              coreMemoryKinds.ephemeralNote,
            scope: preview.value.scope,
            content:
              preview.value.entries[0]?.entry.memory.content ?? "preview",
            citations: preview.value.entries[0]?.entry.memory.citations ?? [],
            provenance: preview.value.entries[0]?.entry.memory.provenance ?? {
              ingress: "import",
              executionRole: binding.executionRole,
            },
            confidence: preview.value.entries[0]?.entry.memory.confidence ?? 0,
            status: "review",
            relationships: [],
            createdAt: clock(),
            updatedAt: clock(),
            trust: "untrusted",
            authority: "none",
          };
          const access = canAccessMemory(binding, accessProbe, clock());
          if (!access.ok) return access;
          const selected = preview.value.entries.flatMap((staged) => {
            if (!staged.collision) return [staged];
            if (request.collisions === "skip") return [];
            const memory = {
              ...staged.entry.memory,
              status: "review" as const,
            };
            return [
              {
                ...staged,
                entry: {
                  ...staged.entry,
                  memory,
                  revisions: [memory],
                },
              },
            ];
          });
          const reviewRequired = selected.filter(
            ({ entry }) => entry.memory.status === "review",
          ).length;
          const skipped =
            request.collisions === "skip"
              ? preview.value.entries.filter(({ collision }) => collision)
                  .length
              : 0;
          const details = {
            imported: selected.length - reviewRequired,
            reviewRequired,
            skipped,
          };
          if (!safePersistedStructure(selected, exactCanaries))
            return memoryFailure(
              "secret_redaction_failed",
              "Memory import contains sensitive metadata.",
            );
          const authorityBeforeImport = await refreshBinding();
          if (!authorityBeforeImport.ok) return authorityBeforeImport;
          const committed = await options.persistence.commitImport(
            request.previewId,
            selected,
            {
              requestId: request.requestId,
              operation: "commit-import",
              fingerprint,
              details,
            },
          );
          if (!committed.ok) {
            const raced = await options.persistence.getReceipt(
              request.requestId,
            );
            const racedDetails = raced.ok ? raced.value?.details : undefined;
            if (
              raced.ok &&
              raced.value?.operation === "commit-import" &&
              raced.value.fingerprint === fingerprint &&
              typeof racedDetails?.imported === "number" &&
              typeof racedDetails.reviewRequired === "number" &&
              typeof racedDetails.skipped === "number"
            )
              return success({
                type: "commit-import" as const,
                imported: racedDetails.imported,
                reviewRequired: racedDetails.reviewRequired,
                skipped: racedDetails.skipped,
                replayed: true,
              });
            if (raced.ok && raced.value)
              return memoryFailure(
                "invalid_request",
                "Memory request ID was already used for different intent.",
              );
            if (committed.error.code === "preview_expired")
              return memoryFailure(
                "import_preview_expired",
                "Memory import preview expired before commit.",
              );
            return memoryFailure(
              "storage_failed",
              "Memory import could not be committed atomically.",
              committed.error.retryable,
            );
          }
          return success({
            type: "commit-import" as const,
            ...details,
            replayed: false,
          });
        },
      };
    },
  };
}

export { coreMemoryKinds } from "./model.ts";
export type {
  HostMemoryBinding,
  HostMemoryBindingAssertion,
  HostMemoryBindingFactory,
  HostMemoryBindingFactoryOptions,
  MemoryChange,
  MemoryChangeResult,
  MemoryCitation,
  MemoryCitationInput,
  MemoryHit,
  MemoryInspection,
  MemoryInspectRequest,
  MemoryKindRef,
  MemoryRecord,
  MemoryRelationship,
  MemoryScopeSelector,
  MemorySearchRequest,
  MemoryStore,
  MemoryStoreError,
  MemoryStoreErrorCode,
  MemoryStoreLimits,
  MemoryStoreModule,
  MemoryStoreModuleOptions,
  MemoryStoreResult,
  MemoryTransferRequest,
  MemoryTransferResult,
  RememberReceipt,
  RememberRequest,
} from "./model.ts";
