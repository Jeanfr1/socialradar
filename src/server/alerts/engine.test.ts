import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { alerts, brands, connections, postingSchedules, posts, socialAccounts, syncRuns } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import { evaluateAlerts } from "./engine";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

// Tuesday 2026-09-15 12:00 in São Paulo (15:00 UTC).
const NOW = new Date("2026-09-15T15:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000);
let brandId: string;
let accountId: string;
let connectionId: string;

async function setup() {
  await db.delete(alerts);
  await db.delete(brands);
  await db.delete(connections);
  const [brand] = await db.insert(brands).values({ name: "Brand A", slug: `brand-a-${Math.random()}` }).returning();
  brandId = brand!.id;
  const [conn] = await db
    .insert(connections)
    .values({ provider: "buffer", label: "Buffer", status: "active", lastSyncSuccessAt: hours(-1) })
    .returning();
  connectionId = conn!.id;
  const [acc] = await db
    .insert(socialAccounts)
    .values({
      connectionId,
      provider: "buffer",
      externalChannelId: `ch-${Math.random()}`,
      platform: "instagram",
      platformAccountId: "178",
      handle: "brand_a",
      brandId,
      mappingStatus: "mapped",
      providerTimezone: "America/Sao_Paulo",
    })
    .returning();
  accountId = acc!.id;
  await db.insert(postingSchedules).values({
    socialAccountId: accountId,
    mode: "custom",
    timezone: "America/Sao_Paulo",
    slots: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => ({ day, paused: false, times: ["20:00"] })),
    horizonDays: 14,
    warningDays: 7,
    criticalDays: 3,
  });
  await db.insert(syncRuns).values({ connectionId, kind: "queue", status: "succeeded", startedAt: hours(-1), finishedAt: hours(-1) });
}

async function schedule(days: number[]) {
  // One post at 20:00 São Paulo (23:00 UTC) on each given day offset from today.
  await db.insert(posts).values(
    days.map((d) => ({
      socialAccountId: accountId,
      provider: "buffer" as const,
      externalPostId: `p-${d}-${Math.random()}`,
      status: "scheduled" as const,
      dueAt: new Date(Date.UTC(2026, 8, 15 + d, 23, 0, 0)),
    })),
  );
}

const openAlerts = () => db.select().from(alerts).where(eq(alerts.state, "open"));

beforeEach(setup);

describe("alerts engine", () => {
  const gapKey = () => `next_day_gap:${accountId}`;

  it("raises one critical alert when there is a post today and nothing tomorrow, deduplicated on re-evaluation", async () => {
    await schedule([0]); // today 20:00, nothing tomorrow
    await evaluateAlerts(db, NOW);
    await evaluateAlerts(db, new Date(NOW.getTime() + 15 * 60_000));
    const rows = (await openAlerts()).filter((a) => a.dedupeKey === gapKey());
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({ type: "next_day_gap", severity: "critical", brandId });
    expect(rows[0]!.title).toMatch(/^Amanhã \(.+\) não há post agendado em @brand_a \(Instagram\)$/);
    expect(rows[0]!.suggestedAction).toMatch(/^Agende pelo menos um post/);
  });

  it("does not alert when tomorrow already has a post, and never raises the old coverage alerts", async () => {
    await schedule([0, 1]);
    await evaluateAlerts(db, NOW);
    const types = (await openAlerts()).filter((a) => a.socialAccountId === accountId).map((a) => a.type);
    expect(types).toEqual([]);
    await db.delete(posts);
    await schedule([12]); // a distant post only
    await evaluateAlerts(db, NOW);
    const types2 = (await openAlerts()).filter((a) => a.socialAccountId === accountId).map((a) => a.type);
    expect(types2).not.toContain("queue_coverage");
    expect(types2).not.toContain("queue_empty");
  });

  it("auto-resolves when a post is scheduled for tomorrow", async () => {
    await schedule([0]);
    await evaluateAlerts(db, NOW);
    await schedule([1]);
    const summary = await evaluateAlerts(db, NOW);
    expect(summary.resolved).toBeGreaterThanOrEqual(1);
    const [resolved] = await db.select().from(alerts).where(eq(alerts.dedupeKey, gapKey()));
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolutionReason).toBe("condition_cleared");
  });

  it("does not flag an account with no post today", async () => {
    await schedule([3]);
    await evaluateAlerts(db, NOW);
    expect((await openAlerts()).filter((a) => a.dedupeKey === gapKey())).toHaveLength(0);
  });

  it("stays silent when the queue data is too old to confirm tomorrow is empty", async () => {
    await db.delete(syncRuns);
    await db.insert(syncRuns).values({ connectionId, kind: "queue", status: "succeeded", startedAt: hours(-30), finishedAt: hours(-30) });
    await schedule([0]);
    await evaluateAlerts(db, NOW);
    expect((await openAlerts()).filter((a) => a.socialAccountId === accountId)).toHaveLength(0);
  });

  it("raises a per-post publish failure alert and a connection alert for rejected keys", async () => {
    await schedule([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    await db.insert(posts).values({
      socialAccountId: accountId,
      provider: "buffer",
      externalPostId: "failed-1",
      status: "error",
      dueAt: hours(-24),
      errorMessage: "Buffer has lost authorization to post on your behalf.",
    });
    await db.update(connections).set({ status: "invalid", lastErrorCode: "unauthorized" }).where(eq(connections.id, connectionId));
    await evaluateAlerts(db, NOW);
    const rows = await openAlerts();
    expect(rows.filter((a) => a.type === "publish_failed")).toHaveLength(1);
    const conn = rows.find((a) => a.type === "connection_failing");
    expect(conn?.brandId).toBeNull();
    expect(conn?.severity).toBe("critical");
  });

  it("resolves alerts of accounts that are unmapped", async () => {
    await schedule([0]);
    await evaluateAlerts(db, NOW);
    await db.update(socialAccounts).set({ brandId: null, mappingStatus: "unmapped" }).where(eq(socialAccounts.id, accountId));
    await evaluateAlerts(db, NOW);
    expect((await openAlerts()).filter((a) => a.socialAccountId === accountId)).toHaveLength(0);
  });
});
