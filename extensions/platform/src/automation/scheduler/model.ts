export interface OneShotScheduleInput {
  readonly kind: "one-shot";
  readonly at: string;
}

export interface OneShotSchedule {
  readonly kind: "one-shot";
  readonly at: string;
}

export interface IntervalScheduleInput {
  readonly kind: "interval";
  readonly anchor: string;
  readonly everyMs: number;
}

export interface IntervalSchedule {
  readonly kind: "interval";
  readonly anchor: string;
  readonly everyMs: number;
}

export interface CronScheduleInput {
  readonly kind: "cron";
  readonly expression: string;
  readonly timeZone: string;
}

export interface CronSchedule {
  readonly kind: "cron";
  readonly expression: string;
  readonly timeZone: string;
}

export type ScheduleInput =
  OneShotScheduleInput | IntervalScheduleInput | CronScheduleInput;
export type Schedule = OneShotSchedule | IntervalSchedule | CronSchedule;

export interface CalendarSearchOptions {
  readonly horizonMs?: number;
  readonly candidateLimit?: number;
}

export type MissedRunPolicy = "skip" | "run-once";
