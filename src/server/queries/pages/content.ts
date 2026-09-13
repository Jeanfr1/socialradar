/**
 * Content performance: filterable table of published posts with explicit metric statuses, engagement-rate
 * definitions, provenance, cohort ranking badges, per-platform summaries and gap-preserving daily charts.
 * Raw counts are summarized and sorted per platform only.
 */
import { DateTime } from "luxon";
import { and, eq, inArray } from "drizzle-orm";
import { aggregatePostMetrics, detectAlwaysZeroSeries, median, medianMetric, PLATFORM_METRIC_CAPABILITIES, postAgeAtObservationHours, sumInteractions } from "@/domain/metrics";
import { isValidTimezone } from "@/domain/periods";
import { rankContent } from "@/domain/ranking";
import type { MetricKey, Platform } from "@/domain/types";
import { NotFoundError, requireBrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { socialAccounts } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { loadPostPerformance, type PostPerformanceView } from "@/server/queries/post-performance";
import type { TrendPoint } from "@/components/content/TrendChart";
import { dayKey, fmtDateTime, fmtDateTimeShort, fmtNum, hoursSince, PLATFORM_LABEL } from "./format";
import { erCell, metricCell, TABLE_METRICS, type ErCellVM, type MetricCellVM } from "./metric-cells";

export const CONTENT_SORTS = ["recent", "views", "reach", "er", "comments", "shares"] as const;
export type ContentSort = (typeof CONTENT_SORTS)[number];
const PAGE_SIZE = 50;

export interface ContentFilters {
  q?: string;
  account?: string;
  platform?: string;
  format?: string;
  tag?: string;
  from?: string;
  to?: string;
  sort: ContentSort;
  page: number;
}

export interface ContentRowVM {
  postId: string;
  handle: string;
  platformLabel: string;
  format: string | null;
  published: string;
  preview: string;
  externalUrl: string | null;
  tags: string[];
  metrics: MetricCellVM[];
  extraMetrics: MetricCellVM[];
  er: ErCellVM;
  provenance: string;
  observedAge: string | null;
  rank: { kind: "best" | "under" | "neutral"; label: string; explanation: string; confidence: string } | { kind: "excluded"; label: string; explanation: string } | null;
}

export interface PlatformSummaryVM {
  platform: Platform;
  label: string;
  posts: number;
  views: string;
  viewsNote: string;
  engagements: string;
  engagementsNote: string;
  medianReach: string;
  medianEr: string;
  erDefinitionId: string;
  charts: { id: string; title: string; yLabel: string; unit: "count" | "percent"; points: TrendPoint[]; summary: string }[];
}

export interface ContentVM {
  brand: { id: string; name: string; timezone: string };
  filters: ContentFilters & { from: string; to: string };
  options: { accounts: { id: string; label: string }[]; platforms: { value: string; label: string }[]; formats: string[]; tags: string[] };
  filtersActive: boolean;
  metricsAsOf: string | null;
  metricsOutdated: boolean;
  totalInRange: number;
  totalFiltered: number;
  rows: ContentRowVM[];
  page: number;
  pageCount: number;
  sortNote: string | null;
  summaries: PlatformSummaryVM[];
  rankingMethod: string;
  error: string | null;
}

const EXCLUSION_LABEL: Record<string, string> = {
  metrics_pending: "Not ranked: metrics pending",
  too_young_at_observation: "Not ranked: too recent",
  primary_metric_unavailable: "Not ranked: views unavailable",
  primary_metric_ambiguous_zero: "Not ranked: views reported as 0",
  cohort_too_small: "Not ranked: too few comparable posts",
  cohort_median_zero: "Not ranked: cohort median is 0",
  duplicate_observation: "Not ranked: duplicate observation",
};

function sortValue(row: PostPerformanceView, sort: ContentSort, er: number | null): number | null {
  if (sort === "er") return er;
  if (sort === "recent") return row.publishedAt.getTime();
  const mv = row.metrics[sort as MetricKey];
  return mv && (mv.status === "reported" || mv.status === "reported_zero") ? mv.value : null;
}

export async function loadContent(db: Db, user: SessionUser, brandId: string, now: Date, raw: ContentFilters): Promise<ContentVM> {
  const { brand } = await requireBrandRole(db, user, brandId, "viewer");
  const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
  const accounts = await db
    .select({ id: socialAccounts.id, handle: socialAccounts.handle, platform: socialAccounts.platform })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.brandId, brand.id), eq(socialAccounts.mappingStatus, "mapped")));
  if (raw.account && !accounts.some((a) => a.id === raw.account)) throw new NotFoundError();

  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  const parseDay = (v: string | undefined) => {
    const d = v ? DateTime.fromISO(v, { zone: tz }) : null;
    return d && d.isValid ? d.startOf("day") : null;
  };
  let to = parseDay(raw.to) ?? today;
  let from = parseDay(raw.from) ?? to.minus({ days: 27 });
  if (from > to) [from, to] = [to, from];
  if (to.diff(from, "days").days > 366) from = to.minus({ days: 366 });
  const fromUtc = from.toJSDate();
  const toExclusive = to.plus({ days: 1 }).startOf("day").toJSDate();

  const platform = raw.platform && ["instagram", "tiktok", "youtube", "other"].includes(raw.platform) ? (raw.platform as Platform) : undefined;
  const scoped = accounts.filter((a) => (!raw.account || a.id === raw.account) && (!platform || a.platform === platform));
  const filters = { ...raw, platform, from: from.toISODate() as string, to: to.toISODate() as string };
  const vm: ContentVM = {
    brand: { id: brand.id, name: brand.name, timezone: tz },
    filters,
    options: {
      accounts: accounts.map((a) => ({ id: a.id, label: `@${a.handle.replace(/^@/, "")} (${PLATFORM_LABEL[a.platform]})` })),
      platforms: [...new Set(accounts.map((a) => a.platform))].map((p) => ({ value: p, label: PLATFORM_LABEL[p] })),
      formats: [],
      tags: [],
    },
    filtersActive: !!(raw.q || raw.account || platform || raw.format || raw.tag || raw.from || raw.to),
    metricsAsOf: null,
    metricsOutdated: false,
    totalInRange: 0,
    totalFiltered: 0,
    rows: [],
    page: 1,
    pageCount: 1,
    sortNote: null,
    summaries: [],
    rankingMethod: "",
    error: null,
  };

  try {
    const all = await loadPostPerformance(db, { accountIds: scoped.map((a) => a.id), publishedFrom: new Date(fromUtc.getTime() - 28 * 86_400_000), publishedTo: toExclusive });
    const inRange = all.filter((p) => p.publishedAt >= fromUtc && p.publishedAt < toExclusive);
    vm.totalInRange = inRange.length;
    const tagsOf = (p: PostPerformanceView) => [...p.tags.map((t) => `${t.kind}:${t.value}`), ...p.providerTags];
    vm.options.formats = [...new Set(inRange.map((p) => p.format).filter((f): f is string => !!f))].sort();
    vm.options.tags = [...new Set(inRange.flatMap(tagsOf))].sort().slice(0, 200);

    const q = raw.q?.toLowerCase();
    const filtered = inRange.filter(
      (p) =>
        (!raw.format || (p.format ?? "").toLowerCase() === raw.format.toLowerCase()) &&
        (!raw.tag || tagsOf(p).includes(raw.tag)) &&
        (!q || `${p.title ?? ""} ${p.text ?? ""}`.toLowerCase().includes(q)),
    );
    vm.totalFiltered = filtered.length;

    const ranking = rankContent(all, { period: { startUtc: fromUtc, endUtcExclusive: toExclusive }, limit: 10_000 });
    vm.rankingMethod = ranking.method;
    const best = new Set(ranking.best.map((b) => b.postId));
    const under = new Set(ranking.underperforming.map((b) => b.postId));
    const scored = new Map(ranking.scored.map((s) => [s.postId, s]));
    const excluded = new Map(ranking.excluded.map((e) => [e.postId, e]));

    const alwaysZero = new Map<string, boolean>();
    for (const a of scoped) {
      const mine = inRange.filter((p) => p.socialAccountId === a.id);
      for (const key of [...TABLE_METRICS, "follows" as MetricKey]) alwaysZero.set(`${a.id}|${key}`, detectAlwaysZeroSeries(mine, key, 10).likelyNotReported);
    }

    const latestRetrieved = inRange.reduce<Date | null>((m, p) => {
      const t = p.provenance.retrievedAt ?? p.metricsUpdatedAt;
      return t && (!m || t > m) ? t : m;
    }, null);
    vm.metricsAsOf = fmtDateTime(latestRetrieved, tz);
    vm.metricsOutdated = latestRetrieved !== null && (hoursSince(latestRetrieved, now) ?? 0) > 48;

    const withEr = filtered.map((p) => ({ p, er: erCell(p.metrics, p.platform) }));
    const dir = raw.sort === "recent" ? -1 : -1;
    withEr.sort((a, b) => {
      if (raw.sort !== "recent" && !platform) {
        const pc = a.p.platform.localeCompare(b.p.platform);
        if (pc !== 0) return pc;
      }
      const av = sortValue(a.p, raw.sort, a.er.value);
      const bv = sortValue(b.p, raw.sort, b.er.value);
      if (av === null && bv === null) return b.p.publishedAt.getTime() - a.p.publishedAt.getTime();
      if (av === null) return 1;
      if (bv === null) return -1;
      return dir * (av - bv);
    });
    if (raw.sort !== "recent" && !platform) vm.sortNote = "Sorted within each platform: raw counts and engagement rates are never compared across platforms.";

    vm.pageCount = Math.max(1, Math.ceil(withEr.length / PAGE_SIZE));
    vm.page = Math.min(Math.max(1, raw.page), vm.pageCount);
    vm.rows = withEr.slice((vm.page - 1) * PAGE_SIZE, vm.page * PAGE_SIZE).map(({ p, er }) => {
      const s = scored.get(p.postId);
      const e = excluded.get(p.postId);
      const age = postAgeAtObservationHours(p.publishedAt, p.metricsUpdatedAt);
      return {
        postId: p.postId,
        handle: p.handle,
        platformLabel: PLATFORM_LABEL[p.platform],
        format: p.format,
        published: fmtDateTimeShort(p.publishedAt, tz, now) ?? "",
        preview: (p.title || p.text || "").replace(/\s+/g, " ").slice(0, 160),
        externalUrl: p.externalUrl,
        tags: tagsOf(p),
        metrics: TABLE_METRICS.map((k) => metricCell(k, p.metrics[k], p.platform, { likelyNotReported: alwaysZero.get(`${p.socialAccountId}|${k}`) })),
        extraMetrics: (["follows", "provider_engagement_rate", "avg_watch_time_seconds", "total_watch_time_minutes", "impressions", "clicks"] as MetricKey[]).map((k) =>
          metricCell(k, p.metrics[k], p.platform, { likelyNotReported: alwaysZero.get(`${p.socialAccountId}|${k}`) }),
        ),
        er,
        provenance: `Source ${p.provenance.source ?? "buffer"} · provider refresh ${fmtDateTimeShort(p.provenance.providerUpdatedAt ?? p.metricsUpdatedAt, tz, now) ?? "not yet"} · retrieved ${fmtDateTimeShort(p.provenance.retrievedAt, tz, now) ?? "not yet"}`,
        observedAge: age === null ? null : `Observed ${Math.round(age)}h after publishing`,
        rank: s
          ? {
              kind: best.has(p.postId) ? "best" : under.has(p.postId) ? "under" : "neutral",
              label: best.has(p.postId) ? `Top · ${s.score.toFixed(2)}×` : under.has(p.postId) ? `Below · ${s.score.toFixed(2)}×` : `${s.score.toFixed(2)}× median`,
              explanation: s.explanation,
              confidence: s.confidence,
            }
          : e
            ? { kind: "excluded", label: EXCLUSION_LABEL[e.reason] ?? "Not ranked", explanation: e.detail }
            : null,
      };
    });

    const days: string[] = [];
    for (let d = from; d <= to; d = d.plus({ days: 1 }).startOf("day")) days.push(d.toISODate() as string);
    const platforms = [...new Set(scoped.map((a) => a.platform))];
    for (const pf of platforms) {
      const list = filtered.filter((p) => p.platform === pf);
      const views = aggregatePostMetrics(list, "views");
      let engaged = 0;
      let engagedPosts = 0;
      for (const p of list) {
        const s = sumInteractions(p.metrics, pf);
        if (s.result.value !== null) {
          engaged += s.result.value;
          engagedPosts++;
        }
      }
      const reach = medianMetric(list, "reach");
      const erVals = list.map((p) => erCell(p.metrics, pf).value).filter((v): v is number => v !== null);
      const erMed = median(erVals);
      const byDay = new Map<string, PostPerformanceView[]>();
      for (const p of list) {
        const k = dayKey(p.publishedAt, tz);
        byDay.set(k, [...(byDay.get(k) ?? []), p]);
      }
      const label = (k: string) => DateTime.fromISO(k, { zone: tz }).setLocale("en-US").toFormat("d LLL");
      const viewsPoints: TrendPoint[] = days.map((k) => {
        const m = medianMetric(byDay.get(k) ?? [], "views");
        return { day: k, label: label(k), value: m.result.value, n: (byDay.get(k) ?? []).length };
      });
      const erPoints: TrendPoint[] = days.map((k) => {
        const vals = (byDay.get(k) ?? []).map((p) => erCell(p.metrics, pf).value).filter((v): v is number => v !== null);
        return { day: k, label: label(k), value: median(vals), n: (byDay.get(k) ?? []).length };
      });
      const describe = (pts: TrendPoint[], unit: "count" | "percent") => {
        const withData = pts.filter((x) => x.value !== null);
        if (withData.length === 0) return `No day in this range has usable data for ${PLATFORM_LABEL[pf]}.`;
        const top = withData.reduce((m, x) => ((x.value as number) > (m.value as number) ? x : m));
        const fmt = (v: number) => (unit === "percent" ? `${v.toFixed(2)}%` : fmtNum(v));
        return `${withData.length} of ${pts.length} days have data (days without usable data are gaps, not zeros). Highest: ${fmt(top.value as number)} on ${top.label}.`;
      };
      const erId = erCell({}, pf).definitionId;
      vm.summaries.push({
        platform: pf,
        label: PLATFORM_LABEL[pf],
        posts: list.length,
        views: views.result.value === null ? "N/A" : fmtNum(views.result.value),
        viewsNote: views.result.na
          ? views.result.na.message
          : `Sum of lifetime plays counted by ${PLATFORM_LABEL[pf]} across ${views.postsIncluded} posts${views.isComplete ? "" : " (lower bound: some posts have no usable value)"}${views.containsZeroUncertainty ? "; includes ambiguous zeros" : ""}.`,
        engagements: engagedPosts === 0 ? "N/A" : fmtNum(engaged),
        engagementsNote: `Sum of interactions (${sumInteractions({}, pf).components.join(" + ") || "undefined"}) across ${engagedPosts} of ${list.length} posts with every component usable.`,
        medianReach: PLATFORM_METRIC_CAPABILITIES[pf].reach === "unsupported" ? "Unsupported" : reach.result.value === null ? "N/A" : `${fmtNum(reach.result.value)} (n=${reach.sampleSize})`,
        medianEr: erMed === null ? "N/A" : `${erMed.toFixed(2)}% (n=${erVals.length})`,
        erDefinitionId: erId,
        charts: [
          { id: `views-${pf}`, title: `${PLATFORM_LABEL[pf]}: median views per post, by publish day`, yLabel: "Views", unit: "count", points: viewsPoints, summary: describe(viewsPoints, "count") },
          { id: `er-${pf}`, title: `${PLATFORM_LABEL[pf]}: median engagement rate, by publish day (${erId})`, yLabel: "Eng. rate %", unit: "percent", points: erPoints, summary: describe(erPoints, "percent") },
        ],
      });
    }
  } catch (err) {
    logger.error("content performance failed", { err, brandId: brand.id });
    vm.error = "We couldn't load content performance for this selection.";
  }
  return vm;
}
