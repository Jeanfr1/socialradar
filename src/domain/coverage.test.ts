import { describe, expect, it } from "vitest";
import { computeCoverage, parseSlotTime } from "./coverage";
import type { CadenceConfig, CoverageInput, QueueItem, Weekday } from "./types";

const DAY = 86_400_000;
const ALL_DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function cadence(overrides: Partial<CadenceConfig> = {}): CadenceConfig {
  return {
    mode: "custom",
    timezone: "America/Sao_Paulo",
    days: ALL_DAYS.map((day) => ({ day, paused: false, times: ["20:00"] })),
    postsPerWeek: null,
    matchMode: "same_day",
    matchToleranceMinutes: 90,
    horizonDays: 14,
    warningDays: 7,
    criticalDays: 3,
    staleAfterMinutes: 360,
    ...overrides,
  };
}

// Mon 14 Sep 2026 09:00 in São Paulo (UTC−3, no DST).
const NOW = new Date("2026-09-14T12:00:00Z");
/** The 20:00 São Paulo slot `d` days after today (23:00 UTC). */
const slot = (d: number) => new Date(Date.UTC(2026, 8, 14 + d, 23, 0));
const scheduled = (id: string, dueAt: Date | null): QueueItem => ({ id, dueAt, status: "scheduled" });

function input(overrides: Partial<CoverageInput> = {}): CoverageInput {
  return { now: NOW, cadence: cadence(), items: [], lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false, ...overrides };
}

describe("computeCoverage — severity from continuous coverage", () => {
  it("fully covered horizon is healthy", () => {
    const items = Array.from({ length: 14 }, (_, d) => scheduled(`p${d}`, slot(d)));
    const r = computeCoverage(input({ items }));
    expect(r.state).toBe("healthy");
    expect(r.expectedSlots).toBe(14);
    expect(r.coveredSlots).toBe(14);
    expect(r.coverageRatio).toBe(1);
    expect(r.coveredDays).toBe(14);
    expect(r.firstUncoveredSlot).toBeNull();
    expect(r.fillDeadline).toBeNull();
    expect(r.postsNeeded).toBe(0);
    expect(r.estimatedRunwayDays).toBe(14);
    expect(r.nextScheduledAt).toEqual(slot(0));
    expect(r.lastScheduledAt).toEqual(slot(13));
    expect(r.horizonEnd.toISOString()).toBe("2026-09-28T12:00:00.000Z");
  });

  it("empty queue → empty, every slot needed, first gap is the next slot", () => {
    const r = computeCoverage(input());
    expect(r.state).toBe("empty");
    expect(r.scheduledCount).toBe(0);
    expect(r.coverageRatio).toBe(0);
    expect(r.postsNeeded).toBe(14);
    expect(r.firstUncoveredSlot).toEqual(slot(0));
    expect(r.fillDeadline).toEqual(slot(0));
    expect(r.coveredDays).toBeCloseTo(11 / 24, 10);
    expect(r.lastScheduledAt).toBeNull();
    expect(r.estimatedRunwayDays).toBe(0);
  });

  it("a single distant post does NOT make the account healthy (empty next 10 days + one post in 12 days)", () => {
    const r = computeCoverage(input({ items: [scheduled("far", slot(12))] }));
    expect(r.state).toBe("critical");
    expect(r.firstUncoveredSlot).toEqual(slot(0));
    expect(r.fillDeadline).toEqual(slot(0));
    expect(r.coveredDays).toBeLessThan(1);
    expect(r.coveredSlots).toBe(1);
    expect(r.postsNeeded).toBe(13);
    expect(r.lastScheduledAt).toEqual(slot(12));
    expect(r.slots[12]).toEqual({ at: slot(12), covered: true, postId: "far" });
    expect(r.reasons).toContain("distant_post_ignored_for_severity");
  });

  it("post beyond the horizon counts as inventory but never as coverage or unmatched content", () => {
    const r = computeCoverage(input({ items: [scheduled("way-out", slot(40))] }));
    expect(r.scheduledCount).toBe(1);
    expect(r.state).toBe("critical");
    expect(r.coveredSlots).toBe(0);
    expect(r.unmatchedItems).toBe(0);
    expect(r.beyondHorizonCount).toBe(1);
    expect(r.reasons).toEqual(expect.arrayContaining(["inventory_beyond_horizon", "distant_post_ignored_for_severity"]));
  });

  it("warning vs critical thresholds", () => {
    const covered = (n: number) => Array.from({ length: n }, (_, d) => scheduled(`p${d}`, slot(d)));
    const warn = computeCoverage(input({ items: covered(5) }));
    expect(warn.firstUncoveredSlot).toEqual(slot(5));
    expect(warn.coveredDays).toBeCloseTo(5 + 11 / 24, 10);
    expect(warn.state).toBe("warning");

    const crit = computeCoverage(input({ items: covered(2) }));
    expect(crit.coveredDays).toBeCloseTo(2 + 11 / 24, 10);
    expect(crit.state).toBe("critical");
  });

  it("threshold is strict: exactly criticalDays of coverage is warning; a slot at exactly now is not expected", () => {
    const now = slot(0); // exactly at today's 20:00 slot
    const r = computeCoverage(input({ now, lastQueueSyncAt: now, items: [scheduled("a", slot(1)), scheduled("b", slot(2))] }));
    expect(r.slots[0]!.at).toEqual(slot(1));
    expect(r.firstUncoveredSlot).toEqual(slot(3));
    expect(r.coveredDays).toBe(3);
    expect(r.state).toBe("warning");
  });
});

describe("computeCoverage — inventory classification", () => {
  it("unresolved (dueAt null, draft, needs_approval) never counts as coverage; sending counts nowhere; overdue is separate", () => {
    const items: QueueItem[] = [
      scheduled("no-time", null),
      { id: "draft", dueAt: slot(0), status: "draft" },
      { id: "approval", dueAt: slot(1), status: "needs_approval" },
      { id: "sending", dueAt: slot(0), status: "sending" },
      scheduled("overdue", new Date(NOW.getTime() - 3_600_000)),
    ];
    const r = computeCoverage(input({ items }));
    expect(r.scheduledCount).toBe(0);
    expect(r.unresolvedCount).toBe(3);
    expect(r.sendingCount).toBe(1);
    expect(r.overdueCount).toBe(1);
    expect(r.coveredSlots).toBe(0);
    expect(r.unmatchedItems).toBe(0);
    expect(r.state).toBe("empty");
    expect(r.reasons).toEqual(expect.arrayContaining(["unresolved_items_not_counted", "overdue_items_not_counted"]));
  });

  it("is deterministic regardless of item order", () => {
    const items = [scheduled("b", slot(3)), scheduled("a", slot(0)), scheduled("c", slot(3)), scheduled("d", slot(1))];
    const r1 = computeCoverage(input({ items }));
    const r2 = computeCoverage(input({ items: [...items].reverse() }));
    expect(r1).toEqual(r2);
    // Tie on dueAt → id order: "b" takes the slot, "c" is extra.
    expect(r1.slots[3]!.postId).toBe("b");
    expect(r1.unmatchedItems).toBe(1);
  });
});

describe("computeCoverage — matching", () => {
  it("same_day uses the cadence-timezone calendar day: 23:30 local (UTC next day) covers that local day's slot", () => {
    const late = new Date("2026-09-15T02:30:00Z"); // Mon 14 Sep 23:30 in São Paulo
    const r = computeCoverage(input({ items: [scheduled("late", late)] }));
    expect(r.slots[0]).toEqual({ at: slot(0), covered: true, postId: "late" });
    expect(r.slots[1]!.covered).toBe(false);
    expect(r.firstUncoveredSlot).toEqual(slot(1));
  });

  it("same_day: automation posting at 20:00 covers the earliest unmatched slot of Buffer's 18:28/20:30 schedule", () => {
    const cad = cadence({ days: ALL_DAYS.map((day) => ({ day, paused: false, times: ["20:30", "18:28"] })), horizonDays: 1 });
    const post = scheduled("auto", new Date("2026-09-14T23:00:00Z")); // 20:00 local
    const r = computeCoverage(input({ cadence: cad, items: [post] }));
    expect(r.expectedSlots).toBe(2);
    expect(r.slots.map((s) => s.at.toISOString())).toEqual(["2026-09-14T21:28:00.000Z", "2026-09-14T23:30:00.000Z"]);
    expect(r.slots[0]!.postId).toBe("auto");
    expect(r.firstUncoveredSlot!.toISOString()).toBe("2026-09-14T23:30:00.000Z");
  });

  it("time_window picks the nearest slot within tolerance, otherwise the post is unmatched", () => {
    const days = ALL_DAYS.map((day) => ({ day, paused: false, times: ["18:28", "20:30"] }));
    const post = scheduled("auto", new Date("2026-09-14T23:00:00Z")); // 20:00 local: 92 min after 18:28, 30 min before 20:30
    const wide = computeCoverage(input({ cadence: cadence({ days, horizonDays: 1, matchMode: "time_window", matchToleranceMinutes: 120 }), items: [post] }));
    expect(wide.slots[1]!.postId).toBe("auto");
    expect(wide.slots[0]!.covered).toBe(false);

    const exact = computeCoverage(input({ cadence: cadence({ days, horizonDays: 1, matchMode: "time_window", matchToleranceMinutes: 30 }), items: [post] }));
    expect(exact.slots[1]!.postId).toBe("auto");

    const narrow = computeCoverage(input({ cadence: cadence({ days, horizonDays: 1, matchMode: "time_window", matchToleranceMinutes: 20 }), items: [post] }));
    expect(narrow.coveredSlots).toBe(0);
    expect(narrow.unmatchedItems).toBe(1);
  });

  it("each slot takes at most one post and each post covers at most one slot", () => {
    const cad = cadence({ matchMode: "time_window", matchToleranceMinutes: 60, horizonDays: 2 });
    const items = [scheduled("x", new Date(slot(0).getTime() - 10 * 60_000)), scheduled("y", new Date(slot(0).getTime() + 5 * 60_000))];
    const r = computeCoverage(input({ cadence: cad, items }));
    expect(r.coveredSlots).toBe(1);
    expect(r.slots[0]!.postId).toBe("x"); // processed first (earlier dueAt)
    expect(r.unmatchedItems).toBe(1);
  });
});

describe("computeCoverage — cadence shapes", () => {
  it("paused days generate no slots and posts on them are unmatched", () => {
    const days = ALL_DAYS.map((day) => ({ day, paused: day === "sat" || day === "sun", times: ["20:00"] }));
    const r = computeCoverage(input({ cadence: cadence({ days }), items: [scheduled("sat", slot(5))] }));
    expect(r.expectedSlots).toBe(10);
    expect(r.unmatchedItems).toBe(1);
    expect(r.estimatedRunwayDays).toBeCloseTo(1 / (5 / 7), 10);
  });

  it("no expected slots → unknown with no_cadence and null ratio", () => {
    const allPaused = ALL_DAYS.map((day) => ({ day, paused: true, times: ["20:00"] }));
    for (const cad of [cadence({ days: allPaused }), cadence({ days: [] })]) {
      const r = computeCoverage(input({ cadence: cad, items: [scheduled("p", slot(1))] }));
      expect(r.state).toBe("unknown");
      expect(r.expectedSlots).toBe(0);
      expect(r.coverageRatio).toBeNull();
      expect(r.coveredDays).toBeNull();
      expect(r.estimatedRunwayDays).toBeNull();
      expect(r.reasons).toContain("no_cadence");
      expect(r.scheduledCount).toBe(1);
    }
  });

  it("invalid slot times are skipped with a reason; parser accepts H:MM", () => {
    expect(parseSlotTime("8:05")).toEqual({ hour: 8, minute: 5 });
    expect(parseSlotTime("24:00")).toBeNull();
    const days = ALL_DAYS.map((day) => ({ day, paused: false, times: ["20:00", "25:99", "noon"] }));
    const r = computeCoverage(input({ cadence: cadence({ days }) }));
    expect(r.expectedSlots).toBe(14);
    expect(r.reasons).toContain("invalid_slot_time");
  });

  it("a horizon shorter than the warning threshold is flagged (full coverage cannot be healthy)", () => {
    const items = Array.from({ length: 5 }, (_, d) => scheduled(`p${d}`, slot(d)));
    const r = computeCoverage(input({ cadence: cadence({ horizonDays: 5 }), items }));
    expect(r.postsNeeded).toBe(0);
    expect(r.coveredDays).toBe(5);
    expect(r.state).toBe("warning");
    expect(r.reasons).toContain("horizon_shorter_than_warning");
  });

  it("invalid timezone yields unknown instead of throwing", () => {
    const r = computeCoverage(input({ cadence: cadence({ timezone: "Not/AZone" }) }));
    expect(r.state).toBe("unknown");
    expect(r.reasons).toContain("invalid_timezone");
  });
});

describe("computeCoverage — DST (Europe/Paris)", () => {
  const paris = (times: string[], horizonDays: number) =>
    cadence({ timezone: "Europe/Paris", horizonDays, days: ALL_DAYS.map((day) => ({ day, paused: false, times })) });

  it("nonexistent 02:30 on spring-forward day is shifted to 03:30 local", () => {
    const now = new Date("2026-03-28T12:00:00Z");
    const r = computeCoverage(input({ now, lastQueueSyncAt: now, cadence: paris(["02:30"], 3) }));
    expect(r.slots.map((s) => s.at.toISOString())).toEqual([
      "2026-03-29T01:30:00.000Z", // 03:30 +02:00 (shifted)
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
    expect(r.reasons).toContain("dst_nonexistent_time_shifted");
  });

  it("a shifted slot colliding with an existing slot is merged", () => {
    const now = new Date("2026-03-28T12:00:00Z");
    const r = computeCoverage(input({ now, lastQueueSyncAt: now, cadence: paris(["02:30", "03:30"], 1) }));
    expect(r.slots.map((s) => s.at.toISOString())).toEqual(["2026-03-29T01:30:00.000Z"]);
    expect(r.reasons).toContain("dst_slots_merged");
  });

  it("ambiguous 02:30 on fall-back day uses the first occurrence; same_day still matches the second occurrence", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const secondOccurrence = scheduled("late", new Date("2026-10-25T01:30:00Z")); // 02:30 +01:00
    const sameDay = computeCoverage(input({ now, lastQueueSyncAt: now, cadence: paris(["02:30"], 1), items: [secondOccurrence] }));
    expect(sameDay.slots.map((s) => s.at.toISOString())).toEqual(["2026-10-25T00:30:00.000Z"]);
    expect(sameDay.slots[0]!.postId).toBe("late");

    const windowed = computeCoverage(
      input({ now, lastQueueSyncAt: now, cadence: { ...paris(["02:30"], 1), matchMode: "time_window", matchToleranceMinutes: 30 }, items: [secondOccurrence] }),
    );
    expect(windowed.coveredSlots).toBe(0);
    expect(windowed.unmatchedItems).toBe(1);
  });

  it("horizon is in local calendar days: a 7-day horizon across fall-back has exactly 7 daily slots", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const r = computeCoverage(input({ now, lastQueueSyncAt: now, cadence: paris(["20:00"], 7) }));
    expect(r.expectedSlots).toBe(7);
    expect(r.horizonEnd.toISOString()).toBe("2026-10-27T13:00:00.000Z"); // 14:00 local, +01:00 after the change
    expect(r.slots.at(-1)!.at.toISOString()).toBe("2026-10-26T19:00:00.000Z"); // 20:00 +01:00
  });
});

describe("computeCoverage — irregular cadence (virtual slots)", () => {
  const irregular = (postsPerWeek: number | null, days: CadenceConfig["days"] = []) =>
    cadence({ mode: "irregular", postsPerWeek, days, horizonDays: 7 });
  const at = (days: number) => new Date(NOW.getTime() + days * DAY);

  it("spreads postsPerWeek evenly from now and flags the result as an estimate", () => {
    const r = computeCoverage(input({ cadence: irregular(3) }));
    expect(r.isEstimate).toBe(true);
    expect(r.reasons).toContain("irregular_virtual_slots");
    expect(r.slots.map((s) => s.at.getTime() - NOW.getTime())).toEqual([(7 * DAY) / 3, (14 * DAY) / 3, 7 * DAY]);
    expect(r.expectedPostsPerDay).toBeCloseTo(3 / 7, 12);
    expect(r.state).toBe("empty");
  });

  it("a batch of posts on one day covers only one window", () => {
    const r = computeCoverage(input({ cadence: irregular(3), items: [scheduled("a", at(1)), scheduled("b", at(1.05)), scheduled("c", at(1.1))] }));
    expect(r.coveredSlots).toBe(1);
    expect(r.unmatchedItems).toBe(2);
    expect(r.coveredDays).toBeCloseTo(14 / 3, 6);
    expect(r.state).toBe("warning");
  });

  it("a distant post does not cover near-term windows", () => {
    const r = computeCoverage(input({ cadence: irregular(3), items: [scheduled("late", at(6))] }));
    expect(r.slots[0]!.covered).toBe(false);
    expect(r.slots[2]!.postId).toBe("late");
    expect(r.state).toBe("critical");
  });

  it("one post per window covers the horizon", () => {
    const r = computeCoverage(input({ cadence: irregular(3), items: [scheduled("a", at(1)), scheduled("b", at(3.5)), scheduled("c", at(6))] }));
    expect(r.coverageRatio).toBe(1);
    expect(r.coveredDays).toBe(7);
    expect(r.state).toBe("healthy");
  });

  it("paused weekdays do not accrue expected posts", () => {
    const weekendOff = [
      { day: "sat" as const, paused: true, times: [] },
      { day: "sun" as const, paused: true, times: [] },
    ];
    const r = computeCoverage(input({ cadence: irregular(5, weekendOff) }));
    expect(r.slots.map((s) => s.at.toISOString())).toEqual([
      "2026-09-15T12:00:00.000Z",
      "2026-09-16T12:00:00.000Z",
      "2026-09-17T12:00:00.000Z",
      "2026-09-18T12:00:00.000Z",
      "2026-09-21T12:00:00.000Z", // Friday 21:00 → Monday 09:00 skips the weekend
    ]);
  });

  it("missing postsPerWeek → no_cadence", () => {
    const r = computeCoverage(input({ cadence: irregular(null) }));
    expect(r.state).toBe("unknown");
    expect(r.reasons).toContain("no_cadence");
  });
});

describe("computeCoverage — freshness, pause, disconnection", () => {
  it("stale sync → unknown with numbers kept (never confirmed depletion)", () => {
    const r = computeCoverage(input({ lastQueueSyncAt: new Date(NOW.getTime() - 7 * 3_600_000) }));
    expect(r.freshness).toBe("stale");
    expect(r.state).toBe("unknown");
    expect(r.underlyingState).toBe("empty");
    expect(r.postsNeeded).toBe(14);
    expect(r.reasons).toContain("stale_sync");
  });

  it("sync exactly staleAfterMinutes old is still fresh", () => {
    const r = computeCoverage(input({ lastQueueSyncAt: new Date(NOW.getTime() - 360 * 60_000) }));
    expect(r.freshness).toBe("fresh");
    expect(r.state).toBe("empty");
  });

  it("never synced → unknown", () => {
    const r = computeCoverage(input({ lastQueueSyncAt: null }));
    expect(r.freshness).toBe("never_synced");
    expect(r.state).toBe("unknown");
    expect(r.reasons).toContain("never_synced");
  });

  it("queue paused or cadence paused → paused, inventory still computed", () => {
    const items = [scheduled("a", slot(0))];
    const q = computeCoverage(input({ queuePaused: true, items }));
    expect(q.state).toBe("paused");
    expect(q.scheduledCount).toBe(1);
    expect(q.coveredSlots).toBe(1);
    expect(q.underlyingState).toBe("critical");

    const c = computeCoverage(input({ cadence: cadence({ mode: "paused" }), items, lastQueueSyncAt: null }));
    expect(c.state).toBe("paused");
    expect(c.reasons).toEqual(expect.arrayContaining(["cadence_paused", "never_synced"]));
  });

  it("disconnected account → unknown even with an empty queue", () => {
    const r = computeCoverage(input({ accountDisconnected: true }));
    expect(r.state).toBe("unknown");
    expect(r.underlyingState).toBe("empty");
    expect(r.reasons).toContain("account_disconnected");
  });
});

describe("computeCoverage — provider inventory cap", () => {
  const twicePerDay = cadence({ days: ALL_DAYS.map((day) => ({ day, paused: false, times: ["18:28", "20:30"] })) });

  it("flags that the horizon and the healthy threshold are unreachable under the cap", () => {
    const base = computeCoverage(input({ cadence: twicePerDay }));
    const items = base.slots.slice(0, 10).map((s, i) => scheduled(`p${i}`, s.at));
    const r = computeCoverage(input({ cadence: twicePerDay, items }), { inventoryCap: 10 });
    expect(r.expectedSlots).toBe(28);
    expect(r.state).toBe("warning");
    expect(r.remainingCapacity).toBe(0);
    expect(r.maxAchievableCoveredDays).toBeCloseTo(r.coveredDays as number, 10);
    expect(r.reasons).toEqual(expect.arrayContaining(["provider_inventory_cap", "provider_inventory_cap_blocks_healthy"]));
    expect(r.estimatedRunwayDays).toBe(5);
  });

  it("no cap reasons without a cap or when the cap is sufficient", () => {
    expect(computeCoverage(input({ cadence: twicePerDay })).reasons).not.toContain("provider_inventory_cap");
    const roomy = computeCoverage(input({ cadence: twicePerDay }), { inventoryCap: 100 });
    expect(roomy.reasons).not.toContain("provider_inventory_cap");
    expect(roomy.maxAchievableCoveredDays).toBe(14);
    expect(roomy.remainingCapacity).toBe(100);
  });
});
