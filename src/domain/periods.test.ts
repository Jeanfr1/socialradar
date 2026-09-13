import { describe, expect, it } from "vitest";
import {
  isInPeriod,
  isPeriodComplete,
  nextReportRunAt,
  previousCompleteWeek,
  rollingWeeks,
  weekAfter,
  weekBefore,
  weekContaining,
} from "./periods";

const H = 3_600_000;
const hours = (p: { startUtc: Date; endUtcExclusive: Date }) => (p.endUtcExclusive.getTime() - p.startUtc.getTime()) / H;

describe("previousCompleteWeek", () => {
  it("uses the local calendar: Sunday 23:30 in São Paulo is still the current week even though UTC is Monday", () => {
    const now = new Date("2026-09-14T02:30:00Z"); // Sun 13 Sep 23:30 -03:00
    const week = previousCompleteWeek(now, "America/Sao_Paulo");
    expect(week.start).toBe("2026-08-31");
    expect(week.end).toBe("2026-09-06");
    expect(week.startUtc.toISOString()).toBe("2026-08-31T03:00:00.000Z");
    expect(week.endUtcExclusive.toISOString()).toBe("2026-09-07T03:00:00.000Z");

    // Same instant in UTC is already Monday 14 → the week 7–13 Sep is complete.
    const utcWeek = previousCompleteWeek(now, "UTC");
    expect([utcWeek.start, utcWeek.end]).toEqual(["2026-09-07", "2026-09-13"]);
  });

  it("spring-forward week in Europe/Paris lasts 167 hours", () => {
    const week = previousCompleteWeek(new Date("2026-03-30T10:00:00Z"), "Europe/Paris");
    expect([week.start, week.end]).toEqual(["2026-03-23", "2026-03-29"]);
    expect(week.startUtc.toISOString()).toBe("2026-03-22T23:00:00.000Z"); // +01:00
    expect(week.endUtcExclusive.toISOString()).toBe("2026-03-29T22:00:00.000Z"); // +02:00
    expect(hours(week)).toBe(167);
  });

  it("fall-back week in Europe/Paris lasts 169 hours", () => {
    const week = previousCompleteWeek(new Date("2026-10-26T12:00:00Z"), "Europe/Paris");
    expect([week.start, week.end]).toEqual(["2026-10-19", "2026-10-25"]);
    expect(week.startUtc.toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(week.endUtcExclusive.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(hours(week)).toBe(169);
  });

  it("handles a week spanning a month and year boundary", () => {
    const week = previousCompleteWeek(new Date("2027-01-06T12:00:00Z"), "Europe/Paris");
    expect([week.start, week.end]).toEqual(["2026-12-28", "2027-01-03"]);
    expect(week.startUtc.toISOString()).toBe("2026-12-27T23:00:00.000Z");
    expect(week.endUtcExclusive.toISOString()).toBe("2027-01-03T23:00:00.000Z");
  });

  it("on Monday 00:00 local exactly, the week that just ended is the previous complete week", () => {
    const week = previousCompleteWeek(new Date("2026-09-07T03:00:00Z"), "America/Sao_Paulo");
    expect(week.start).toBe("2026-08-31");
    expect(isPeriodComplete(week, new Date("2026-09-07T03:00:00Z"))).toBe(true);
  });

  it("rejects invalid timezones", () => {
    expect(() => previousCompleteWeek(new Date(), "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("weekBefore / weekAfter / rollingWeeks", () => {
  it("weekBefore crosses the fall-back boundary with correct UTC bounds", () => {
    const current = weekContaining(new Date("2026-10-28T12:00:00Z"), "Europe/Paris");
    expect(current.start).toBe("2026-10-26");
    const prev = weekBefore(current);
    expect([prev.start, prev.end]).toEqual(["2026-10-19", "2026-10-25"]);
    expect(prev.endUtcExclusive.getTime()).toBe(current.startUtc.getTime());
    expect(weekAfter(prev)).toEqual(current);
  });

  it("rollingWeeks returns contiguous weeks, oldest first, ending with the given week", () => {
    const last = previousCompleteWeek(new Date("2026-04-08T12:00:00Z"), "Europe/Paris"); // 30 Mar – 5 Apr
    const weeks = rollingWeeks(last, 4);
    expect(weeks.map((w) => w.start)).toEqual(["2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30"]);
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]!.startUtc.getTime()).toBe(weeks[i - 1]!.endUtcExclusive.getTime());
    }
    expect(weeks.map(hours)).toEqual([168, 168, 167, 168]);
    expect(rollingWeeks(last, 0)).toEqual([]);
    expect(() => rollingWeeks(last, -1)).toThrow(RangeError);
  });
});

describe("isPeriodComplete / isInPeriod", () => {
  const week = previousCompleteWeek(new Date("2026-09-14T12:00:00Z"), "America/Sao_Paulo"); // 7–13 Sep

  it("is incomplete until the exclusive end instant", () => {
    expect(isPeriodComplete(week, new Date(week.endUtcExclusive.getTime() - 1))).toBe(false);
    expect(isPeriodComplete(week, week.endUtcExclusive)).toBe(true);
  });

  it("membership is [start, end)", () => {
    expect(isInPeriod(week, week.startUtc)).toBe(true);
    expect(isInPeriod(week, week.endUtcExclusive)).toBe(false);
    expect(isInPeriod(week, new Date("2026-09-14T02:30:00Z"))).toBe(true); // Sun 23:30 local
  });
});

describe("nextReportRunAt", () => {
  const monday8 = { dayOfWeek: 1, hour: 8, minute: 0 };

  it("keeps local wall time across spring-forward (UTC hour shifts)", () => {
    const next = nextReportRunAt(new Date("2026-03-23T07:30:00Z"), "Europe/Paris", monday8); // Mon 08:30 +01
    expect(next.toISOString()).toBe("2026-03-30T06:00:00.000Z"); // Mon 08:00 +02
  });

  it("returns today when the run time is still ahead, next week when exactly at the run time", () => {
    expect(nextReportRunAt(new Date("2026-03-30T05:59:00Z"), "Europe/Paris", monday8).toISOString()).toBe("2026-03-30T06:00:00.000Z");
    expect(nextReportRunAt(new Date("2026-03-30T06:00:00Z"), "Europe/Paris", monday8).toISOString()).toBe("2026-04-06T06:00:00.000Z");
  });

  it("shifts a nonexistent local time forward by the DST gap", () => {
    const next = nextReportRunAt(new Date("2026-03-28T12:00:00Z"), "Europe/Paris", { dayOfWeek: 7, hour: 2, minute: 30 });
    expect(next.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 03:30 +02:00
  });

  it("uses the first occurrence of an ambiguous local time", () => {
    const next = nextReportRunAt(new Date("2026-10-24T12:00:00Z"), "Europe/Paris", { dayOfWeek: 7, hour: 2, minute: 30 });
    expect(next.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // 02:30 +02:00
  });

  it("uses the brand timezone day, not the UTC day (São Paulo Sunday 23:30)", () => {
    const next = nextReportRunAt(new Date("2026-09-14T02:30:00Z"), "America/Sao_Paulo", monday8);
    expect(next.toISOString()).toBe("2026-09-14T11:00:00.000Z");
  });

  it("validates the schedule", () => {
    expect(() => nextReportRunAt(new Date(), "UTC", { dayOfWeek: 0, hour: 8, minute: 0 })).toThrow(RangeError);
    expect(() => nextReportRunAt(new Date(), "UTC", { dayOfWeek: 1, hour: 24, minute: 0 })).toThrow(RangeError);
    expect(() => nextReportRunAt(new Date(), "Nowhere/City", monday8)).toThrow(RangeError);
  });
});
