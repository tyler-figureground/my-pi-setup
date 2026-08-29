export interface CleanupBudget {
  readonly deadline: number;
  remaining(stage: string, maximumMs?: number): number;
}

export function createCleanupBudget(
  totalMs: number,
  now: () => number = Date.now,
): CleanupBudget {
  if (!Number.isFinite(totalMs) || totalMs <= 0)
    throw new RangeError("Cleanup budget must be positive.");
  const deadline = now() + totalMs;
  return Object.freeze({
    deadline,
    remaining(stage: string, maximumMs = Number.POSITIVE_INFINITY) {
      const remaining = Math.min(maximumMs, Math.max(0, deadline - now()));
      if (remaining <= 0)
        throw new Error(`Cleanup deadline exhausted before ${stage}.`);
      return remaining;
    },
  });
}
