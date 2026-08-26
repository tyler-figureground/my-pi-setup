import {
  hookEvents,
  type HookDefinition,
  type HookDiagnostic,
  type HookEvent,
  type HookProvenance,
  type HookRegistration,
  type MatcherValue,
  type TriggerEngineOptions,
} from "./model.ts";

export const defaultLimits = {
  maxHooks: 256,
  maxHooksPerDispatch: 64,
  maxEffectsPerDispatch: 64,
  dispatchTimeoutMs: 1_000,
  maxConfigBytes: 256 * 1024,
  maxConfigDepth: 24,
  maxConfigNodes: 10_000,
  maxMatchersPerHook: 32,
  maxHookTimeoutMs: 30_000,
  maxHookOutputBytes: 50 * 1024,
  maxLogEntries: 200,
  maxLogBytes: 128 * 1024,
} as const;

export function resolveLimits(options: TriggerEngineOptions) {
  const limits = {
    maxHooks: options.maxHooks ?? defaultLimits.maxHooks,
    maxHooksPerDispatch:
      options.maxHooksPerDispatch ?? defaultLimits.maxHooksPerDispatch,
    maxEffectsPerDispatch:
      options.maxEffectsPerDispatch ?? defaultLimits.maxEffectsPerDispatch,
    dispatchTimeoutMs:
      options.dispatchTimeoutMs ?? defaultLimits.dispatchTimeoutMs,
    maxConfigBytes: options.maxConfigBytes ?? defaultLimits.maxConfigBytes,
    maxConfigDepth: options.maxConfigDepth ?? defaultLimits.maxConfigDepth,
    maxConfigNodes: options.maxConfigNodes ?? defaultLimits.maxConfigNodes,
    maxMatchersPerHook:
      options.maxMatchersPerHook ?? defaultLimits.maxMatchersPerHook,
    maxHookTimeoutMs:
      options.maxHookTimeoutMs ?? defaultLimits.maxHookTimeoutMs,
    maxHookOutputBytes:
      options.maxHookOutputBytes ?? defaultLimits.maxHookOutputBytes,
    maxLogEntries: options.maxLogEntries ?? defaultLimits.maxLogEntries,
    maxLogBytes: options.maxLogBytes ?? defaultLimits.maxLogBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

const eventSet = new Set<string>(hookEvents);
const closedCapableEvents = new Set<HookEvent>([
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_before_tree",
  "context",
  "tool_call",
  "user_bash",
  "input",
]);
const contextEvents = new Set<HookEvent>(["before_agent_start", "context"]);
const policyEvents = new Set<HookEvent>([
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_before_tree",
  "tool_call",
  "user_bash",
  "input",
]);
const sensitiveKey =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)/gi;
const sensitiveAssignment =
  /\b(authorization|cookie|password|passwd|secret|token|api[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const sensitiveValue = /(?:bearer\s+)[a-z0-9._~+\-/]+=*/gi;

export function redact(value: string) {
  return value
    .replace(sensitiveAssignment, "$1=[REDACTED]")
    .replace(sensitiveValue, "Bearer [REDACTED]")
    .replace(sensitiveKey, "[REDACTED]");
}

export function containsSensitiveKey(value: string) {
  return /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)/i.test(
    value,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function measurePlainData(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
) {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > maxNodes)
      return { valid: false, reason: "node limit exceeded" };
    if (current.depth > maxDepth)
      return { valid: false, reason: "depth limit exceeded" };
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value))
        return { valid: false, reason: "non-finite number" };
      continue;
    }
    if (typeof current.value !== "object")
      return { valid: false, reason: "non-plain value" };
    if (seen.has(current.value))
      return { valid: false, reason: "cycle or repeated object reference" };
    seen.add(current.value);
    try {
      if (Array.isArray(current.value)) {
        if (Object.getPrototypeOf(current.value) !== Array.prototype) {
          return { valid: false, reason: "non-plain array" };
        }
        const descriptors = Object.getOwnPropertyDescriptors(current.value);
        const names = Object.keys(descriptors).filter(
          (name) => name !== "length",
        );
        if (
          Object.getOwnPropertySymbols(current.value).length > 0 ||
          names.length !== current.value.length ||
          names.some((name, index) => name !== String(index))
        ) {
          return { valid: false, reason: "sparse or decorated array" };
        }
        for (const name of names) {
          const descriptor = descriptors[name];
          if (!descriptor || !("value" in descriptor)) {
            return { valid: false, reason: "accessor property" };
          }
          stack.push({
            value: descriptor.value,
            depth: current.depth + 1,
          });
        }
        continue;
      }
      if (!isRecord(current.value))
        return { valid: false, reason: "non-plain object" };
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      if (
        Object.getOwnPropertySymbols(current.value).length > 0 ||
        Object.keys(descriptors).length !== Object.keys(current.value).length
      ) {
        return { valid: false, reason: "decorated object" };
      }
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor)) {
          return { valid: false, reason: "accessor property" };
        }
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
        });
      }
    } catch {
      return { valid: false, reason: "uninspectable object" };
    }
  }
  return { valid: true, nodes };
}

function diagnostic(
  provenance: HookProvenance,
  code: string,
  message: string,
  hookId?: string,
): HookDiagnostic {
  return {
    severity: "error",
    code,
    source: provenance.source,
    ...(hookId ? { hookId } : {}),
    message: redact(message),
  };
}

function validateMatcher(value: unknown): value is MatcherValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if ("equals" in value) {
    const equals = value.equals;
    return (
      equals === null ||
      typeof equals === "string" ||
      typeof equals === "boolean" ||
      (typeof equals === "number" && Number.isFinite(equals))
    );
  }
  if ("exists" in value) return typeof value.exists === "boolean";
  for (const operator of ["contains", "startsWith", "endsWith"] as const) {
    if (operator in value) return typeof value[operator] === "string";
  }
  return false;
}

function validateAction(
  action: unknown,
  hook: { event: HookEvent; failurePolicy: unknown; outputCapBytes: unknown },
  provenance: HookProvenance,
  hookId: string,
) {
  const errors: HookDiagnostic[] = [];
  if (!isRecord(action) || typeof action.type !== "string") {
    return [
      diagnostic(
        provenance,
        "invalid-action",
        "Action must be an object with a type.",
        hookId,
      ),
    ];
  }
  const exactKeys = (allowed: readonly string[]) => {
    const unknown = Object.keys(action).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      errors.push(
        diagnostic(
          provenance,
          "invalid-action-field",
          `Action has unsupported fields: ${unknown.join(", ")}.`,
          hookId,
        ),
      );
    }
  };
  switch (action.type) {
    case "command":
      exactKeys(["type", "executable", "args"]);
      if (
        typeof action.executable !== "string" ||
        action.executable.trim() === "" ||
        Buffer.byteLength(action.executable) > 1_024 ||
        /[\0\r\n]/.test(action.executable)
      ) {
        errors.push(
          diagnostic(
            provenance,
            "invalid-command",
            "Command executable must be a bounded single-line string.",
            hookId,
          ),
        );
      }
      if (hook.event === "before_agent_start") {
        errors.push(
          diagnostic(
            provenance,
            "invalid-action-event",
            "Command actions are unavailable for before_agent_start because Pi cannot fail that event closed.",
            hookId,
          ),
        );
      }
      if (
        !Array.isArray(action.args) ||
        action.args.length > 128 ||
        !action.args.every(
          (arg) =>
            typeof arg === "string" &&
            Buffer.byteLength(arg) <= 8_192 &&
            !arg.includes("\0"),
        ) ||
        (Array.isArray(action.args) &&
          action.args.reduce(
            (bytes, arg) =>
              bytes + (typeof arg === "string" ? Buffer.byteLength(arg) : 0),
            0,
          ) >
            64 * 1024)
      ) {
        errors.push(
          diagnostic(
            provenance,
            "invalid-command",
            "Command args must be at most 128 bounded strings and 64 KiB total.",
            hookId,
          ),
        );
      }
      break;
    case "notify":
      exactKeys(["type", "message", "level"]);
      if (typeof action.message !== "string" || action.message.length === 0)
        errors.push(
          diagnostic(
            provenance,
            "invalid-notify",
            "Notify message must be non-empty.",
            hookId,
          ),
        );
      if (!new Set(["info", "warning", "error"]).has(String(action.level)))
        errors.push(
          diagnostic(
            provenance,
            "invalid-notify",
            "Notify level must be info, warning, or error.",
            hookId,
          ),
        );
      if (hook.failurePolicy !== "open")
        errors.push(
          diagnostic(
            provenance,
            "invalid-failure-policy",
            "Notify actions must fail open.",
            hookId,
          ),
        );
      break;
    case "status":
      exactKeys(["type", "key", "text"]);
      if (
        typeof action.key !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(action.key)
      )
        errors.push(
          diagnostic(
            provenance,
            "invalid-status",
            "Status key is invalid.",
            hookId,
          ),
        );
      if (action.text !== null && typeof action.text !== "string")
        errors.push(
          diagnostic(
            provenance,
            "invalid-status",
            "Status text must be a string or null.",
            hookId,
          ),
        );
      if (hook.failurePolicy !== "open")
        errors.push(
          diagnostic(
            provenance,
            "invalid-failure-policy",
            "Status actions must fail open.",
            hookId,
          ),
        );
      break;
    case "context":
      exactKeys(["type", "content"]);
      if (typeof action.content !== "string" || action.content.length === 0)
        errors.push(
          diagnostic(
            provenance,
            "invalid-context",
            "Context content must be non-empty.",
            hookId,
          ),
        );
      if (!contextEvents.has(hook.event))
        errors.push(
          diagnostic(
            provenance,
            "invalid-action-event",
            `Context actions are unavailable for ${hook.event}.`,
            hookId,
          ),
        );
      break;
    case "policy":
      exactKeys(["type", "decision", "reason"]);
      if (
        !new Set(["allow", "deny", "require-user-confirmation"]).has(
          String(action.decision),
        )
      )
        errors.push(
          diagnostic(
            provenance,
            "invalid-policy",
            "Policy decision is invalid.",
            hookId,
          ),
        );
      if (typeof action.reason !== "string" || action.reason.length === 0)
        errors.push(
          diagnostic(
            provenance,
            "invalid-policy",
            "Policy reason must be non-empty.",
            hookId,
          ),
        );
      if (!policyEvents.has(hook.event))
        errors.push(
          diagnostic(
            provenance,
            "invalid-action-event",
            `Policy actions are unavailable for ${hook.event}.`,
            hookId,
          ),
        );
      if (hook.failurePolicy !== "closed")
        errors.push(
          diagnostic(
            provenance,
            "invalid-failure-policy",
            "Policy actions must fail closed.",
            hookId,
          ),
        );
      break;
    default:
      errors.push(
        diagnostic(
          provenance,
          "invalid-action",
          `Unsupported action type ${JSON.stringify(action.type)}.`,
          hookId,
        ),
      );
  }
  if (
    typeof hook.outputCapBytes === "number" &&
    (action.type === "notify" || action.type === "context")
  ) {
    const text = action.type === "notify" ? action.message : action.content;
    if (
      typeof text === "string" &&
      Buffer.byteLength(text) > hook.outputCapBytes
    ) {
      errors.push(
        diagnostic(
          provenance,
          "static-output-too-large",
          "Action content exceeds its output cap.",
          hookId,
        ),
      );
    }
  }
  return errors;
}

export function validateRegistration(
  registration: unknown,
  limits: ReturnType<typeof resolveLimits>,
) {
  const fallback: HookProvenance = {
    scope: "runtime",
    source: "unknown",
    trusted: false,
  };
  if (!isRecord(registration) || !isRecord(registration.provenance)) {
    return {
      registration: undefined,
      diagnostics: [
        diagnostic(
          fallback,
          "invalid-registration",
          "Registration and provenance must be plain objects.",
        ),
      ],
    };
  }
  const provenanceValue = registration.provenance;
  const provenance: HookProvenance = {
    scope:
      provenanceValue.scope === "global" ||
      provenanceValue.scope === "project" ||
      provenanceValue.scope === "runtime"
        ? provenanceValue.scope
        : "runtime",
    source:
      typeof provenanceValue.source === "string"
        ? provenanceValue.source
        : "unknown",
    trusted: provenanceValue.trusted === true,
    ...(Number.isSafeInteger(provenanceValue.documentIndex)
      ? { documentIndex: Number(provenanceValue.documentIndex) }
      : {}),
    ...(Number.isSafeInteger(provenanceValue.hookIndex)
      ? { hookIndex: Number(provenanceValue.hookIndex) }
      : {}),
  };
  const errors: HookDiagnostic[] = [];
  if (
    !["global", "project", "runtime"].includes(String(provenanceValue.scope)) ||
    provenance.source.trim() === "" ||
    typeof provenanceValue.trusted !== "boolean"
  ) {
    errors.push(
      diagnostic(
        provenance,
        "invalid-provenance",
        "Hook provenance is invalid.",
      ),
    );
  }
  if (
    !provenance.trusted ||
    (provenance.scope === "project" && provenanceValue.trusted !== true)
  ) {
    errors.push(
      diagnostic(
        provenance,
        "untrusted-source",
        "Untrusted project hooks never load.",
      ),
    );
  }
  if (!isRecord(registration.hook)) {
    errors.push(
      diagnostic(provenance, "invalid-hook", "Hook must be a plain object."),
    );
    return { registration: undefined, diagnostics: errors };
  }
  const hook = registration.hook;
  const id = typeof hook.id === "string" ? hook.id : "";
  const unknownHookFields = Object.keys(hook).filter(
    (key) =>
      ![
        "id",
        "event",
        "priority",
        "match",
        "action",
        "timeoutMs",
        "outputCapBytes",
        "failurePolicy",
      ].includes(key),
  );
  if (unknownHookFields.length > 0) {
    errors.push(
      diagnostic(
        provenance,
        "invalid-hook-field",
        `Hook has unsupported fields: ${unknownHookFields.join(", ")}.`,
        id,
      ),
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id))
    errors.push(
      diagnostic(
        provenance,
        "invalid-id",
        "Hook id is invalid.",
        id || undefined,
      ),
    );
  if (typeof hook.event !== "string" || !eventSet.has(hook.event))
    errors.push(
      diagnostic(
        provenance,
        "invalid-event",
        `Unsupported hook event ${JSON.stringify(hook.event)}.`,
        id,
      ),
    );
  if (
    !Number.isSafeInteger(hook.priority) ||
    Number(hook.priority) < -10_000 ||
    Number(hook.priority) > 10_000
  )
    errors.push(
      diagnostic(
        provenance,
        "invalid-priority",
        "Hook priority must be an integer from -10000 through 10000.",
        id,
      ),
    );
  if (
    !Number.isSafeInteger(hook.timeoutMs) ||
    Number(hook.timeoutMs) <= 0 ||
    Number(hook.timeoutMs) > limits.maxHookTimeoutMs
  )
    errors.push(
      diagnostic(
        provenance,
        "invalid-timeout",
        `Hook timeout must be from 1 through ${limits.maxHookTimeoutMs}ms.`,
        id,
      ),
    );
  if (
    !Number.isSafeInteger(hook.outputCapBytes) ||
    Number(hook.outputCapBytes) <= 0 ||
    Number(hook.outputCapBytes) > limits.maxHookOutputBytes
  )
    errors.push(
      diagnostic(
        provenance,
        "invalid-output-cap",
        `Hook output cap must be from 1 through ${limits.maxHookOutputBytes} bytes.`,
        id,
      ),
    );
  if (hook.failurePolicy !== "open" && hook.failurePolicy !== "closed")
    errors.push(
      diagnostic(
        provenance,
        "invalid-failure-policy",
        "Failure policy must be explicit: open or closed.",
        id,
      ),
    );
  if (
    hook.failurePolicy === "closed" &&
    typeof hook.event === "string" &&
    eventSet.has(hook.event) &&
    !closedCapableEvents.has(hook.event as HookEvent)
  ) {
    errors.push(
      diagnostic(
        provenance,
        "invalid-failure-policy",
        `Event ${hook.event} cannot fail closed.`,
        id,
      ),
    );
  }
  if (!isRecord(hook.match)) {
    errors.push(
      diagnostic(
        provenance,
        "invalid-matcher",
        "Hook match must be a plain object.",
        id,
      ),
    );
  } else {
    const matchers = Object.entries(hook.match);
    if (matchers.length > limits.maxMatchersPerHook)
      errors.push(
        diagnostic(
          provenance,
          "invalid-matcher",
          `Hook has more than ${limits.maxMatchersPerHook} matchers.`,
          id,
        ),
      );
    for (const [path, value] of matchers) {
      if (
        !/^[$A-Z_a-z][$\w]*(?:\.[A-Z_a-z$][$\w]*)*$/.test(path) ||
        !validateMatcher(value)
      ) {
        errors.push(
          diagnostic(
            provenance,
            "invalid-matcher",
            `Invalid matcher at ${JSON.stringify(path)}.`,
            id,
          ),
        );
      }
    }
  }
  if (
    typeof hook.event === "string" &&
    eventSet.has(hook.event) &&
    (hook.failurePolicy === "open" || hook.failurePolicy === "closed")
  ) {
    errors.push(
      ...validateAction(
        hook.action,
        {
          event: hook.event as HookEvent,
          failurePolicy: hook.failurePolicy,
          outputCapBytes: hook.outputCapBytes,
        },
        provenance,
        id,
      ),
    );
  }
  const plain = measurePlainData(
    registration,
    limits.maxConfigDepth,
    limits.maxConfigNodes,
  );
  if (!plain.valid) {
    errors.push(
      diagnostic(
        provenance,
        "non-plain-registration",
        `Registration is invalid: ${plain.reason}.`,
        id,
      ),
    );
  } else {
    let bytes = limits.maxConfigBytes + 1;
    try {
      bytes = Buffer.byteLength(JSON.stringify(registration));
    } catch {
      // Plain-data validation reports the actionable error.
    }
    if (bytes > limits.maxConfigBytes) {
      errors.push(
        diagnostic(
          provenance,
          "registration-too-large",
          `Registration exceeds ${limits.maxConfigBytes} bytes.`,
          id,
        ),
      );
    }
  }
  if (errors.length > 0)
    return { registration: undefined, diagnostics: errors };
  return {
    registration: structuredClone({
      hook: hook as unknown as HookDefinition,
      provenance,
    }) satisfies HookRegistration,
    diagnostics: [],
  };
}

export function isPlainPayload(value: unknown) {
  return measurePlainData(value, 32, 20_000).valid && isRecord(value);
}
