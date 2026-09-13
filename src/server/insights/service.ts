/**
 * Recommendations & experiments service.
 *
 * Generation (worker, no actor): rule candidates (rules.ts) are reconciled with stored recommendations per brand:
 * - same dedupe key + status `proposed` → finding/evidence/text refreshed in place;
 * - same key + `accepted` / `in_experiment` → left untouched (the team is acting on it);
 * - new key → inserted (race-safe via the partial unique index on active statuses), unless a recommendation with
 *   that key was dismissed or marked done within the cooldown;
 * - `proposed` recommendations whose key is no longer produced → `superseded`.
 * Reads/writes by users always resolve the owning brand first and require membership (NotFoundError otherwise).
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, max, ne, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";
import type { Platform } from "@/domain/types";
import { ConflictError, isUniqueViolation, isUuid, NotFoundError, parseInput, requireBrandRole, ValidationError, type Actor, type BrandRow } from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { brands, experiments, recommendations, socialAccounts, syncRuns } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { loadAccountStatuses } from "@/server/queries/account-status";
import { loadPostPerformance } from "@/server/queries/post-performance";
import { resolveReportLocale } from "@/server/reports/i18n";
import { buildRecommendationCandidates, RECOMMENDATION_RULES, type InsightInput } from "./rules";

export type RecommendationRow = typeof recommendations.$inferSelect;
export type ExperimentRow = typeof experiments.$inferSelect;
export type RecommendationStatus = RecommendationRow["status"];
export type RecommendationView = RecommendationRow & { platform: Platform | null; handle: string | null };

export interface RecommendationFilter {
  statuses?: RecommendationStatus[];
  priorities?: ("high" | "medium" | "low")[];
  platform?: Platform;
  socialAccountId?: string;
  /** Superseded recommendations are hidden unless requested (or explicitly listed in `statuses`). */
  includeSuperseded?: boolean;
}

export interface GenerationSummary {
  brandId: string;
  candidates: number;
  created: number;
  refreshed: number;
  superseded: number;
  skippedCooldown: number;
}

const ACTIVE_STATUSES = ["proposed", "accepted", "in_experiment"] as const;
const log = logger.child({ component: "insights" });
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
export async function generateRecommendationsForConnection(db: Db, connectionId: string, now: Date): Promise<GenerationSummary[]> {
  if (!isUuid(connectionId)) return [];
  const rows = await db
    .selectDistinct({ brandId: socialAccounts.brandId })
    .from(socialAccounts)
    .innerJoin(brands, eq(brands.id, socialAccounts.brandId))
    .where(
      and(
        eq(socialAccounts.connectionId, connectionId),
        eq(socialAccounts.mappingStatus, "mapped"),
        isNull(socialAccounts.removedAt),
        isNotNull(socialAccounts.brandId),
        isNull(brands.archivedAt),
      ),
    );
  const summaries: GenerationSummary[] = [];
  const errors: unknown[] = [];
  for (const { brandId } of rows) {
    if (!brandId) continue;
    try {
      summaries.push(await generateRecommendationsForBrand(db, brandId, now));
    } catch (err) {
      errors.push(err);
      log.error("recommendation generation failed", { brandId, connectionId, error: err });
    }
  }
  if (errors.length > 0 && summaries.length === 0) throw errors[0];
  return summaries;
}

export async function loadInsightInput(db: Db, brand: BrandRow, now: Date): Promise<InsightInput> {
  const statuses = (await loadAccountStatuses(db, { brandIds: [brand.id] }, now)).filter((s) => s.account.brandId === brand.id);
  const accountIds = statuses.map((s) => s.account.id);
  const connectionIds = [...new Set(statuses.map((s) => s.account.connectionId))];
  const [posts, syncs] = await Promise.all([
    loadPostPerformance(db, { accountIds, publishedFrom: new Date(now.getTime() - RECOMMENDATION_RULES.timingWindowDays * DAY_MS), publishedTo: now }),
    connectionIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ connectionId: syncRuns.connectionId, at: max(syncRuns.finishedAt) })
          .from(syncRuns)
          .where(and(inArray(syncRuns.connectionId, connectionIds), eq(syncRuns.kind, "published"), eq(syncRuns.status, "succeeded"), lte(syncRuns.finishedAt, now)))
          .groupBy(syncRuns.connectionId),
  ]);
  const lastPublished = new Map(syncs.map((s) => [s.connectionId, s.at]));
  return {
    brand: { id: brand.id, timezone: brand.timezone, locale: resolveReportLocale(brand.reportLocale), contentPillars: brand.contentPillars ?? [] },
    now,
    accounts: statuses.map((s) => ({
      id: s.account.id,
      handle: s.account.handle,
      platform: s.account.platform,
      isDisconnected: s.account.isDisconnected,
      connectionStatus: s.connection.status,
      cadence: s.cadence,
      coverage: s.coverage,
      lastPublishedSyncAt: lastPublished.get(s.account.connectionId) ?? null,
      recentErrors: s.recentErrors,
      inventoryCap: s.inventoryCap,
    })),
    posts: posts.map((p) => ({
      postId: p.postId,
      socialAccountId: p.socialAccountId,
      platform: p.platform,
      format: p.format,
      publishedAt: p.publishedAt,
      metricsUpdatedAt: p.metricsUpdatedAt,
      metrics: p.metrics,
      tags: p.tags,
      externalUrl: p.externalUrl,
      text: p.text,
      title: p.title,
    })),
  };
}

export async function generateRecommendationsForBrand(db: Db, brandId: string, now: Date): Promise<GenerationSummary> {
  if (!isUuid(brandId)) throw new NotFoundError();
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
  if (!brand) throw new NotFoundError();
  const input = await loadInsightInput(db, brand, now);
  const locale = input.brand.locale;

  const seen = new Set<string>();
  const candidates = buildRecommendationCandidates(input).filter((c) => (seen.has(c.dedupeKey) ? false : (seen.add(c.dedupeKey), true)));
  const active = await db.select().from(recommendations).where(and(eq(recommendations.brandId, brand.id), inArray(recommendations.status, [...ACTIVE_STATUSES])));
  const activeByKey = new Map(active.map((r) => [r.dedupeKey, r]));
  const cooldownSince = new Date(now.getTime() - RECOMMENDATION_RULES.cooldownDays * DAY_MS);
  const recentlyClosed = new Set(
    (
      await db
        .select({ dedupeKey: recommendations.dedupeKey })
        .from(recommendations)
        .where(and(eq(recommendations.brandId, brand.id), inArray(recommendations.status, ["dismissed", "done"]), gte(recommendations.updatedAt, cooldownSince)))
    ).map((r) => r.dedupeKey),
  );

  const summary: GenerationSummary = { brandId: brand.id, candidates: candidates.length, created: 0, refreshed: 0, superseded: 0, skippedCooldown: 0 };
  for (const c of candidates) {
    const fields = {
      socialAccountId: c.socialAccountId,
      kind: c.kind,
      locale,
      finding: c.finding,
      evidence: { ...c.evidence, generatedAt: now.toISOString() },
      interpretation: c.interpretation,
      action: c.action,
      priority: c.priority,
      confidence: c.confidence,
      successMetric: c.successMetric,
      evaluationWindowDays: c.evaluationWindowDays,
    };
    const existing = activeByKey.get(c.dedupeKey);
    if (existing) {
      if (existing.status === "proposed") {
        await db.update(recommendations).set({ ...fields, updatedAt: now }).where(and(eq(recommendations.id, existing.id), eq(recommendations.status, "proposed")));
        summary.refreshed++;
      }
      continue;
    }
    if (recentlyClosed.has(c.dedupeKey)) {
      summary.skippedCooldown++;
      continue;
    }
    const inserted = await db
      .insert(recommendations)
      .values({ ...fields, brandId: brand.id, dedupeKey: c.dedupeKey, status: "proposed", generatedBy: "deterministic", isDemo: brand.isDemo, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: recommendations.id });
    if (inserted.length > 0) summary.created++;
  }

  const keys = new Set(candidates.map((c) => c.dedupeKey));
  const obsolete = active.filter((r) => r.status === "proposed" && !keys.has(r.dedupeKey)).map((r) => r.id);
  if (obsolete.length > 0) {
    const updated = await db
      .update(recommendations)
      .set({ status: "superseded", updatedAt: now })
      .where(and(inArray(recommendations.id, obsolete), eq(recommendations.status, "proposed")))
      .returning({ id: recommendations.id });
    summary.superseded = updated.length;
  }
  log.info("recommendations generated", { ...summary });
  return summary;
}

// ---------------------------------------------------------------------------
// Recommendations (user-facing)
// ---------------------------------------------------------------------------
const statusEnum = z.enum(["proposed", "accepted", "dismissed", "in_experiment", "done", "superseded"]);
const priorityEnum = z.enum(["high", "medium", "low"]);
const filterSchema = z
  .object({
    statuses: z.array(statusEnum).optional(),
    priorities: z.array(priorityEnum).optional(),
    platform: z.enum(["instagram", "tiktok", "youtube", "other"]).optional(),
    socialAccountId: z.string().uuid().optional(),
    includeSuperseded: z.boolean().optional(),
  })
  .strict();

export async function listRecommendations(db: Db, actor: Actor, brandId: string, filter: RecommendationFilter = {}): Promise<RecommendationView[]> {
  await requireBrandRole(db, actor, brandId, "viewer");
  const f = parseInput(filterSchema, filter);
  const conditions: SQL[] = [eq(recommendations.brandId, brandId)];
  if (f.statuses?.length) conditions.push(inArray(recommendations.status, f.statuses));
  else if (!f.includeSuperseded) conditions.push(ne(recommendations.status, "superseded"));
  if (f.priorities?.length) conditions.push(inArray(recommendations.priority, f.priorities));
  if (f.platform) conditions.push(eq(socialAccounts.platform, f.platform));
  if (f.socialAccountId) conditions.push(eq(recommendations.socialAccountId, f.socialAccountId));
  const rows = await db
    .select({ rec: recommendations, platform: socialAccounts.platform, handle: socialAccounts.handle })
    .from(recommendations)
    .leftJoin(socialAccounts, eq(socialAccounts.id, recommendations.socialAccountId))
    .where(and(...conditions))
    .orderBy(sql`case ${recommendations.priority} when 'high' then 0 when 'medium' then 1 else 2 end`, desc(recommendations.updatedAt));
  return rows.map((r) => ({ ...r.rec, platform: r.platform, handle: r.handle }));
}

async function requireRecommendation(db: Db, actor: Actor, recommendationId: string, min: "viewer" | "manager"): Promise<{ rec: RecommendationRow; brand: BrandRow }> {
  if (!actor) throw new NotFoundError();
  if (!isUuid(recommendationId)) throw new NotFoundError();
  const [rec] = await db.select().from(recommendations).where(eq(recommendations.id, recommendationId)).limit(1);
  if (!rec) throw new NotFoundError();
  const { brand } = await requireBrandRole(db, actor, rec.brandId, min);
  return { rec, brand };
}

const updatableStatus = z.enum(["proposed", "accepted", "dismissed", "done"]);

export async function updateRecommendationStatus(db: Db, actor: Actor, recommendationId: string, status: RecommendationStatus): Promise<RecommendationRow> {
  const { rec } = await requireRecommendation(db, actor, recommendationId, "manager");
  const next = parseInput(updatableStatus, status);
  if (rec.status === "superseded") throw new ConflictError("This recommendation was superseded by newer data.");
  if (rec.status === next) return rec;
  try {
    const [updated] = await db.update(recommendations).set({ status: next, updatedAt: new Date() }).where(eq(recommendations.id, rec.id)).returning();
    return updated!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("An active recommendation for the same finding already exists.");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.").refine((d) => DateTime.fromISO(d).isValid, "Invalid date.");
const createSchema = z
  .object({
    hypothesis: z.string().trim().min(1).max(2000).optional(),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict();
const patchSchema = z
  .object({
    hypothesis: z.string().trim().min(1).max(2000).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    status: z.enum(["planned", "running", "completed", "abandoned"]).optional(),
    resultSummary: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

function assertDateOrder(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start) throw new ValidationError("The end date must be on or after the start date.", [{ path: "endDate", message: "Must be on or after startDate." }]);
}

export async function listExperiments(db: Db, actor: Actor, brandId: string): Promise<ExperimentRow[]> {
  await requireBrandRole(db, actor, brandId, "viewer");
  return db.select().from(experiments).where(eq(experiments.brandId, brandId)).orderBy(desc(experiments.createdAt));
}

export async function createExperimentFromRecommendation(
  db: Db,
  actor: Actor,
  recommendationId: string,
  input: { hypothesis?: string; startDate: string; endDate: string },
): Promise<ExperimentRow> {
  const { rec, brand } = await requireRecommendation(db, actor, recommendationId, "manager");
  const data = parseInput(createSchema, input);
  assertDateOrder(data.startDate, data.endDate);
  if (rec.status !== "proposed" && rec.status !== "accepted") throw new ConflictError("Only proposed or accepted recommendations can start an experiment.");
  const today = DateTime.now().setZone(brand.timezone).toISODate() as string;
  return db.transaction(async (tx) => {
    const [moved] = await tx
      .update(recommendations)
      .set({ status: "in_experiment", updatedAt: new Date() })
      .where(and(eq(recommendations.id, rec.id), inArray(recommendations.status, ["proposed", "accepted"])))
      .returning({ id: recommendations.id });
    if (!moved) throw new ConflictError("This recommendation changed; reload and try again.");
    const [experiment] = await tx
      .insert(experiments)
      .values({
        brandId: rec.brandId,
        recommendationId: rec.id,
        socialAccountId: rec.socialAccountId,
        hypothesis: data.hypothesis ?? rec.interpretation,
        action: rec.action,
        successMetric: rec.successMetric,
        baseline: { capturedAt: new Date().toISOString(), finding: rec.finding, evidence: rec.evidence, evaluationWindowDays: rec.evaluationWindowDays },
        startDate: data.startDate,
        endDate: data.endDate,
        status: data.startDate <= today ? "running" : "planned",
        createdBy: actor.id,
      })
      .returning();
    return experiment!;
  });
}

export async function updateExperiment(
  db: Db,
  actor: Actor,
  experimentId: string,
  patch: { hypothesis?: string; startDate?: string; endDate?: string; status?: ExperimentRow["status"]; resultSummary?: string | null },
): Promise<ExperimentRow> {
  if (!actor || !isUuid(experimentId)) throw new NotFoundError();
  const [exp] = await db.select().from(experiments).where(eq(experiments.id, experimentId)).limit(1);
  if (!exp) throw new NotFoundError();
  await requireBrandRole(db, actor, exp.brandId, "manager");
  const data = parseInput(patchSchema, patch);
  assertDateOrder(data.startDate ?? exp.startDate, data.endDate ?? exp.endDate);
  if ((exp.status === "completed" || exp.status === "abandoned") && data.status && data.status !== exp.status) {
    throw new ConflictError("A finished experiment cannot be reopened.");
  }
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(experiments)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(experiments.id, exp.id))
      .returning();
    if (exp.recommendationId && data.status && data.status !== exp.status && (data.status === "completed" || data.status === "abandoned")) {
      await tx
        .update(recommendations)
        .set({ status: data.status === "completed" ? "done" : "accepted", updatedAt: new Date() })
        .where(and(eq(recommendations.id, exp.recommendationId), eq(recommendations.status, "in_experiment")));
    }
    return updated!;
  });
}
