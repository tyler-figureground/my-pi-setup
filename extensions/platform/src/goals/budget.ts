import type {
  GoalBudget,
  GoalBudgetAmounts,
  GoalBudgetLimits,
  GoalOutcome,
  GoalReservation,
} from "./model.ts";

/**
 * Budget arithmetic for Goal Attempts.
 *
 * Worst-case amounts are reserved before dispatch and released at settlement,
 * so a crash between the two can never leak capacity: the reservation lives in
 * the same transactional record as the Attempt. Currency is integer micros;
 * floating point never enters the ledger.
 */

export interface GoalMeteringCapabilities {
  readonly tokens: boolean;
  readonly cost: boolean;
}

type MeteredBudgetLimits = Pick<
  GoalBudgetLimits,
  "maxTokens" | "maxCostMicros"
>;

export interface GoalUsage {
  readonly runtimeMs: number;
  readonly tokens?: number;
  readonly costMicros?: number;
  /** False when the executor cannot prove token or cost metering. */
  readonly authoritative: boolean;
}

/** One Attempt's charge, with the provenance of each metered figure. */
export interface GoalAttemptCharge extends GoalBudgetAmounts {
  /** True only when a token-metering executor certified the token figure. */
  readonly tokensMetered: boolean;
  /** True only when a run-pricing executor certified the cost figure. */
  readonly costMetered: boolean;
}

export type GoalAttemptSettlement =
  | { readonly kind: "settled"; readonly usage: GoalUsage }
  /** Execution may have happened: charge the full worst case. */
  | { readonly kind: "unknown" }
  /** Executor certified nothing ran: release everything. */
  | { readonly kind: "not-started" };

const ZERO: GoalBudgetAmounts = Object.freeze({
  calls: 0,
  runtimeMs: 0,
  tokens: 0,
  costMicros: 0,
});

export function initialBudget(limits: GoalBudgetLimits): GoalBudget {
  return { limits, reserved: ZERO, consumed: ZERO };
}

function counted(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function isMeasured(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exceeded(
  limit: "calls" | "runtime" | "tokens" | "cost",
): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code: "budget_exceeded",
      message: `Goal budget has no remaining ${limit} capacity.`,
      retryable: false,
      details: { limit },
    },
  };
}

function unmetered(limit: "tokens" | "cost"): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code: "metering_unavailable",
      message: `Enforcing the ${limit} limit requires authoritative executor metering.`,
      retryable: false,
      details: { limit },
    },
  };
}

/** Reject finite dimensions the executor cannot authoritatively measure. */
export function validateBudgetMetering(
  limits: MeteredBudgetLimits,
  metering: GoalMeteringCapabilities,
): GoalOutcome<undefined> {
  if (limits.maxTokens != null && !metering.tokens) return unmetered("tokens");
  if (limits.maxCostMicros != null && !metering.cost) return unmetered("cost");
  return { ok: true, value: undefined };
}

export function budgetRemaining(budget: GoalBudget): GoalBudgetAmounts {
  const used = (pick: keyof GoalBudgetAmounts) =>
    budget.reserved[pick] + budget.consumed[pick];
  const remaining = (limit: number | null, pick: keyof GoalBudgetAmounts) =>
    limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - used(pick));
  return {
    calls: remaining(budget.limits.maxAgentCalls, "calls"),
    runtimeMs: remaining(budget.limits.maxRuntimeMs, "runtimeMs"),
    tokens: remaining(budget.limits.maxTokens, "tokens"),
    costMicros: remaining(budget.limits.maxCostMicros, "costMicros"),
  };
}

/**
 * Reserve one Attempt's worst case.
 *
 * Finite token and cost limits require authoritative executor metering.
 * Reservations coordinate already-admitted Attempts; they are not measurements
 * and cannot make an unmetered executor bounded.
 *
 * The reservation is also what absorbs metering's one-request overshoot. A
 * token meter only advances when a request completes, so an executor enforcing
 * the node's cap can stop a child slightly above it. Holding the node's full
 * worst case from dispatch to settlement means that excess is charged against
 * capacity this Attempt already owned, so a Goal cannot be pushed past its
 * budget by a sibling that was admitted on the strength of an unspent
 * reservation.
 */
export function reserveAttempt(
  budget: GoalBudget,
  reservation: GoalReservation,
  metering: GoalMeteringCapabilities,
): GoalOutcome<GoalBudget> {
  const admitted = validateBudgetMetering(budget.limits, metering);
  if (!admitted.ok) return admitted;
  const remaining = budgetRemaining(budget);
  if (remaining.calls < 1) return exceeded("calls");
  if (remaining.runtimeMs < reservation.runtimeMs) return exceeded("runtime");
  if (remaining.tokens < reservation.tokens) return exceeded("tokens");
  if (remaining.costMicros < reservation.costMicros) return exceeded("cost");
  return {
    ok: true,
    value: {
      ...budget,
      reserved: {
        calls: budget.reserved.calls + 1,
        runtimeMs: budget.reserved.runtimeMs + reservation.runtimeMs,
        tokens: budget.reserved.tokens + reservation.tokens,
        costMicros: budget.reserved.costMicros + reservation.costMicros,
      },
    },
  };
}

/**
 * What one settled Attempt costs the budget, and how much of that was measured.
 *
 * Runtime is host-measured, so a well-formed reported value is trusted. Tokens
 * and cost are charged only when the executor both declares authoritative
 * metering and certifies the reported figure. Reservations are released, never
 * converted into fabricated usage for an unmetered completion.
 */
export function chargeForAttempt(
  reservation: GoalReservation,
  settlement: GoalAttemptSettlement,
  metering: GoalMeteringCapabilities,
): GoalAttemptCharge {
  if (settlement.kind === "not-started")
    return {
      calls: 0,
      runtimeMs: 0,
      tokens: 0,
      costMicros: 0,
      tokensMetered: false,
      costMetered: false,
    };
  if (settlement.kind === "unknown")
    return {
      calls: 1,
      ...reservation,
      tokensMetered: false,
      costMetered: false,
    };
  const measuredTokens = isMeasured(settlement.usage.tokens)
    ? settlement.usage.tokens
    : null;
  const measuredCost = isMeasured(settlement.usage.costMicros)
    ? settlement.usage.costMicros
    : null;
  const tokensMetered =
    metering.tokens &&
    settlement.usage.authoritative &&
    measuredTokens !== null;
  const costMetered =
    metering.cost && settlement.usage.authoritative && measuredCost !== null;
  return {
    calls: 1,
    runtimeMs: counted(settlement.usage.runtimeMs, reservation.runtimeMs),
    tokens: tokensMetered ? (measuredTokens ?? 0) : 0,
    costMicros: costMetered ? (measuredCost ?? 0) : 0,
    tokensMetered,
    costMetered,
  };
}

/** Release the reservation and record consumption. */
export function settleAttempt(
  budget: GoalBudget,
  reservation: GoalReservation,
  settlement: GoalAttemptSettlement,
  metering: GoalMeteringCapabilities,
): GoalBudget {
  const released = {
    calls: Math.max(0, budget.reserved.calls - 1),
    runtimeMs: Math.max(0, budget.reserved.runtimeMs - reservation.runtimeMs),
    tokens: Math.max(0, budget.reserved.tokens - reservation.tokens),
    costMicros: Math.max(
      0,
      budget.reserved.costMicros - reservation.costMicros,
    ),
  };
  if (settlement.kind === "not-started")
    return { ...budget, reserved: released };
  const charge = chargeForAttempt(reservation, settlement, metering);
  return {
    ...budget,
    reserved: released,
    consumed: {
      calls: budget.consumed.calls + charge.calls,
      runtimeMs: budget.consumed.runtimeMs + charge.runtimeMs,
      tokens: budget.consumed.tokens + charge.tokens,
      costMicros: budget.consumed.costMicros + charge.costMicros,
    },
  };
}
