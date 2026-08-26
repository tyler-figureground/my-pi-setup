import { validateConfigSources } from "./config.ts";
import { hookEvents } from "./model.ts";
import type {
  DispatchResult,
  HookConfigSource,
  HookDefinition,
  HookDiagnostic,
  HookEffect,
  HookEventEnvelope,
  HookInspection,
  HookLogEntry,
  HookRegistration,
  ReloadResult,
  TriggerEngine,
  TriggerEngineOptions,
  ValidationResult,
} from "./model.ts";
import {
  containsSensitiveKey,
  isPlainPayload,
  isRecord,
  redact,
  resolveLimits,
  validateRegistration,
} from "./validation.ts";

function valueAtPath(value: Readonly<Record<string, unknown>>, path: string) {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return { exists: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function matches(
  hook: HookDefinition,
  payload: Readonly<Record<string, unknown>>,
) {
  return Object.entries(hook.match).every(([path, matcher]) => {
    const actual = valueAtPath(payload, path);
    if (
      matcher === null ||
      typeof matcher === "string" ||
      typeof matcher === "number" ||
      typeof matcher === "boolean"
    ) {
      return actual.exists && actual.value === matcher;
    }
    if ("exists" in matcher) return actual.exists === matcher.exists;
    if ("equals" in matcher)
      return actual.exists && actual.value === matcher.equals;
    if (typeof actual.value !== "string") return false;
    if ("contains" in matcher)
      return actual.value.includes(matcher.contains ?? "");
    if ("startsWith" in matcher)
      return actual.value.startsWith(matcher.startsWith ?? "");
    if ("endsWith" in matcher)
      return actual.value.endsWith(matcher.endsWith ?? "");
    return false;
  });
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRegistrations(left: HookRegistration, right: HookRegistration) {
  return (
    left.hook.priority - right.hook.priority ||
    compareText(left.provenance.source, right.provenance.source) ||
    compareText(left.hook.id, right.hook.id)
  );
}

export function createTriggerEngine(
  options: TriggerEngineOptions = {},
): TriggerEngine {
  const limits = resolveLimits(options);
  const instanceId = options.instanceId ?? "trigger-engine";
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(instanceId)) {
    throw new TypeError("TriggerEngine instanceId is invalid.");
  }
  const runtimeHooks = new Map<string, HookRegistration>();
  let configHooks = new Map<string, HookRegistration>();
  let configSources: readonly HookConfigSource[] = [];
  let state: HookInspection["state"] = "created";
  let diagnostics: readonly HookDiagnostic[] = [];
  let logs: HookLogEntry[] = [];
  let logBytes = 0;
  let nextDispatch = 0;
  let nextLog = 0;
  let mutationVersion = 0;
  let dispatching = false;

  const appendLog = (
    entry: Omit<HookLogEntry, "sequence" | "message"> & { message: string },
  ) => {
    const safe = {
      ...entry,
      ...(entry.hookId && containsSensitiveKey(entry.hookId)
        ? { hookId: "[REDACTED]" }
        : {}),
      sequence: ++nextLog,
      message: redact(entry.message).slice(0, 2_000),
    } satisfies HookLogEntry;
    const bytes = Buffer.byteLength(JSON.stringify(safe));
    if (bytes > limits.maxLogBytes) return;
    logs.push(safe);
    logBytes += bytes;
    while (
      logs.length > limits.maxLogEntries ||
      logBytes > limits.maxLogBytes
    ) {
      const removed = logs.shift();
      if (removed) logBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  };

  const allHooks = () =>
    [...runtimeHooks.values(), ...configHooks.values()].sort(
      compareRegistrations,
    );

  const emptyResult = (
    dispatchId: string,
    status: DispatchResult["status"],
    eventDiagnostics: readonly HookDiagnostic[] = [],
  ): DispatchResult => ({
    dispatchId,
    status,
    effects: [],
    matchedHookIds: [],
    diagnostics: eventDiagnostics,
  });

  const register = (input: HookRegistration) => {
    const checked = validateRegistration(input, limits);
    if (!checked.registration) {
      return { accepted: false, diagnostics: checked.diagnostics };
    }
    if (
      runtimeHooks.has(checked.registration.hook.id) ||
      configHooks.has(checked.registration.hook.id)
    ) {
      return {
        accepted: false,
        diagnostics: [
          {
            severity: "error",
            code: "duplicate-id",
            source: checked.registration.provenance.source,
            hookId: checked.registration.hook.id,
            message: `Duplicate hook id ${JSON.stringify(checked.registration.hook.id)}.`,
          },
        ],
      } as const;
    }
    if (runtimeHooks.size + configHooks.size >= limits.maxHooks) {
      return {
        accepted: false,
        diagnostics: [
          {
            severity: "error",
            code: "hook-limit",
            source: checked.registration.provenance.source,
            hookId: checked.registration.hook.id,
            message: `Hook limit of ${limits.maxHooks} reached.`,
          },
        ],
      } as const;
    }
    runtimeHooks.set(checked.registration.hook.id, checked.registration);
    mutationVersion++;
    return { accepted: true, diagnostics: [] } as const;
  };

  const dispatch = async (event: HookEventEnvelope) => {
    const dispatchId = `dispatch-${++nextDispatch}`;
    const candidate: unknown = event;
    const plainEnvelope = isPlainPayload(candidate);
    const knownEvent =
      plainEnvelope &&
      isRecord(candidate) &&
      typeof candidate.event === "string" &&
      hookEvents.some((name) => name === candidate.event)
        ? (candidate.event as HookEventEnvelope["event"])
        : undefined;
    const validTrace =
      plainEnvelope &&
      isRecord(candidate) &&
      (candidate.trace === undefined ||
        (Array.isArray(candidate.trace) &&
          candidate.trace.length <= 16 &&
          candidate.trace.every(
            (item) => typeof item === "string" && item.length <= 128,
          )));
    const validEnvelope =
      plainEnvelope &&
      isRecord(candidate) &&
      knownEvent !== undefined &&
      (candidate.mode === "normal" || candidate.mode === "plan") &&
      isPlainPayload(candidate.payload) &&
      validTrace &&
      Object.keys(candidate).every((key) =>
        ["event", "mode", "payload", "trace"].includes(key),
      );
    if (!validEnvelope) {
      const invalid: HookDiagnostic = {
        severity: "error",
        code: "invalid-event-envelope",
        source: instanceId,
        message:
          "Event requires a known event, normal/plan mode, bounded plain payload, and bounded trace.",
      };
      if (knownEvent) {
        appendLog({
          dispatchId,
          event: knownEvent,
          outcome: "invalid",
          message: invalid.message,
        });
      }
      return emptyResult(dispatchId, "invalid-event", [invalid]);
    }
    event = candidate as unknown as HookEventEnvelope;
    if (state !== "running") {
      appendLog({
        dispatchId,
        event: event.event,
        outcome: "not-running",
        message: "Dispatch ignored because TriggerEngine is not running.",
      });
      return emptyResult(dispatchId, "not-running");
    }
    if (dispatching || event.trace?.includes(instanceId)) {
      appendLog({
        dispatchId,
        event: event.event,
        outcome: "recursion-blocked",
        message: "Recursive or reentrant dispatch blocked.",
      });
      return emptyResult(dispatchId, "recursion-blocked");
    }

    dispatching = true;
    try {
      const startedAt = Date.now();
      const candidates = allHooks().filter(
        ({ hook }) =>
          hook.event === event.event && matches(hook, event.payload),
      );
      const matched = candidates.slice(0, limits.maxHooksPerDispatch);
      const effects: HookEffect[] = [];
      const eventDiagnostics: HookDiagnostic[] = [];
      let bounded = candidates.length > matched.length;
      for (const registration of matched) {
        if (
          effects.length >= limits.maxEffectsPerDispatch ||
          Date.now() - startedAt >= limits.dispatchTimeoutMs
        ) {
          bounded = true;
          break;
        }
        const { hook, provenance } = registration;
        const trace = [...(event.trace ?? []), instanceId];
        let effect: HookEffect;
        if (
          event.mode === "plan" &&
          (hook.action.type === "command" ||
            (hook.action.type === "policy" && hook.action.decision !== "deny"))
        ) {
          effect = {
            effectId: `${dispatchId}:${hook.id}`,
            hookId: hook.id,
            event: hook.event,
            type: "policy",
            decision: "deny",
            reason:
              hook.action.type === "command"
                ? "Plan mode denies hook command/process effects."
                : "Plan mode denial cannot be overridden by a hook policy decision.",
            timeoutMs: hook.timeoutMs,
            outputCapBytes: hook.outputCapBytes,
            failurePolicy: "closed",
            provenance: structuredClone(provenance),
            trace,
          };
          appendLog({
            dispatchId,
            event: event.event,
            hookId: hook.id,
            outcome: "plan-denied",
            message: effect.reason,
          });
        } else {
          effect = {
            effectId: `${dispatchId}:${hook.id}`,
            hookId: hook.id,
            event: hook.event,
            ...structuredClone(hook.action),
            timeoutMs: hook.timeoutMs,
            outputCapBytes: hook.outputCapBytes,
            failurePolicy: hook.failurePolicy,
            provenance: structuredClone(provenance),
            trace,
          };
          appendLog({
            dispatchId,
            event: event.event,
            hookId: hook.id,
            outcome: "emitted",
            message: `Emitted ${hook.action.type} effect.`,
          });
        }
        effects.push(effect);
      }
      if (bounded) {
        const boundedDiagnostic: HookDiagnostic = {
          severity: "warning",
          code: "dispatch-bounded",
          source: instanceId,
          message: "Whole-dispatch hook, effect, or time bound reached.",
        };
        eventDiagnostics.push(boundedDiagnostic);
        appendLog({
          dispatchId,
          event: event.event,
          outcome: "bounded",
          message: boundedDiagnostic.message,
        });
      }
      return {
        dispatchId,
        status: bounded ? "bounded" : "completed",
        effects,
        matchedHookIds: matched
          .slice(0, effects.length)
          .map(({ hook }) => hook.id),
        diagnostics: eventDiagnostics,
      } satisfies DispatchResult;
    } finally {
      dispatching = false;
    }
  };

  const validate = async (
    sources: readonly HookConfigSource[] = configSources,
  ): Promise<ValidationResult> =>
    validateConfigSources(sources, limits, new Set(runtimeHooks.keys()));

  const reload = async (
    sources?: readonly HookConfigSource[],
  ): Promise<ReloadResult> => {
    if (sources) configSources = [...sources];
    for (let attempt = 0; attempt < 3; attempt++) {
      const observedMutation = mutationVersion;
      const result = await validate(configSources);
      if (observedMutation !== mutationVersion) continue;
      if (result.valid) {
        configHooks = new Map(
          result.hooks.map((registration) => [
            registration.hook.id,
            structuredClone(registration),
          ]),
        );
        mutationVersion++;
      }
      diagnostics = result.diagnostics;
      return { ...result, applied: result.valid };
    }
    const concurrent: HookDiagnostic = {
      severity: "error",
      code: "concurrent-mutation",
      source: instanceId,
      message:
        "Hook registration changed repeatedly during reload; last known-good configuration retained.",
    };
    diagnostics = [concurrent];
    return {
      valid: false,
      applied: false,
      hooks: [],
      diagnostics,
      sources: [],
    };
  };

  const start = async (sources?: readonly HookConfigSource[]) => {
    state = "running";
    return reload(sources);
  };

  const stop = async (reason = "stop") => {
    state = "stopped";
    dispatching = false;
    return { status: "stopped", reason } as const;
  };

  const inspect = (): HookInspection => ({
    instanceId,
    state,
    hooks: allHooks().map(({ hook, provenance }) => ({
      id: hook.id,
      event: hook.event,
      priority: hook.priority,
      source: provenance.source,
      scope: provenance.scope,
      action: hook.action.type,
      failurePolicy: hook.failurePolicy,
    })),
    logs: logs.map((entry) => ({ ...entry })),
    diagnostics: diagnostics.map((entry) => ({ ...entry })),
  });

  return {
    instanceId,
    register,
    dispatch,
    validate,
    reload,
    start,
    stop,
    inspect,
  };
}
