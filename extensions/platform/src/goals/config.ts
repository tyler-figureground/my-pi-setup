import type { PlatformDiagnostic } from "../flags.ts";
import { GOAL_LIMITS } from "./model.ts";

/**
 * Host caps for Goal Mode.
 *
 * The Goal core already bounds every field it accepts. These caps are the
 * narrower host policy layered on top: they decide how much a direct user or a
 * model-authored submission may ask for on this machine, and they supply the
 * defaults the host fills in for fields no caller is allowed to choose.
 * A trusted project config may only narrow them, never widen them.
 */
export interface PlatformGoalConfiguration {
  readonly maxGoals: number;
  readonly maxNodesPerGoal: number;
  readonly maxConcurrentNodes: number;
  readonly maxAgentCalls: number;
  readonly maxRuntimeMs: number;
  readonly defaultConcurrency: number;
  readonly defaultAgentCalls: number;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxAttempts: number;
  readonly defaultRetryDelayMs: number;
  readonly defaultOutputBytes: number;
  readonly leaseTtlMs: number;
  /** How long a finished Goal keeps its records before compaction. */
  readonly terminalRetentionMs: number;
  /** Ceiling for a Goal-wide token budget, and the default per-node worst case. */
  readonly maxTokensPerGoal: number;
  readonly defaultNodeTokenReservation: number;
  /** Ceiling for a Goal-wide cost budget, and the default per-node worst case. */
  readonly maxCostMicrosPerGoal: number;
  readonly defaultNodeCostMicrosReservation: number;
}

export const defaultPlatformGoalConfiguration: PlatformGoalConfiguration =
  Object.freeze({
    maxGoals: 100,
    maxNodesPerGoal: 32,
    maxConcurrentNodes: 4,
    maxAgentCalls: 256,
    maxRuntimeMs: 6 * 3_600_000,
    defaultConcurrency: 2,
    defaultAgentCalls: 8,
    defaultTimeoutMs: 900_000,
    defaultMaxAttempts: 3,
    defaultRetryDelayMs: 30_000,
    defaultOutputBytes: 256 * 1024,
    leaseTtlMs: 300_000,
    terminalRetentionMs: 7 * 24 * 3_600_000,
    maxTokensPerGoal: 20_000_000,
    defaultNodeTokenReservation: 200_000,
    maxCostMicrosPerGoal: 100_000_000,
    defaultNodeCostMicrosReservation: 1_000_000,
  });

const BOUNDS: Readonly<
  Record<keyof PlatformGoalConfiguration, readonly [number, number]>
> = {
  maxGoals: [1, 1_000],
  maxNodesPerGoal: [1, GOAL_LIMITS.maxNodes],
  maxConcurrentNodes: [1, GOAL_LIMITS.maxConcurrentNodes],
  maxAgentCalls: [1, GOAL_LIMITS.maxAgentCalls],
  maxRuntimeMs: [60_000, GOAL_LIMITS.maxRuntimeMs],
  defaultConcurrency: [1, GOAL_LIMITS.maxConcurrentNodes],
  defaultAgentCalls: [1, GOAL_LIMITS.maxAgentCalls],
  defaultTimeoutMs: [GOAL_LIMITS.minTimeoutMs, GOAL_LIMITS.maxTimeoutMs],
  defaultMaxAttempts: [1, GOAL_LIMITS.maxAttemptsPerNode],
  defaultRetryDelayMs: [0, GOAL_LIMITS.maxRetryDelayMs],
  defaultOutputBytes: [1_024, GOAL_LIMITS.maxOutputBytes],
  leaseTtlMs: [60_000, 900_000],
  terminalRetentionMs: [60_000, 30 * 24 * 3_600_000],
  maxTokensPerGoal: [1, GOAL_LIMITS.maxTokens],
  defaultNodeTokenReservation: [1, GOAL_LIMITS.maxTokens],
  maxCostMicrosPerGoal: [1, GOAL_LIMITS.maxCostMicros],
  defaultNodeCostMicrosReservation: [1, GOAL_LIMITS.maxCostMicros],
};

export function decodeGoalConfiguration(
  input: unknown,
  base: PlatformGoalConfiguration = defaultPlatformGoalConfiguration,
  scope: "user" | "project" = "user",
): { goals: PlatformGoalConfiguration; diagnostics: PlatformDiagnostic[] } {
  if (input === undefined) return { goals: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      goals: base,
      diagnostics: [
        { path: "goalSettings", message: "Goal settings must be an object." },
      ],
    };
  }
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  const allowed = new Set(Object.keys(BOUNDS));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      diagnostics.push({
        path: `goalSettings.${key}`,
        message: `Unknown goal setting ${JSON.stringify(key)}.`,
      });
    }
  }
  const integer = (field: keyof PlatformGoalConfiguration) => {
    const [minimum, maximum] = BOUNDS[field];
    const fallback = base[field];
    const candidate = value[field];
    if (candidate === undefined) return fallback;
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < minimum ||
      (candidate as number) > maximum ||
      // A trusted project may tighten host policy; it may never widen it.
      (scope === "project" &&
        (field === "leaseTtlMs"
          ? (candidate as number) !== fallback
          : (candidate as number) > fallback))
    ) {
      diagnostics.push({
        path: `goalSettings.${field}`,
        message: `${field} is outside host safety bounds.`,
      });
      return fallback;
    }
    return candidate as number;
  };
  const goals: PlatformGoalConfiguration = {
    maxGoals: integer("maxGoals"),
    maxNodesPerGoal: integer("maxNodesPerGoal"),
    maxConcurrentNodes: integer("maxConcurrentNodes"),
    maxAgentCalls: integer("maxAgentCalls"),
    maxRuntimeMs: integer("maxRuntimeMs"),
    defaultConcurrency: integer("defaultConcurrency"),
    defaultAgentCalls: integer("defaultAgentCalls"),
    defaultTimeoutMs: integer("defaultTimeoutMs"),
    defaultMaxAttempts: integer("defaultMaxAttempts"),
    defaultRetryDelayMs: integer("defaultRetryDelayMs"),
    defaultOutputBytes: integer("defaultOutputBytes"),
    leaseTtlMs: integer("leaseTtlMs"),
    terminalRetentionMs: integer("terminalRetentionMs"),
    maxTokensPerGoal: integer("maxTokensPerGoal"),
    defaultNodeTokenReservation: integer("defaultNodeTokenReservation"),
    maxCostMicrosPerGoal: integer("maxCostMicrosPerGoal"),
    defaultNodeCostMicrosReservation: integer(
      "defaultNodeCostMicrosReservation",
    ),
  };
  // Defaults can never exceed the caps they are measured against.
  const clamped: PlatformGoalConfiguration = {
    ...goals,
    defaultConcurrency: Math.min(
      goals.defaultConcurrency,
      goals.maxConcurrentNodes,
    ),
    defaultAgentCalls: Math.min(goals.defaultAgentCalls, goals.maxAgentCalls),
    defaultNodeTokenReservation: Math.min(
      goals.defaultNodeTokenReservation,
      goals.maxTokensPerGoal,
    ),
    defaultNodeCostMicrosReservation: Math.min(
      goals.defaultNodeCostMicrosReservation,
      goals.maxCostMicrosPerGoal,
    ),
  };
  if (
    clamped.defaultConcurrency !== goals.defaultConcurrency ||
    clamped.defaultAgentCalls !== goals.defaultAgentCalls ||
    clamped.defaultNodeTokenReservation !== goals.defaultNodeTokenReservation ||
    clamped.defaultNodeCostMicrosReservation !==
      goals.defaultNodeCostMicrosReservation
  ) {
    diagnostics.push({
      path: "goalSettings",
      message: "Goal defaults were clamped to the configured host caps.",
    });
  }
  return { goals: clamped, diagnostics };
}
