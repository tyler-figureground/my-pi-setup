import { isProxy } from "node:util/types";
import { platformHookEvents, type PlainData } from "./hooks/model.ts";

export type PlatformHookEvent = (typeof platformHookEvents)[number];
export type PlatformHookEventSource =
  "workspaces" | "subagents" | "workflows" | "monitors" | "scheduler";

export interface PlatformHookEventEnvelope {
  readonly event: PlatformHookEvent;
  readonly source: PlatformHookEventSource;
  readonly payload: Readonly<Record<string, PlainData>>;
}

export interface PlatformHookEventSink {
  publish(event: PlatformHookEventEnvelope): void;
}

export interface PlatformHookEventProducer {
  publish(
    event: PlatformHookEvent,
    payload: Readonly<Record<string, unknown>>,
  ): void;
}

interface PayloadBudget {
  nodes: number;
  bytes: number;
  readonly seen: WeakSet<object>;
}

const MAX_PAYLOAD_BYTES = 24 * 1024;
const MAX_STRING_BYTES = 4 * 1024;
const MAX_KEY_BYTES = 128;
const MAX_NODES = 256;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 64;
const eventNames = new Set<string>(platformHookEvents);
const sourceNames = new Set<string>([
  "workspaces",
  "subagents",
  "workflows",
  "monitors",
  "scheduler",
]);
const reservedKey =
  /^(?:authority|capabilities|event|eventType|permissions?|provenance|source|trusted|trust)$/i;
const sensitiveKey =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const sinks = new WeakMap<object, PlatformHookEventSink>();

function boundedText(text: string, limit: number, budget: PayloadBudget) {
  const remaining = Math.max(0, MAX_PAYLOAD_BYTES - budget.bytes);
  const byteLimit = Math.min(limit, remaining);
  if (Buffer.byteLength(text) <= byteLimit) {
    budget.bytes += Buffer.byteLength(text);
    return text;
  }
  let output = text.slice(0, byteLimit);
  while (Buffer.byteLength(output) > byteLimit) output = output.slice(0, -1);
  budget.bytes += Buffer.byteLength(output);
  return output || "[BOUNDED]";
}

function plainValue(
  value: unknown,
  budget: PayloadBudget,
  depth: number,
): PlainData {
  budget.nodes++;
  if (
    budget.nodes > MAX_NODES ||
    depth > MAX_DEPTH ||
    budget.bytes >= MAX_PAYLOAD_BYTES
  ) {
    return "[BOUNDED]";
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : "[NON_FINITE]";
  if (typeof value === "string")
    return boundedText(value, MAX_STRING_BYTES, budget);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (isProxy(value)) return "[PROXY]";
  if (budget.seen.has(value)) return "[CYCLE]";
  budget.seen.add(value);

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return "[UNREADABLE]";
  }

  if (Array.isArray(value)) {
    const output: PlainData[] = [];
    for (let index = 0; index < Math.min(value.length, MAX_ENTRIES); index++) {
      const descriptor = descriptors[String(index)];
      output.push(
        descriptor && "value" in descriptor
          ? plainValue(descriptor.value, budget, depth + 1)
          : "[ACCESSOR]",
      );
    }
    if (value.length > MAX_ENTRIES) output.push("[BOUNDED]");
    return output;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "[UNSUPPORTED_OBJECT]";
  }
  const output: Record<string, PlainData> = {};
  const entries = Object.entries(descriptors).filter(
    ([key, descriptor]) => descriptor.enumerable && !reservedKey.test(key),
  );
  for (const [rawKey, descriptor] of entries.slice(0, MAX_ENTRIES)) {
    const key = boundedText(rawKey, MAX_KEY_BYTES, budget);
    if (!key || Object.hasOwn(output, key)) continue;
    if (sensitiveKey.test(rawKey)) output[key] = "[REDACTED]";
    else if ("value" in descriptor)
      output[key] = plainValue(descriptor.value, budget, depth + 1);
    else output[key] = "[ACCESSOR]";
  }
  if (entries.length > MAX_ENTRIES) output.bounded = "[BOUNDED]";
  return output;
}

function freezePlain(value: PlainData): PlainData {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezePlain(child);
    Object.freeze(value);
  }
  return value;
}

function payload(value: Readonly<Record<string, unknown>>) {
  const budget: PayloadBudget = {
    nodes: 0,
    bytes: 0,
    seen: new WeakSet(),
  };
  const converted = plainValue(value, budget, 0);
  if (
    converted === null ||
    typeof converted !== "object" ||
    Array.isArray(converted)
  ) {
    return Object.freeze({}) as Readonly<Record<string, PlainData>>;
  }
  return freezePlain(converted) as Readonly<Record<string, PlainData>>;
}

export function bindPlatformHookEventSink(
  loader: object,
  sink: PlatformHookEventSink,
) {
  if (sinks.has(loader)) {
    throw new Error(
      "A platform hook event sink is already bound to this loader.",
    );
  }
  sinks.set(loader, sink);
  return () => {
    if (sinks.get(loader) === sink) sinks.delete(loader);
  };
}

export function platformHookEventProducerFor(
  loader: object,
  source: PlatformHookEventSource,
): PlatformHookEventProducer {
  return {
    publish(event, input) {
      if (!eventNames.has(event) || !sourceNames.has(source)) return;
      const sink = sinks.get(loader);
      if (!sink) return;
      const envelope = Object.freeze({
        event,
        source,
        payload: payload(input),
      });
      try {
        sink.publish(envelope);
      } catch {
        // Observe-only publication must not roll back a committed transition.
      }
    },
  };
}
