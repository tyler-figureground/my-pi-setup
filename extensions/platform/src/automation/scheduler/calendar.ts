import { CronExpressionParser } from "cron-parser";
import type {
  CalendarSearchOptions,
  MissedRunPolicy,
  Schedule,
  ScheduleInput,
} from "./model.ts";

const explicitOffsetInstant =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function parseExplicitInstant(value: string, label: string) {
  const match = explicitOffsetInstant.exec(value);
  if (!match) {
    throw new TypeError(
      `${label} must be an RFC 3339 instant with an explicit offset`,
    );
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new RangeError(`${label} is not a valid RFC 3339 instant`);
  }

  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`${label} is not a valid RFC 3339 instant`);
  }
  return epochMs;
}

function normalizeCron(expression: string, timeZone: string) {
  const fields = expression.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    fields.some((field) => !/^[\d*,/-]+$/.test(field))
  ) {
    throw new RangeError(
      "cron expression must use five numeric fields without aliases or special operators",
    );
  }
  if (fields[2] !== "*" && fields[4] !== "*") {
    throw new RangeError(
      "cron expression cannot constrain both day-of-month and day-of-week",
    );
  }

  const ianaName =
    timeZone === "UTC" ||
    /^(?:[A-Za-z][A-Za-z0-9._+-]*\/)+[A-Za-z][A-Za-z0-9._+-]*$/.test(timeZone);
  if (!ianaName) {
    throw new RangeError(
      "cron timeZone must be an explicit valid IANA timezone",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new RangeError(
      "cron timeZone must be an explicit valid IANA timezone",
    );
  }

  const normalizedExpression = fields.join(" ");
  try {
    CronExpressionParser.parse(`0 ${normalizedExpression}`, {
      currentDate: "2000-01-01T00:00:00.000Z",
      strict: true,
      tz: timeZone,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new RangeError(`invalid cron expression: ${reason}`);
  }

  return { normalizedExpression, timeZone };
}

export function normalizeSchedule(input: ScheduleInput) {
  if (input.kind === "one-shot") {
    return {
      kind: "one-shot",
      at: new Date(parseExplicitInstant(input.at, "one-shot at")).toISOString(),
    } as const;
  }

  if (input.kind === "cron") {
    const cron = normalizeCron(input.expression, input.timeZone);
    return {
      kind: "cron",
      expression: cron.normalizedExpression,
      timeZone: cron.timeZone,
    } as const;
  }

  if (!Number.isSafeInteger(input.everyMs) || input.everyMs <= 0) {
    throw new RangeError("interval everyMs must be a positive safe integer");
  }
  return {
    kind: "interval",
    anchor: new Date(
      parseExplicitInstant(input.anchor, "interval anchor"),
    ).toISOString(),
    everyMs: input.everyMs,
  } as const;
}

function localFields(epochMs: number, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(epochMs)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  const year = parts.year;
  const month = parts.month;
  const dayOfMonth = parts.day;
  if (year === undefined || month === undefined || dayOfMonth === undefined) {
    throw new RangeError(
      `cannot resolve local calendar fields for ${timeZone}`,
    );
  }
  return {
    second: parts.second,
    minute: parts.minute,
    hour: parts.hour,
    dayOfMonth,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
  };
}

function fieldMatches(values: readonly (number | string)[], value: number) {
  return values.some((candidate) => candidate === value);
}

function candidateMatchesLocalFields(
  expression: ReturnType<typeof CronExpressionParser.parse>,
  epochMs: number,
  timeZone: string,
) {
  const local = localFields(epochMs, timeZone);
  return (
    local.second !== undefined &&
    local.minute !== undefined &&
    local.hour !== undefined &&
    fieldMatches(expression.fields.second.values, local.second) &&
    fieldMatches(expression.fields.minute.values, local.minute) &&
    fieldMatches(expression.fields.hour.values, local.hour) &&
    fieldMatches(expression.fields.dayOfMonth.values, local.dayOfMonth) &&
    fieldMatches(expression.fields.month.values, local.month) &&
    fieldMatches(expression.fields.dayOfWeek.values, local.dayOfWeek)
  );
}

function cronOccurrence(
  schedule: Extract<Schedule, { kind: "cron" }>,
  afterMs: number,
  options: CalendarSearchOptions,
) {
  const horizonMs = options.horizonMs ?? 10 * 366 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(horizonMs) || horizonMs <= 0) {
    throw new RangeError("calendar horizonMs must be a positive safe integer");
  }

  const candidateLimit = options.candidateLimit ?? 10_000;
  if (
    !Number.isSafeInteger(candidateLimit) ||
    candidateLimit <= 0 ||
    candidateLimit > 10_000
  ) {
    throw new RangeError(
      "calendar candidateLimit must be a positive integer no greater than 10000",
    );
  }

  const maximumDateMs = 8_640_000_000_000_000n;
  const requestedEndMs = BigInt(afterMs) + BigInt(horizonMs);
  const endMs = requestedEndMs < maximumDateMs ? requestedEndMs : maximumDateMs;
  try {
    const expression = CronExpressionParser.parse(`0 ${schedule.expression}`, {
      currentDate: afterMs,
      endDate: Number(endMs),
      strict: true,
      tz: schedule.timeZone,
    });
    for (
      let index = 0;
      index < candidateLimit && expression.hasNext();
      index++
    ) {
      const candidate = expression.next();
      const epochMs = candidate.getTime();
      if (candidateMatchesLocalFields(expression, epochMs, schedule.timeZone)) {
        return candidate.toISOString();
      }
    }
    return null;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "Out of the time span range" ||
        error.message === "Invalid expression, loop limit exceeded")
    ) {
      return null;
    }
    throw error;
  }
}

export function nextOccurrence(
  schedule: Schedule,
  after: string,
  options: CalendarSearchOptions = {},
) {
  const afterMs = parseExplicitInstant(after, "after");
  if (schedule.kind === "one-shot") {
    const occurrenceMs = parseExplicitInstant(schedule.at, "one-shot at");
    return occurrenceMs > afterMs ? new Date(occurrenceMs).toISOString() : null;
  }
  if (schedule.kind === "cron") {
    return cronOccurrence(schedule, afterMs, options);
  }

  const anchorMs = parseExplicitInstant(schedule.anchor, "interval anchor");
  if (anchorMs > afterMs) {
    return new Date(anchorMs).toISOString();
  }

  const everyMs = BigInt(schedule.everyMs);
  const elapsedMs = BigInt(afterMs) - BigInt(anchorMs);
  const occurrenceMs = BigInt(anchorMs) + (elapsedMs / everyMs + 1n) * everyMs;
  const maximumDateMs = 8_640_000_000_000_000n;
  if (occurrenceMs > maximumDateMs) {
    return null;
  }
  return new Date(Number(occurrenceMs)).toISOString();
}

export function resolveMissedRun(
  schedule: Schedule,
  dueAt: string,
  now: string,
  policy: MissedRunPolicy,
  options: CalendarSearchOptions = {},
) {
  const dueMs = parseExplicitInstant(dueAt, "dueAt");
  const nowMs = parseExplicitInstant(now, "now");
  if (dueMs > nowMs) {
    return {
      occurrenceAt: null,
      nextAt: new Date(dueMs).toISOString(),
      missed: false,
    };
  }
  if (dueMs === nowMs) {
    return {
      occurrenceAt: new Date(dueMs).toISOString(),
      nextAt: nextOccurrence(schedule, now, options),
      missed: false,
    };
  }

  const nextAt = nextOccurrence(schedule, now, options);
  if (policy === "skip") {
    return { occurrenceAt: null, nextAt, missed: true };
  }
  return {
    occurrenceAt: new Date(dueMs).toISOString(),
    nextAt,
    missed: true,
  };
}
