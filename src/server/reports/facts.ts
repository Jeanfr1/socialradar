/**
 * Deterministic weekly-report facts (the `dataSnapshot`). Pure: every input is passed in, `now` is injected.
 *
 * All numbers come from src/domain (aggregatePostMetrics, medianMetric, primaryEngagementRate, compareValues,
 * rollingBaseline, rankContent, computeCoverage, detectAlwaysZeroSeries). This module only selects WHICH
 * observations feed them:
 * - "latest" cells use each post's latest lifetime values (post_metrics_latest).
 * - week-over-week and trend cells use AGE-MATCHED observations from metric_observations: for every post, the single
 *   provider refresh closest to (but not after) the comparison age. One refresh per post → snapshots are never summed.
 * Methodology: docs/REPORTS_AND_INSIGHTS.md.
 */
import {
  aggregatePostMetrics,
  compareValues,
  detectAlwaysZeroSeries,
  isUsable,
  medianMetric,
  median,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  na,
  ok,
  PLATFORM_METRIC_CAPABILITIES,
  primaryEngagementRate,
  rollingBaseline,
} from "@/domain/metrics";
import { computeCoverage, type CoverageResultDetailed } from "@/domain/coverage";
import { isPeriodComplete, rollingWeeks, weekBefore, type WeekPeriod } from "@/domain/periods";
import { rankContent, type RankingExclusionReason } from "@/domain/ranking";
import type { CadenceConfig, Computed, MetricKey, MetricValue, Platform, PostPerformance, ValueStatus } from "@/domain/types";
import { redactText } from "@/server/security/redact";
import { resolveReportLocale } from "./i18n";
import {
  REPORT_SCHEMA_VERSION,
  type AccountDataQuality,
  type CellStatus,
  type ComparisonParameters,
  type FactAccountRef,
  type FactCell,
  type FactConsistency,
  type FactContentList,
  type FactKpiRow,
  type FactNA,
  type FactTrendMetric,
  type KpiAggregation,
  type KpiMetricId,
  type PreliminaryReasonCode,
  type RankingParameters,
  type ReportFacts,
  type ReportNaCode,
  type ReportUnit,
} from "./types";

const HOUR_MS = 3_600_000;

export const COMPARISON_PARAMETERS: ComparisonParameters = {
  /** Preferred post age for week-over-week comparisons (7 days). */
  targetAgeHours: 168,
  /** Below this age lifetime counters are too immature to compare. */
  minComparisonAgeHours: 24,
  /** Observation must be within min(maxToleranceHours, age/2) before the comparison age. */
  maxToleranceHours: 36,
  /** Minimum posts per side for medians (and per week for trends). */
  minMedianSample: 3,
};

export const RANKING_PARAMETERS: RankingParameters = {
  minObservationAgeHours: 72,
  minCohortSize: 5,
  baselineWindowDays: 28,
  bestMinRatio: 1.2,
  underperformingMaxRatio: 0.8,
  limit: 5,
};

export const TREND_WEEKS = 4;
export const TREND_MIN_WEEKS = 3;
/** Minimum distinct posts to flag an always-zero series as likely not reported. */
export const ALWAYS_ZERO_MIN_SAMPLE = 10;
/** Preliminary until a published sync succeeded at least this long after the period end. */
export const PUBLISHED_SYNC_GRACE_HOURS = 24;
export const EXCERPT_MAX_CHARS = 280;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export interface ReportInputAccount {
  id: string;
  handle: string;
  displayName: string | null;
  platform: Platform;
  connectionStatus: string;
  isDisconnected: boolean;
  isQueuePaused: boolean;
  cadence: CadenceConfig;
  cadenceIsDefault: boolean;
  /** Queue coverage computed at generation time. */
  coverage: CoverageResultDetailed;
  lastQueueSyncAt: Date | null;
  /** Last SUCCEEDED published-posts/metrics sync of the account's connection (finished at or before `now`). */
  lastPublishedSyncAt: Date | null;
  overdueCount: number;
}

export interface ReportInputPost extends PostPerformance {
  text: string | null;
  title: string | null;
}

export interface ObservationInput {
  postId: string;
  metricKey: string;
  value: number | null;
  valueStatus: "reported" | "reported_zero" | "not_reported" | "pending";
  providerUpdatedAt: Date;
}

export interface FailedPostInput {
  postId: string;
  socialAccountId: string;
  dueAt: Date | null;
  message: string | null;
  externalUrl: string | null;
}

export interface ReportInput {
  brand: { id: string; name: string; timezone: string; reportLocale: string; contentPillars: string[] };
  period: WeekPeriod;
  now: Date;
  accounts: ReportInputAccount[];
  /** Published posts (latest metrics) of the accounts, published in [trend window start, period end). */
  posts: ReportInputPost[];
  /** Post metric observation history (providerUpdatedAt <= now) for those posts. */
  observations: ObservationInput[];
  /** Posts with status error whose dueAt falls in the period. */
  failedPosts: FailedPostInput[];
}

/** First instant whose posts the report must load (trend window + ranking baseline). */
export function reportWindowStart(period: WeekPeriod): Date {
  const trendStart = rollingWeeks(period, TREND_WEEKS + 1)[0]!.startUtc.getTime();
  const rankingStart = period.endUtcExclusive.getTime() - RANKING_PARAMETERS.baselineWindowDays * 86_400_000;
  return new Date(Math.min(trendStart, rankingStart, period.startUtc.getTime()));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const inPeriod = (at: Date, p: Pick<WeekPeriod, "startUtc" | "endUtcExclusive">) =>
  at.getTime() >= p.startUtc.getTime() && at.getTime() < p.endUtcExclusive.getTime();

/** Control, zero-width, bidi-override and line-separator characters stripped from untrusted text. */
const UNSAFE_TEXT_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g");

/** Collapses whitespace, strips control characters and truncates untrusted text. */
export function excerpt(text: string | null | undefined, max = EXCERPT_MAX_CHARS): string | null {
  if (!text) return null;
  const clean = text.replace(UNSAFE_TEXT_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function cell(value: number | null, status: CellStatus, naCode: ReportNaCode | null, unit: ReportUnit, included: number, total: number, zero = false): FactCell {
  return { value, status, na: naCode ? { code: naCode } : null, unit, postsIncluded: included, postsTotal: total, containsZeroUncertainty: zero };
}

function naCell(code: ReportNaCode, unit: ReportUnit, total: number, status: CellStatus = "unavailable"): FactCell {
  return cell(null, status, code, unit, 0, total);
}

/** Explains an all-unusable metric from the statuses of the posts in scope. */
function unusableCell(perfs: PostPerformance[], key: MetricKey, unit: ReportUnit, total: number): FactCell {
  const statuses = perfs.map((p) => p.metrics[key]?.status ?? ("not_reported" as ValueStatus));
  if (total === 0) return naCell("no_posts", unit, 0);
  if (statuses.length > 0 && statuses.every((s) => s === "unsupported")) return naCell("unsupported_by_provider", unit, total, "unsupported");
  if (statuses.length > 0 && statuses.every((s) => s === "pending")) return naCell("metrics_pending", unit, total, "pending");
  if (statuses.length > 0 && statuses.every((s) => s === "not_reported")) return naCell("not_reported", unit, total);
  return naCell("no_data", unit, total);
}

function unitOf(key: MetricKey): ReportUnit {
  return METRIC_DEFINITIONS[key].unit;
}

// ---------------------------------------------------------------------------
// Age-matched observations
// ---------------------------------------------------------------------------
export type RefreshIndex = Map<string, Map<number, ObservationInput[]>>;

export function buildRefreshIndex(observations: ObservationInput[], now: Date): RefreshIndex {
  const index: RefreshIndex = new Map();
  for (const o of observations) {
    const t = o.providerUpdatedAt.getTime();
    if (!Number.isFinite(t) || t > now.getTime()) continue;
    let refreshes = index.get(o.postId);
    if (!refreshes) index.set(o.postId, (refreshes = new Map()));
    const rows = refreshes.get(t) ?? [];
    // Same post + metric + refresh is unique in the DB; keep the first defensively.
    if (!rows.some((r) => r.metricKey === o.metricKey)) rows.push(o);
    refreshes.set(t, rows);
  }
  return index;
}

const ageHoursAt = (publishedAt: Date, at: number) => Math.max(0, at - publishedAt.getTime()) / HOUR_MS;

export function maxObservedAgeHours(post: Pick<PostPerformance, "postId" | "publishedAt">, index: RefreshIndex): number | null {
  const refreshes = index.get(post.postId);
  if (!refreshes || refreshes.size === 0) return null;
  return Math.max(...[...refreshes.keys()].map((t) => ageHoursAt(post.publishedAt, t)));
}

export type AgeMatchExclusion = "metrics_pending" | "too_young" | "no_comparable_observation";

export interface AgeMatched {
  perf: PostPerformance | null;
  observedAgeHours: number | null;
  exclusion: AgeMatchExclusion | null;
}

function metricsFromRefresh(platform: Platform, rows: ObservationInput[]): Partial<Record<MetricKey, MetricValue>> {
  const byKey = new Map(rows.map((r) => [r.metricKey, r]));
  const caps = PLATFORM_METRIC_CAPABILITIES[platform];
  const metrics: Partial<Record<MetricKey, MetricValue>> = {};
  for (const key of METRIC_KEYS) {
    const row = byKey.get(key);
    if (caps[key] === "unsupported") metrics[key] = { key, value: null, status: "unsupported" };
    else if (!row) metrics[key] = { key, value: null, status: "not_reported" };
    else if ((row.valueStatus === "reported" || row.valueStatus === "reported_zero") && typeof row.value === "number" && Number.isFinite(row.value)) {
      metrics[key] = { key, value: row.value, status: row.value === 0 ? "reported_zero" : "reported" };
    } else metrics[key] = { key, value: null, status: row.valueStatus === "pending" ? "pending" : "not_reported" };
  }
  return metrics;
}

/**
 * The post as observed at the provider refresh closest to, but not after, `ageHours` after publishing.
 * The refresh must be at least `ageHours − min(maxToleranceHours, ageHours / 2)` old, otherwise the post is excluded.
 */
export function snapshotAtAge(post: PostPerformance, index: RefreshIndex, ageHours: number, now: Date, params = COMPARISON_PARAMETERS): AgeMatched {
  const refreshes = index.get(post.postId);
  if (!refreshes || refreshes.size === 0) return { perf: null, observedAgeHours: null, exclusion: "metrics_pending" };
  const tolerance = Math.min(params.maxToleranceHours, ageHours / 2);
  let bestAt: number | null = null;
  let bestAge = -Infinity;
  for (const at of refreshes.keys()) {
    const age = ageHoursAt(post.publishedAt, at);
    if (age <= ageHours + 1e-9 && age > bestAge) {
      bestAge = age;
      bestAt = at;
    }
  }
  const tooYoung = ageHoursAt(post.publishedAt, now.getTime()) < ageHours;
  if (bestAt === null || bestAge < ageHours - tolerance - 1e-9) {
    return { perf: null, observedAgeHours: bestAt === null ? null : round(bestAge, 2), exclusion: tooYoung ? "too_young" : "no_comparable_observation" };
  }
  return {
    perf: { ...post, metricsUpdatedAt: new Date(bestAt), metrics: metricsFromRefresh(post.platform, refreshes.get(bestAt)!) },
    observedAgeHours: round(bestAge, 2),
    exclusion: null,
  };
}

/**
 * Latest comparison age at or below the target for which every current-week post has a nearby observation.
 * Candidate ages come from real provider refreshes; this avoids selecting an arbitrary age between polling runs
 * that would exclude part of the current week. Null when the posts are too young or have no common comparable age.
 */
export function chooseComparisonAge(
  currentPosts: PostPerformance[],
  index: RefreshIndex,
  params = COMPARISON_PARAMETERS,
): { ageHours: number; na: null } | { ageHours: null; na: ReportNaCode } {
  if (currentPosts.length === 0) return { ageHours: null, na: "no_posts" };
  const ages = currentPosts.map((p) => maxObservedAgeHours(p, index)).filter((a): a is number => a !== null);
  if (ages.length === 0) return { ageHours: null, na: "metrics_pending" };
  const qualifying = ages.filter((a) => a >= params.minComparisonAgeHours);
  if (qualifying.length === 0) return { ageHours: null, na: "insufficient_post_age" };

  const candidateAges = new Set<number>();
  for (const post of currentPosts) {
    for (const at of index.get(post.postId)?.keys() ?? []) {
      const age = ageHoursAt(post.publishedAt, at);
      if (age >= params.minComparisonAgeHours && age <= params.targetAgeHours) candidateAges.add(age);
    }
  }
  for (const candidate of [...candidateAges].sort((a, b) => b - a)) {
    const tolerance = Math.min(params.maxToleranceHours, candidate / 2);
    const everyPostComparable = currentPosts.every((post) => {
      const refreshes = index.get(post.postId);
      if (!refreshes) return false;
      let best = -Infinity;
      for (const at of refreshes.keys()) {
        const age = ageHoursAt(post.publishedAt, at);
        if (age <= candidate + 1e-9 && age > best) best = age;
      }
      return best >= candidate - tolerance - 1e-9;
    });
    if (everyPostComparable) return { ageHours: round(candidate, 2), na: null };
  }
  return { ageHours: null, na: "no_comparable_observation" };
}

export function ageMatchedPosts(posts: PostPerformance[], index: RefreshIndex, ageHours: number, now: Date, params = COMPARISON_PARAMETERS) {
  const perfs: PostPerformance[] = [];
  const exclusions: { postId: string; reason: AgeMatchExclusion }[] = [];
  for (const p of posts) {
    const m = snapshotAtAge(p, index, ageHours, now, params);
    if (m.perf) perfs.push(m.perf);
    else exclusions.push({ postId: p.postId, reason: m.exclusion! });
  }
  return { perfs, exclusions };
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------
function sumCell(perfs: PostPerformance[], key: MetricKey, total: number, emptyNa: ReportNaCode | null): FactCell {
  const unit = unitOf(key);
  if (total === 0) return naCell("no_posts", unit, 0);
  if (perfs.length === 0) return naCell(emptyNa ?? "no_data", unit, total, emptyNa === "metrics_pending" ? "pending" : "unavailable");
  const agg = aggregatePostMetrics(perfs, key);
  if (agg.result.value === null) return unusableCell(perfs, key, unit, total);
  const complete = agg.postsIncluded === total;
  return cell(round(agg.result.value), complete ? "available" : "partial", null, unit, agg.postsIncluded, total, agg.containsZeroUncertainty);
}

function medianCell(perfs: PostPerformance[], key: MetricKey, total: number, emptyNa: ReportNaCode | null): FactCell {
  const unit = unitOf(key);
  if (total === 0) return naCell("no_posts", unit, 0);
  if (perfs.length === 0) return naCell(emptyNa ?? "no_data", unit, total, emptyNa === "metrics_pending" ? "pending" : "unavailable");
  const m = medianMetric(perfs, key);
  if (m.result.value === null) return unusableCell(perfs, key, unit, total);
  return cell(round(m.result.value), m.sampleSize === total ? "available" : "partial", null, unit, m.sampleSize, total, m.containsZeroUncertainty);
}

function erDefinitionId(platform: Platform): string {
  return primaryEngagementRate({}, platform).definitionId;
}

function engagementMedianCell(perfs: PostPerformance[], platform: Platform, total: number, emptyNa: ReportNaCode | null): FactCell {
  if (total === 0) return naCell("no_posts", "percent", 0);
  if (platform === "other") return naCell("unsupported_by_provider", "percent", total, "unsupported");
  if (perfs.length === 0) return naCell(emptyNa ?? "no_data", "percent", total, emptyNa === "metrics_pending" ? "pending" : "unavailable");
  const rates = perfs.map((p) => primaryEngagementRate(p.metrics, p.platform));
  const values = rates.map((r) => r.result.value).filter((v): v is number => v !== null);
  const m = median(values);
  if (m === null) {
    const codes = rates.map((r) => r.result.na?.code);
    if (codes.every((c) => c === "unsupported_by_provider")) return naCell("unsupported_by_provider", "percent", total, "unsupported");
    if (perfs.every((p) => Object.values(p.metrics).some((v) => v?.status === "pending"))) return naCell("metrics_pending", "percent", total, "pending");
    const code = codes.find((c): c is NonNullable<typeof c> => !!c) ?? "no_data";
    return naCell(code, "percent", total);
  }
  const zero = rates.some((r) => r.result.value !== null && r.containsZeroUncertainty);
  return cell(round(m), values.length === total ? "available" : "partial", null, "percent", values.length, total, zero);
}

function computedOf(c: FactCell): Computed {
  return c.value === null ? na(c.na?.code === "unsupported_by_provider" ? "unsupported_by_provider" : "no_data", "unavailable") : ok(c.value);
}

interface ChangeResult {
  absoluteChange: number | null;
  percentChange: number | null;
  na: FactNA | null;
  percentNa: FactNA | null;
}

export function compareCells(current: FactCell, previous: FactCell, aggregation: KpiAggregation, periodComplete: boolean, params = COMPARISON_PARAMETERS): ChangeResult {
  const fail = (code: ReportNaCode): ChangeResult => ({ absoluteChange: null, percentChange: null, na: { code }, percentNa: null });
  if (!periodComplete) return fail("partial_period");
  if (current.value === null) return fail(current.na?.code ?? "no_data");
  if (previous.value === null) return fail(previous.na?.code ?? "no_data");
  if (aggregation === "sum_distinct_posts" && (current.status !== "available" || previous.status !== "available")) return fail("incomplete_sample");
  if (aggregation === "median_per_post" && (current.postsIncluded < params.minMedianSample || previous.postsIncluded < params.minMedianSample)) {
    return fail("insufficient_sample");
  }
  // Definition ids are identical by construction (same account & platform); compareValues still enforces the rules.
  const r = compareValues(computedOf(current), computedOf(previous), { currentDefinitionId: "same", previousDefinitionId: "same", currentComplete: true, previousComplete: true });
  if (r.absoluteChange.value === null) return fail("no_data");
  return {
    absoluteChange: round(r.absoluteChange.value),
    percentChange: r.percentChange.value === null ? null : round(r.percentChange.value),
    na: null,
    percentNa: r.percentChange.na ? { code: r.percentChange.na.code } : null,
  };
}

// ---------------------------------------------------------------------------
// KPI rows
// ---------------------------------------------------------------------------
interface KpiSpec {
  metricId: KpiMetricId;
  aggregation: KpiAggregation;
  key: MetricKey | null;
}

export const KPI_SPECS: readonly KpiSpec[] = [
  { metricId: "posts_published", aggregation: "count", key: null },
  { metricId: "views", aggregation: "sum_distinct_posts", key: "views" },
  { metricId: "reactions", aggregation: "sum_distinct_posts", key: "reactions" },
  { metricId: "comments", aggregation: "sum_distinct_posts", key: "comments" },
  { metricId: "shares", aggregation: "sum_distinct_posts", key: "shares" },
  { metricId: "saves", aggregation: "sum_distinct_posts", key: "saves" },
  { metricId: "total_watch_time", aggregation: "sum_distinct_posts", key: "total_watch_time_minutes" },
  { metricId: "reach_median", aggregation: "median_per_post", key: "reach" },
  { metricId: "engagement_rate_median", aggregation: "median_per_post", key: null },
  { metricId: "provider_engagement_rate_median", aggregation: "median_per_post", key: "provider_engagement_rate" },
  { metricId: "avg_watch_time_median", aggregation: "median_per_post", key: "avg_watch_time_seconds" },
];

function definitionIdOf(spec: KpiSpec, platform: Platform): string {
  if (spec.metricId === "posts_published") return "posts_published:v1";
  if (spec.metricId === "engagement_rate_median") return `median:${erDefinitionId(platform)}`;
  return `${spec.aggregation === "sum_distinct_posts" ? "sum" : "median"}:${spec.key}:v1`;
}

function cellFor(spec: KpiSpec, perfs: PostPerformance[], platform: Platform, total: number, emptyNa: ReportNaCode | null): FactCell {
  if (spec.metricId === "engagement_rate_median") return engagementMedianCell(perfs, platform, total, emptyNa);
  const key = spec.key as MetricKey;
  if (PLATFORM_METRIC_CAPABILITIES[platform][key] === "unsupported") return naCell("unsupported_by_provider", unitOf(key), total, "unsupported");
  return spec.aggregation === "sum_distinct_posts" ? sumCell(perfs, key, total, emptyNa) : medianCell(perfs, key, total, emptyNa);
}

function observedRange(posts: PostPerformance[]) {
  const times = posts.map((p) => p.metricsUpdatedAt?.getTime()).filter((t): t is number => typeof t === "number");
  return {
    observedAtMin: times.length ? new Date(Math.min(...times)).toISOString() : null,
    observedAtMax: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

function exclusionNa(exclusions: { reason: AgeMatchExclusion }[]): ReportNaCode {
  if (exclusions.length > 0 && exclusions.every((e) => e.reason === "metrics_pending")) return "metrics_pending";
  if (exclusions.some((e) => e.reason === "too_young")) return "insufficient_post_age";
  return "no_comparable_observation";
}

export function computeAccountKpis(
  account: ReportInputAccount,
  currentPosts: PostPerformance[],
  previousPosts: PostPerformance[],
  index: RefreshIndex,
  period: WeekPeriod,
  now: Date,
  params = COMPARISON_PARAMETERS,
): { comparisonAgeHours: number | null; rows: FactKpiRow[] } {
  const periodComplete = isPeriodComplete(period, now);
  const age = chooseComparisonAge(currentPosts, index, params);
  const cur = age.ageHours === null ? null : ageMatchedPosts(currentPosts, index, age.ageHours, now, params);
  const prev = age.ageHours === null ? null : ageMatchedPosts(previousPosts, index, age.ageHours, now, params);
  const neverSynced = account.lastPublishedSyncAt === null;

  const rows = KPI_SPECS.map((spec): FactKpiRow => {
    const definitionId = definitionIdOf(spec, account.platform);
    const source = spec.metricId === "posts_published" ? "brandpulse:posts" : "buffer:post_metrics";
    if (spec.metricId === "posts_published") {
      const latest = neverSynced ? naCell("never_synced", "posts", 0) : cell(currentPosts.length, "available", null, "posts", currentPosts.length, currentPosts.length);
      const previous = neverSynced ? naCell("never_synced", "posts", 0) : cell(previousPosts.length, "available", null, "posts", previousPosts.length, previousPosts.length);
      return {
        metricId: spec.metricId,
        definitionId,
        aggregation: "count",
        unit: "posts",
        source,
        latest: { ...latest, observedAtMin: null, observedAtMax: null },
        comparison: { basis: "count", ageHours: null, ageDays: null, current: latest, previous, ...compareCells(latest, previous, "count", periodComplete, params) },
        status: latest.status,
      };
    }
    const latestCell = cellFor(spec, currentPosts, account.platform, currentPosts.length, null);
    const latest = { ...latestCell, ...observedRange(currentPosts) };
    let currentCell: FactCell;
    let previousCell: FactCell;
    if (age.ageHours === null || !cur || !prev) {
      const unsupported = latestCell.status === "unsupported";
      currentCell = unsupported ? latestCell : naCell(age.na ?? "no_data", latestCell.unit, currentPosts.length, age.na === "metrics_pending" ? "pending" : "unavailable");
      previousCell = unsupported ? { ...latestCell, postsTotal: previousPosts.length } : naCell(age.na ?? "no_data", latestCell.unit, previousPosts.length);
    } else {
      currentCell = cellFor(spec, cur.perfs, account.platform, currentPosts.length, exclusionNa(cur.exclusions));
      previousCell = cellFor(spec, prev.perfs, account.platform, previousPosts.length, exclusionNa(prev.exclusions));
    }
    const change = latestCell.status === "unsupported" ? { absoluteChange: null, percentChange: null, na: { code: "unsupported_by_provider" as const }, percentNa: null } : compareCells(currentCell, previousCell, spec.aggregation, periodComplete, params);
    return {
      metricId: spec.metricId,
      definitionId,
      aggregation: spec.aggregation,
      unit: latestCell.unit,
      source,
      latest,
      comparison: {
        basis: "age_matched",
        ageHours: age.ageHours,
        ageDays: age.ageHours === null ? null : round(age.ageHours / 24, 2),
        current: currentCell,
        previous: previousCell,
        ...change,
      },
      status: latestCell.status,
    };
  });
  return { comparisonAgeHours: age.ageHours, rows };
}

// ---------------------------------------------------------------------------
// Publication consistency
// ---------------------------------------------------------------------------
export interface WeekSlotCoverage {
  mode: CadenceConfig["mode"];
  isEstimate: boolean;
  plannedSlots: number | null;
  covered: number | null;
  offCadence: number | null;
  status: "on_track" | "below_plan" | "no_cadence" | "paused";
}

/**
 * Planned slots of a past week (from the cadence as currently configured) matched against the posts actually
 * published in it, reusing the coverage matcher with `now` = 1 ms before the week starts and a 7-day horizon.
 */
export function computeWeekSlotCoverage(cadence: CadenceConfig, period: Pick<WeekPeriod, "startUtc" | "endUtcExclusive">, published: { id: string; at: Date }[]): WeekSlotCoverage {
  if (cadence.mode === "paused") return { mode: cadence.mode, isEstimate: false, plannedSlots: null, covered: null, offCadence: null, status: "paused" };
  const start = new Date(period.startUtc.getTime() - 1);
  const items = published.filter((p) => inPeriod(p.at, period)).map((p) => ({ id: p.id, dueAt: p.at, status: "scheduled" as const }));
  const cov = computeCoverage({
    now: start,
    cadence: { ...cadence, horizonDays: 7, staleAfterMinutes: Number.MAX_SAFE_INTEGER },
    items,
    lastQueueSyncAt: start,
    queuePaused: false,
    accountDisconnected: false,
  });
  // Slots at or after the period end (horizon edge) are not part of the week.
  const slots = cov.slots.filter((s) => s.at.getTime() < period.endUtcExclusive.getTime());
  if (slots.length === 0) return { mode: cadence.mode, isEstimate: cov.isEstimate, plannedSlots: null, covered: null, offCadence: null, status: "no_cadence" };
  const covered = slots.filter((s) => s.covered).length;
  return {
    mode: cadence.mode,
    isEstimate: cov.isEstimate,
    plannedSlots: slots.length,
    covered,
    offCadence: items.length - covered,
    status: covered >= slots.length ? "on_track" : "below_plan",
  };
}

function consistencyFor(account: ReportInputAccount, currentPosts: PostPerformance[], failed: FailedPostInput[], period: WeekPeriod, now: Date): FactConsistency {
  const week = computeWeekSlotCoverage(account.cadence, period, currentPosts.map((p) => ({ id: p.postId, at: p.publishedAt })));
  const neverSynced = account.lastPublishedSyncAt === null;
  const cov = account.coverage;
  return {
    accountId: account.id,
    handle: account.handle,
    displayName: account.displayName,
    platform: account.platform,
    cadenceMode: account.cadence.mode,
    isEstimate: week.isEstimate,
    plannedSlots: week.plannedSlots,
    slotsCoveredByPublished: neverSynced ? null : week.covered,
    slotCoveragePct: neverSynced || week.plannedSlots === null || week.covered === null ? null : round((week.covered / week.plannedSlots) * 100, 1),
    missedSlots: neverSynced || week.plannedSlots === null || week.covered === null ? null : week.plannedSlots - week.covered,
    publishedCount: neverSynced ? naCell("never_synced", "posts", 0) : cell(currentPosts.length, "available", null, "posts", currentPosts.length, currentPosts.length),
    offCadencePublished: neverSynced ? null : week.offCadence,
    failedCount: failed.length,
    failedPosts: failed
      .slice()
      .sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0))
      .map((f) => ({ postId: f.postId, dueAt: iso(f.dueAt), message: excerpt(redactText(f.message ?? ""), 200) ?? "", externalUrl: f.externalUrl })),
    status: neverSynced ? "unknown" : week.status,
    atGeneration: {
      at: now.toISOString(),
      coverageState: cov.state,
      freshness: cov.freshness,
      firstUncoveredSlot: iso(cov.firstUncoveredSlot),
      coveredDays: cov.coveredDays === null ? null : round(cov.coveredDays, 1),
      postsNeeded: cov.postsNeeded,
      scheduledCount: cov.scheduledCount,
      overdueCount: account.overdueCount,
      isDisconnected: account.isDisconnected,
      isQueuePaused: account.isQueuePaused,
      connectionStatus: account.connectionStatus,
    },
    cadenceIsDefault: account.cadenceIsDefault,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
function contentLists(input: ReportInput, accountsById: Map<string, ReportInputAccount>): { best: FactContentList; under: FactContentList } {
  const result = rankContent(input.posts, { period: input.period, ...RANKING_PARAMETERS });
  const postsById = new Map(input.posts.map((p) => [p.postId, p]));
  const toItems = (items: typeof result.best) =>
    items.map((it, i) => {
      const post = postsById.get(it.postId);
      const acc = accountsById.get(it.socialAccountId);
      return {
        rank: i + 1,
        postId: it.postId,
        accountId: it.socialAccountId,
        handle: acc?.handle ?? "",
        platform: it.platform,
        format: it.format,
        publishedAt: it.publishedAt.toISOString(),
        externalUrl: post?.externalUrl ?? null,
        textExcerpt: excerpt(post?.title || post?.text),
        score: round(it.score),
        confidence: it.confidence,
        views: it.evidence.value,
        cohortMedianViews: round(it.evidence.cohortMedian),
        cohortSize: it.evidence.cohortSize,
        ageAtObservationHours: round(it.evidence.ageAtObservationHours, 1),
        cohortMedianAgeHours: round(it.evidence.cohortMedianAgeHours, 1),
        metricsUpdatedAt: it.evidence.metricsUpdatedAt,
        secondary: {
          definitionId: it.evidence.secondary.definitionId,
          value: it.evidence.secondary.value === null ? null : round(it.evidence.secondary.value),
          cohortMedian: it.evidence.secondary.cohortMedian === null ? null : round(it.evidence.secondary.cohortMedian),
          ratio: it.evidence.secondary.ratio === null ? null : round(it.evidence.secondary.ratio),
          na: it.evidence.secondary.naReason ? { code: it.evidence.secondary.naReason as ReportNaCode } : null,
          containsZeroUncertainty: it.evidence.secondary.containsZeroUncertainty,
        },
      };
    });
  const counts = new Map<RankingExclusionReason, number>();
  for (const e of result.excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const excluded = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([reason, count]) => ({ reason, count }));
  const scoredCount = result.scored.length;
  return { best: { items: toItems(result.best), scoredCount, excluded }, under: { items: toItems(result.underperforming), scoredCount, excluded } };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------
function trendMetrics(account: ReportInputAccount, accountPosts: PostPerformance[], index: RefreshIndex, period: WeekPeriod, now: Date, ageHours: number): FactTrendMetric[] {
  const weeks = [...rollingWeeks(weekBefore(period), TREND_WEEKS), period];
  const minSample = COMPARISON_PARAMETERS.minMedianSample;
  const perWeek = weeks.map((w) => {
    const posts = accountPosts.filter((p) => inPeriod(p.publishedAt, w));
    const { perfs, exclusions } = ageMatchedPosts(posts, index, ageHours, now);
    return { week: w, posts, perfs, exclusions, complete: isPeriodComplete(w, now) };
  });

  const build = (metricId: FactTrendMetric["metricId"]): FactTrendMetric => {
    const isEr = metricId === "median_engagement_rate";
    const definitionId = isEr ? `median:${erDefinitionId(account.platform)}@age` : "median:views@age:v1";
    const unit: ReportUnit = isEr ? "percent" : "count";
    const cells = perWeek.map((w) =>
      isEr ? engagementMedianCell(w.perfs, account.platform, w.posts.length, exclusionNa(w.exclusions)) : medianCell(w.perfs, "views", w.posts.length, exclusionNa(w.exclusions)),
    );
    const weekValues = perWeek.map((w, i) => {
      const c = cells[i]!;
      return { weekStart: w.week.start, value: c.value !== null && c.postsIncluded >= minSample ? c.value : null, postsIncluded: c.postsIncluded, complete: w.complete };
    });
    const currentRaw = cells[cells.length - 1]!;
    const current: FactCell =
      currentRaw.value !== null && currentRaw.postsIncluded < minSample ? { ...currentRaw, value: null, status: "unavailable", na: { code: "insufficient_sample" } } : currentRaw;
    const base = rollingBaseline(weekValues.slice(0, TREND_WEEKS), TREND_WEEKS, TREND_MIN_WEEKS);
    const baselineMedian = base.median.value;
    let vs: FactTrendMetric["vsBaseline"];
    if (current.status === "unsupported") vs = { absoluteChange: null, percentChange: null, na: { code: "unsupported_by_provider" }, percentNa: null };
    else if (baselineMedian === null) vs = { absoluteChange: null, percentChange: null, na: { code: "insufficient_sample" }, percentNa: null };
    else {
      vs = compareCells(current, cell(baselineMedian, "available", null, unit, minSample, minSample), "count", isPeriodComplete(period, now));
    }
    return {
      metricId,
      definitionId,
      unit,
      ageHours,
      weeks: weekValues,
      current,
      baseline: {
        status: baselineMedian === null ? "insufficient" : "available",
        median: baselineMedian === null ? null : round(baselineMedian),
        mean: base.mean.value === null ? null : round(base.mean.value),
        weeksUsed: base.weeksUsed,
        weeksExcluded: base.weeksExcluded,
        na: base.median.na ? { code: "insufficient_sample" } : null,
      },
      vsBaseline: vs,
    };
  };
  return [build("median_views_per_post"), build("median_engagement_rate")];
}

// ---------------------------------------------------------------------------
// Data quality & preliminary rules
// ---------------------------------------------------------------------------
function dataQualityFor(account: ReportInputAccount, currentPosts: PostPerformance[], windowPosts: PostPerformance[], period: WeekPeriod, comparisonAgeHours: number | null): AccountDataQuality {
  const caps = PLATFORM_METRIC_CAPABILITIES[account.platform];
  const withMetrics = currentPosts.filter((p) => p.metricsUpdatedAt !== null);
  const supported = METRIC_KEYS.filter((k) => caps[k] === "supported");
  const updated = withMetrics.map((p) => p.metricsUpdatedAt!.getTime());
  return {
    accountId: account.id,
    handle: account.handle,
    displayName: account.displayName,
    platform: account.platform,
    lastPublishedSyncAt: iso(account.lastPublishedSyncAt),
    lastQueueSyncAt: iso(account.lastQueueSyncAt),
    queueFreshness: account.coverage.freshness,
    postsInPeriod: currentPosts.length,
    metricsPendingPosts: currentPosts.length - withMetrics.length,
    metricsNotRefreshedAfterPeriodEnd: withMetrics.filter((p) => p.metricsUpdatedAt!.getTime() < period.endUtcExclusive.getTime()).length,
    latestMetricsUpdatedAt: updated.length ? new Date(Math.max(...updated)).toISOString() : null,
    comparisonAgeHours,
    unsupportedMetrics: METRIC_KEYS.filter((k) => caps[k] === "unsupported"),
    notReportedMetrics: supported.filter((k) => withMetrics.length > 0 && withMetrics.every((p) => p.metrics[k]?.status === "not_reported")),
    likelyNotReportedMetrics: supported.filter(
      (k) => METRIC_DEFINITIONS[k].subject === "post" && detectAlwaysZeroSeries(windowPosts, k, ALWAYS_ZERO_MIN_SAMPLE).likelyNotReported,
    ),
    zeroUncertaintyMetrics: supported.filter((k) => withMetrics.some((p) => p.metrics[k]?.status === "reported_zero" && isUsable(p.metrics[k]))),
  };
}

export function preliminaryReasonsFor(input: Pick<ReportInput, "accounts" | "period" | "now">, quality: AccountDataQuality[]): { code: PreliminaryReasonCode; accountId: string | null }[] {
  const reasons: { code: PreliminaryReasonCode; accountId: string | null }[] = [];
  if (!isPeriodComplete(input.period, input.now)) reasons.push({ code: "period_incomplete", accountId: null });
  const cutoff = input.period.endUtcExclusive.getTime() + PUBLISHED_SYNC_GRACE_HOURS * HOUR_MS;
  const qualityById = new Map(quality.map((q) => [q.accountId, q]));
  for (const a of input.accounts) {
    if (a.lastPublishedSyncAt === null) reasons.push({ code: "published_sync_missing", accountId: a.id });
    else if (a.lastPublishedSyncAt.getTime() < cutoff) reasons.push({ code: "published_sync_before_cutoff", accountId: a.id });
    if (a.coverage.freshness === "never_synced") reasons.push({ code: "queue_sync_never", accountId: a.id });
    else if (a.coverage.freshness === "stale") reasons.push({ code: "queue_sync_stale", accountId: a.id });
    const q = qualityById.get(a.id);
    if (q && q.metricsPendingPosts > 0) reasons.push({ code: "post_metrics_pending", accountId: a.id });
    if (q && q.metricsNotRefreshedAfterPeriodEnd > 0) reasons.push({ code: "post_metrics_not_refreshed", accountId: a.id });
  }
  return reasons;
}

export function encodePreliminaryReasons(reasons: { code: PreliminaryReasonCode; accountId: string | null }[]): string[] {
  return reasons.map((r) => (r.accountId ? `${r.code}:${r.accountId}` : r.code));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function computeReportFacts(input: ReportInput): ReportFacts {
  const { period, now } = input;
  const previous = weekBefore(period);
  const locale = resolveReportLocale(input.brand.reportLocale);
  const index = buildRefreshIndex(input.observations, now);
  const accounts = [...input.accounts].sort((a, b) => a.platform.localeCompare(b.platform) || a.handle.localeCompare(b.handle) || a.id.localeCompare(b.id));
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const posts = input.posts.filter((p) => accountsById.has(p.socialAccountId));

  const ref = (a: ReportInputAccount): FactAccountRef => ({ accountId: a.id, handle: a.handle, displayName: a.displayName, platform: a.platform });
  const kpis: ReportFacts["kpis"] = [];
  const consistency: FactConsistency[] = [];
  const trends: ReportFacts["trends"] = [];
  const dataQuality: AccountDataQuality[] = [];
  let postsPublished = 0;
  let postsPublishedPrevious = 0;

  for (const a of accounts) {
    const accountPosts = posts.filter((p) => p.socialAccountId === a.id);
    const current = accountPosts.filter((p) => inPeriod(p.publishedAt, period));
    const prev = accountPosts.filter((p) => inPeriod(p.publishedAt, previous));
    postsPublished += current.length;
    postsPublishedPrevious += prev.length;
    const k = computeAccountKpis(a, current, prev, index, period, now);
    kpis.push({ ...ref(a), comparisonAgeHours: k.comparisonAgeHours, rows: k.rows });
    consistency.push(consistencyFor(a, current, input.failedPosts.filter((f) => f.socialAccountId === a.id), period, now));
    trends.push({ ...ref(a), metrics: trendMetrics(a, accountPosts, index, period, now, k.comparisonAgeHours ?? COMPARISON_PARAMETERS.targetAgeHours) });
    const windowStart = period.endUtcExclusive.getTime() - RANKING_PARAMETERS.baselineWindowDays * 86_400_000;
    dataQuality.push(dataQualityFor(a, current, accountPosts.filter((p) => p.publishedAt.getTime() >= windowStart), period, k.comparisonAgeHours));
  }

  const { best, under } = contentLists({ ...input, posts }, accountsById);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    brand: { id: input.brand.id, name: input.brand.name, timezone: input.brand.timezone, locale, requestedLocale: input.brand.reportLocale },
    period: {
      start: period.start,
      end: period.end,
      startUtc: period.startUtc.toISOString(),
      endUtcExclusive: period.endUtcExclusive.toISOString(),
      previousStart: previous.start,
      previousEnd: previous.end,
      complete: isPeriodComplete(period, now),
    },
    observationCutoff: now.toISOString(),
    parameters: { comparison: COMPARISON_PARAMETERS, ranking: RANKING_PARAMETERS, trendWeeks: TREND_WEEKS, trendMinWeeks: TREND_MIN_WEEKS },
    totals: { accounts: accounts.length, postsPublished, postsPublishedPrevious, failedPosts: input.failedPosts.filter((f) => accountsById.has(f.socialAccountId)).length },
    kpis,
    consistency,
    bestContent: best,
    underperformingContent: under,
    trends,
    dataQuality,
    preliminaryReasons: preliminaryReasonsFor({ accounts, period, now }, dataQuality),
    hasTaggedPosts: posts.some((p) => p.tags.length > 0),
    brandHasContentPillars: input.brand.contentPillars.length > 0,
  };
}
