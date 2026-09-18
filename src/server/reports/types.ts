/**
 * Weekly report document contract (schemaVersion 1) rendered by the in-app viewer, the PDF and the CSV export,
 * plus the language-neutral data snapshot (`ReportFacts`) every version stores as `dataSnapshot`.
 *
 * Rules the renderer can rely on
 * - Numbers are plain numbers (never pre-formatted strings) and always come with a status. `value: null` is NEVER a
 *   zero: read `status` + `na` ("Indisponível" / "Não suportado" / "Pendente") instead.
 * - Every human-readable string (narratives, labels, NA messages, explanations) is already in the brand report
 *   locale (`locale`). UI chrome stays English and is not part of this document.
 * - Post captions/titles (`textExcerpt`) are UNTRUSTED user content: render as plain text only.
 * - Percent metrics are on a 0–100 scale; `absoluteChange` of a percent metric is in percentage points.
 * See docs/REPORTS_AND_INSIGHTS.md for the methodology behind every field.
 */
import type { CoverageState, Platform } from "@/domain/types";

export const REPORT_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_REPORT_LOCALES = ["pt-BR", "en-US", "es-ES"] as const;
export type ReportLocale = (typeof SUPPORTED_REPORT_LOCALES)[number];

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------
export type ReportNaCode =
  | "numerator_unavailable"
  | "denominator_unavailable"
  | "denominator_zero"
  | "starting_audience_not_positive"
  | "insufficient_sample"
  | "incompatible_definitions"
  /** Metric cannot be summed across posts (reach, rates, averages). */
  | "not_summable"
  | "partial_period"
  | "unsupported_by_provider"
  | "no_data"
  /** No post was published in the period. */
  | "no_posts"
  /** Buffer has not ingested metrics for the posts yet. */
  | "metrics_pending"
  /** Supported metric absent from the provider response. */
  | "not_reported"
  /** Published posts never synchronized (no successful published sync). */
  | "never_synced"
  /** Some posts lack a usable value, so a sum would be a lower bound and is not compared. */
  | "incomplete_sample"
  /** Current-week posts are too young (< minimum comparison age) for a fair week-over-week comparison. */
  | "insufficient_post_age"
  /** No observation close enough to the comparison age exists in the metric history. */
  | "no_comparable_observation"
  /** Follower/subscriber counts are not provided by Buffer. */
  | "requires_direct_connection";

export interface ReportNA {
  code: ReportNaCode;
  /** Localized explanation. */
  message: string;
}

/** available = complete · partial = some posts excluded (lower bound for sums) · the rest carry `na`. */
export type CellStatus = "available" | "partial" | "unavailable" | "unsupported" | "pending";

export type ReportUnit = "count" | "people" | "percent" | "seconds" | "minutes" | "posts" | "ratio" | "hours" | "days";

export interface MetricCell {
  value: number | null;
  status: CellStatus;
  na: ReportNA | null;
  unit: ReportUnit;
  /** Distinct posts that contributed a usable value. */
  postsIncluded: number;
  /** Distinct posts in scope (published in the period). */
  postsTotal: number;
  /** At least one contributing value was a provider `0` (possibly a default for "not reported"). */
  containsZeroUncertainty: boolean;
}

export type KpiMetricId =
  | "posts_published"
  | "views"
  | "reactions"
  | "comments"
  | "shares"
  | "saves"
  | "total_watch_time"
  | "reach_median"
  | "engagement_rate_median"
  | "provider_engagement_rate_median"
  | "avg_watch_time_median";

export type KpiAggregation = "count" | "sum_distinct_posts" | "median_per_post";

// ---------------------------------------------------------------------------
// Section 2 — KPI table
// ---------------------------------------------------------------------------
export interface KpiRow {
  metricId: KpiMetricId;
  /** Stable formula id (e.g. `sum:views:v1`, `median:er_reach:instagram:v1`). Rows with different ids are never compared. */
  definitionId: string;
  label: string;
  aggregation: KpiAggregation;
  unit: ReportUnit;
  /** e.g. `buffer:post_metrics` or `brandpulse:posts`. */
  source: string;
  /** Lifetime-to-date value of posts published in the week, as of each post's last provider refresh. */
  latest: MetricCell & { observedAtMin: string | null; observedAtMax: string | null };
  /**
   * Week-over-week comparison at equal post age: for both weeks each post contributes the observation closest to
   * (not after) `ageHours`. `current`/`previous` are those age-matched values (not the `latest` value).
   */
  comparison: {
    basis: "age_matched" | "count";
    ageHours: number | null;
    current: MetricCell;
    previous: MetricCell;
    absoluteChange: number | null;
    percentChange: number | null;
    /** Why no change is shown (null when absoluteChange is present). */
    na: ReportNA | null;
    /** Why the percent change alone is missing (e.g. previous value 0). */
    percentNa: ReportNA | null;
  };
  status: CellStatus;
}

export interface AccountRef {
  accountId: string;
  handle: string;
  displayName: string | null;
  platform: Platform;
}

export interface AccountKpis extends AccountRef {
  rows: KpiRow[];
}

// ---------------------------------------------------------------------------
// Section 3 — publication consistency & scheduling health
// ---------------------------------------------------------------------------
export type CadenceMode = "provider_schedule" | "custom" | "irregular" | "paused";

export interface FailedPostRef {
  postId: string;
  dueAt: string | null;
  /** Provider error text, redacted and truncated. UNTRUSTED. */
  message: string;
  externalUrl: string | null;
}

export interface AccountConsistency extends AccountRef {
  cadenceMode: CadenceMode;
  /** True when the cadence is irregular (virtual slots) — planned slots are an estimate. */
  isEstimate: boolean;
  /** Expected slots in the week from the CURRENT cadence configuration; null when paused or without cadence. */
  plannedSlots: number | null;
  slotsCoveredByPublished: number | null;
  slotCoveragePct: number | null;
  publishedCount: MetricCell;
  /** Published posts that matched no planned slot. */
  offCadencePublished: number | null;
  failedCount: number;
  failedPosts: FailedPostRef[];
  status: "on_track" | "below_plan" | "no_cadence" | "paused" | "unknown";
  /** Queue health at report generation time (not at period end). */
  atGeneration: {
    at: string;
    coverageState: CoverageState;
    freshness: "fresh" | "stale" | "never_synced";
    firstUncoveredSlot: string | null;
    coveredDays: number | null;
    postsNeeded: number;
    scheduledCount: number;
    overdueCount: number;
    isDisconnected: boolean;
    isQueuePaused: boolean;
    connectionStatus: string;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Sections 4 & 5 — ranked content
// ---------------------------------------------------------------------------
export interface RankedContentItem {
  rank: number;
  postId: string;
  accountId: string;
  handle: string;
  platform: Platform;
  format: string | null;
  publishedAt: string;
  externalUrl: string | null;
  /** Caption/title excerpt (≤ 280 chars). UNTRUSTED user content. */
  textExcerpt: string | null;
  /** views ÷ cohort median views. */
  score: number;
  confidence: "high" | "medium" | "low";
  views: number;
  cohortMedianViews: number;
  cohortSize: number;
  ageAtObservationHours: number;
  cohortMedianAgeHours: number;
  metricsUpdatedAt: string;
  secondary: {
    definitionId: string;
    value: number | null;
    cohortMedian: number | null;
    ratio: number | null;
    na: ReportNA | null;
    containsZeroUncertainty: boolean;
  };
  explanation: string;
}

export interface ContentSection {
  narrative: string;
  /** How the list was ranked (always shown inline). */
  method: string;
  fairnessNote: string;
  items: RankedContentItem[];
  excluded: { reason: string; label: string; count: number }[];
  /** Why the list is empty (null when it has items). */
  emptyReason: string | null;
}

// ---------------------------------------------------------------------------
// Section 6 — audience & engagement trends
// ---------------------------------------------------------------------------
export interface TrendWeek {
  weekStart: string;
  value: number | null;
  postsIncluded: number;
  complete: boolean;
}

export interface TrendMetric {
  metricId: "median_views_per_post" | "median_engagement_rate";
  definitionId: string;
  label: string;
  unit: ReportUnit;
  /** Post age at which every week's posts were observed. */
  ageHours: number;
  /** Four prior weeks (oldest first) followed by the report week. */
  weeks: TrendWeek[];
  current: MetricCell;
  baseline: {
    status: "available" | "insufficient";
    median: number | null;
    mean: number | null;
    weeksUsed: string[];
    weeksExcluded: { weekStart: string; reason: string }[];
    na: ReportNA | null;
  };
  vsBaseline: { absoluteChange: number | null; percentChange: number | null; na: ReportNA | null; percentNa: ReportNA | null };
}

export interface AccountTrends extends AccountRef {
  metrics: TrendMetric[];
}

// ---------------------------------------------------------------------------
// Sections 7–9
// ---------------------------------------------------------------------------
export interface ReportInsightItem {
  /** Stable machine code, e.g. `views_up:<accountId>`. */
  id: string;
  text: string;
  accountId: string | null;
  evidence: { metricId?: string; postIds?: string[]; values?: Record<string, number | string | null> };
}

export type ReportActionKind =
  | "reconnect_account"
  | "fix_publish_failures"
  | "replenish_queue"
  | "restore_cadence"
  | "repeat_top_format"
  | "review_underperforming"
  | "resolve_sync"
  | "wait_for_metrics"
  | "tag_content_pillars"
  | "maintain_cadence"
  | "track_success_metrics";

export interface ReportAction {
  rank: number;
  priority: "high" | "medium" | "low";
  kind: ReportActionKind;
  accountId: string | null;
  title: string;
  description: string;
  successMetric: string;
  evaluationWindowDays: number;
  /** Active recommendation with the same dedupe key, when one exists at generation time. */
  relatedRecommendationId: string | null;
}

// ---------------------------------------------------------------------------
// Section 10 — data quality
// ---------------------------------------------------------------------------
export type PreliminaryReasonCode =
  | "period_incomplete"
  | "published_sync_missing"
  | "published_sync_before_cutoff"
  | "queue_sync_stale"
  | "queue_sync_never"
  | "post_metrics_pending"
  | "post_metrics_not_refreshed";

export interface AccountDataQuality extends AccountRef {
  lastPublishedSyncAt: string | null;
  lastQueueSyncAt: string | null;
  queueFreshness: "fresh" | "stale" | "never_synced";
  postsInPeriod: number;
  metricsPendingPosts: number;
  metricsNotRefreshedAfterPeriodEnd: number;
  latestMetricsUpdatedAt: string | null;
  /** Comparison age used for this account's week-over-week comparison (null = not comparable). */
  comparisonAgeHours: number | null;
  unsupportedMetrics: string[];
  notReportedMetrics: string[];
  likelyNotReportedMetrics: string[];
  zeroUncertaintyMetrics: string[];
}

export interface ReportLabels {
  reportTitle: string;
  periodLabel: string;
  generatedAtLabel: string;
  preliminaryBanner: string;
  finalBadge: string;
  preliminaryBadge: string;
  sections: {
    executiveSummary: string;
    kpiTable: string;
    publicationConsistency: string;
    bestContent: string;
    underperformingContent: string;
    audienceAndEngagementTrends: string;
    wentWell: string;
    needsImprovement: string;
    actions: string;
    dataQuality: string;
  };
  columns: {
    account: string;
    platform: string;
    metric: string;
    latest: string;
    current: string;
    previous: string;
    change: string;
    status: string;
    definition: string;
    plannedSlots: string;
    published: string;
    failed: string;
    coverageNow: string;
    score: string;
    views: string;
    cohortMedian: string;
    confidence: string;
    baseline: string;
    priority: string;
    successMetric: string;
    evaluationWindow: string;
    lastSync: string;
    link: string;
  };
  statuses: Record<CellStatus, string>;
  priorities: Record<"high" | "medium" | "low", string>;
  confidences: Record<"high" | "medium" | "low", string>;
  platforms: Record<Platform, string>;
  coverageStates: Record<CoverageState, string>;
  audienceUnavailable: string;
  days: string;
  hours: string;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
export interface WeeklyReportContent {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  locale: ReportLocale;
  timezone: string;
  brand: { id: string; name: string };
  period: {
    /** "week" (Monday–Sunday) or "month" (calendar month). Absent in reports generated before monthly support. */
    kind?: "week" | "month";
    /** Local first / last day (inclusive) YYYY-MM-DD in `timezone`. */
    start: string;
    end: string;
    startUtc: string;
    endUtcExclusive: string;
    previousStart: string;
    previousEnd: string;
    complete: boolean;
  };
  generatedAt: string;
  status: "final" | "preliminary";
  narrativeSource: "ai" | "deterministic";
  narrativeMeta: { source: "ai" | "deterministic"; model: string | null; fallbackReason: string | null };
  labels: ReportLabels;

  /** 1 */
  executiveSummary: { narrative: string; highlights: string[] };
  /** 2 */
  kpiTable: { narrative: string; comparisonNote: string; accounts: AccountKpis[] };
  /** 3 */
  publicationConsistency: { narrative: string; accounts: AccountConsistency[] };
  /** 4 */
  bestContent: ContentSection;
  /** 5 */
  underperformingContent: ContentSection;
  /** 6 */
  audienceAndEngagementTrends: {
    narrative: string;
    audience: {
      status: "unsupported";
      message: string;
      accounts: (AccountRef & { followers: MetricCell })[];
    };
    engagement: AccountTrends[];
  };
  /** 7 */
  wentWell: { narrative: string; items: ReportInsightItem[] };
  /** 8 */
  needsImprovement: { narrative: string; items: ReportInsightItem[] };
  /** 9 — 3 to 5 prioritized actions. */
  actions: { narrative: string; items: ReportAction[] };
  /** 10 — always present. */
  dataQuality: {
    narrative: string;
    generatedAt: string;
    observationCutoff: string;
    isPreliminary: boolean;
    preliminaryReasons: { code: PreliminaryReasonCode; accountId: string | null; message: string }[];
    comparisonMethod: string;
    accounts: AccountDataQuality[];
    missingDataStatement: string;
    limitations: string[];
  };
}

// ---------------------------------------------------------------------------
// Data snapshot (language-neutral facts; stored as report_versions.data_snapshot)
// ---------------------------------------------------------------------------
export interface FactNA {
  code: ReportNaCode;
}

export interface FactCell {
  value: number | null;
  status: CellStatus;
  na: FactNA | null;
  unit: ReportUnit;
  postsIncluded: number;
  postsTotal: number;
  containsZeroUncertainty: boolean;
}

export interface FactKpiRow {
  metricId: KpiMetricId;
  definitionId: string;
  aggregation: KpiAggregation;
  unit: ReportUnit;
  source: string;
  latest: FactCell & { observedAtMin: string | null; observedAtMax: string | null };
  comparison: {
    basis: "age_matched" | "count";
    ageHours: number | null;
    ageDays: number | null;
    current: FactCell;
    previous: FactCell;
    absoluteChange: number | null;
    percentChange: number | null;
    na: FactNA | null;
    percentNa: FactNA | null;
  };
  status: CellStatus;
}

export interface FactAccountRef {
  accountId: string;
  handle: string;
  displayName: string | null;
  platform: Platform;
}

export interface FactConsistency extends FactAccountRef {
  cadenceMode: CadenceMode;
  isEstimate: boolean;
  plannedSlots: number | null;
  slotsCoveredByPublished: number | null;
  slotCoveragePct: number | null;
  missedSlots: number | null;
  publishedCount: FactCell;
  offCadencePublished: number | null;
  failedCount: number;
  failedPosts: FailedPostRef[];
  status: AccountConsistency["status"];
  atGeneration: AccountConsistency["atGeneration"];
  cadenceIsDefault: boolean;
}

export interface FactRankedItem extends Omit<RankedContentItem, "secondary" | "explanation"> {
  secondary: Omit<RankedContentItem["secondary"], "na"> & { na: FactNA | null };
}

export interface FactContentList {
  items: FactRankedItem[];
  /** Candidates that received a score (in either list or neither). */
  scoredCount: number;
  excluded: { reason: string; count: number }[];
}

export interface FactTrendMetric extends Omit<TrendMetric, "label" | "current" | "baseline" | "vsBaseline"> {
  current: FactCell;
  baseline: Omit<TrendMetric["baseline"], "na"> & { na: FactNA | null };
  vsBaseline: { absoluteChange: number | null; percentChange: number | null; na: FactNA | null; percentNa: FactNA | null };
}

export interface RankingParameters {
  minObservationAgeHours: number;
  minCohortSize: number;
  baselineWindowDays: number;
  bestMinRatio: number;
  underperformingMaxRatio: number;
  limit: number;
}

export interface ComparisonParameters {
  targetAgeHours: number;
  minComparisonAgeHours: number;
  maxToleranceHours: number;
  minMedianSample: number;
}

export interface ReportFacts {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  brand: { id: string; name: string; timezone: string; locale: ReportLocale; requestedLocale: string };
  period: WeeklyReportContent["period"];
  /** Observations retrieved after this instant are ignored (equals generation time). */
  observationCutoff: string;
  parameters: { comparison: ComparisonParameters; ranking: RankingParameters; trendWeeks: number; trendMinWeeks: number };
  totals: { accounts: number; postsPublished: number; postsPublishedPrevious: number; failedPosts: number };
  kpis: (FactAccountRef & { comparisonAgeHours: number | null; rows: FactKpiRow[] })[];
  consistency: FactConsistency[];
  bestContent: FactContentList;
  underperformingContent: FactContentList;
  trends: (FactAccountRef & { metrics: FactTrendMetric[] })[];
  dataQuality: AccountDataQuality[];
  preliminaryReasons: { code: PreliminaryReasonCode; accountId: string | null }[];
  hasTaggedPosts: boolean;
  brandHasContentPillars: boolean;
}
