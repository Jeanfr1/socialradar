/**
 * Portfolio overview: every accessible brand's operational status (worst status wins), accounts closest to running
 * out, connection failures (workspace admins), valid week-over-week performance changes and open alert counts.
 * Demo brands are tallied separately from production totals.
 */
import { and, count, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { compareValues, median, postAgeAtObservationHours, primaryEngagementRate } from "@/domain/metrics";
import { isPeriodComplete, isValidTimezone, previousCompleteWeek, weekBefore } from "@/domain/periods";
import type { Computed, Platform } from "@/domain/types";
import { listAccessibleBrands, type BrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import { listConnections } from "@/server/connections/service";
import type { Db } from "@/server/db/client";
import { alerts } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { loadAccountStatuses } from "@/server/queries/account-status";
import { loadPostPerformance, type PostPerformanceView } from "@/server/queries/post-performance";
import type { FreshnessVM } from "@/components/ui/Freshness";
import { buildAccountHealth, freshnessVM, needsAttention, STATUS_RANK, worstStatus, type AccountHealthVM, type StatusKind } from "./account-health";
import { fmtDate, fmtDateTime, fmtPct, fmtRelative, fmtSignedPct, PLATFORM_LABEL, plural } from "./format";

export interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
}

export interface BrandCardVM {
  id: string;
  name: string;
  logoUrl: string | null;
  isDemo: boolean;
  role: BrandRole;
  timezone: string;
  worst: StatusKind | null;
  stale: boolean;
  needsAttention: boolean;
  attentionReasons: string[];
  accountCount: number;
  platforms: { platform: Platform; label: string; count: number; worst: StatusKind }[];
  freshness: FreshnessVM;
  connectionUnavailable: boolean;
  openAlerts: SeverityCounts;
  postsLast7d: number | null;
}

export interface RunningOutVM {
  brandId: string;
  brandName: string;
  isDemo: boolean;
  health: AccountHealthVM;
}

export interface PerformanceChangeVM {
  brandId: string;
  brandName: string;
  isDemo: boolean;
  accountId: string;
  handle: string;
  platformLabel: string;
  metricLabel: string;
  definitionId: string;
  previousLabel: string;
  currentLabel: string;
  previous: string;
  current: string;
  sample: string;
  change: string | null;
  direction: "up" | "down" | "flat" | null;
  naReason: string | null;
  sortKey: number;
}

export interface PortfolioVM {
  isWorkspaceAdmin: boolean;
  brands: BrandCardVM[];
  attentionAccountCount: number;
  totals: { production: { brands: number; accounts: number; alerts: SeverityCounts }; demo: { brands: number; accounts: number; alerts: SeverityCounts } | null };
  connectionAlerts: SeverityCounts | null;
  runningOut: RunningOutVM[];
  connectionFailures: { id: string; label: string; status: string; keyHint: string | null; lastError: string | null; failures: number; lastSuccess: string }[] | null;
  changes: { valid: PerformanceChangeVM[]; unavailable: PerformanceChangeVM[] } | null;
  sectionErrors: { changes?: string; connections?: string };
}

const emptyCounts = (): SeverityCounts => ({ critical: 0, warning: 0, info: 0 });
const MIN_SAMPLE = 3;

function medianEngagement(posts: PostPerformanceView[], platform: Platform): { result: Computed; definitionId: string; n: number; medianAge: number | null } {
  const values: number[] = [];
  const ages: number[] = [];
  let definitionId = primaryEngagementRate({}, platform).definitionId;
  for (const p of posts) {
    const er = primaryEngagementRate(p.metrics, platform);
    definitionId = er.definitionId;
    if (er.result.value !== null) {
      values.push(er.result.value);
      const age = postAgeAtObservationHours(p.publishedAt, p.metricsUpdatedAt);
      if (age !== null) ages.push(age);
    }
  }
  const m = median(values);
  if (values.length < MIN_SAMPLE) {
    return {
      result: { value: null, na: { code: "insufficient_sample", message: `Needs at least ${MIN_SAMPLE} posts with a usable engagement rate; found ${values.length}.` } },
      definitionId,
      n: values.length,
      medianAge: median(ages),
    };
  }
  return { result: { value: m as number, na: null }, definitionId, n: values.length, medianAge: median(ages) };
}

export async function loadPortfolio(db: Db, user: SessionUser, now: Date): Promise<PortfolioVM> {
  const brands = await listAccessibleBrands(db, user.id);
  const brandIds = brands.map((b) => b.id);
  const statuses = brandIds.length ? await loadAccountStatuses(db, { brandIds }, now) : [];
  const health = statuses.map((s) => buildAccountHealth(s, now));

  // Open alert counts (snoozed and resolved excluded), scoped to accessible brands (+ connection-level for admins).
  const scope: SQL[] = [];
  if (brandIds.length) scope.push(inArray(alerts.brandId, brandIds));
  if (user.isWorkspaceAdmin) scope.push(isNull(alerts.brandId));
  const alertRows = scope.length
    ? await db
        .select({ brandId: alerts.brandId, severity: alerts.severity, n: count() })
        .from(alerts)
        .where(and(ne(alerts.state, "resolved"), ne(alerts.state, "snoozed"), or(...scope)))
        .groupBy(alerts.brandId, alerts.severity)
    : [];
  const alertsByBrand = new Map<string | null, SeverityCounts>();
  for (const r of alertRows) {
    const c = alertsByBrand.get(r.brandId) ?? emptyCounts();
    c[r.severity] += Number(r.n);
    alertsByBrand.set(r.brandId, c);
  }

  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const sectionErrors: PortfolioVM["sectionErrors"] = {};
  const changes: PerformanceChangeVM[] = [];
  const posts7d = new Map<string, number>();

  // Per-brand performance: posts in the last 7 days and median engagement rate, last complete week vs the week before.
  try {
    for (const brand of brands) {
      const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
      const accountHealth = health.filter((h) => h.brandId === brand.id);
      if (accountHealth.length === 0) continue;
      const current = previousCompleteWeek(now, tz);
      const previous = weekBefore(current);
      const from = new Date(Math.min(previous.startUtc.getTime(), sevenDaysAgo.getTime()));
      const posts = await loadPostPerformance(db, { accountIds: accountHealth.map((h) => h.accountId), publishedFrom: from, publishedTo: now });
      posts7d.set(brand.id, posts.filter((p) => p.publishedAt.getTime() >= sevenDaysAgo.getTime()).length);
      for (const acc of accountHealth) {
        const mine = posts.filter((p) => p.socialAccountId === acc.accountId);
        const cur = mine.filter((p) => p.publishedAt >= current.startUtc && p.publishedAt < current.endUtcExclusive);
        const prev = mine.filter((p) => p.publishedAt >= previous.startUtc && p.publishedAt < previous.endUtcExclusive);
        if (cur.length === 0 && prev.length === 0) continue;
        const a = medianEngagement(cur, acc.platform);
        const b = medianEngagement(prev, acc.platform);
        let cmp = compareValues(a.result, b.result, {
          currentDefinitionId: a.definitionId,
          previousDefinitionId: b.definitionId,
          currentComplete: isPeriodComplete(current, now),
          previousComplete: isPeriodComplete(previous, now),
        });
        // Lifetime counters depend on post age: withhold comparisons of posts observed at very different ages.
        if (cmp.absoluteChange.value !== null && a.medianAge !== null && b.medianAge !== null && b.medianAge > 0) {
          const ratio = a.medianAge / b.medianAge;
          if (ratio < 0.25 || ratio > 4) {
            const na = { value: null, na: { code: "partial_period" as const, message: "Posts in the two weeks were observed at very different ages; comparison withheld." } };
            cmp = { absoluteChange: na, percentChange: na };
          }
        }
        const pct = cmp.percentChange.value;
        const abs = cmp.absoluteChange.value;
        changes.push({
          brandId: brand.id,
          brandName: brand.name,
          isDemo: brand.isDemo,
          accountId: acc.accountId,
          handle: acc.handle,
          platformLabel: PLATFORM_LABEL[acc.platform],
          metricLabel: acc.platform === "instagram" ? "Median engagement rate (by reach)" : "Median engagement rate (by views)",
          definitionId: a.definitionId,
          previousLabel: `${fmtDate(previous.startUtc, tz)} – ${previous.end}`,
          currentLabel: `${fmtDate(current.startUtc, tz)} – ${current.end}`,
          previous: b.result.value === null ? "N/A" : fmtPct(b.result.value, 2),
          current: a.result.value === null ? "N/A" : fmtPct(a.result.value, 2),
          sample: `n=${a.n} vs n=${b.n} posts`,
          change: abs === null ? null : `${abs > 0 ? "+" : ""}${abs.toFixed(2)} pp${pct !== null ? ` (${fmtSignedPct(pct)})` : ""}`,
          direction: abs === null ? null : abs > 0 ? "up" : abs < 0 ? "down" : "flat",
          naReason: cmp.absoluteChange.na?.message ?? null,
          sortKey: pct !== null ? Math.abs(pct) : abs !== null ? Math.abs(abs) : -1,
        });
      }
    }
  } catch (err) {
    logger.error("portfolio performance changes failed", { err });
    sectionErrors.changes = "We couldn't load performance changes.";
  }

  const cards: BrandCardVM[] = brands.map((brand) => {
    const accs = health.filter((h) => h.brandId === brand.id);
    const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
    const byPlatform = new Map<Platform, AccountHealthVM[]>();
    for (const a of accs) byPlatform.set(a.platform, [...(byPlatform.get(a.platform) ?? []), a]);
    const syncTimes = statuses.filter((s) => s.account.brandId === brand.id).map((s) => s.lastQueueSyncAt);
    const oldestSync = syncTimes.length === 0 || syncTimes.some((t) => t === null) ? null : new Date(Math.min(...syncTimes.map((t) => (t as Date).getTime())));
    const reasons: string[] = [];
    const count = (pred: (a: AccountHealthVM) => boolean) => accs.filter(pred).length;
    const crit = count((a) => a.status === "critical");
    const empty = count((a) => a.status === "empty");
    const disc = count((a) => a.status === "disconnected");
    const stale = count((a) => a.stale !== null);
    const conn = count((a) => a.connectionIssue !== null);
    if (disc) reasons.push(`${plural(disc, "account")} disconnected`);
    if (crit) reasons.push(`${plural(crit, "account")} critical`);
    if (empty) reasons.push(`${plural(empty, "empty queue")}`);
    if (stale) reasons.push(`${plural(stale, "account")} with stale data`);
    if (conn) reasons.push(`${plural(conn, "account")} with connection problems`);
    return {
      id: brand.id,
      name: brand.name,
      logoUrl: brand.logoUrl,
      isDemo: brand.isDemo,
      role: brand.role,
      timezone: tz,
      worst: accs.length ? worstStatus(accs.map((a) => a.status)) : null,
      stale: stale > 0,
      needsAttention: accs.some(needsAttention),
      attentionReasons: reasons,
      accountCount: accs.length,
      platforms: [...byPlatform.entries()].map(([platform, list]) => ({
        platform,
        label: PLATFORM_LABEL[platform],
        count: list.length,
        worst: worstStatus(list.map((a) => a.status)),
      })),
      freshness: accs.length ? freshnessVM(oldestSync, now, tz) : { label: "No accounts mapped", absolute: null, level: "fresh" },
      connectionUnavailable: accs.length > 0 && accs.every((a) => a.connectionIssue === "Data unavailable this sync"),
      openAlerts: alertsByBrand.get(brand.id) ?? emptyCounts(),
      postsLast7d: posts7d.get(brand.id) ?? (accs.length ? 0 : null),
    };
  });
  cards.sort(
    (a, b) =>
      Number(b.needsAttention) - Number(a.needsAttention) ||
      (a.worst === null ? 99 : STATUS_RANK[a.worst]) - (b.worst === null ? 99 : STATUS_RANK[b.worst]) ||
      a.name.localeCompare(b.name),
  );

  const sum = (list: BrandCardVM[]) => ({
    brands: list.length,
    accounts: list.reduce((n, c) => n + c.accountCount, 0),
    alerts: list.reduce((acc, c) => ({ critical: acc.critical + c.openAlerts.critical, warning: acc.warning + c.openAlerts.warning, info: acc.info + c.openAlerts.info }), emptyCounts()),
  });
  const demoCards = cards.filter((c) => c.isDemo);

  const brandName = new Map(brands.map((b) => [b.id, b]));
  const runningOut = health
    .filter((h) => h.coveredDaysRaw !== null && h.status !== "paused" && h.status !== "disconnected")
    .sort((a, b) => (a.coveredDaysRaw as number) - (b.coveredDaysRaw as number))
    .slice(0, 8)
    .map((h) => ({ brandId: h.brandId as string, brandName: brandName.get(h.brandId as string)?.name ?? "", isDemo: brandName.get(h.brandId as string)?.isDemo ?? false, health: h }));

  let connectionFailures: PortfolioVM["connectionFailures"] = null;
  if (user.isWorkspaceAdmin) {
    try {
      connectionFailures = (await listConnections(db, user))
        .filter((c) => c.status !== "active" || c.consecutiveFailures > 0 || c.lastErrorCode)
        .map((c) => ({
          id: c.id,
          label: c.label,
          status: c.status,
          keyHint: c.keyHint,
          lastError: c.lastErrorMessage ?? c.lastErrorCode,
          failures: c.consecutiveFailures,
          lastSuccess: c.lastSyncSuccessAt ? `${fmtRelative(c.lastSyncSuccessAt, now)} (${fmtDateTime(c.lastSyncSuccessAt, "UTC")})` : "Never",
        }));
    } catch (err) {
      logger.error("portfolio connections failed", { err });
      sectionErrors.connections = "We couldn't load connection health.";
    }
  }

  const valid = changes.filter((c) => c.change !== null).sort((a, b) => b.sortKey - a.sortKey).slice(0, 8);
  const unavailable = changes.filter((c) => c.change === null).slice(0, 12);

  return {
    isWorkspaceAdmin: user.isWorkspaceAdmin,
    brands: cards,
    attentionAccountCount: health.filter(needsAttention).length,
    totals: { production: sum(cards.filter((c) => !c.isDemo)), demo: demoCards.length ? sum(demoCards) : null },
    connectionAlerts: user.isWorkspaceAdmin ? (alertsByBrand.get(null) ?? emptyCounts()) : null,
    runningOut,
    connectionFailures,
    changes: sectionErrors.changes ? null : { valid, unavailable },
    sectionErrors,
  };
}
