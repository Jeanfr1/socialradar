import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { brands, connections, jobs, reportVersions, syncRuns } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import { scheduleSyncJobs, scheduleWeeklyReports } from "./scheduler";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(jobs);
  await db.delete(brands);
  await db.delete(connections);
});

const OPTS = { queueBaseMinutes: 120, publishedHours: 24, alertsEveryMinutes: 15 };

describe("weekly report scheduling", () => {
  it("enqueues the previous week's report at Monday 08:00 brand time, once", async () => {
    const [brand] = await db.insert(brands).values({ name: "B", slug: "b", timezone: "America/Sao_Paulo" }).returning();
    // Monday 2026-09-14 07:59 in São Paulo = 10:59 UTC.
    expect(await scheduleWeeklyReports(db, new Date("2026-09-14T10:59:00Z"))).toEqual([]);
    const due = new Date("2026-09-14T11:00:00Z");
    expect(await scheduleWeeklyReports(db, due)).toEqual([`report.weekly:${brand!.id}:2026-09-07`]);
    expect(await scheduleWeeklyReports(db, due)).toEqual([]);
    const queued = await db.select().from(jobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ brandId: brand!.id, periodStart: "2026-09-07" });
  });

  it("catches up after downtime and skips periods that already have a scheduled report", async () => {
    const [brand] = await db.insert(brands).values({ name: "B", slug: "b2", timezone: "Europe/Paris" }).returning();
    const wednesday = new Date("2026-09-16T12:00:00Z");
    expect(await scheduleWeeklyReports(db, wednesday)).toHaveLength(1);
    await db.delete(jobs);
    await db.insert(reportVersions).values({
      brandId: brand!.id,
      periodStart: "2026-09-07",
      periodEnd: "2026-09-13",
      version: 1,
      status: "final",
      trigger: "scheduled",
      locale: "pt-BR",
      timezone: "Europe/Paris",
    });
    expect(await scheduleWeeklyReports(db, wednesday)).toEqual([]);
  });

  it("respects disabled schedules", async () => {
    await db.insert(brands).values({ name: "B", slug: "b3", reportSchedule: { enabled: false, dayOfWeek: 1, hour: 8, minute: 0 } });
    expect(await scheduleWeeklyReports(db, new Date("2026-09-16T12:00:00Z"))).toEqual([]);
  });
});

describe("sync scheduling", () => {
  it("schedules first syncs, then waits for the interval", async () => {
    const [conn] = await db.insert(connections).values({ provider: "buffer", label: "c", status: "active" }).returning();
    const now = new Date("2026-09-13T12:00:00Z");
    expect(await scheduleSyncJobs(db, now, OPTS)).toEqual([`sync.queue:${conn!.id}`, `sync.published:${conn!.id}`]);
    await db.delete(jobs);
    await db.insert(syncRuns).values([
      { connectionId: conn!.id, kind: "queue", status: "succeeded", startedAt: new Date(now.getTime() - 30 * 60_000) },
      { connectionId: conn!.id, kind: "published", status: "succeeded", startedAt: new Date(now.getTime() - 3600_000) },
    ]);
    expect(await scheduleSyncJobs(db, now, OPTS)).toEqual([]);
    expect(await scheduleSyncJobs(db, new Date(now.getTime() + 91 * 60_000), OPTS)).toEqual([`sync.queue:${conn!.id}`]);
  });

  it("never schedules invalid, removed or demo-provider connections", async () => {
    await db.insert(connections).values([
      { provider: "buffer", label: "invalid", status: "invalid" },
      { provider: "buffer", label: "removed", status: "active", deletedAt: new Date() },
      { provider: "demo", label: "demo", status: "active", isDemo: true },
    ]);
    expect(await scheduleSyncJobs(db, new Date(), OPTS)).toEqual([]);
  });

  it("widens the queue interval when the daily quota is tight", async () => {
    const now = new Date("2026-09-13T12:00:00Z");
    const [conn] = await db
      .insert(connections)
      .values({
        provider: "buffer",
        label: "tight",
        status: "active",
        // 130 left, 125 reserved → 5 spendable over 10h at 2 requests/run → one run every ~4h.
        rateLimitState: { "250-in-1day": { limit: 250, remaining: 130, resetAt: new Date(now.getTime() + 10 * 3600_000).toISOString(), windowSeconds: 86400 } },
      })
      .returning();
    await db.insert(syncRuns).values([
      { connectionId: conn!.id, kind: "queue", status: "succeeded", startedAt: new Date(now.getTime() - 150 * 60_000) },
      { connectionId: conn!.id, kind: "published", status: "succeeded", startedAt: new Date(now.getTime() - 3600_000) },
    ]);
    expect(await scheduleSyncJobs(db, now, OPTS)).toEqual([]);
  });
});
