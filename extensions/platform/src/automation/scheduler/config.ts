/**
 * Decoder for the `schedulerSettings` block of `platform.json`: Schedule
 * count, concurrency, default timeout, and occurrence Lease TTL.
 *
 * Out-of-range or unknown fields keep the `base` value and add a diagnostic
 * instead of failing the file. A project source may only keep or lower a
 * value and may never change `leaseTtlMs`. Decoded by `src/config.ts`, each
 * source layered on the last; `index.ts` re-checks the ranges at startup.
 * See: docs/phase-7-configuration.md (Scheduler settings)
 */

import type { PlatformDiagnostic } from "../../flags.ts";

export interface PlatformSchedulerConfiguration {
  readonly maxSchedules: number;
  readonly maxConcurrent: number;
  readonly defaultTimeoutMs: number;
  readonly leaseTtlMs: number;
}

export const defaultPlatformSchedulerConfiguration: PlatformSchedulerConfiguration =
  Object.freeze({
    maxSchedules: 1_000,
    maxConcurrent: 4,
    defaultTimeoutMs: 15 * 60 * 1_000,
    leaseTtlMs: 60_000,
  });

export function decodeSchedulerConfiguration(
  input: unknown,
  base: PlatformSchedulerConfiguration = defaultPlatformSchedulerConfiguration,
  scope: "user" | "project" = "user",
): {
  scheduler: PlatformSchedulerConfiguration;
  diagnostics: PlatformDiagnostic[];
} {
  if (input === undefined) return { scheduler: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      scheduler: base,
      diagnostics: [
        {
          path: "schedulerSettings",
          message: "Scheduler settings must be an object.",
        },
      ],
    };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  const allowed = new Set([
    "maxSchedules",
    "maxConcurrent",
    "defaultTimeoutMs",
    "leaseTtlMs",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      diagnostics.push({
        path: `schedulerSettings.${key}`,
        message: `Unknown scheduler setting ${JSON.stringify(key)}.`,
      });
  }
  const integer = (
    field: keyof PlatformSchedulerConfiguration,
    minimum: number,
    maximum: number,
    projectAllows: (candidate: number) => boolean,
  ) => {
    const fallback = base[field];
    const candidate = value[field];
    if (candidate === undefined) return fallback;
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < minimum ||
      (candidate as number) > maximum ||
      (scope === "project" && !projectAllows(candidate as number))
    ) {
      diagnostics.push({
        path: `schedulerSettings.${field}`,
        message: `${field} is outside host safety bounds.`,
      });
      return fallback;
    }
    return candidate as number;
  };
  return {
    scheduler: {
      maxSchedules: integer(
        "maxSchedules",
        1,
        1_000,
        (candidate) => candidate <= base.maxSchedules,
      ),
      maxConcurrent: integer(
        "maxConcurrent",
        1,
        4,
        (candidate) => candidate <= base.maxConcurrent,
      ),
      defaultTimeoutMs: integer(
        "defaultTimeoutMs",
        1_000,
        60 * 60 * 1_000,
        (candidate) => candidate <= base.defaultTimeoutMs,
      ),
      leaseTtlMs: integer(
        "leaseTtlMs",
        10_000,
        5 * 60 * 1_000,
        (candidate) => candidate === base.leaseTtlMs,
      ),
    },
    diagnostics,
  };
}
