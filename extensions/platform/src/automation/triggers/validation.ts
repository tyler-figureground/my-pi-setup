/**
 * Structural guards for untrusted plain data, shared across automation:
 * TriggerEngine envelopes and durable records (`engine.ts`,
 * `persistence.ts`, `state-store-persistence.ts`), monitor definitions and
 * settings, and hook action settings.
 *
 * Inspection reads property descriptors, so getters never run; proxies,
 * accessors, symbol keys, non-plain objects, cycles, and non-finite numbers
 * are rejected. Pure, no I/O.
 * See: docs/security/phase-7-threat-model.md (Forged event provenance or
 * authority)
 */

import { isProxy } from "node:util/types";

interface PlainValidationOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

function hasPlainPrototype(value: object) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** JSON-like data within `maxDepth` (default 32) and `maxNodes` (10,000). */
export function isPlainData(
  value: unknown,
  options: PlainValidationOptions = {},
) {
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
    if (typeof candidate !== "object") return false;
    if (isProxy(candidate)) return false;
    if (depth > (options.maxDepth ?? 32)) return false;
    if (++nodes > (options.maxNodes ?? 10_000)) return false;
    if (active.has(candidate)) return false;
    if (!Array.isArray(candidate) && !hasPlainPrototype(candidate))
      return false;
    if (Object.getOwnPropertySymbols(candidate).length > 0) return false;

    active.add(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Object.keys(descriptors);
    if (
      Array.isArray(candidate) &&
      keys.some((key) => key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key))
    ) {
      active.delete(candidate);
      return false;
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "length" && Array.isArray(candidate)) continue;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        active.delete(candidate);
        return false;
      }
      if (!visit(descriptor.value, depth + 1)) {
        active.delete(candidate);
        return false;
      }
    }
    active.delete(candidate);
    return true;
  };

  return visit(value, 0);
}

/**
 * True when every own key of `value` is in `allowed`. Despite the name, no
 * key is required; callers add a key-count check when they need exactness.
 */
export function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
) {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

export function isBoundedIdentifier(value: unknown, maxLength = 256) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
