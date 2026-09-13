/**
 * Explainable content ranking ("best" and "underperforming").
 *
 * Method
 * - Cohort = same social account + platform + format (null format → "unknown"). Raw counts are never compared
 *   across cohorts, platforms or accounts; only dimensionless ratios to each post's OWN cohort median are ordered.
 * - Eligibility: metrics ingested (metricsUpdatedAt set), post age at observation >= minObservationAgeHours
 *   (default 72h, measured at metricsUpdatedAt — not at `now`), primary metric (views) reported and non-zero.
 *   A reported 0 view count is ambiguous (possible provider default) and is excluded rather than ranked last.
 * - Baseline: eligible posts of the cohort published in the trailing `baselineWindowDays` (default 28) ending at
 *   the period end (extended to cover the whole period if the period is longer). Candidates are part of their cohort.
 * - Score = views ÷ cohort median views. A cohort smaller than minCohortSize (default 5) → no score.
 * - Secondary metric: BrandPulse engagement rate (Instagram by reach; TikTok/YouTube by views), reported as
 *   evidence and used only to break ties.
 * - Confidence reflects sample size and age comparability (lifetime counters grow with age):
 *   high = cohort >= 2×minCohortSize and post age within 0.5–2× the cohort median age; medium = age within
 *   0.25–4×; low otherwise.
 */
import type { Platform, PostPerformance } from "./types";
import { isUsable, median, postAgeAtObservationHours, primaryEngagementRate } from "./metrics";

const DAY_MS = 86_400_000;
const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", other: "other-platform" };

export interface RankingOptions {
  /** Candidates are posts published in [startUtc, endUtcExclusive). */
  period: { startUtc: Date; endUtcExclusive: Date };
  minObservationAgeHours?: number;
  minCohortSize?: number;
  baselineWindowDays?: number;
  /** Minimum ratio to appear in "best" (default 1.2). */
  bestMinRatio?: number;
  /** Maximum ratio to appear in "underperforming" (default 0.8). */
  underperformingMaxRatio?: number;
  /** Max items per list (default 5). */
  limit?: number;
}

export type RankingConfidence = "high" | "medium" | "low";

export type RankingExclusionReason =
  | "duplicate_observation"
  | "metrics_pending"
  | "too_young_at_observation"
  | "primary_metric_unavailable"
  | "primary_metric_ambiguous_zero"
  | "cohort_too_small"
  | "cohort_median_zero";

export interface RankedItem {
  postId: string;
  socialAccountId: string;
  platform: Platform;
  format: string | null;
  cohortKey: string;
  publishedAt: Date;
  /** Views ÷ cohort median views. */
  score: number;
  confidence: RankingConfidence;
  evidence: {
    metric: "views";
    value: number;
    cohortMedian: number;
    ratio: number;
    cohortSize: number;
    ageAtObservationHours: number;
    cohortMedianAgeHours: number;
    metricsUpdatedAt: string;
    baselineWindow: { start: string; endExclusive: string };
    secondary: {
      definitionId: string;
      value: number | null;
      cohortMedian: number | null;
      ratio: number | null;
      naReason: string | null;
      containsZeroUncertainty: boolean;
    };
  };
  explanation: string;
}

export interface RankingExclusion {
  postId: string;
  reason: RankingExclusionReason;
  detail: string;
}

export interface CohortSummary {
  cohortKey: string;
  socialAccountId: string;
  platform: Platform;
  format: string | null;
  size: number;
  medianViews: number | null;
  eligibleForRanking: boolean;
}

export interface RankingResult {
  method: string;
  best: RankedItem[];
  underperforming: RankedItem[];
  /** Every scored candidate, best first. */
  scored: RankedItem[];
  excluded: RankingExclusion[];
  cohorts: CohortSummary[];
}

function normalizeFormat(format: string | null): string | null {
  const f = format?.trim().toLowerCase();
  return f ? f : null;
}

export function cohortKeyOf(p: Pick<PostPerformance, "socialAccountId" | "platform" | "format">): string {
  return `${p.socialAccountId}|${p.platform}|${normalizeFormat(p.format) ?? "unknown"}`;
}

interface Eligible {
  post: PostPerformance;
  views: number;
  age: number;
}

function checkEligibility(p: PostPerformance, minAge: number): Eligible | RankingExclusion {
  const age = postAgeAtObservationHours(p.publishedAt, p.metricsUpdatedAt);
  if (age === null) return { postId: p.postId, reason: "metrics_pending", detail: "Metrics not ingested by the provider yet." };
  if (age < minAge) {
    return { postId: p.postId, reason: "too_young_at_observation", detail: `Observed ${age.toFixed(1)}h after publishing; minimum is ${minAge}h.` };
  }
  const views = p.metrics.views;
  if (!isUsable(views)) {
    return { postId: p.postId, reason: "primary_metric_unavailable", detail: `Views are ${views?.status ?? "missing"}.` };
  }
  if (views.value === 0) {
    return { postId: p.postId, reason: "primary_metric_ambiguous_zero", detail: "Views reported as 0, which may be a provider default." };
  }
  return { post: p, views: views.value, age };
}

function rounded(n: number, digits = 2): string {
  return Number(n.toFixed(digits)).toString();
}

export function rankContent(posts: PostPerformance[], opts: RankingOptions): RankingResult {
  const minAge = opts.minObservationAgeHours ?? 72;
  const minCohort = opts.minCohortSize ?? 5;
  const baselineDays = opts.baselineWindowDays ?? 28;
  const bestMin = opts.bestMinRatio ?? 1.2;
  const underMax = opts.underperformingMaxRatio ?? 0.8;
  const limit = opts.limit ?? 5;
  const start = opts.period.startUtc.getTime();
  const end = opts.period.endUtcExclusive.getTime();
  const baselineStart = Math.min(start, end - baselineDays * DAY_MS);

  const method =
    `Ranked by views relative to the median views of posts from the same account, platform and format published in the trailing ${baselineDays} days ` +
    `(posts observed at least ${minAge}h after publishing; cohorts need at least ${minCohort} posts). ` +
    `Engagement rate (Instagram: by reach; TikTok and YouTube: by views) is shown as supporting evidence and breaks ties. ` +
    `Raw counts are never compared across platforms or accounts. "Best" requires at least ${bestMin}x the cohort median; ` +
    `"underperforming" at most ${underMax}x. Metrics are lifetime totals as of each post's last provider refresh.`;

  // Latest observation per distinct post.
  const latest = new Map<string, PostPerformance>();
  const excluded: RankingExclusion[] = [];
  for (const p of posts) {
    const prev = latest.get(p.postId);
    if (!prev) latest.set(p.postId, p);
    else if ((p.metricsUpdatedAt?.getTime() ?? -Infinity) > (prev.metricsUpdatedAt?.getTime() ?? -Infinity)) latest.set(p.postId, p);
  }
  if (latest.size < posts.length) {
    const counted = new Set<string>();
    for (const p of posts) {
      if (latest.get(p.postId) === p && !counted.has(p.postId)) counted.add(p.postId);
      else if (inRange(p.publishedAt.getTime(), start, end)) {
        excluded.push({ postId: p.postId, reason: "duplicate_observation", detail: "Older observation of a post already included." });
      }
    }
  }

  // Baseline pools per cohort.
  const pools = new Map<string, Eligible[]>();
  const candidates: Eligible[] = [];
  for (const p of latest.values()) {
    const t = p.publishedAt.getTime();
    const isCandidate = inRange(t, start, end);
    const inBaseline = inRange(t, baselineStart, end);
    if (!isCandidate && !inBaseline) continue;
    const e = checkEligibility(p, minAge);
    if ("reason" in e) {
      if (isCandidate) excluded.push(e);
      continue;
    }
    const key = cohortKeyOf(p);
    const pool = pools.get(key) ?? [];
    pool.push(e);
    pools.set(key, pool);
    if (isCandidate) candidates.push(e);
  }

  const cohorts: CohortSummary[] = [...pools.entries()]
    .map(([cohortKey, pool]) => {
      const first = (pool[0] as Eligible).post;
      return {
        cohortKey,
        socialAccountId: first.socialAccountId,
        platform: first.platform,
        format: normalizeFormat(first.format),
        size: pool.length,
        medianViews: median(pool.map((x) => x.views)),
        eligibleForRanking: pool.length >= minCohort,
      };
    })
    .sort((a, b) => (a.cohortKey < b.cohortKey ? -1 : a.cohortKey > b.cohortKey ? 1 : 0));

  const scored: RankedItem[] = [];
  for (const c of candidates) {
    const key = cohortKeyOf(c.post);
    const pool = pools.get(key) as Eligible[];
    if (pool.length < minCohort) {
      excluded.push({ postId: c.post.postId, reason: "cohort_too_small", detail: `Cohort has ${pool.length} eligible posts; minimum is ${minCohort}.` });
      continue;
    }
    const medViews = median(pool.map((x) => x.views)) as number;
    if (medViews <= 0) {
      excluded.push({ postId: c.post.postId, reason: "cohort_median_zero", detail: "Cohort median views is 0; ratio undefined." });
      continue;
    }
    const medAge = median(pool.map((x) => x.age)) as number;
    const ageRatio = medAge > 0 ? c.age / medAge : 1;
    const confidence: RankingConfidence =
      pool.length >= 2 * minCohort && ageRatio >= 0.5 && ageRatio <= 2 ? "high" : ageRatio >= 0.25 && ageRatio <= 4 ? "medium" : "low";

    const er = primaryEngagementRate(c.post.metrics, c.post.platform);
    const cohortErs = pool
      .map((x) => primaryEngagementRate(x.post.metrics, x.post.platform).result.value)
      .filter((v): v is number => v !== null);
    const erMedian = median(cohortErs);
    const erValue = er.result.value;
    const ratio = c.views / medViews;
    const format = normalizeFormat(c.post.format);

    scored.push({
      postId: c.post.postId,
      socialAccountId: c.post.socialAccountId,
      platform: c.post.platform,
      format,
      cohortKey: key,
      publishedAt: c.post.publishedAt,
      score: ratio,
      confidence,
      evidence: {
        metric: "views",
        value: c.views,
        cohortMedian: medViews,
        ratio,
        cohortSize: pool.length,
        ageAtObservationHours: c.age,
        cohortMedianAgeHours: medAge,
        metricsUpdatedAt: (c.post.metricsUpdatedAt as Date).toISOString(),
        baselineWindow: { start: new Date(baselineStart).toISOString(), endExclusive: new Date(end).toISOString() },
        secondary: {
          definitionId: er.definitionId,
          value: erValue,
          cohortMedian: erMedian,
          ratio: erValue !== null && erMedian !== null && erMedian > 0 ? erValue / erMedian : null,
          naReason: er.result.na?.code ?? null,
          containsZeroUncertainty: er.containsZeroUncertainty,
        },
      },
      explanation:
        `${c.views} views, ${rounded(ratio)}x the median (${rounded(medViews, 1)}) of ${pool.length} ${PLATFORM_LABEL[c.post.platform]} ` +
        `${format ?? "unknown-format"} posts from this account in the trailing ${baselineDays} days; observed ${Math.round(c.age)}h after publishing.`,
    });
  }

  const tieBreak = (a: RankedItem, b: RankedItem, secondaryDir: 1 | -1): number => {
    const av = a.evidence.secondary.value;
    const bv = b.evidence.secondary.value;
    if (av !== bv) {
      if (av === null) return 1;
      if (bv === null) return -1;
      return secondaryDir * (bv - av);
    }
    return a.publishedAt.getTime() - b.publishedAt.getTime() || (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0);
  };
  scored.sort((a, b) => b.score - a.score || tieBreak(a, b, 1));

  const best = scored.filter((x) => x.score >= bestMin).slice(0, limit);
  const underperforming = scored
    .filter((x) => x.score <= underMax)
    .sort((a, b) => a.score - b.score || tieBreak(a, b, -1))
    .slice(0, limit);

  return { method, best, underperforming, scored, excluded, cohorts };
}

function inRange(t: number, start: number, endExclusive: number): boolean {
  return t >= start && t < endExclusive;
}
