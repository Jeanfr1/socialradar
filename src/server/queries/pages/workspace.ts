/**
 * View models for the four main tabs (Calendar, Metrics, Reports, Recommendations).
 *
 * Every loader authorizes the brand first. Numbers come from the same deterministic code paths the reports use
 * (computeFactsForBrand / composeReport / loadPostPerformance / evaluateNextDayGap); nothing is recomputed here
 * with different rules. Captions are untrusted text and are only ever rendered as text.
 */
import { and, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { NEXT_DAY_GAP_MAX_DATA_AGE_HOURS } from "@/domain/alert-rules";
import { evaluateNextDayGap, type DayPost } from "@/domain/next-day-gap";
import {
  isValidTimezone,
  periodAfter,
  periodBefore,
  periodContaining,
  previousCompletePeriod,
  type PeriodKind,
  type WeekPeriod,
} from "@/domain/periods";
import type { Platform } from "@/domain/types";
import { listReportVersions } from "@/server/reports/service";
import { requireBrandRole, roleAtLeast, type Actor, type BrandRow } from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { posts, socialAccounts, syncRuns } from "@/server/db/schema";
import { loadPostPerformance } from "@/server/queries/post-performance";
import { composeReport } from "@/server/reports/compose";
import { computeFactsForBrand } from "@/server/reports/service";

const PT = "pt-BR";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const PLATFORM_NAME: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", other: "Outra" };

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
export interface AccountVM {
  id: string;
  platform: Platform;
  handle: string;
  label: string;
}

async function loadBrand(db: Db, actor: Actor, brandId: string) {
  const { brand, role } = await requireBrandRole(db, actor, brandId, "viewer");
  const timezone = isValidTimezone(brand.timezone) ? brand.timezone : "America/Sao_Paulo";
  return { brand, role, timezone };
}

async function loadAccounts(db: Db, brandId: string): Promise<(AccountVM & { connectionId: string })[]> {
  const rows = await db
    .select({ id: socialAccounts.id, platform: socialAccounts.platform, handle: socialAccounts.handle, displayName: socialAccounts.displayName, connectionId: socialAccounts.connectionId })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.brandId, brandId), eq(socialAccounts.mappingStatus, "mapped"), isNull(socialAccounts.removedAt)));
  const order: Record<Platform, number> = { instagram: 0, tiktok: 1, youtube: 2, other: 3 };
  return rows
    .map((r) => ({ id: r.id, platform: r.platform, handle: r.handle, connectionId: r.connectionId, label: r.displayName?.trim() || r.handle }))
    .sort((a, b) => order[a.platform] - order[b.platform] || a.handle.localeCompare(b.handle));
}

async function lastQueueSyncByConnection(db: Db, connectionIds: string[]): Promise<Map<string, Date>> {
  if (connectionIds.length === 0) return new Map();
  const rows = await db
    .select({ connectionId: syncRuns.connectionId, at: max(syncRuns.finishedAt) })
    .from(syncRuns)
    .where(and(inArray(syncRuns.connectionId, connectionIds), eq(syncRuns.kind, "queue"), inArray(syncRuns.status, ["succeeded", "partial"])))
    .groupBy(syncRuns.connectionId);
  return new Map(rows.filter((r) => r.at).map((r) => [r.connectionId, r.at as Date]));
}

function local(at: Date, tz: string) {
  return DateTime.fromJSDate(at, { zone: tz }).setLocale(PT);
}

export function syncedLabel(at: Date | null, tz: string, now: Date): string | null {
  if (!at) return null;
  const d = local(at, tz);
  const today = local(now, tz).startOf("day");
  const day = d.startOf("day");
  const prefix = +day === +today ? "hoje" : +day === +today.minus({ days: 1 }) ? "ontem" : d.toFormat("dd/LL");
  return `${prefix} às ${d.toFormat("HH:mm")}`;
}

// ---------------------------------------------------------------------------
// Period selection (metrics / recommendations)
// ---------------------------------------------------------------------------
export interface PeriodVM {
  kind: PeriodKind;
  start: string;
  label: string;
  inProgress: boolean;
  prevStart: string;
  nextStart: string | null;
}

export function periodLabel(p: WeekPeriod): string {
  const s = DateTime.fromISO(p.start, { zone: p.timezone }).setLocale(PT);
  const e = DateTime.fromISO(p.end, { zone: p.timezone }).setLocale(PT);
  if (p.kind === "month") return s.toFormat("LLLL 'de' yyyy").replace(/^./, (c) => c.toUpperCase());
  if (s.month === e.month) return `${s.toFormat("d")}–${e.toFormat("d 'de' LLL yyyy")}`;
  return `${s.toFormat("d 'de' LLL")} – ${e.toFormat("d 'de' LLL yyyy")}`;
}

/** Default: the last complete period (fair comparisons need finished periods). Future periods are not allowed. */
export function resolveSelectedPeriod(kind: PeriodKind, start: string | undefined, tz: string, now: Date): WeekPeriod {
  const current = periodContaining(kind, now, tz);
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const d = DateTime.fromISO(start, { zone: tz });
    if (d.isValid) {
      const p = periodContaining(kind, d.toJSDate(), tz);
      if (p.start === start && p.startUtc.getTime() <= current.startUtc.getTime()) return p;
    }
  }
  return previousCompletePeriod(kind, now, tz);
}

function periodVM(p: WeekPeriod, now: Date): PeriodVM {
  const current = periodContaining(p.kind ?? "week", now, p.timezone);
  const next = periodAfter(p);
  return {
    kind: p.kind ?? "week",
    start: p.start,
    label: periodLabel(p),
    inProgress: now.getTime() < p.endUtcExclusive.getTime(),
    prevStart: periodBefore(p).start,
    nextStart: next.startUtc.getTime() <= current.startUtc.getTime() ? next.start : null,
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
export type CalendarPostStatus = "scheduled" | "published" | "failed" | "approval";

export interface CalendarPostVM {
  id: string;
  accountId: string;
  platform: Platform;
  handle: string;
  time: string;
  status: CalendarPostStatus;
  title: string | null;
  url: string | null;
}

export interface CalendarDayVM {
  date: string;
  day: number;
  weekday: string;
  inMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  /** Tomorrow for an account that posts today but has nothing scheduled for this day. */
  isGap: boolean;
  posts: CalendarPostVM[];
}

export interface CalendarAlertVM {
  kind: "next_day_gap" | "publish_failed";
  accountId: string;
  platform: Platform;
  handle: string;
  title: string;
  detail: string;
}

export interface CalendarVM {
  brand: { id: string; name: string; timezone: string };
  month: { key: string; label: string; prevKey: string; nextKey: string; isCurrent: boolean };
  weeks: CalendarDayVM[][];
  accounts: AccountVM[];
  selectedAccountId: string | null;
  alerts: CalendarAlertVM[];
  totals: { scheduled: number; published: number; failed: number };
  lastSync: string | null;
}

const FAILURE_LOOKBACK_DAYS = 7;

function snippet(text: string | null, max = 90): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one || null;
}

export async function loadCalendar(
  db: Db,
  actor: Actor,
  brandId: string,
  opts: { month?: string; accountId?: string },
  now: Date,
): Promise<CalendarVM> {
  const { brand, timezone: tz } = await loadBrand(db, actor, brandId);
  const accounts = await loadAccounts(db, brand.id);
  const selected = accounts.find((a) => a.id === opts.accountId) ?? null;

  const today = local(now, tz).startOf("day");
  const monthStart = (() => {
    if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
      const m = DateTime.fromFormat(opts.month, "yyyy-LL", { zone: tz });
      if (m.isValid) return m.startOf("month");
    }
    return today.startOf("month");
  })();
  const gridStart = monthStart.minus({ days: monthStart.weekday - 1 });
  const monthEnd = monthStart.plus({ months: 1 });
  const gridEnd = monthEnd.plus({ days: (8 - monthEnd.weekday) % 7 });

  const accountIds = (selected ? [selected] : accounts).map((a) => a.id);
  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  const rows =
    accountIds.length === 0
      ? []
      : await db
          .select({
            id: posts.id,
            accountId: posts.socialAccountId,
            status: posts.status,
            dueAt: posts.dueAt,
            sentAt: posts.sentAt,
            title: posts.title,
            text: posts.text,
            url: posts.externalUrl,
          })
          .from(posts)
          .where(
            and(
              inArray(posts.socialAccountId, accountIds),
              inArray(posts.status, ["scheduled", "sending", "sent", "error", "needs_approval"]),
              sql`coalesce(${posts.sentAt}, ${posts.dueAt}) >= ${gridStart.toJSDate()} and coalesce(${posts.sentAt}, ${posts.dueAt}) < ${gridEnd.toJSDate()}`,
            ),
          );

  const postsByDay = new Map<string, CalendarPostVM[]>();
  const totals = { scheduled: 0, published: 0, failed: 0 };
  for (const r of rows) {
    const at = r.status === "sent" ? r.sentAt ?? r.dueAt : r.dueAt ?? r.sentAt;
    const acc = byAccount.get(r.accountId);
    if (!at || !acc) continue;
    const status: CalendarPostStatus =
      r.status === "sent" ? "published" : r.status === "error" ? "failed" : r.status === "needs_approval" ? "approval" : "scheduled";
    const d = local(at, tz);
    if (d >= monthStart && d < monthEnd) {
      if (status === "published") totals.published++;
      else if (status === "failed") totals.failed++;
      else if (status === "scheduled") totals.scheduled++;
    }
    const key = d.toISODate() as string;
    const list = postsByDay.get(key) ?? [];
    list.push({ id: r.id, accountId: acc.id, platform: acc.platform, handle: acc.handle, time: d.toFormat("HH:mm"), status, title: snippet(r.title ?? r.text), url: r.url });
    postsByDay.set(key, list);
  }

  // Alerts are always computed for the whole brand, whatever filter or month is on screen.
  const alerts: CalendarAlertVM[] = [];
  const gapDays = new Set<string>();
  const syncs = await lastQueueSyncByConnection(db, [...new Set(accounts.map((a) => a.connectionId))]);
  if (accounts.length > 0) {
    const around = await db
      .select({ accountId: posts.socialAccountId, status: posts.status, dueAt: posts.dueAt, sentAt: posts.sentAt, errorMessage: posts.errorMessage })
      .from(posts)
      .where(
        and(
          inArray(posts.socialAccountId, accounts.map((a) => a.id)),
          inArray(posts.status, ["scheduled", "sending", "sent", "error"]),
          sql`coalesce(${posts.sentAt}, ${posts.dueAt}) between ${new Date(now.getTime() - FAILURE_LOOKBACK_DAYS * DAY_MS)} and ${new Date(now.getTime() + 3 * DAY_MS)}`,
        ),
      );
    for (const acc of accounts) {
      const mine = around.filter((p) => p.accountId === acc.id);
      const lastSync = syncs.get(acc.connectionId) ?? null;
      if (lastSync && now.getTime() - lastSync.getTime() <= NEXT_DAY_GAP_MAX_DATA_AGE_HOURS * HOUR_MS) {
        const dayPosts: DayPost[] = mine.filter((p) => p.status !== "error").map((p) => ({ status: p.status, at: p.status === "sent" ? p.sentAt ?? p.dueAt : p.dueAt }));
        const gap = evaluateNextDayGap({ now, timezone: tz, posts: dayPosts });
        if (gap.isGap) {
          gapDays.add(gap.tomorrow);
          const tomorrowLabel = DateTime.fromISO(gap.tomorrow, { zone: tz }).setLocale(PT).toFormat("cccc, dd/LL");
          alerts.push({
            kind: "next_day_gap",
            accountId: acc.id,
            platform: acc.platform,
            handle: acc.handle,
            title: `Amanhã não há post agendado em @${acc.handle}`,
            detail: `${PLATFORM_NAME[acc.platform]} · ${tomorrowLabel}. Hoje ${gap.postsToday === 1 ? "tem 1 post" : `tem ${gap.postsToday} posts`}; agende pelo menos um para amanhã.`,
          });
        }
      }
      const failed = mine.filter((p) => p.status === "error");
      if (failed.length > 0) {
        const latest = failed.sort((a, b) => (b.dueAt?.getTime() ?? 0) - (a.dueAt?.getTime() ?? 0))[0]!;
        alerts.push({
          kind: "publish_failed",
          accountId: acc.id,
          platform: acc.platform,
          handle: acc.handle,
          title: failed.length === 1 ? `1 post não foi publicado em @${acc.handle}` : `${failed.length} posts não foram publicados em @${acc.handle}`,
          detail: `${PLATFORM_NAME[acc.platform]} · ${latest.errorMessage ?? "O Buffer não informou o motivo."} Corrija no Buffer e reagende.`,
        });
      }
    }
  }

  const weeks: CalendarDayVM[][] = [];
  for (let cursor = gridStart; cursor < gridEnd; cursor = cursor.plus({ weeks: 1 })) {
    const week: CalendarDayVM[] = [];
    for (let i = 0; i < 7; i++) {
      const d = cursor.plus({ days: i });
      const key = d.toISODate() as string;
      const list = (postsByDay.get(key) ?? []).sort((a, b) => a.time.localeCompare(b.time));
      week.push({
        date: key,
        day: d.day,
        weekday: d.toFormat("ccc").replace(".", ""),
        inMonth: d.month === monthStart.month,
        isToday: +d === +today,
        isPast: d < today,
        isGap: gapDays.has(key) && (!selected || alerts.some((a) => a.kind === "next_day_gap" && a.accountId === selected.id)),
        posts: list,
      });
    }
    weeks.push(week);
  }

  const latestSync = [...syncs.values()].sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return {
    brand: { id: brand.id, name: brand.name, timezone: tz },
    month: {
      key: monthStart.toFormat("yyyy-LL"),
      label: monthStart.setLocale(PT).toFormat("LLLL 'de' yyyy").replace(/^./, (c) => c.toUpperCase()),
      prevKey: monthStart.minus({ months: 1 }).toFormat("yyyy-LL"),
      nextKey: monthStart.plus({ months: 1 }).toFormat("yyyy-LL"),
      isCurrent: +monthStart === +today.startOf("month"),
    },
    weeks,
    accounts: accounts.map(({ connectionId: _c, ...a }) => a),
    selectedAccountId: selected?.id ?? null,
    alerts: alerts.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "next_day_gap" ? -1 : 1)),
    totals,
    lastSync: syncedLabel(latestSync, tz, now),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export interface MetricValueVM {
  /** Latest lifetime value of the period's posts (null = not available). */
  value: number | null;
  /** Change vs previous period, comparing posts at the same age (null = not comparable). */
  change: number | null;
  /** "pct" for counts, "pp" (percentage points) for rates. */
  changeUnit: "pct" | "pp";
}

export interface MetricsRowVM {
  account: AccountVM;
  posts: MetricValueVM;
  views: MetricValueVM;
  engagement: MetricValueVM;
  rate: MetricValueVM;
}

export interface MetricsVM {
  brand: { id: string; name: string };
  period: PeriodVM;
  totals: { posts: MetricValueVM; views: MetricValueVM; engagement: MetricValueVM; rate: MetricValueVM };
  accounts: MetricsRowVM[];
  daily: { date: string; label: string; views: number }[];
  topPosts: { id: string; platform: Platform; handle: string; date: string; title: string | null; views: number; engagement: number | null; url: string | null }[];
  comparisonNote: string | null;
}

/** Posts younger than this at their last observation are left out of per-post averages (still accumulating). */
export const MIN_POST_AGE_HOURS_FOR_AVERAGE = 48;

type Perf = Awaited<ReturnType<typeof loadPostPerformance>>[number];

function usable(p: Perf, key: "views" | "reactions" | "comments" | "shares" | "saves"): number | null {
  const v = p.metrics[key];
  return v && (v.status === "reported" || v.status === "reported_zero") && v.value !== null ? v.value : null;
}

function interactions(p: Perf): number | null {
  let total: number | null = null;
  for (const key of ["reactions", "comments", "shares", "saves"] as const) {
    const v = usable(p, key);
    if (v !== null) total = (total ?? 0) + v;
  }
  return total;
}

function matureEnough(p: Perf): boolean {
  if (!p.metricsUpdatedAt) return false;
  return (p.metricsUpdatedAt.getTime() - p.publishedAt.getTime()) / HOUR_MS >= MIN_POST_AGE_HOURS_FOR_AVERAGE;
}

interface PeriodAggregate {
  posts: number;
  views: number | null;
  engagement: number | null;
  /** Averages over posts old enough to compare (null when none). */
  avgViews: number | null;
  avgEngagement: number | null;
  rate: number | null;
}

function aggregate(list: Perf[]): PeriodAggregate {
  let views: number | null = null;
  let engagement: number | null = null;
  let viewsSum = 0;
  let engSum = 0;
  let mature = 0;
  for (const p of list) {
    const v = usable(p, "views");
    const e = interactions(p);
    if (v !== null) views = (views ?? 0) + v;
    if (e !== null) engagement = (engagement ?? 0) + e;
    if (matureEnough(p) && v !== null) {
      viewsSum += v;
      engSum += e ?? 0;
      mature++;
    }
  }
  return {
    posts: list.length,
    views,
    engagement,
    avgViews: mature > 0 ? viewsSum / mature : null,
    avgEngagement: mature > 0 ? engSum / mature : null,
    rate: views ? ((engagement ?? 0) / views) * 100 : null,
  };
}

function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

function compare(cur: PeriodAggregate, prev: PeriodAggregate): Omit<MetricsRowVM, "account"> {
  return {
    posts: { value: cur.posts, change: pctChange(cur.posts, prev.posts), changeUnit: "pct" },
    views: { value: cur.views, change: pctChange(cur.avgViews, prev.avgViews), changeUnit: "pct" },
    engagement: { value: cur.engagement, change: pctChange(cur.avgEngagement, prev.avgEngagement), changeUnit: "pct" },
    rate: { value: cur.rate, change: cur.rate !== null && prev.rate !== null ? cur.rate - prev.rate : null, changeUnit: "pp" },
  };
}

export async function loadMetrics(
  db: Db,
  actor: Actor,
  brandId: string,
  opts: { kind: PeriodKind; start?: string },
  now: Date,
): Promise<MetricsVM> {
  const { brand, timezone: tz } = await loadBrand(db, actor, brandId);
  const period = resolveSelectedPeriod(opts.kind, opts.start, tz, now);
  const previous = periodBefore(period);
  const accounts = await loadAccounts(db, brand.id);
  const ids = accounts.map((a) => a.id);
  const [perf, prevPerf] = await Promise.all([
    loadPostPerformance(db, { accountIds: ids, publishedFrom: period.startUtc, publishedTo: period.endUtcExclusive }),
    loadPostPerformance(db, { accountIds: ids, publishedFrom: previous.startUtc, publishedTo: previous.endUtcExclusive }),
  ]);

  const accountRows: MetricsRowVM[] = accounts.map(({ connectionId: _c, ...account }) => ({
    account,
    ...compare(aggregate(perf.filter((p) => p.socialAccountId === account.id)), aggregate(prevPerf.filter((p) => p.socialAccountId === account.id))),
  }));

  const dailyMap = new Map<string, number>();
  for (let d = DateTime.fromISO(period.start, { zone: tz }); d <= DateTime.fromISO(period.end, { zone: tz }); d = d.plus({ days: 1 })) {
    dailyMap.set(d.toISODate() as string, 0);
  }
  for (const p of perf) {
    const key = local(p.publishedAt, tz).toISODate() as string;
    if (dailyMap.has(key)) dailyMap.set(key, (dailyMap.get(key) ?? 0) + (usable(p, "views") ?? 0));
  }
  const daily = [...dailyMap.entries()].map(([date, v]) => {
    const d = DateTime.fromISO(date, { zone: tz }).setLocale(PT);
    return { date, label: opts.kind === "month" ? d.toFormat("d") : d.toFormat("ccc d").replace(".", ""), views: v };
  });

  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  const topPosts = perf
    .filter((p) => byAccount.has(p.socialAccountId) && (usable(p, "views") ?? 0) > 0)
    .sort((a, b) => (usable(b, "views") ?? 0) - (usable(a, "views") ?? 0))
    .slice(0, 5)
    .map((p) => {
      const acc = byAccount.get(p.socialAccountId)!;
      return {
        id: p.postId,
        platform: acc.platform,
        handle: acc.handle,
        date: local(p.publishedAt, tz).toFormat("dd/LL"),
        title: snippet(p.title ?? p.text, 110),
        views: usable(p, "views") ?? 0,
        engagement: interactions(p),
        url: p.externalUrl,
      };
    });

  return {
    brand: { id: brand.id, name: brand.name },
    period: periodVM(period, now),
    totals: compare(aggregate(perf), aggregate(prevPerf)),
    accounts: accountRows,
    daily,
    topPosts,
    comparisonNote: `Variação em relação ${opts.kind === "month" ? "ao mês" : "à semana"} anterior. Visualizações e engajamento comparam a média por post (só posts com 2 dias ou mais de publicação), para que posts mais antigos não levem vantagem.`,
  };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------
export interface InsightVM {
  text: string;
  platform: Platform | null;
}

export interface ContentHighlightVM {
  id: string;
  platform: Platform;
  handle: string;
  date: string;
  title: string | null;
  views: number;
  /** Views relative to similar posts of the same account and format (e.g. 1.8 = 80% above). */
  score: number;
  url: string | null;
}

export interface ChangeVM {
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  successMetric: string;
}

export interface RecommendationsVM {
  brand: { id: string; name: string };
  period: PeriodVM;
  working: InsightVM[];
  notWorking: InsightVM[];
  topContent: ContentHighlightVM[];
  weakContent: ContentHighlightVM[];
  changes: ChangeVM[];
  isEmpty: boolean;
}

/** Operational findings live in the calendar; this tab is about what the content is doing. */
const OPERATIONAL_FINDING_PREFIXES = ["failures:", "disconnected:", "sync_stale:", "coverage:"];
const CONTENT_ACTIONS = new Set(["repeat_top_format", "review_underperforming", "restore_cadence", "maintain_cadence", "tag_content_pillars", "track_success_metrics"]);

export async function loadRecommendations(
  db: Db,
  actor: Actor,
  brandId: string,
  opts: { kind: PeriodKind; start?: string },
  now: Date,
): Promise<RecommendationsVM> {
  const { brand, timezone: tz } = await loadBrand(db, actor, brandId);
  const period = resolveSelectedPeriod(opts.kind, opts.start, tz, now);
  const accounts = await loadAccounts(db, brand.id);
  const platformOf = new Map(accounts.map((a) => [a.id, a.platform]));
  const facts = await computeFactsForBrand(db, { ...brand, timezone: tz } as BrandRow, period, now);
  const content = composeReport(facts);

  const keep = (id: string) => !OPERATIONAL_FINDING_PREFIXES.some((p) => id.startsWith(p));
  const insight = (i: { id: string; text: string; accountId: string | null }): InsightVM => ({ text: i.text, platform: i.accountId ? platformOf.get(i.accountId) ?? null : null });
  const highlight = (i: (typeof content.bestContent.items)[number]): ContentHighlightVM => ({
    id: i.postId,
    platform: i.platform,
    handle: i.handle,
    date: local(new Date(i.publishedAt), tz).toFormat("dd/LL"),
    title: snippet(i.textExcerpt, 110),
    views: i.views,
    score: i.score,
    url: i.externalUrl,
  });

  const working = content.wentWell.items.filter((i) => keep(i.id)).map(insight);
  const notWorking = content.needsImprovement.items.filter((i) => keep(i.id)).map(insight);
  const topContent = content.bestContent.items.map(highlight);
  const weakContent = content.underperformingContent.items.map(highlight);
  const changes = content.actions.items
    .filter((a) => CONTENT_ACTIONS.has(a.kind))
    .map((a) => ({ priority: a.priority, title: a.title, description: a.description, successMetric: a.successMetric }));

  return {
    brand: { id: brand.id, name: brand.name },
    period: periodVM(period, now),
    working,
    notWorking,
    topContent,
    weakContent,
    changes,
    isEmpty: working.length + notWorking.length + topContent.length + weakContent.length + changes.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Reports list
// ---------------------------------------------------------------------------
export interface ReportListItemVM {
  id: string;
  label: string;
  status: "final" | "preliminary" | "generating" | "failed";
  version: number;
  generatedAt: string | null;
}

export interface ReportsListVM {
  brand: { id: string; name: string };
  kind: PeriodKind;
  canRegenerate: boolean;
  items: ReportListItemVM[];
}

export async function loadReportsList(db: Db, actor: Actor, brandId: string, kind: PeriodKind, now: Date): Promise<ReportsListVM> {
  const { brand, role, timezone: tz } = await loadBrand(db, actor, brandId);
  const all = await listReportVersions(db, actor, brand.id);
  // Only the latest version of each period is listed (history stays available through regeneration).
  const latest = new Map<string, (typeof all)[number]>();
  for (const r of all) {
    if ((r.periodKind ?? "week") !== kind) continue;
    const prev = latest.get(r.periodStart);
    if (!prev || r.version > prev.version) latest.set(r.periodStart, r);
  }
  const items = [...latest.values()]
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))
    .map((r) => {
      const p = periodContaining(kind, DateTime.fromISO(r.periodStart, { zone: tz }).toJSDate(), tz);
      return {
        id: r.id,
        label: periodLabel(p),
        status: r.status,
        version: r.version,
        generatedAt: r.generatedAt ? syncedLabel(r.generatedAt, tz, now) : null,
      };
    });
  return { brand: { id: brand.id, name: brand.name }, kind, canRegenerate: roleAtLeast(role, "manager"), items };
}

export async function latestReportIdForPeriod(db: Db, brandId: string, kind: PeriodKind, periodStart: string): Promise<string | null> {
  const { reportVersions } = await import("@/server/db/schema");
  const [row] = await db
    .select({ id: reportVersions.id })
    .from(reportVersions)
    .where(and(eq(reportVersions.brandId, brandId), eq(reportVersions.periodKind, kind), eq(reportVersions.periodStart, periodStart)))
    .orderBy(desc(reportVersions.version))
    .limit(1);
  return row?.id ?? null;
}
