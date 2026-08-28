import assert from "node:assert/strict";
import test from "node:test";
import {
  nextOccurrence,
  normalizeSchedule,
  resolveMissedRun,
} from "./src/automation/scheduler/calendar.ts";

test("one-shot schedules require an explicit offset and produce one UTC occurrence", () => {
  const schedule = normalizeSchedule({
    kind: "one-shot",
    at: "2027-01-15T12:30:00+05:45",
  });

  assert.deepEqual(schedule, {
    kind: "one-shot",
    at: "2027-01-15T06:45:00.000Z",
  });
  assert.equal(
    nextOccurrence(schedule, "2027-01-15T06:44:59.999Z"),
    "2027-01-15T06:45:00.000Z",
  );
  assert.equal(nextOccurrence(schedule, "2027-01-15T06:45:00.000Z"), null);
  assert.throws(
    () => normalizeSchedule({ kind: "one-shot", at: "2027-01-15T12:30:00" }),
    /explicit offset/,
  );
});

test("fixed intervals advance from their anchor rather than a completion time", () => {
  const schedule = normalizeSchedule({
    kind: "interval",
    anchor: "2027-01-15T12:30:00+05:45",
    everyMs: 90 * 60 * 1_000,
  });

  assert.deepEqual(schedule, {
    kind: "interval",
    anchor: "2027-01-15T06:45:00.000Z",
    everyMs: 5_400_000,
  });
  assert.equal(
    nextOccurrence(schedule, "2027-01-15T06:00:00.000Z"),
    "2027-01-15T06:45:00.000Z",
  );
  assert.equal(
    nextOccurrence(schedule, "2027-01-15T09:44:00.000Z"),
    "2027-01-15T09:45:00.000Z",
  );
  assert.throws(
    () =>
      normalizeSchedule({
        kind: "interval",
        anchor: "2027-01-15T06:45:00Z",
        everyMs: 0,
      }),
    /positive safe integer/,
  );
});

test("cron accepts only unambiguous five-field numeric grammar with an explicit IANA timezone", () => {
  assert.deepEqual(
    normalizeSchedule({
      kind: "cron",
      expression: "  */15   9-17  * * 1-5 ",
      timeZone: "America/New_York",
    }),
    {
      kind: "cron",
      expression: "*/15 9-17 * * 1-5",
      timeZone: "America/New_York",
    },
  );

  const rejectedExpressions = [
    "0 */15 9-17 * * 1-5",
    "@daily",
    "0 9 * * MON",
    "H 9 * * *",
    "0 9 L * *",
    "0 9 1W * *",
    "0 9 * * 1#2",
    "0 9 1 * 1",
  ];
  for (const expression of rejectedExpressions) {
    assert.throws(
      () =>
        normalizeSchedule({
          kind: "cron",
          expression,
          timeZone: "America/New_York",
        }),
      /cron/i,
      expression,
    );
  }

  for (const timeZone of ["Not/A_Zone", "+01:00"]) {
    assert.throws(
      () =>
        normalizeSchedule({
          kind: "cron",
          expression: "0 9 * * *",
          timeZone,
        }),
      /IANA timezone/,
    );
  }
});

test("cron next occurrences are UTC-stable and bounded by the caller search horizon", () => {
  const weekdays = normalizeSchedule({
    kind: "cron",
    expression: "0 9 * * 1-5",
    timeZone: "America/New_York",
  });
  const previousHostZone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Auckland";
    assert.equal(
      nextOccurrence(weekdays, "2027-01-15T13:59:59.999Z"),
      "2027-01-15T14:00:00.000Z",
    );
    process.env.TZ = "Europe/London";
    assert.equal(
      nextOccurrence(weekdays, "2027-01-15T14:00:00.000Z"),
      "2027-01-18T14:00:00.000Z",
    );
  } finally {
    process.env.TZ = previousHostZone;
  }

  const leapDay = normalizeSchedule({
    kind: "cron",
    expression: "0 0 29 2 *",
    timeZone: "UTC",
  });
  assert.equal(
    nextOccurrence(leapDay, "2028-02-29T00:00:00.000Z", {
      horizonMs: 366 * 24 * 60 * 60 * 1_000,
    }),
    null,
  );
  assert.equal(
    nextOccurrence(leapDay, "2028-02-29T00:00:00.000Z"),
    "2032-02-29T00:00:00.000Z",
  );
});

test("cron skips nonexistent local occurrences instead of accepting DST shifts", () => {
  const vectors = [
    {
      timeZone: "America/New_York",
      expression: "30 2 * * *",
      after: "2026-03-07T07:30:00.000Z",
      expected: "2026-03-09T06:30:00.000Z",
    },
    {
      timeZone: "Australia/Lord_Howe",
      expression: "15 2 * * *",
      after: "2026-10-02T15:45:00.000Z",
      expected: "2026-10-04T15:15:00.000Z",
    },
    {
      timeZone: "Pacific/Chatham",
      expression: "0 3 * * *",
      after: "2026-09-25T14:15:00.000Z",
      expected: "2026-09-27T13:15:00.000Z",
    },
    {
      timeZone: "Africa/Casablanca",
      expression: "30 2 * * *",
      after: "2026-03-21T02:30:00.000Z",
      expected: "2026-03-23T01:30:00.000Z",
    },
  ] as const;

  for (const vector of vectors) {
    const schedule = normalizeSchedule({
      kind: "cron",
      expression: vector.expression,
      timeZone: vector.timeZone,
    });
    assert.equal(
      nextOccurrence(schedule, vector.after),
      vector.expected,
      vector.timeZone,
    );
  }
});

test("cron overlaps choose the earliest instant once across non-hour transitions", () => {
  const vectors = [
    {
      timeZone: "America/New_York",
      expression: "30 1 * * *",
      after: "2026-10-31T05:30:00.000Z",
      first: "2026-11-01T05:30:00.000Z",
      following: "2026-11-02T06:30:00.000Z",
    },
    {
      timeZone: "Australia/Lord_Howe",
      expression: "45 1 * * *",
      after: "2026-04-03T14:45:00.000Z",
      first: "2026-04-04T14:45:00.000Z",
      following: "2026-04-05T15:15:00.000Z",
    },
    {
      timeZone: "Pacific/Chatham",
      expression: "0 3 * * *",
      after: "2026-04-03T13:15:00.000Z",
      first: "2026-04-04T13:15:00.000Z",
      following: "2026-04-05T14:15:00.000Z",
    },
    {
      timeZone: "Africa/Casablanca",
      expression: "30 2 * * *",
      after: "2026-02-14T01:30:00.000Z",
      first: "2026-02-15T01:30:00.000Z",
      following: "2026-02-16T02:30:00.000Z",
    },
  ] as const;

  for (const vector of vectors) {
    const schedule = normalizeSchedule({
      kind: "cron",
      expression: vector.expression,
      timeZone: vector.timeZone,
    });
    const first = nextOccurrence(schedule, vector.after);
    assert.equal(first, vector.first, vector.timeZone);
    assert.equal(
      nextOccurrence(schedule, first!),
      vector.following,
      vector.timeZone,
    );
  }
});

test("missed skip and run-once advance cadence while collapsing backlog", () => {
  const schedule = normalizeSchedule({
    kind: "interval",
    anchor: "2027-01-01T00:00:00Z",
    everyMs: 60 * 60 * 1_000,
  });
  const dueAt = "2027-01-01T01:00:00.000Z";
  const now = "2027-01-01T05:30:00.000Z";

  assert.deepEqual(resolveMissedRun(schedule, dueAt, now, "skip"), {
    occurrenceAt: null,
    nextAt: "2027-01-01T06:00:00.000Z",
    missed: true,
  });
  assert.deepEqual(resolveMissedRun(schedule, dueAt, now, "run-once"), {
    occurrenceAt: dueAt,
    nextAt: "2027-01-01T06:00:00.000Z",
    missed: true,
  });
  assert.deepEqual(resolveMissedRun(schedule, now, now, "skip"), {
    occurrenceAt: now,
    nextAt: "2027-01-01T06:00:00.000Z",
    missed: false,
  });
});
