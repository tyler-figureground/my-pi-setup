import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetRemaining,
  chargeForAttempt,
  initialBudget,
  reserveAttempt,
  settleAttempt,
  type GoalBudgetLimits,
  type GoalReservation,
} from "./src/goals/index.ts";

const METERED = { tokens: true, cost: true };
const UNMETERED = { tokens: false, cost: false };

function limits(overrides: Partial<GoalBudgetLimits> = {}): GoalBudgetLimits {
  return {
    maxConcurrency: 2,
    maxAgentCalls: 3,
    maxRuntimeMs: 10_000,
    maxTokens: null,
    maxCostMicros: null,
    ...overrides,
  };
}

function reservation(
  overrides: Partial<GoalReservation> = {},
): GoalReservation {
  return { runtimeMs: 4_000, tokens: 0, costMicros: 0, ...overrides };
}

test("reservation holds worst case amounts before dispatch", () => {
  const budget = initialBudget(limits());
  const reserved = reserveAttempt(budget, reservation(), UNMETERED);
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.deepEqual(reserved.value.reserved, {
    calls: 1,
    runtimeMs: 4_000,
    tokens: 0,
    costMicros: 0,
  });
  assert.deepEqual(reserved.value.consumed, {
    calls: 0,
    runtimeMs: 0,
    tokens: 0,
    costMicros: 0,
  });
  assert.deepEqual(budgetRemaining(reserved.value), {
    calls: 2,
    runtimeMs: 6_000,
    tokens: Number.POSITIVE_INFINITY,
    costMicros: Number.POSITIVE_INFINITY,
  });
});

test("reservations refuse to exceed call, runtime, token, or cost limits", () => {
  const callBound = initialBudget(limits({ maxAgentCalls: 1 }));
  const first = reserveAttempt(callBound, reservation(), UNMETERED);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = reserveAttempt(first.value, reservation(), UNMETERED);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.code, "budget_exceeded");
  assert.equal(second.error.details?.limit, "calls");

  const runtime = reserveAttempt(
    initialBudget(limits({ maxRuntimeMs: 1_000 })),
    reservation({ runtimeMs: 4_000 }),
    UNMETERED,
  );
  assert.equal(runtime.ok, false);
  if (!runtime.ok) assert.equal(runtime.error.details?.limit, "runtime");

  const tokens = reserveAttempt(
    initialBudget(limits({ maxTokens: 100 })),
    reservation({ tokens: 500 }),
    METERED,
  );
  assert.equal(tokens.ok, false);
  if (!tokens.ok) assert.equal(tokens.error.details?.limit, "tokens");

  const cost = reserveAttempt(
    initialBudget(limits({ maxCostMicros: 1_000 })),
    reservation({ costMicros: 2_500 }),
    METERED,
  );
  assert.equal(cost.ok, false);
  if (!cost.ok) assert.equal(cost.error.details?.limit, "cost");
});

test("token and cost limits without executor metering block dispatch", () => {
  const tokens = reserveAttempt(
    initialBudget(limits({ maxTokens: 10_000 })),
    reservation({ tokens: 500 }),
    UNMETERED,
  );
  assert.equal(tokens.ok, false);
  if (!tokens.ok) {
    assert.equal(tokens.error.code, "metering_unavailable");
    assert.equal(tokens.error.details?.limit, "tokens");
    assert.equal(tokens.error.retryable, false);
  }
  const cost = reserveAttempt(
    initialBudget(limits({ maxCostMicros: 10_000 })),
    reservation({ costMicros: 500 }),
    { tokens: true, cost: false },
  );
  assert.equal(cost.ok, false);
  if (!cost.ok) {
    assert.equal(cost.error.code, "metering_unavailable");
    assert.equal(cost.error.details?.limit, "cost");
  }
});

test("a reservation never substitutes for authoritative token metering", () => {
  const budget = initialBudget(limits({ maxAgentCalls: 8, maxTokens: 1_000 }));
  const reserved = reserveAttempt(
    budget,
    reservation({ tokens: 400 }),
    UNMETERED,
  );
  assert.equal(reserved.ok, false);
  if (!reserved.ok) {
    assert.equal(reserved.error.code, "metering_unavailable");
    assert.equal(reserved.error.details?.limit, "tokens");
  }
});

test("a reservation never substitutes for authoritative cost metering", () => {
  const tokenMeteredOnly = { tokens: true, cost: false };
  const budget = initialBudget(
    limits({ maxAgentCalls: 8, maxCostMicros: 1_000 }),
  );
  const reserved = reserveAttempt(
    budget,
    reservation({ costMicros: 400 }),
    tokenMeteredOnly,
  );
  assert.equal(reserved.ok, false);
  if (!reserved.ok) {
    assert.equal(reserved.error.code, "metering_unavailable");
    assert.equal(reserved.error.details?.limit, "cost");
  }
});

test("only authoritative executor usage is charged as token or cost usage", () => {
  const charge = chargeForAttempt(
    reservation({ tokens: 1_000, costMicros: 500 }),
    {
      kind: "settled",
      usage: {
        runtimeMs: 900,
        tokens: 250,
        costMicros: 90,
        authoritative: true,
      },
    },
    METERED,
  );
  assert.equal(charge.costMicros, 90);
  assert.equal(charge.costMetered, true);

  // A settled run with no authoritative reading releases its reservation. The
  // reservation is admission control, not a usage estimate.
  const unmetered = chargeForAttempt(
    reservation({ tokens: 1_000, costMicros: 500 }),
    {
      kind: "settled",
      usage: {
        runtimeMs: 900,
        tokens: 250,
        costMicros: 90,
        authoritative: false,
      },
    },
    METERED,
  );
  assert.equal(unmetered.costMicros, 0);
  assert.equal(unmetered.costMetered, false);
  assert.equal(unmetered.tokens, 0);
  assert.equal(unmetered.tokensMetered, false);
});

test("settlement moves authoritative usage to consumed and frees the rest", () => {
  const budget = initialBudget(
    limits({ maxTokens: 10_000, maxCostMicros: 10_000 }),
  );
  const reserved = reserveAttempt(
    budget,
    reservation({ tokens: 1_000, costMicros: 500 }),
    METERED,
  );
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const settled = settleAttempt(
    reserved.value,
    reservation({ tokens: 1_000, costMicros: 500 }),
    {
      kind: "settled",
      usage: {
        runtimeMs: 1_200,
        tokens: 250,
        costMicros: 90,
        authoritative: true,
      },
    },
    METERED,
  );
  assert.deepEqual(settled.reserved, {
    calls: 0,
    runtimeMs: 0,
    tokens: 0,
    costMicros: 0,
  });
  assert.deepEqual(settled.consumed, {
    calls: 1,
    runtimeMs: 1_200,
    tokens: 250,
    costMicros: 90,
  });
});

test("unknown attempts consume the entire reservation", () => {
  const reserved = reserveAttempt(
    initialBudget(limits({ maxTokens: 10_000, maxCostMicros: 10_000 })),
    reservation({ tokens: 1_000, costMicros: 500 }),
    METERED,
  );
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const settled = settleAttempt(
    reserved.value,
    reservation({ tokens: 1_000, costMicros: 500 }),
    { kind: "unknown" },
    METERED,
  );
  assert.deepEqual(settled.reserved, {
    calls: 0,
    runtimeMs: 0,
    tokens: 0,
    costMicros: 0,
  });
  assert.deepEqual(settled.consumed, {
    calls: 1,
    runtimeMs: 4_000,
    tokens: 1_000,
    costMicros: 500,
  });
});

test("certified not started attempts release the whole reservation", () => {
  const reserved = reserveAttempt(
    initialBudget(limits()),
    reservation(),
    UNMETERED,
  );
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const settled = settleAttempt(
    reserved.value,
    reservation(),
    { kind: "not-started" },
    UNMETERED,
  );
  assert.deepEqual(settled.reserved, {
    calls: 0,
    runtimeMs: 0,
    tokens: 0,
    costMicros: 0,
  });
  assert.deepEqual(settled.consumed, {
    calls: 0,
    runtimeMs: 0,
    tokens: 0,
    costMicros: 0,
  });
});

test("unmetered or malformed usage never becomes measured consumption", () => {
  const reserved = reserveAttempt(
    initialBudget(limits()),
    reservation(),
    UNMETERED,
  );
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const unauthoritative = settleAttempt(
    reserved.value,
    reservation(),
    {
      kind: "settled",
      usage: {
        runtimeMs: 1_000,
        tokens: 25,
        costMicros: 5,
        authoritative: false,
      },
    },
    UNMETERED,
  );
  assert.equal(unauthoritative.consumed.tokens, 0);
  assert.equal(unauthoritative.consumed.costMicros, 0);
  assert.equal(unauthoritative.consumed.runtimeMs, 1_000);

  const malformed = chargeForAttempt(
    reservation({ tokens: 1_000, costMicros: 500 }),
    {
      kind: "settled",
      usage: {
        runtimeMs: 1.5,
        tokens: -3,
        costMicros: Number.NaN,
        authoritative: true,
      },
    },
    METERED,
  );
  assert.deepEqual(malformed, {
    calls: 1,
    runtimeMs: 4_000,
    tokens: 0,
    costMicros: 0,
    tokensMetered: false,
    costMetered: false,
  });
});

test("over consumption is recorded and closes the budget", () => {
  const reserved = reserveAttempt(
    initialBudget(limits({ maxRuntimeMs: 10_000 })),
    reservation({ runtimeMs: 4_000 }),
    UNMETERED,
  );
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const settled = settleAttempt(
    reserved.value,
    reservation({ runtimeMs: 4_000 }),
    {
      kind: "settled",
      usage: {
        runtimeMs: 9_000,
        tokens: 0,
        costMicros: 0,
        authoritative: true,
      },
    },
    METERED,
  );
  assert.equal(settled.consumed.runtimeMs, 9_000);
  assert.equal(budgetRemaining(settled).runtimeMs, 1_000);
  const next = reserveAttempt(
    settled,
    reservation({ runtimeMs: 4_000 }),
    UNMETERED,
  );
  assert.equal(next.ok, false);
  if (!next.ok) assert.equal(next.error.details?.limit, "runtime");
});

test("currency stays integral micros through reserve and settle", () => {
  const reserved = reserveAttempt(
    initialBudget(limits({ maxCostMicros: 1_000_000 })),
    reservation({ costMicros: 1 }),
    METERED,
  );
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  const settled = settleAttempt(
    reserved.value,
    reservation({ costMicros: 1 }),
    {
      kind: "settled",
      usage: { runtimeMs: 1, tokens: 0, costMicros: 1, authoritative: true },
    },
    METERED,
  );
  for (const value of Object.values(settled.consumed)) {
    assert.equal(Number.isSafeInteger(value), true);
  }
  for (const value of Object.values(settled.reserved)) {
    assert.equal(Number.isSafeInteger(value), true);
  }
});
