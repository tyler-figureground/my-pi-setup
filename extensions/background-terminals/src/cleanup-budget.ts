/**
 * One shared wall-clock deadline for a multi-stage teardown, used by
 * `manager.ts` when killing a Windows process tree.
 *
 * `remaining(stage, maximumMs?)` returns the milliseconds left (optionally
 * capped for that stage) and throws once the deadline is exhausted, naming
 * the stage it was about to start. `createCleanupBudget` throws `RangeError`
 * for a non-positive or non-finite total.
 */

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
