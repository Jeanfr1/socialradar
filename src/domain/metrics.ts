/**
 * Canonical metric semantics and deterministic calculations. Human-readable dictionary:
 * docs/METRIC_DICTIONARY.md (keep both in sync).
 *
 * Core rules
 * - Missing is never zero. Every value carries a status: reported | reported_zero | not_reported | pending | unsupported.
 *   Only `reported` and `reported_zero` are usable in calculations; `reported_zero` is surfaced with a
 *   `containsZeroUncertainty` flag because Buffer defaults unreported metrics to 0.
 * - Buffer post metrics are LIFETIME CUMULATIVE per post, refreshed ~once a day. Summing two observations
 *   of the same post double counts; aggregates use only the latest observation per distinct post.
 * - Reach (unique people per post) and every rate/average are not summable across posts.
 *
 * "Performance earned during a week" vs "lifetime performance of posts published that week"
 * - Earned during a week = the increase of every post's counters between two snapshots taken at the week
 *   boundaries. Buffer only exposes the current lifetime counter per post, so this requires consistent daily
 *   snapshots of ALL posts (including older ones still accruing views). BrandPulse does not report it.
 * - Lifetime performance of posts published that week = the latest lifetime counters of the posts whose
 *   publishedAt falls inside the week, labeled "as of <metricsUpdatedAt>". This is what BrandPulse reports.
 *   Young posts are still accruing: always show observation time / post age (`postAgeAtObservationHours`)
 *   and prefer comparisons between posts observed at comparable ages (see ranking.ts).
 */
import type { Computed, MetricKey, MetricValue, NAReason, Platform, PostPerformance, ValueStatus } from "./types";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------
export type MetricUnit = "count" | "people" | "percent" | "seconds" | "minutes";
export type MetricSemantics = "lifetime_cumulative" | "point_in_time" | "period_activity";

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  description: string;
  unit: MetricUnit;
  semantics: MetricSemantics;
  subject: "post" | "account";
  /** Whether summing the metric across DISTINCT posts yields a meaningful total. */
  summableAcrossPosts: boolean;
  summabilityNote: string;
  /** Provider metric types mapping to this key (Buffer PostMetric.type). */
  providerTypes: string[];
  sourceNotes: string;
}

export const METRIC_KEYS: readonly MetricKey[] = [
  "reactions",
  "comments",
  "shares",
  "saves",
  "views",
  "reach",
  "impressions",
  "clicks",
  "follows",
  "provider_engagement_rate",
  "avg_watch_time_seconds",
  "total_watch_time_minutes",
  "followers",
];

const LIFETIME_NOTE = "Lifetime cumulative per post as of Buffer metricsUpdatedAt (refreshed about once a day).";

export const METRIC_DEFINITIONS: Readonly<Record<MetricKey, MetricDefinition>> = {
  reactions: {
    key: "reactions",
    label: "Reactions",
    description: "Likes/reactions on the post.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Events: summable across distinct posts (latest observation per post only).",
    providerTypes: ["reactions"],
    sourceNotes: `${LIFETIME_NOTE} Instagram, TikTok, YouTube.`,
  },
  comments: {
    key: "comments",
    label: "Comments",
    description: "Comments on the post.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Events: summable across distinct posts.",
    providerTypes: ["comments"],
    sourceNotes: `${LIFETIME_NOTE} Instagram, TikTok, YouTube.`,
  },
  shares: {
    key: "shares",
    label: "Shares",
    description: "Times the post was shared.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Events: summable across distinct posts.",
    providerTypes: ["shares"],
    sourceNotes: `${LIFETIME_NOTE} Instagram, TikTok. Not available for YouTube via Buffer.`,
  },
  saves: {
    key: "saves",
    label: "Saves",
    description: "Times the post was saved/bookmarked.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Events: summable across distinct posts.",
    providerTypes: ["saves"],
    sourceNotes: `${LIFETIME_NOTE} Instagram only via Buffer.`,
  },
  views: {
    key: "views",
    label: "Views",
    description: "Plays/views of the post as counted by the platform (not unique people).",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Plays: summable across distinct posts; the total is plays, never people.",
    providerTypes: ["views"],
    sourceNotes: `${LIFETIME_NOTE} Instagram, TikTok, YouTube. Primary cross-platform comparison metric within a cohort; each platform counts a view differently.`,
  },
  reach: {
    key: "reach",
    label: "Reach",
    description: "Unique accounts that saw the post.",
    unit: "people",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: false,
    summabilityNote:
      "Unique people per post: the same person can be reached by many posts, so reach cannot be summed or deduplicated across posts, accounts or platforms. Use median reach per post.",
    providerTypes: ["reach"],
    sourceNotes: `${LIFETIME_NOTE} Instagram, TikTok. Not available for YouTube via Buffer.`,
  },
  impressions: {
    key: "impressions",
    label: "Impressions",
    description: "Times the post was displayed.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Displays: summable across distinct posts.",
    providerTypes: ["impressions"],
    sourceNotes: `${LIFETIME_NOTE} Not observed for Instagram, TikTok or YouTube via Buffer.`,
  },
  clicks: {
    key: "clicks",
    label: "Clicks",
    description: "Link clicks on the post.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Events: summable across distinct posts.",
    providerTypes: ["clicks"],
    sourceNotes: `${LIFETIME_NOTE} Not observed for Instagram, TikTok or YouTube via Buffer.`,
  },
  follows: {
    key: "follows",
    label: "Follows from post",
    description: "Accounts that followed from this post.",
    unit: "count",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Events: summable across distinct posts, but see the always-zero caveat.",
    providerTypes: ["follows"],
    sourceNotes: `${LIFETIME_NOTE} Instagram only. Observed as 0 on 100% of sampled posts: treat an always-zero series as likely not reported (detectAlwaysZeroSeries).`,
  },
  provider_engagement_rate: {
    key: "provider_engagement_rate",
    label: "Engagement rate (provider)",
    description: "Engagement rate as computed by Buffer/the network. Formula undocumented; never compared with BrandPulse-computed rates.",
    unit: "percent",
    semantics: "point_in_time",
    subject: "post",
    summableAcrossPosts: false,
    summabilityNote: "Rate: not summable; not averageable without the undisclosed denominators. Use median per post.",
    providerTypes: ["engagementRate"],
    sourceNotes: "Percentage as reported by Buffer for Instagram, TikTok, YouTube. Formula undocumented.",
  },
  avg_watch_time_seconds: {
    key: "avg_watch_time_seconds",
    label: "Average watch time",
    description: "Average time viewers watched the video.",
    unit: "seconds",
    semantics: "point_in_time",
    subject: "post",
    summableAcrossPosts: false,
    summabilityNote: "Average: not summable; averaging averages ignores view counts. Use median per post.",
    providerTypes: ["averageTimeWatched"],
    sourceNotes: "Seconds. TikTok; sometimes Instagram. Not available for YouTube via Buffer.",
  },
  total_watch_time_minutes: {
    key: "total_watch_time_minutes",
    label: "Total watch time",
    description: "Total time all viewers spent watching the video.",
    unit: "minutes",
    semantics: "lifetime_cumulative",
    subject: "post",
    summableAcrossPosts: true,
    summabilityNote: "Duration: summable across distinct posts.",
    providerTypes: ["totalTimeWatched"],
    sourceNotes: `${LIFETIME_NOTE} Minutes. TikTok; sometimes Instagram. Not available for YouTube via Buffer.`,
  },
  followers: {
    key: "followers",
    label: "Followers",
    description: "Audience size of the account at a point in time.",
    unit: "people",
    semantics: "point_in_time",
    subject: "account",
    summableAcrossPosts: false,
    summabilityNote: "Account-level snapshot; audiences overlap across accounts/platforms, so totals are not unique people.",
    providerTypes: [],
    sourceNotes: "Not provided by Buffer for any platform. Requires a direct platform connection.",
  },
};

/** Buffer PostMetric.type → canonical key. */
export const PROVIDER_METRIC_TYPE_MAP: Readonly<Record<string, MetricKey>> = {
  reactions: "reactions",
  comments: "comments",
  shares: "shares",
  saves: "saves",
  views: "views",
  reach: "reach",
  impressions: "impressions",
  clicks: "clicks",
  follows: "follows",
  engagementRate: "provider_engagement_rate",
  averageTimeWatched: "avg_watch_time_seconds",
  totalTimeWatched: "total_watch_time_minutes",
};

export function canonicalMetricKey(providerType: string): MetricKey | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_METRIC_TYPE_MAP, providerType)
    ? (PROVIDER_METRIC_TYPE_MAP[providerType] as MetricKey)
    : null;
}

/**
 * Availability via Buffer, from live observation (2026-09-13). "unsupported" = never observed for that platform:
 * an ABSENT metric is then labeled unsupported instead of not_reported. A metric PRESENT in the provider list is
 * always trusted (Buffer: metrics absent from the list are the unsupported ones).
 */
export type MetricCapability = "supported" | "unsupported";

function capabilities(supported: MetricKey[]): Record<MetricKey, MetricCapability> {
  const out = {} as Record<MetricKey, MetricCapability>;
  for (const key of METRIC_KEYS) out[key] = supported.includes(key) ? "supported" : "unsupported";
  return out;
}

export const PLATFORM_METRIC_CAPABILITIES: Readonly<Record<Platform, Record<MetricKey, MetricCapability>>> = {
  instagram: capabilities([
    "reactions",
    "comments",
    "shares",
    "saves",
    "views",
    "reach",
    "follows",
    "provider_engagement_rate",
    "avg_watch_time_seconds",
    "total_watch_time_minutes",
  ]),
  tiktok: capabilities([
    "reactions",
    "comments",
    "shares",
    "views",
    "reach",
    "provider_engagement_rate",
    "avg_watch_time_seconds",
    "total_watch_time_minutes",
  ]),
  youtube: capabilities(["reactions", "comments", "views", "provider_engagement_rate"]),
  other: capabilities(METRIC_KEYS.filter((k) => k !== "followers")),
};

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------
export function ok(value: number): Computed {
  return { value, na: null };
}

export function na(code: NAReason["code"], message: string): Computed {
  return { value: null, na: { code, message } };
}

export type UsableMetricValue = MetricValue & { value: number; status: "reported" | "reported_zero" };

/** Usable in calculations: reported or reported_zero with a finite value. */
export function isUsable(v: MetricValue | undefined | null): v is UsableMetricValue {
  return !!v && (v.status === "reported" || v.status === "reported_zero") && typeof v.value === "number" && Number.isFinite(v.value);
}

function statusOf(v: MetricValue | undefined): ValueStatus | "missing" {
  return v ? v.status : "missing";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
export interface RawProviderMetric {
  type: string;
  unit: string;
  value: number;
}

/**
 * Classifies a provider metric list into one MetricValue per canonical key.
 * Order: absent & unsupported-on-platform → unsupported; metricsUpdatedAt null → pending (pre-ingestion zeros are
 * defaults, not data); absent → not_reported; non-finite → not_reported; 0 → reported_zero; else reported.
 * Unknown provider types are ignored; for duplicate types the first occurrence wins.
 */
export function classifyProviderMetrics(
  raw: RawProviderMetric[] | null,
  ctx: { metricsUpdatedAt: Date | null; platform: Platform },
): Record<MetricKey, MetricValue> {
  const byKey = new Map<MetricKey, RawProviderMetric>();
  for (const m of raw ?? []) {
    const key = canonicalMetricKey(m.type);
    if (key && !byKey.has(key)) byKey.set(key, m);
  }
  const caps = PLATFORM_METRIC_CAPABILITIES[ctx.platform];
  const out = {} as Record<MetricKey, MetricValue>;
  for (const key of METRIC_KEYS) {
    const entry = byKey.get(key);
    let mv: MetricValue;
    if (!entry && caps[key] === "unsupported") mv = { key, value: null, status: "unsupported" };
    else if (ctx.metricsUpdatedAt === null) mv = { key, value: null, status: "pending" };
    else if (!entry || typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      mv = { key, value: null, status: "not_reported" };
    } else if (entry.value === 0) mv = { key, value: 0, status: "reported_zero" };
    else mv = { key, value: entry.value, status: "reported" };
    out[key] = mv;
  }
  return out;
}

export interface AlwaysZeroSeriesInfo {
  key: MetricKey;
  /** Distinct posts with a usable value (reported or reported_zero). */
  sampleSize: number;
  zeroCount: number;
  nonZeroCount: number;
  insufficientSample: boolean;
  /** True when every post in a sample >= minSample reported exactly 0. Values are NOT rewritten. */
  likelyNotReported: boolean;
  message: string;
}

/**
 * Flags metrics that are reported_zero on every post of a sufficiently large sample (e.g. Instagram `follows`),
 * which almost certainly means "not reported" rather than "zero". Run it per account + platform.
 */
export function detectAlwaysZeroSeries(posts: PostPerformance[], key: MetricKey, minSample: number): AlwaysZeroSeriesInfo {
  let zeroCount = 0;
  let nonZeroCount = 0;
  const seen = new Set<string>();
  for (const p of latestPerPost(posts).kept) {
    if (seen.has(p.postId)) continue;
    seen.add(p.postId);
    const mv = p.metrics[key];
    if (!isUsable(mv)) continue;
    if (mv.value === 0) zeroCount++;
    else nonZeroCount++;
  }
  const sampleSize = zeroCount + nonZeroCount;
  const insufficientSample = sampleSize < minSample;
  const likelyNotReported = !insufficientSample && sampleSize > 0 && nonZeroCount === 0;
  const label = METRIC_DEFINITIONS[key].label;
  const message = likelyNotReported
    ? `${label} was 0 on all ${sampleSize} posts; the platform most likely does not report it. Show as "likely not reported", not as zero.`
    : insufficientSample
      ? `Only ${sampleSize} posts with a value for ${label}; at least ${minSample} are needed to judge an always-zero series.`
      : `${label} has non-zero values on ${nonZeroCount} of ${sampleSize} posts.`;
  return { key, sampleSize, zeroCount, nonZeroCount, insufficientSample, likelyNotReported, message };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------
/** Interactions counted in BrandPulse engagement rates, per platform (only metrics Buffer provides for it). */
export const INTERACTION_COMPONENTS: Readonly<Record<Platform, readonly MetricKey[] | null>> = {
  instagram: ["reactions", "comments", "shares", "saves"],
  tiktok: ["reactions", "comments", "shares"],
  youtube: ["reactions", "comments"],
  other: null,
};

export interface RateResult {
  result: Computed;
  /** Stable identifier of the exact formula; values with different ids are never compared. */
  definitionId: string;
  components: MetricKey[];
  /** True when at least one usable input was reported_zero (possibly a provider default). */
  containsZeroUncertainty: boolean;
}

type MetricsRecord = Partial<Record<MetricKey, MetricValue>>;

export function sumInteractions(
  metrics: MetricsRecord,
  platform: Platform,
): { result: Computed; components: MetricKey[]; containsZeroUncertainty: boolean } {
  const components = INTERACTION_COMPONENTS[platform];
  if (!components) {
    return { result: na("unsupported_by_provider", `No interaction definition for platform "${platform}".`), components: [], containsZeroUncertainty: false };
  }
  const unusable = components.filter((k) => !isUsable(metrics[k]));
  const containsZeroUncertainty = components.some((k) => metrics[k]?.status === "reported_zero");
  if (unusable.length > 0) {
    const detail = unusable.map((k) => `${k}: ${statusOf(metrics[k])}`).join(", ");
    return { result: na("numerator_unavailable", `Interaction components unavailable (${detail}).`), components: [...components], containsZeroUncertainty };
  }
  const total = components.reduce((acc, k) => acc + (metrics[k] as UsableMetricValue).value, 0);
  return { result: ok(total), components: [...components], containsZeroUncertainty };
}

function engagementRate(metrics: MetricsRecord, platform: Platform, denominator: "reach" | "views"): RateResult {
  const prefix = denominator === "reach" ? "er_reach" : "er_views";
  const definitionId = `${prefix}:${platform}:v1`;
  const interactions = sumInteractions(metrics, platform);
  const base = { definitionId, components: interactions.components, containsZeroUncertainty: interactions.containsZeroUncertainty };
  if (!INTERACTION_COMPONENTS[platform]) return { ...base, result: interactions.result };

  const d = metrics[denominator];
  if (!isUsable(d)) {
    const status = statusOf(d);
    const unsupported = status === "unsupported" || (status === "missing" && PLATFORM_METRIC_CAPABILITIES[platform][denominator] === "unsupported");
    return {
      ...base,
      result: unsupported
        ? na("unsupported_by_provider", `${METRIC_DEFINITIONS[denominator].label} is not available for ${platform} via the provider.`)
        : na("denominator_unavailable", `${METRIC_DEFINITIONS[denominator].label} is ${status}.`),
    };
  }
  if (interactions.result.na) return { ...base, result: interactions.result };
  if (d.value === 0) {
    return { ...base, result: na("denominator_zero", `${METRIC_DEFINITIONS[denominator].label} is 0 (possibly not reported); rate undefined.`) };
  }
  return { ...base, result: ok(((interactions.result.value as number) / d.value) * 100) };
}

/** (platform interactions ÷ reach) × 100, in percent. Definition id `er_reach:<platform>:v1`. */
export function engagementRateByReach(metrics: MetricsRecord, platform: Platform): RateResult {
  return engagementRate(metrics, platform, "reach");
}

/** (platform interactions ÷ views) × 100, in percent. Definition id `er_views:<platform>:v1`. */
export function engagementRateByViews(metrics: MetricsRecord, platform: Platform): RateResult {
  return engagementRate(metrics, platform, "views");
}

/** Headline engagement rate per platform: Instagram by reach; TikTok and YouTube by views. */
export function primaryEngagementRate(metrics: MetricsRecord, platform: Platform): RateResult {
  if (platform === "instagram") return engagementRateByReach(metrics, platform);
  if (platform === "tiktok" || platform === "youtube") return engagementRateByViews(metrics, platform);
  return {
    result: na("unsupported_by_provider", `No engagement rate definition for platform "${platform}".`),
    definitionId: `er:${platform}:v1`,
    components: [],
    containsZeroUncertainty: false,
  };
}

/** (clicks ÷ impressions) × 100, in percent. Definition id `ctr:v1`. */
export function clickThroughRate(clicks: MetricValue | undefined, impressions: MetricValue | undefined): RateResult {
  const base = { definitionId: "ctr:v1", components: ["clicks"] as MetricKey[], containsZeroUncertainty: clicks?.status === "reported_zero" };
  if (!isUsable(impressions)) {
    return {
      ...base,
      result:
        impressions?.status === "unsupported"
          ? na("unsupported_by_provider", "Impressions are not available for this platform via the provider.")
          : na("denominator_unavailable", `Impressions are ${statusOf(impressions)}.`),
    };
  }
  if (!isUsable(clicks)) {
    return {
      ...base,
      result:
        clicks?.status === "unsupported"
          ? na("unsupported_by_provider", "Clicks are not available for this platform via the provider.")
          : na("numerator_unavailable", `Clicks are ${statusOf(clicks)}.`),
    };
  }
  if (impressions.value === 0) return { ...base, result: na("denominator_zero", "Impressions are 0; click-through rate undefined.") };
  return { ...base, result: ok((clicks.value / impressions.value) * 100) };
}

// ---------------------------------------------------------------------------
// Audience (requires real snapshots; Buffer provides none)
// ---------------------------------------------------------------------------
function missingAudience(start: number | null, end: number | null): Computed | null {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return na("no_data", "Audience snapshots are missing for the start or end of the period (never estimated).");
  }
  return null;
}

/** end − start followers. N/A no_data without both snapshots. */
export function netAudienceGrowth(start: number | null, end: number | null): Computed {
  return missingAudience(start, end) ?? ok((end as number) - (start as number));
}

/** (end − start) ÷ start × 100. Only when start > 0. */
export function audienceGrowthPct(start: number | null, end: number | null): Computed {
  const missing = missingAudience(start, end);
  if (missing) return missing;
  if ((start as number) <= 0) return na("starting_audience_not_positive", "Growth percentage needs a starting audience above 0.");
  return ok((((end as number) - (start as number)) / (start as number)) * 100);
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------
export interface ComparisonContext {
  currentDefinitionId: string;
  previousDefinitionId: string;
  currentComplete: boolean;
  previousComplete: boolean;
}

export interface ComparisonResult {
  /** current − previous, in the metric's unit (percentage points for percent metrics). */
  absoluteChange: Computed;
  /** (current − previous) ÷ |previous| × 100. N/A when previous is 0. */
  percentChange: Computed;
}

export function compareValues(current: Computed, previous: Computed, ctx: ComparisonContext): ComparisonResult {
  const both = (c: Computed): ComparisonResult => ({ absoluteChange: c, percentChange: c });
  if (ctx.currentDefinitionId !== ctx.previousDefinitionId) {
    return both(na("incompatible_definitions", `Cannot compare "${ctx.currentDefinitionId}" with "${ctx.previousDefinitionId}".`));
  }
  if (!ctx.currentComplete || !ctx.previousComplete) {
    const which = !ctx.currentComplete && !ctx.previousComplete ? "Both periods are" : !ctx.currentComplete ? "The current period is" : "The previous period is";
    return both(na("partial_period", `${which} incomplete; comparison withheld.`));
  }
  if (current.na) return both({ value: null, na: { code: current.na.code, message: `Current value unavailable: ${current.na.message}` } });
  if (previous.na) return both({ value: null, na: { code: previous.na.code, message: `Previous value unavailable: ${previous.na.message}` } });
  const absoluteChange = ok(current.value - previous.value);
  const percentChange =
    previous.value === 0
      ? na("denominator_zero", "Previous value is 0; percentage change undefined (absolute change is shown).")
      : ok(((current.value - previous.value) / Math.abs(previous.value)) * 100);
  return { absoluteChange, percentChange };
}

// ---------------------------------------------------------------------------
// Aggregation across posts
// ---------------------------------------------------------------------------
export type PostExclusionReason = ValueStatus | "missing" | "duplicate_observation";

export interface PostExclusion {
  postId: string;
  reason: PostExclusionReason;
}

/** Keeps the latest observation (by metricsUpdatedAt; null is oldest; ties keep input order) per postId. */
function latestPerPost(posts: PostPerformance[]): { kept: PostPerformance[]; duplicates: PostExclusion[] } {
  const best = new Map<string, number>();
  posts.forEach((p, i) => {
    const current = best.get(p.postId);
    if (current === undefined) return void best.set(p.postId, i);
    const a = (posts[current] as PostPerformance).metricsUpdatedAt?.getTime() ?? -Infinity;
    const b = p.metricsUpdatedAt?.getTime() ?? -Infinity;
    if (b > a) best.set(p.postId, i);
  });
  const kept: PostPerformance[] = [];
  const duplicates: PostExclusion[] = [];
  posts.forEach((p, i) => {
    if (best.get(p.postId) === i) kept.push(p);
    else duplicates.push({ postId: p.postId, reason: "duplicate_observation" });
  });
  return { kept, duplicates };
}

export interface AggregateResult {
  key: MetricKey;
  result: Computed;
  postsIncluded: number;
  includedPostIds: string[];
  postsExcluded: PostExclusion[];
  /** Some included posts were reported_zero. */
  containsZeroUncertainty: boolean;
  /** False when any distinct post was excluded for missing data: the total is then a lower bound. */
  isComplete: boolean;
}

function collectUsable(posts: PostPerformance[], key: MetricKey) {
  const { kept, duplicates } = latestPerPost(posts);
  const included: { postId: string; value: number; status: ValueStatus }[] = [];
  const excluded: PostExclusion[] = [];
  for (const p of kept) {
    const mv = p.metrics[key];
    if (isUsable(mv)) included.push({ postId: p.postId, value: mv.value, status: mv.status });
    else excluded.push({ postId: p.postId, reason: statusOf(mv) });
  }
  return { included, excluded, duplicates };
}

/**
 * Sums a summable lifetime metric across DISTINCT posts using only the latest observation per post.
 * Refuses non-summable keys (reach, rates, averages, followers). No usable post → N/A no_data (never 0).
 */
export function aggregatePostMetrics(posts: PostPerformance[], key: MetricKey): AggregateResult {
  const def = METRIC_DEFINITIONS[key];
  if (!def.summableAcrossPosts) {
    return {
      key,
      result: na("not_summable", `${def.label} cannot be summed across posts. ${def.summabilityNote}`),
      postsIncluded: 0,
      includedPostIds: [],
      postsExcluded: [],
      containsZeroUncertainty: false,
      isComplete: false,
    };
  }
  const { included, excluded, duplicates } = collectUsable(posts, key);
  const result =
    included.length === 0
      ? na("no_data", `No post has a usable ${def.label} value.`)
      : ok(included.reduce((acc, x) => acc + x.value, 0));
  return {
    key,
    result,
    postsIncluded: included.length,
    includedPostIds: included.map((x) => x.postId),
    postsExcluded: [...excluded, ...duplicates],
    containsZeroUncertainty: included.some((x) => x.status === "reported_zero"),
    isComplete: excluded.length === 0 && included.length > 0,
  };
}

/** Median of a finite list (mean of the two middle values for even length); null when empty. */
export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface MedianResult {
  key: MetricKey;
  result: Computed;
  sampleSize: number;
  postsExcluded: PostExclusion[];
  containsZeroUncertainty: boolean;
}

/** Median per distinct post (latest observation). Valid for every metric, including reach and rates. */
export function medianMetric(posts: PostPerformance[], key: MetricKey): MedianResult {
  const { included, excluded, duplicates } = collectUsable(posts, key);
  const m = median(included.map((x) => x.value));
  return {
    key,
    result: m === null ? na("no_data", `No post has a usable ${METRIC_DEFINITIONS[key].label} value.`) : ok(m),
    sampleSize: included.length,
    postsExcluded: [...excluded, ...duplicates],
    containsZeroUncertainty: included.some((x) => x.status === "reported_zero"),
  };
}

// ---------------------------------------------------------------------------
// Baselines & age
// ---------------------------------------------------------------------------
export interface WeeklyValue {
  /** Local Monday YYYY-MM-DD. Missing weeks must be passed with value null (not omitted). */
  weekStart: string;
  value: number | null;
  complete: boolean;
}

export interface BaselineResult {
  mean: Computed;
  median: Computed;
  /** The `weeks` most recent distinct weeks considered. */
  windowWeeks: string[];
  weeksUsed: string[];
  weeksExcluded: { weekStart: string; reason: "incomplete" | "no_value" | "duplicate_week" }[];
}

/**
 * Baseline from the `weeks` most recent PRIOR weeks (caller excludes the week being evaluated).
 * Only complete weeks with a value count; fewer than `minWeeks` usable → N/A insufficient_sample.
 * A weekStart present more than once is ambiguous (possible double ingestion) and excluded entirely.
 */
export function rollingBaseline(weeklyValues: WeeklyValue[], weeks = 4, minWeeks = 3): BaselineResult {
  const counts = new Map<string, number>();
  for (const w of weeklyValues) counts.set(w.weekStart, (counts.get(w.weekStart) ?? 0) + 1);
  const distinct = [...counts.keys()].sort().reverse().slice(0, Math.max(0, weeks));
  const weeksUsed: string[] = [];
  const weeksExcluded: BaselineResult["weeksExcluded"] = [];
  const values: number[] = [];
  for (const weekStart of distinct) {
    if ((counts.get(weekStart) ?? 0) > 1) {
      weeksExcluded.push({ weekStart, reason: "duplicate_week" });
      continue;
    }
    const w = weeklyValues.find((x) => x.weekStart === weekStart) as WeeklyValue;
    if (!w.complete) weeksExcluded.push({ weekStart, reason: "incomplete" });
    else if (w.value === null || !Number.isFinite(w.value)) weeksExcluded.push({ weekStart, reason: "no_value" });
    else {
      weeksUsed.push(weekStart);
      values.push(w.value);
    }
  }
  if (values.length < minWeeks) {
    const reason = na("insufficient_sample", `Baseline needs ${minWeeks} complete weeks with data out of the last ${weeks}; found ${values.length}.`);
    return { mean: reason, median: reason, windowWeeks: distinct, weeksUsed, weeksExcluded };
  }
  return {
    mean: ok(values.reduce((a, b) => a + b, 0) / values.length),
    median: ok(median(values) as number),
    windowWeeks: distinct,
    weeksUsed,
    weeksExcluded,
  };
}

/** Hours between publication and the provider's metrics refresh; null until first ingestion; floored at 0. */
export function postAgeAtObservationHours(publishedAt: Date, metricsUpdatedAt: Date | null): number | null {
  if (metricsUpdatedAt === null) return null;
  return Math.max(0, metricsUpdatedAt.getTime() - publishedAt.getTime()) / 3_600_000;
}
