/**
 * Brand dashboard: Operational Health and Content Performance as independent regions (one never gates the other).
 */
import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { aggregatePostMetrics, median, medianMetric, PLATFORM_METRIC_CAPABILITIES } from "@/domain/metrics";
import { rankContent } from "@/domain/ranking";
import type { Platform } from "@/domain/types";
import { requireBrandRole, roleAtLeast, type BrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { alerts, posts } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { loadAccountStatuses } from "@/server/queries/account-status";
import { loadPostPerformance } from "@/server/queries/post-performance";
import { buildAccountHealth, type AccountHealthVM } from "./account-health";
import { fmtDateTime, fmtDateTimeShort, fmtNum, fmtRelative, PLATFORM_LABEL } from "./format";
import { erCell, type ErCellVM } from "./metric-cells";
import { getReportVersion, listReportVersions } from "@/server/reports/service";

export type DashboardRange = "7d" | "28d";

export interface PlatformPerformanceVM {
  platform: Platform;
  label: string;
  postsPublished: number;
  views: { display: string; note: string | null };
  medianReach: { display: string; note: string | null };
  medianEr: { display: string; note: string | null; definitionId: string };
  metricsAsOf: string | null;
}

export interface TopPostVM {
  postId: string;
  handle: string;
  platformLabel: string;
  publishedAt: string;
  title: string;
  externalUrl: string | null;
  ratio: string;
  confidence: string;
  explanation: string;
  er: ErCellVM;
}

export interface DashboardAlertVM {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  suggestedAction: string;
  updated: string;
  isDemo: boolean;
}

export interface BrandDashboardVM {
  brand: { id: string; name: string; timezone: string; isDemo: boolean };
  role: BrandRole;
  canManage: boolean;
  range: DashboardRange;
  platformFilter: Platform | "all";
  accounts: AccountHealthVM[];
  hasAnyPosts: boolean;
  staleData: boolean;
  performance: { platforms: PlatformPerformanceVM[]; topPosts: TopPostVM[]; rankingMethod: string; rankingNote: string | null; error: string | null };
  alerts: DashboardAlertVM[];
  openAlertCount: number;
  /** Executive summary of the latest final/preliminary weekly report (narrative in the report locale). */
  thisWeek: { reportId: string; periodLabel: string; status: string; locale: string; summary: string; highlights: string[] } | null;
}

export async function loadBrandDashboard(
  db: Db,
  user: SessionUser,
  brandId: string,
  now: Date,
  opts: { range: DashboardRange; platform: Platform | "all" },
): Promise<BrandDashboardVM> {
  const { brand, role } = await requireBrandRole(db, user, brandId, "viewer");
  const tz = brand.timezone;
  const statuses = await loadAccountStatuses(db, { brandIds: [brand.id] }, now);
  const accounts = statuses.map((s) => buildAccountHealth(s, now));
  const accountIds = accounts.map((a) => a.accountId);

  const [postCount] = accountIds.length
    ? await db.select({ n: count() }).from(posts).where(inArray(posts.socialAccountId, accountIds))
    : [{ n: 0 }];

  const days = opts.range === "7d" ? 7 : 28;
  const periodStart = new Date(now.getTime() - days * 86_400_000);
  const performance: BrandDashboardVM["performance"] = { platforms: [], topPosts: [], rankingMethod: "", rankingNote: null, error: null };
  try {
    const scoped = accounts.filter((a) => opts.platform === "all" || a.platform === opts.platform);
    const all = await loadPostPerformance(db, {
      accountIds: scoped.map((a) => a.accountId),
      publishedFrom: new Date(periodStart.getTime() - 28 * 86_400_000),
      publishedTo: now,
    });
    const inPeriod = all.filter((p) => p.publishedAt.getTime() >= periodStart.getTime());
    const platforms = [...new Set(scoped.map((a) => a.platform))];
    for (const platform of platforms) {
      const list = inPeriod.filter((p) => p.platform === platform);
      const views = aggregatePostMetrics(list, "views");
      const reachSupported = PLATFORM_METRIC_CAPABILITIES[platform].reach === "supported";
      const reach = medianMetric(list, "reach");
      const ers = list.map((p) => erCell(p.metrics, platform));
      const erValues = ers.map((e) => e.value).filter((v): v is number => v !== null);
      const erMedian = median(erValues);
      const asOf = list.reduce<Date | null>((m, p) => (p.metricsUpdatedAt && (!m || p.metricsUpdatedAt > m) ? p.metricsUpdatedAt : m), null);
      performance.platforms.push({
        platform,
        label: PLATFORM_LABEL[platform],
        postsPublished: list.length,
        views: {
          display: views.result.value === null ? "N/A" : fmtNum(views.result.value),
          note: views.result.na
            ? views.result.na.message
            : `Plays as counted by ${PLATFORM_LABEL[platform]} (lifetime totals of ${views.postsIncluded} posts)${views.isComplete ? "" : "; lower bound — some posts have no usable value"}${views.containsZeroUncertainty ? "; includes ambiguous zeros" : ""}.`,
        },
        medianReach: reachSupported
          ? { display: reach.result.value === null ? "N/A" : fmtNum(reach.result.value), note: reach.result.na?.message ?? `Median per post, n=${reach.sampleSize}. Reach is never summed.` }
          : { display: "Unsupported", note: `Reach is not available on ${PLATFORM_LABEL[platform]} via Buffer.` },
        medianEr: {
          display: erMedian === null ? "N/A" : `${erMedian.toFixed(2)}%`,
          note: erMedian === null ? "No post in this period has a usable engagement rate." : `Median per post, n=${erValues.length}.`,
          definitionId: ers[0]?.definitionId ?? erCell({}, platform).definitionId,
        },
        metricsAsOf: fmtDateTime(asOf, tz),
      });
    }
    const ranking = rankContent(all, { period: { startUtc: periodStart, endUtcExclusive: now }, limit: 3 });
    performance.rankingMethod = ranking.method;
    const byId = new Map(all.map((p) => [p.postId, p]));
    performance.topPosts = ranking.best.slice(0, 3).map((item) => {
      const p = byId.get(item.postId)!;
      return {
        postId: item.postId,
        handle: p.handle,
        platformLabel: PLATFORM_LABEL[item.platform],
        publishedAt: fmtDateTimeShort(item.publishedAt, tz, now) ?? "",
        title: (p.title || p.text || "Untitled post").slice(0, 120),
        externalUrl: p.externalUrl,
        ratio: `${item.score.toFixed(2)}× cohort median views`,
        confidence: item.confidence,
        explanation: item.explanation,
        er: erCell(p.metrics, p.platform),
      };
    });
    if (performance.topPosts.length === 0) {
      performance.rankingNote =
        inPeriod.length === 0
          ? null
          : `No post in this period clearly outperformed its cohort (${ranking.scored.length} ranked, ${ranking.excluded.length} not rankable — e.g. too young, too few comparable posts, or views not reported).`;
    }
  } catch (err) {
    logger.error("dashboard performance failed", { err, brandId: brand.id });
    performance.error = "We couldn't load performance data for this brand. Operational health may still be shown below.";
  }

  let thisWeek: BrandDashboardVM["thisWeek"] = null;
  try {
    const versions = await listReportVersions(db, user, brand.id);
    const latest = versions.find((v) => v.status === "final" || v.status === "preliminary");
    if (latest) {
      const full = await getReportVersion(db, user, latest.id);
      const c = full.content;
      if (c && c.schemaVersion === 1) {
        thisWeek = {
          reportId: latest.id,
          periodLabel: `${latest.periodStart} – ${latest.periodEnd}`,
          status: latest.status === "final" ? "Final" : "Preliminary",
          locale: c.locale,
          summary: c.executiveSummary.narrative,
          highlights: c.executiveSummary.highlights.slice(0, 4),
        };
      }
    }
  } catch (err) {
    logger.warn("dashboard: latest report unavailable", { err, brandId: brand.id });
  }

  const alertRows = await db
    .select({ id: alerts.id, severity: alerts.severity, title: alerts.title, suggestedAction: alerts.suggestedAction, lastDetectedAt: alerts.lastDetectedAt, isDemo: alerts.isDemo })
    .from(alerts)
    .where(and(eq(alerts.brandId, brand.id), ne(alerts.state, "resolved"), ne(alerts.state, "snoozed")))
    .orderBy(desc(alerts.severity), desc(alerts.lastDetectedAt));

  return {
    brand: { id: brand.id, name: brand.name, timezone: tz, isDemo: brand.isDemo },
    role,
    canManage: roleAtLeast(role, "manager"),
    range: opts.range,
    platformFilter: opts.platform,
    accounts,
    hasAnyPosts: Number(postCount?.n ?? 0) > 0,
    staleData: accounts.some((a) => a.stale !== null || a.freshness.level !== "fresh"),
    performance,
    alerts: alertRows.slice(0, 3).map((a) => ({
      id: a.id,
      severity: a.severity,
      title: a.title,
      suggestedAction: a.suggestedAction,
      updated: `Updated ${fmtRelative(a.lastDetectedAt, now)}`,
      isDemo: a.isDemo,
    })),
    openAlertCount: alertRows.length,
    thisWeek,
  };
}
