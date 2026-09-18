import { describe, expect, it } from "vitest";
import { evaluateNextDayGap } from "./next-day-gap";

const TZ = "America/Sao_Paulo";
// Thursday 2026-09-17 10:00 in São Paulo (13:00 UTC).
const NOW = new Date("2026-09-17T13:00:00Z");
const sp = (day: number, hour: number) => new Date(Date.UTC(2026, 8, day, hour + 3, 0, 0));

describe("next-day gap", () => {
  it("is critical when there is a post today and nothing scheduled tomorrow", () => {
    const r = evaluateNextDayGap({ now: NOW, timezone: TZ, posts: [{ status: "scheduled", at: sp(17, 20) }] });
    expect(r).toMatchObject({ today: "2026-09-17", tomorrow: "2026-09-18", postsToday: 1, scheduledTomorrow: 0, isGap: true });
    expect(r.tomorrowStartsAt.toISOString()).toBe("2026-09-18T03:00:00.000Z");
  });

  it("counts a post already published today", () => {
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts: [{ status: "sent", at: sp(17, 8) }] }).isGap).toBe(true);
  });

  it("is not a gap when tomorrow has a scheduled post", () => {
    const posts = [
      { status: "scheduled", at: sp(17, 20) },
      { status: "scheduled", at: sp(18, 20) },
    ];
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts }).isGap).toBe(false);
  });

  it("does not flag accounts with nothing today (inactive or publishing outside Buffer)", () => {
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts: [] }).isGap).toBe(false);
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts: [{ status: "scheduled", at: sp(20, 20) }] }).isGap).toBe(false);
  });

  it("ignores drafts, approvals, failures and posts without a time", () => {
    const posts = [
      { status: "scheduled", at: sp(17, 20) },
      { status: "needs_approval", at: sp(18, 20) },
      { status: "draft", at: sp(18, 21) },
      { status: "error", at: sp(18, 22) },
      { status: "scheduled", at: null },
    ];
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts }).isGap).toBe(true);
  });

  it("ignores posts published natively outside Buffer (not scheduled)", () => {
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts: [{ status: "sent", at: sp(17, 8), via: "network" }] }).isGap).toBe(false);
    expect(evaluateNextDayGap({ now: NOW, timezone: TZ, posts: [{ status: "sent", at: sp(17, 8), via: "buffer" }] }).isGap).toBe(true);
  });

  it("uses local calendar days (23:30 local is still today)", () => {
    const late = new Date("2026-09-18T02:30:00Z"); // 23:30 on the 17th in São Paulo
    const r = evaluateNextDayGap({ now: late, timezone: TZ, posts: [{ status: "sent", at: new Date("2026-09-18T02:00:00Z") }] });
    expect(r.today).toBe("2026-09-17");
    expect(r.isGap).toBe(true);
  });
});
