/**
 * Reporting periods (ISO weeks, Monday–Sunday) in an IANA timezone.
 *
 * Rules
 * - A week is the local calendar range [Monday 00:00, next Monday 00:00) in the brand timezone.
 *   Its UTC length is 168h, except DST boundary weeks (167h / 169h) — never assume 7 * 24h.
 * - `end` is the inclusive local Sunday date; `endUtcExclusive` is the next local Monday 00:00 as an instant.
 * - A period is complete only once `now >= endUtcExclusive`. Partial weeks must never be compared
 *   against complete weeks (see metrics.compareValues).
 * - DST: a local wall time that does not exist (spring-forward gap) is shifted forward by the gap
 *   (e.g. 02:30 → 03:30 Europe/Paris). An ambiguous wall time (fall-back overlap) resolves to its
 *   FIRST occurrence (the pre-transition offset). This is luxon's documented behavior; we rely on it and test it.
 *
 * Pure functions: `now` is always injected.
 */
import { DateTime } from "luxon";

/** Reporting granularity. Absent on a period means "week" (backward compatible). */
export type PeriodKind = "week" | "month";

export interface WeekPeriod {
  timezone: string;
  kind?: PeriodKind;
  /** Local Monday, YYYY-MM-DD. */
  start: string;
  /** Local Sunday (inclusive), YYYY-MM-DD. */
  end: string;
  startUtc: Date;
  endUtcExclusive: Date;
}

export interface ReportSchedule {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  hour: number;
  minute: number;
}

/** Throws RangeError for an invalid IANA zone (configuration error, not data). */
export function assertValidTimezone(tz: string): void {
  if (!isValidTimezone(tz)) throw new RangeError(`Invalid IANA timezone: "${tz}"`);
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  return DateTime.fromMillis(0, { zone: tz }).isValid;
}

/** Local date string (YYYY-MM-DD) of an instant in a timezone. */
export function localDateKey(at: Date, tz: string): string {
  return DateTime.fromJSDate(at, { zone: tz }).toISODate() as string;
}

function weekFromLocalMonday(monday: DateTime, tz: string): WeekPeriod {
  // Rebuild from calendar fields so DST never shifts the boundaries.
  const start = DateTime.fromObject({ year: monday.year, month: monday.month, day: monday.day }, { zone: tz });
  const nextMondayDate = start.plus({ days: 7 });
  const next = DateTime.fromObject(
    { year: nextMondayDate.year, month: nextMondayDate.month, day: nextMondayDate.day },
    { zone: tz },
  );
  const sunday = start.plus({ days: 6 });
  return {
    timezone: tz,
    start: start.toISODate() as string,
    end: sunday.toISODate() as string,
    startUtc: start.toJSDate(),
    endUtcExclusive: next.toJSDate(),
    kind: "week",
  };
}

/** The (possibly incomplete) week that contains `at`. */
export function weekContaining(at: Date, tz: string): WeekPeriod {
  assertValidTimezone(tz);
  const local = DateTime.fromJSDate(at, { zone: tz });
  const monday = local.startOf("day").minus({ days: local.weekday - 1 });
  return weekFromLocalMonday(monday, tz);
}

/** The most recent fully elapsed Monday–Sunday week, in local time. */
export function previousCompleteWeek(now: Date, tz: string): WeekPeriod {
  return weekBefore(weekContaining(now, tz));
}

/** The week immediately before `period` (same timezone). */
export function weekBefore(period: WeekPeriod): WeekPeriod {
  const monday = DateTime.fromISO(period.start, { zone: period.timezone }).minus({ days: 7 });
  return weekFromLocalMonday(monday, period.timezone);
}

/** The week immediately after `period` (same timezone). */
export function weekAfter(period: WeekPeriod): WeekPeriod {
  const monday = DateTime.fromISO(period.start, { zone: period.timezone }).plus({ days: 7 });
  return weekFromLocalMonday(monday, period.timezone);
}

/** True once the whole period has elapsed (`now >= endUtcExclusive`). */
export function isPeriodComplete(period: Pick<WeekPeriod, "endUtcExclusive">, now: Date): boolean {
  return now.getTime() >= period.endUtcExclusive.getTime();
}

/** True when `at` falls inside [startUtc, endUtcExclusive). */
export function isInPeriod(period: Pick<WeekPeriod, "startUtc" | "endUtcExclusive">, at: Date): boolean {
  const t = at.getTime();
  return t >= period.startUtc.getTime() && t < period.endUtcExclusive.getTime();
}

/**
 * `n` consecutive weeks ENDING WITH `period` (inclusive), oldest first.
 * For a baseline that excludes the current week, call `rollingWeeks(weekBefore(period), n)`.
 */
export function rollingWeeks(period: WeekPeriod, n: number): WeekPeriod[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`rollingWeeks: n must be a non-negative integer, got ${n}`);
  const out: WeekPeriod[] = [];
  let cursor = period;
  for (let i = 0; i < n; i++) {
    out.push(cursor);
    cursor = weekBefore(cursor);
  }
  return out.reverse();
}

/**
 * Next report run strictly after `now`, at the local wall time `schedule` in `tz`.
 * DST: nonexistent wall times shift forward by the gap; ambiguous wall times use the first occurrence.
 */
export function nextReportRunAt(now: Date, tz: string, schedule: ReportSchedule): Date {
  assertValidTimezone(tz);
  const { dayOfWeek, hour, minute } = schedule;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    throw new RangeError(`dayOfWeek must be 1..7 (ISO, 1 = Monday), got ${dayOfWeek}`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError(`Invalid report time ${hour}:${minute}`);
  }
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  // 8 days guarantees a match even when today's run time has already passed.
  for (let d = 0; d <= 8; d++) {
    const day = today.plus({ days: d });
    if (day.weekday !== dayOfWeek) continue;
    const candidate = DateTime.fromObject(
      { year: day.year, month: day.month, day: day.day, hour, minute },
      { zone: tz },
    );
    if (candidate.toMillis() > now.getTime()) return candidate.toJSDate();
  }
  /* c8 ignore next */
  throw new Error("nextReportRunAt: no candidate found (unreachable)");
}

// ---------------------------------------------------------------------------
// Calendar months (same shape as weeks, so reports and metrics can use either)
// ---------------------------------------------------------------------------
function monthFromLocalDate(anyDay: DateTime, tz: string): WeekPeriod {
  const start = DateTime.fromObject({ year: anyDay.year, month: anyDay.month, day: 1 }, { zone: tz });
  const nextFirst = start.plus({ months: 1 });
  const next = DateTime.fromObject({ year: nextFirst.year, month: nextFirst.month, day: 1 }, { zone: tz });
  return {
    timezone: tz,
    kind: "month",
    start: start.toISODate() as string,
    end: next.minus({ days: 1 }).toISODate() as string,
    startUtc: start.toJSDate(),
    endUtcExclusive: next.toJSDate(),
  };
}

/** The (possibly incomplete) calendar month that contains `at`, in local time. */
export function monthContaining(at: Date, tz: string): WeekPeriod {
  assertValidTimezone(tz);
  return monthFromLocalDate(DateTime.fromJSDate(at, { zone: tz }), tz);
}

/** The most recent fully elapsed calendar month, in local time. */
export function previousCompleteMonth(now: Date, tz: string): WeekPeriod {
  return periodBefore(monthContaining(now, tz));
}

export function periodContaining(kind: PeriodKind, at: Date, tz: string): WeekPeriod {
  return kind === "month" ? monthContaining(at, tz) : weekContaining(at, tz);
}

export function previousCompletePeriod(kind: PeriodKind, now: Date, tz: string): WeekPeriod {
  return periodBefore(periodContaining(kind, now, tz));
}

/** The period immediately before `period` (same kind and timezone). */
export function periodBefore(period: WeekPeriod): WeekPeriod {
  if (period.kind !== "month") return weekBefore(period);
  return monthFromLocalDate(DateTime.fromISO(period.start, { zone: period.timezone }).minus({ months: 1 }), period.timezone);
}

/** The period immediately after `period` (same kind and timezone). */
export function periodAfter(period: WeekPeriod): WeekPeriod {
  if (period.kind !== "month") return weekAfter(period);
  return monthFromLocalDate(DateTime.fromISO(period.start, { zone: period.timezone }).plus({ months: 1 }), period.timezone);
}

/** `n` consecutive periods ENDING WITH `period` (inclusive), oldest first. */
export function rollingPeriods(period: WeekPeriod, n: number): WeekPeriod[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`rollingPeriods: n must be a non-negative integer, got ${n}`);
  const out: WeekPeriod[] = [];
  let cursor = period;
  for (let i = 0; i < n; i++) {
    out.push(cursor);
    cursor = periodBefore(cursor);
  }
  return out.reverse();
}
