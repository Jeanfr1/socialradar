import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { posts, recommendations } from "@/server/db/schema";
import { addMember, seedAccount, seedBrand, seedConnection, seedPost, seedSync, seedUser } from "@/server/reports/testing";
import { createTestDb } from "@/test/db";
import {
  createExperimentFromRecommendation,
  generateRecommendationsForBrand,
  generateRecommendationsForConnection,
  listExperiments,
  listRecommendations,
  updateExperiment,
  updateRecommendationStatus,
} from "./service";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-09-16T15:00:00Z");
const DAY = 86_400_000;

let brandA: Awaited<ReturnType<typeof seedBrand>>;
let brandB: Awaited<ReturnType<typeof seedBrand>>;
let connA: string;
let accA: string;
let failedPostId: string;
let manager: { id: string; isWorkspaceAdmin: boolean };
let viewer: { id: string; isWorkspaceAdmin: boolean };
let outsider: { id: string; isWorkspaceAdmin: boolean };

const metricsFor = (views: number) => ({ views, reach: Math.round(views * 0.8), reactions: Math.round(views / 20), comments: 2, shares: 1, saves: 1 });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  brandA = await seedBrand(db, { name: "Marca A", contentPillars: ["educação", "bastidores"] });
  brandB = await seedBrand(db, { name: "Marca B" });
  manager = await seedUser(db, "Manager");
  viewer = await seedUser(db, "Viewer");
  outsider = await seedUser(db, "Outsider");
  await addMember(db, manager.id, brandA.id, "manager");
  await addMember(db, viewer.id, brandA.id, "viewer");
  await addMember(db, outsider.id, brandB.id, "owner");

  connA = await seedConnection(db);
  accA = await seedAccount(db, { connectionId: connA, brandId: brandA.id, handle: "marca_a" });
  await seedSync(db, connA, "queue", new Date(NOW.getTime() - 3_600_000));
  await seedSync(db, connA, "published", new Date(NOW.getTime() - 3_600_000));
  // 14 posts in the last 28 days, all observed long after publishing: reels ~2.5× carousels.
  for (let i = 0; i < 14; i++) {
    const publishedAt = new Date(NOW.getTime() - (5 + i * 1.5) * DAY);
    const reel = i % 2 === 0;
    await seedPost(db, {
      accountId: accA,
      publishedAt,
      format: reel ? "reel" : "carousel",
      metricsUpdatedAt: new Date(NOW.getTime() - 3_600_000),
      latest: metricsFor(reel ? 1000 + i * 10 : 400 + i * 5),
    });
  }
  failedPostId = await seedPost(db, { accountId: accA, publishedAt: new Date(NOW.getTime() - 2 * DAY), status: "error", errorMessage: "Buffer has lost authorization." });

  const connB = await seedConnection(db);
  const accB = await seedAccount(db, { connectionId: connB, brandId: brandB.id, handle: "marca_b" });
  await seedPost(db, { accountId: accB, publishedAt: new Date(NOW.getTime() - 2 * DAY), status: "error", errorMessage: "failed" });
});
afterAll(async () => close());

const byKey = async (brandId: string) => {
  const rows = await db.select().from(recommendations).where(eq(recommendations.brandId, brandId));
  return rows;
};

describe("recommendation generation", () => {
  it("creates evidence-based candidates in the brand locale and deduplicates reruns", async () => {
    const first = await generateRecommendationsForBrand(db, brandA.id, NOW);
    expect(first.created).toBeGreaterThanOrEqual(2);
    const rows = await byKey(brandA.id);
    const format = rows.find((r) => r.kind === "format_mix")!;
    expect(format.dedupeKey).toBe(`format_mix:${accA}:reel`);
    expect(format.finding).toContain("Nos últimos 28 dias, posts reel de marca_a");
    expect(format.interpretation.startsWith("Hipótese")).toBe(true);
    expect(format.locale).toBe("pt-BR");
    const evidence = format.evidence as { sampleSize: number; formats: { posts: { postId: string; url: string }[] }[]; window: unknown };
    expect(evidence.sampleSize).toBe(14);
    expect(evidence.formats[0]!.posts[0]!.url).toMatch(/^https:\/\//);
    expect(evidence.window).toBeTruthy();
    expect(rows.some((r) => r.kind === "publish_failures" && r.priority === "high")).toBe(true);
    expect(rows.some((r) => r.kind === "timing_experiment")).toBe(false); // < 8 posts per time bucket
    expect(rows.some((r) => r.kind === "tagging_gap")).toBe(true);

    const second = await generateRecommendationsForBrand(db, brandA.id, new Date(NOW.getTime() + 3_600_000));
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(first.created);
    const after = await byKey(brandA.id);
    expect(new Set(after.map((r) => r.dedupeKey)).size).toBe(after.length);
  });

  it("supersedes proposed recommendations that no longer apply and respects dismissal cooldown", async () => {
    await db.update(posts).set({ status: "sent", sentAt: new Date(NOW.getTime() - 2 * DAY), errorMessage: null }).where(eq(posts.id, failedPostId));
    const summary = await generateRecommendationsForBrand(db, brandA.id, NOW);
    expect(summary.superseded).toBeGreaterThanOrEqual(1);
    const [superseded] = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brandA.id), eq(recommendations.kind, "publish_failures")));
    expect(superseded!.status).toBe("superseded");

    // Failure comes back; the new active one is dismissed; it is not re-proposed during the cooldown.
    await db.update(posts).set({ status: "error", sentAt: null, errorMessage: "again" }).where(eq(posts.id, failedPostId));
    await generateRecommendationsForBrand(db, brandA.id, NOW);
    const [active] = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brandA.id), eq(recommendations.kind, "publish_failures"), eq(recommendations.status, "proposed")));
    await updateRecommendationStatus(db, manager, active!.id, "dismissed");
    const again = await generateRecommendationsForBrand(db, brandA.id, NOW);
    expect(again.skippedCooldown).toBe(1);
    const stillActive = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brandA.id), eq(recommendations.kind, "publish_failures"), eq(recommendations.status, "proposed")));
    expect(stillActive).toHaveLength(0);
  });

  it("leaves accepted recommendations untouched", async () => {
    const [format] = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brandA.id), eq(recommendations.kind, "format_mix")));
    const accepted = await updateRecommendationStatus(db, manager, format!.id, "accepted");
    await generateRecommendationsForBrand(db, brandA.id, new Date(NOW.getTime() + 2 * 3_600_000));
    const [after] = await db.select().from(recommendations).where(eq(recommendations.id, format!.id));
    expect(after!.status).toBe("accepted");
    expect(after!.updatedAt.getTime()).toBe(accepted.updatedAt.getTime());
  });

  it("generates for every brand mapped on a connection", async () => {
    const summaries = await generateRecommendationsForConnection(db, connA, NOW);
    expect(summaries.map((s) => s.brandId)).toEqual([brandA.id]);
    expect(await generateRecommendationsForConnection(db, "not-a-uuid", NOW)).toEqual([]);
  });
});

describe("recommendations & experiments access", () => {
  it("lists with filters and hides superseded by default", async () => {
    const all = await listRecommendations(db, viewer, brandA.id);
    expect(all.every((r) => r.status !== "superseded")).toBe(true);
    expect(all.find((r) => r.kind === "format_mix")!.platform).toBe("instagram");
    const high = await listRecommendations(db, viewer, brandA.id, { priorities: ["high"] });
    expect(high.every((r) => r.priority === "high")).toBe(true);
    const superseded = await listRecommendations(db, viewer, brandA.id, { statuses: ["superseded"] });
    expect(superseded.length).toBeGreaterThanOrEqual(1);
  });

  it("isolates brands and enforces roles", async () => {
    const [rec] = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brandA.id), eq(recommendations.kind, "format_mix")));
    await expect(listRecommendations(db, outsider, brandA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateRecommendationStatus(db, outsider, rec!.id, "dismissed")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createExperimentFromRecommendation(db, outsider, rec!.id, { startDate: "2026-09-17", endDate: "2026-09-30" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listExperiments(db, outsider, brandA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateRecommendationStatus(db, viewer, rec!.id, "dismissed")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateRecommendationStatus(db, manager, "00000000-0000-4000-8000-000000000000", "dismissed")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creates an experiment from a recommendation and closes the loop", async () => {
    const [rec] = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brandA.id), eq(recommendations.kind, "format_mix")));
    await expect(createExperimentFromRecommendation(db, manager, rec!.id, { startDate: "2026-09-30", endDate: "2026-09-17" })).rejects.toThrow(/end date/);
    const exp = await createExperimentFromRecommendation(db, manager, rec!.id, { startDate: "2099-01-05", endDate: "2099-01-19" });
    expect(exp).toMatchObject({ brandId: brandA.id, recommendationId: rec!.id, status: "planned", hypothesis: rec!.interpretation, successMetric: rec!.successMetric });
    const [inExperiment] = await db.select().from(recommendations).where(eq(recommendations.id, rec!.id));
    expect(inExperiment!.status).toBe("in_experiment");
    await expect(createExperimentFromRecommendation(db, manager, rec!.id, { startDate: "2099-01-05", endDate: "2099-01-19" })).rejects.toBeInstanceOf(ConflictError);

    expect((await listExperiments(db, viewer, brandA.id)).map((e) => e.id)).toContain(exp.id);
    await expect(updateExperiment(db, outsider, exp.id, { status: "running" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateExperiment(db, viewer, exp.id, { status: "running" })).rejects.toBeInstanceOf(ForbiddenError);
    const done = await updateExperiment(db, manager, exp.id, { status: "completed", resultSummary: "Mediana de reels manteve-se acima." });
    expect(done.status).toBe("completed");
    const [closed] = await db.select().from(recommendations).where(eq(recommendations.id, rec!.id));
    expect(closed!.status).toBe("done");
    await expect(updateExperiment(db, manager, exp.id, { status: "running" })).rejects.toBeInstanceOf(ConflictError);
  });
});
