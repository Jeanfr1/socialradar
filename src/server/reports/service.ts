/**
 * Weekly report service: scheduled (idempotent) and manual generation, versions, PDF/CSV exports.
 *
 * Generation = load (brand-scoped) → deterministic facts → deterministic content → optional AI narrative (validated)
 * → persist content + dataSnapshot + sha256 hash + preliminary flag. A failed generation marks the row `failed`
 * (kept in history) and rethrows so the worker job retries.
 *
 * Idempotency: `report_versions_scheduled_uq` allows one trigger='scheduled' row per brand + period.
 * - final/preliminary scheduled row → returned as-is.
 * - failed row, or `generating` row whose lease expired (crash) → regenerated INTO the same row.
 * - `generating` row with a fresh lease (another worker) → returned as-is.
 * While a row is `generating`, `generated_at` holds the lease start; on completion it is the generation time.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, getTableColumns, isNull, lt, max, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { isValidTimezone, monthContaining, weekContaining, type PeriodKind, type WeekPeriod } from "@/domain/periods";
import { recordAudit } from "@/server/audit";
import {
  ConflictError,
  isUniqueViolation,
  isUuid,
  NotFoundError,
  requireBrandRole,
  requireReportAccess,
  ValidationError,
  type Actor,
  type BrandRow,
  type ReportVersionRow,
} from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { brands, recommendations, reportVersions } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { redactText } from "@/server/security/redact";
import { applyAiOutcome, generateAiNarrative, type AnthropicClient } from "./ai";
import { actionDedupeKey, composeReport } from "./compose";
import { reportToCsv } from "./csv";
import { computeReportFacts, encodePreliminaryReasons, PUBLISHED_SYNC_GRACE_HOURS } from "./facts";
import { loadReportInput } from "./load";
import { buildReportPdf } from "./pdf";
import type { ReportFacts, WeeklyReportContent } from "./types";

export type { ReportVersionRow } from "@/server/auth/authz";

export interface ReportDeps {
  /** Injected Anthropic client (tests). When omitted and AI is enabled, a client is created from the environment. */
  anthropic?: AnthropicClient | null;
  /** Environment used for AI configuration (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export type ReportVersionSummary = Omit<ReportVersionRow, "content" | "dataSnapshot">;
export type ReportVersionView = Omit<ReportVersionRow, "content"> & { content: WeeklyReportContent | null };

export const GENERATION_LEASE_MS = 15 * 60_000;
/** Minimum time between automatic refreshes of a preliminary report. */
export const PRELIMINARY_REFRESH_MIN_AGE_MS = 6 * 3_600_000;
/** How far back preliminary reports are refreshed automatically. */
export const PRELIMINARY_REFRESH_LOOKBACK_DAYS = 21;

const log = logger.child({ component: "reports" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashSnapshot(facts: ReportFacts): string {
  return createHash("sha256").update(canonicalJson(facts)).digest("hex");
}

export function resolvePeriod(timezone: string, periodStart: string, kind: PeriodKind = "week"): WeekPeriod {
  if (typeof periodStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) throw new ValidationError("periodStart must be a local date (YYYY-MM-DD).");
  if (!isValidTimezone(timezone)) throw new ValidationError("The brand timezone is invalid.");
  const local = DateTime.fromISO(periodStart, { zone: timezone });
  if (!local.isValid) throw new ValidationError("periodStart must be a valid date.");
  if (kind === "month") {
    const month = monthContaining(local.toJSDate(), timezone);
    if (month.start !== periodStart) throw new ValidationError("periodStart must be the first day of a month in the brand timezone.");
    return month;
  }
  const week = weekContaining(local.toJSDate(), timezone);
  if (week.start !== periodStart) throw new ValidationError("periodStart must be a Monday in the brand timezone.");
  return week;
}

function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : "Report generation failed.";
  return redactText(msg).slice(0, 500);
}

async function loadBrand(db: Db, brandId: string): Promise<BrandRow> {
  if (!isUuid(brandId)) throw new NotFoundError();
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
  if (!brand) throw new NotFoundError();
  return brand;
}

async function findScheduled(db: Db, brandId: string, periodStart: string, kind: PeriodKind): Promise<ReportVersionRow | null> {
  const [row] = await db
    .select()
    .from(reportVersions)
    .where(
      and(
        eq(reportVersions.brandId, brandId),
        eq(reportVersions.periodKind, kind),
        eq(reportVersions.periodStart, periodStart),
        eq(reportVersions.trigger, "scheduled"),
      ),
    )
    .limit(1);
  return row ?? null;
}

class ScheduledRowExists extends Error {
  constructor(readonly row: ReportVersionRow) {
    super("scheduled report row exists");
  }
}

async function insertVersion(
  db: Db,
  brand: BrandRow,
  period: WeekPeriod,
  trigger: "scheduled" | "manual",
  generatedBy: string | null,
  now: Date,
): Promise<ReportVersionRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [current] = await db
      .select({ v: max(reportVersions.version) })
      .from(reportVersions)
      .where(and(eq(reportVersions.brandId, brand.id), eq(reportVersions.periodKind, period.kind ?? "week"), eq(reportVersions.periodStart, period.start)));
    try {
      const [row] = await db
        .insert(reportVersions)
        .values({
          brandId: brand.id,
          periodStart: period.start,
          periodEnd: period.end,
          periodKind: period.kind ?? "week",
          version: (current?.v ?? 0) + 1,
          status: "generating",
          trigger,
          locale: brand.reportLocale,
          timezone: brand.timezone,
          generatedBy,
          generatedAt: now,
          isDemo: brand.isDemo,
        })
        .returning();
      return row!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (trigger === "scheduled") {
        const existing = await findScheduled(db, brand.id, period.start, period.kind ?? "week");
        if (existing) throw new ScheduledRowExists(existing);
      }
      // Version number taken by a concurrent generation: retry with the next one.
    }
  }
  throw new ConflictError("Could not allocate a report version. Please retry.");
}

async function linkRecommendations(db: Db, brandId: string, content: WeeklyReportContent): Promise<WeeklyReportContent> {
  const keys = content.actions.items.map((a) => actionDedupeKey(a.kind, a.accountId)).filter((k): k is string => !!k);
  if (keys.length === 0) return content;
  const active = await db
    .select({ id: recommendations.id, dedupeKey: recommendations.dedupeKey })
    .from(recommendations)
    .where(and(eq(recommendations.brandId, brandId), sql`${recommendations.status} in ('proposed', 'accepted', 'in_experiment')`));
  const byKey = new Map(active.map((r) => [r.dedupeKey, r.id]));
  return {
    ...content,
    actions: {
      ...content.actions,
      items: content.actions.items.map((a) => {
        const key = actionDedupeKey(a.kind, a.accountId);
        return { ...a, relatedRecommendationId: key ? byKey.get(key) ?? null : null };
      }),
    },
  };
}

export async function computeFactsForBrand(db: Db, brand: BrandRow, period: WeekPeriod, now: Date): Promise<ReportFacts> {
  return computeReportFacts(await loadReportInput(db, brand, period, now));
}

async function generateInto(db: Db, row: ReportVersionRow, brand: BrandRow, period: WeekPeriod, now: Date, deps: ReportDeps, precomputed?: ReportFacts): Promise<ReportVersionRow> {
  try {
    const facts = precomputed ?? (await computeFactsForBrand(db, brand, period, now));
    let content = composeReport(facts);
    content = await linkRecommendations(db, brand.id, content);
    const outcome = await generateAiNarrative(facts, content, { client: deps.anthropic, env: deps.env });
    content = applyAiOutcome(content, outcome);
    const isPreliminary = facts.preliminaryReasons.length > 0;
    const [updated] = await db
      .update(reportVersions)
      .set({
        status: isPreliminary ? "preliminary" : "final",
        locale: facts.brand.locale,
        timezone: facts.brand.timezone,
        content: content as unknown as Record<string, unknown>,
        narrativeSource: content.narrativeSource,
        dataSnapshot: facts as unknown as Record<string, unknown>,
        dataSnapshotHash: hashSnapshot(facts),
        isPreliminary,
        preliminaryReasons: encodePreliminaryReasons(facts.preliminaryReasons),
        errorMessage: null,
        generatedAt: now,
      })
      .where(eq(reportVersions.id, row.id))
      .returning();
    log.info("report generated", { reportId: row.id, brandId: brand.id, periodStart: period.start, version: row.version, status: updated?.status, narrativeSource: content.narrativeSource });
    return updated!;
  } catch (err) {
    await db
      .update(reportVersions)
      .set({ status: "failed", errorMessage: safeErrorMessage(err), generatedAt: now })
      .where(eq(reportVersions.id, row.id))
      .catch(() => undefined);
    log.error("report generation failed", { reportId: row.id, brandId: brand.id, periodStart: period.start, error: err });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
export async function runScheduledWeeklyReport(
  db: Db,
  input: { brandId: string; periodStart: string; kind?: PeriodKind },
  now: Date,
  deps: ReportDeps = {},
): Promise<ReportVersionRow> {
  const brand = await loadBrand(db, input.brandId);
  const kind = input.kind ?? "week";
  const period = resolvePeriod(brand.timezone, input.periodStart, kind);

  let row = await findScheduled(db, brand.id, period.start, kind);
  if (!row) {
    try {
      const created = await insertVersion(db, brand, period, "scheduled", null, now);
      return await generateInto(db, created, brand, period, now, deps);
    } catch (err) {
      if (!(err instanceof ScheduledRowExists)) throw err;
      row = err.row;
    }
  }
  if (row.status === "final" || row.status === "preliminary") return row;

  const leaseExpiredBefore = new Date(now.getTime() - GENERATION_LEASE_MS);
  const [claimed] = await db
    .update(reportVersions)
    .set({ status: "generating", errorMessage: null, generatedAt: now })
    .where(
      and(
        eq(reportVersions.id, row.id),
        or(
          eq(reportVersions.status, "failed"),
          and(eq(reportVersions.status, "generating"), or(isNull(reportVersions.generatedAt), lt(reportVersions.generatedAt, leaseExpiredBefore))),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    const [latest] = await db.select().from(reportVersions).where(eq(reportVersions.id, row.id)).limit(1);
    return latest ?? row;
  }
  return generateInto(db, claimed, brand, period, now, deps);
}

export async function regenerateReport(
  db: Db,
  actor: Actor,
  brandId: string,
  periodStart: string,
  now: Date,
  deps: ReportDeps = {},
  kind: PeriodKind = "week",
): Promise<ReportVersionRow> {
  const { brand } = await requireBrandRole(db, actor, brandId, "manager");
  const period = resolvePeriod(brand.timezone, periodStart, kind);
  if (period.startUtc.getTime() > now.getTime()) throw new ValidationError("Reports cannot be generated for a period that has not started.");
  const row = await insertVersion(db, brand, period, "manual", actor.id, now);
  await recordAudit(db, {
    actorUserId: actor.id,
    action: "report_regenerated",
    brandId: brand.id,
    targetType: "report_version",
    targetId: row.id,
    metadata: { periodStart: period.start, periodKind: kind, version: row.version },
  });
  return generateInto(db, row, brand, period, now, deps);
}

/**
 * Creates a new version for recent periods whose LATEST version is preliminary, once the published-sync grace period
 * has passed, the latest version is at least 6h old and the deterministic facts changed (different preliminary
 * reasons or snapshot hash). New versions use trigger 'manual' with generatedBy null. Intended for the scheduler.
 */
export async function refreshPreliminaryReports(db: Db, now: Date, deps: ReportDeps = {}): Promise<ReportVersionRow[]> {
  const since = DateTime.fromJSDate(now).minus({ days: PRELIMINARY_REFRESH_LOOKBACK_DAYS }).toISODate() as string;
  const candidates = await db
    .select({ brandId: reportVersions.brandId, periodKind: reportVersions.periodKind, periodStart: reportVersions.periodStart, version: max(reportVersions.version) })
    .from(reportVersions)
    .where(sql`${reportVersions.periodStart} >= ${since}`)
    .groupBy(reportVersions.brandId, reportVersions.periodKind, reportVersions.periodStart);
  const created: ReportVersionRow[] = [];
  for (const c of candidates) {
    try {
      const [latest] = await db
        .select()
        .from(reportVersions)
        .where(and(eq(reportVersions.brandId, c.brandId), eq(reportVersions.periodKind, c.periodKind), eq(reportVersions.periodStart, c.periodStart)))
        .orderBy(desc(reportVersions.version))
        .limit(1);
      if (!latest || latest.status !== "preliminary") continue;
      if (latest.generatedAt && now.getTime() - latest.generatedAt.getTime() < PRELIMINARY_REFRESH_MIN_AGE_MS) continue;
      const brand = await loadBrand(db, c.brandId);
      if (brand.archivedAt) continue;
      const period = resolvePeriod(brand.timezone, c.periodStart, c.periodKind);
      if (now.getTime() < period.endUtcExclusive.getTime() + PUBLISHED_SYNC_GRACE_HOURS * 3_600_000) continue;
      const facts = await computeFactsForBrand(db, brand, period, now);
      const reasons = encodePreliminaryReasons(facts.preliminaryReasons);
      const sameReasons = reasons.length === latest.preliminaryReasons.length && reasons.every((r) => latest.preliminaryReasons.includes(r));
      if (sameReasons && facts.preliminaryReasons.length > 0) continue;
      const row = await insertVersion(db, brand, period, "manual", null, now);
      created.push(await generateInto(db, row, brand, period, now, deps, facts));
    } catch (err) {
      log.error("preliminary report refresh failed", { brandId: c.brandId, periodStart: c.periodStart, error: err });
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Reads & exports
// ---------------------------------------------------------------------------
export async function listReportVersions(db: Db, actor: Actor, brandId: string): Promise<ReportVersionSummary[]> {
  await requireBrandRole(db, actor, brandId, "viewer");
  const { content: _c, dataSnapshot: _d, ...columns } = getTableColumns(reportVersions);
  return db
    .select(columns)
    .from(reportVersions)
    .where(eq(reportVersions.brandId, brandId))
    .orderBy(desc(reportVersions.periodStart), desc(reportVersions.version));
}

export async function getReportVersion(db: Db, actor: Actor, reportId: string): Promise<ReportVersionView> {
  const { report } = await requireReportAccess(db, actor, reportId, "viewer");
  return { ...report, content: (report.content as unknown as WeeklyReportContent | null) ?? null };
}

async function exportable(db: Db, actor: Actor, reportId: string) {
  const { report, brandId } = await requireReportAccess(db, actor, reportId, "viewer");
  const content = report.content as unknown as WeeklyReportContent | null;
  if (!content || (report.status !== "final" && report.status !== "preliminary")) throw new ConflictError("This report version has no content to export.");
  const [brand] = await db.select({ slug: brands.slug }).from(brands).where(eq(brands.id, brandId)).limit(1);
  const slug = (brand?.slug ?? "brand").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  return { report, content, brandId, base: `brandpulse-${slug}-${report.periodKind === "month" ? "mensal" : "semanal"}-${report.periodStart}-v${report.version}` };
}

export async function renderReportPdf(db: Db, actor: Actor, reportId: string): Promise<{ filename: string; body: Buffer }> {
  const { report, content, brandId, base } = await exportable(db, actor, reportId);
  const body = await buildReportPdf(content);
  await recordAudit(db, { actorUserId: actor.id, action: "report_downloaded", brandId, targetType: "report_version", targetId: report.id, metadata: { format: "pdf", version: report.version, periodStart: report.periodStart } });
  return { filename: `${base}.pdf`, body };
}

export async function renderReportCsv(db: Db, actor: Actor, reportId: string): Promise<{ filename: string; body: string }> {
  const { report, content, brandId, base } = await exportable(db, actor, reportId);
  const body = reportToCsv(content);
  await recordAudit(db, { actorUserId: actor.id, action: "export_downloaded", brandId, targetType: "report_version", targetId: report.id, metadata: { format: "csv", version: report.version, periodStart: report.periodStart } });
  return { filename: `${base}.csv`, body };
}

/** Generic name: the service handles weekly and monthly periods. */
export const runScheduledReport = runScheduledWeeklyReport;
