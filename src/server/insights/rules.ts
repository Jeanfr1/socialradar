/**
 * Rule-based recommendation candidates. Pure and deterministic (`now` injected); all numbers come from src/domain
 * (medians, primary engagement rate, rankContent scores, coverage). Every candidate carries:
 *   finding (observed fact) · evidence (values, post ids + URLs, window, sample sizes) · interpretation (labeled
 *   hypothesis, never causal) · concrete action · priority · confidence (sample size + consistency) · success metric
 *   · evaluation window.
 * Rules only fire when their documented minimum sample is met (RECOMMENDATION_RULES). Timing is only ever proposed as
 * an experiment; no "best posting time" is claimed. No creative/hook analysis is derived from metrics.
 */
import { DateTime } from "luxon";
import { computeWeekSlotCoverage, excerpt, round, type ReportInputAccount, type ReportInputPost } from "@/server/reports/facts";
import { fmtDateTime, fmtDate, fmtNumber, fmtPct, fmtRatio } from "@/server/reports/i18n";
import type { ReportLocale } from "@/server/reports/types";
import { isUsable, median, postAgeAtObservationHours, primaryEngagementRate } from "@/domain/metrics";
import { isPeriodComplete, previousCompleteWeek, weekBefore, type WeekPeriod } from "@/domain/periods";
import { rankContent } from "@/domain/ranking";
import { recommendationTemplates, type TimeBucket } from "./templates";

const DAY_MS = 86_400_000;

export const RECOMMENDATION_RULES = {
  /** Window for format and content-pillar rules. */
  performanceWindowDays: 28,
  /** Window for timing experiments (needs more posts per bucket). */
  timingWindowDays: 56,
  /** Posts must be observed at least this long after publishing (lifetime counters mature). */
  minObservationAgeHours: 72,
  publishFailureLookbackDays: 14,
  formatMix: { minPostsPerFormat: 5, highConfidencePostsPerFormat: 10, minRatio: 1.25, maxMedianAgeRatio: 2 },
  contentPillar: { minPostsWithTag: 5, minPostsWithoutTag: 5, highConfidencePosts: 10, minRatioAbove: 1.25, maxRatioBelow: 0.8, maxTagChars: 60 },
  tagging: { minEligiblePosts: 10, maxTaggedShare: 0.5 },
  consistency: { weeks: 2, minPlannedSlotsPerWeek: 3, maxCoverageRatio: 0.8, highPriorityBelowRatio: 0.5 },
  timing: { minPostsPerBucket: 8, mediumConfidencePostsPerBucket: 15, minRatio: 1.2 },
  /** A dismissed or done recommendation with the same dedupe key is not re-proposed within this many days. */
  cooldownDays: 30,
} as const;

export type RecommendationKind =
  | "reconnect_account"
  | "publish_failures"
  | "queue_replenishment"
  | "posting_consistency"
  | "format_mix"
  | "content_pillar"
  | "tagging_gap"
  | "timing_experiment";

export interface RecommendationCandidate {
  kind: RecommendationKind;
  dedupeKey: string;
  socialAccountId: string | null;
  finding: string;
  evidence: Record<string, unknown>;
  interpretation: string;
  action: string;
  priority: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  successMetric: string;
  evaluationWindowDays: number;
}

export interface InsightAccount extends Pick<ReportInputAccount, "id" | "handle" | "platform" | "isDisconnected" | "connectionStatus" | "cadence" | "coverage" | "lastPublishedSyncAt"> {
  recentErrors: { postId: string; dueAt: Date | null; message: string; externalUrl: string | null }[];
  inventoryCap: number | null;
}

export interface InsightInput {
  brand: { id: string; timezone: string; locale: ReportLocale; contentPillars: string[] };
  now: Date;
  accounts: InsightAccount[];
  /** Published posts (latest metrics) of the brand's mapped accounts, published within the timing window. */
  posts: ReportInputPost[];
}

interface Eligible {
  post: ReportInputPost;
  views: number;
  age: number;
}

function eligible(posts: ReportInputPost[], fromMs: number, toMs: number, minAge: number): Eligible[] {
  const out: Eligible[] = [];
  for (const p of posts) {
    const t = p.publishedAt.getTime();
    if (t < fromMs || t >= toMs) continue;
    const age = postAgeAtObservationHours(p.publishedAt, p.metricsUpdatedAt);
    const views = p.metrics.views;
    if (age === null || age < minAge || !isUsable(views) || views.value <= 0) continue;
    out.push({ post: p, views: views.value, age });
  }
  return out;
}

const postRef = (p: ReportInputPost, value: number | null = null) => ({ postId: p.postId, url: p.externalUrl, publishedAt: p.publishedAt.toISOString(), value });
const normFormat = (f: string | null) => f?.trim().toLowerCase() || null;

function bucketOf(at: Date, tz: string): TimeBucket {
  const h = DateTime.fromJSDate(at, { zone: tz }).hour;
  return h < 6 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

export function buildRecommendationCandidates(input: InsightInput): RecommendationCandidate[] {
  const { brand, now } = input;
  const L = brand.locale;
  const T = recommendationTemplates(L);
  const R = RECOMMENDATION_RULES;
  const out: RecommendationCandidate[] = [];
  const nowMs = now.getTime();
  const n0 = (v: number) => fmtNumber(L, v, 0);
  const n1 = (v: number) => fmtNumber(L, v, 1);
  const dt = (d: Date) => fmtDateTime(L, d.toISOString(), brand.timezone);
  const perfWindow = { start: new Date(nowMs - R.performanceWindowDays * DAY_MS).toISOString(), endExclusive: now.toISOString() };

  for (const a of input.accounts) {
    const accountPosts = input.posts.filter((p) => p.socialAccountId === a.id);

    // --- Operational: reconnect -----------------------------------------------------------
    if (a.isDisconnected || a.connectionStatus === "invalid" || a.connectionStatus === "revoked") {
      out.push({
        kind: "reconnect_account",
        dedupeKey: `reconnect_account:${a.id}`,
        socialAccountId: a.id,
        finding: T.reconnect.finding(a.handle, a.connectionStatus),
        evidence: { rule: "reconnect_account", isDisconnected: a.isDisconnected, connectionStatus: a.connectionStatus, observedAt: now.toISOString(), scheduledCount: a.coverage.scheduledCount, sampleSize: 1 },
        interpretation: T.reconnect.interpretation,
        action: T.reconnect.action,
        priority: "high",
        confidence: "high",
        successMetric: T.reconnect.success,
        evaluationWindowDays: 7,
      });
    }

    // --- Operational: publish failures ----------------------------------------------------
    const failures = a.recentErrors.filter((e) => e.dueAt === null || e.dueAt.getTime() >= nowMs - R.publishFailureLookbackDays * DAY_MS);
    if (failures.length > 0) {
      out.push({
        kind: "publish_failures",
        dedupeKey: `publish_failures:${a.id}`,
        socialAccountId: a.id,
        finding: T.failures.finding(a.handle, failures.length, n0(R.publishFailureLookbackDays)),
        evidence: {
          rule: "publish_failures",
          window: { start: new Date(nowMs - R.publishFailureLookbackDays * DAY_MS).toISOString(), endExclusive: now.toISOString() },
          sampleSize: failures.length,
          posts: failures.map((f) => ({ postId: f.postId, url: f.externalUrl, dueAt: f.dueAt?.toISOString() ?? null, providerMessage: excerpt(f.message, 200) })),
        },
        interpretation: T.failures.interpretation,
        action: T.failures.action(failures.length),
        priority: "high",
        confidence: "high",
        successMetric: T.failures.success,
        evaluationWindowDays: 7,
      });
    }

    // --- Operational: queue replenishment (fresh data only) -------------------------------
    const cov = a.coverage;
    if (!a.isDisconnected && cov.freshness === "fresh" && (cov.state === "critical" || cov.state === "empty" || cov.state === "warning")) {
      const capBlocks = cov.reasons.includes("provider_inventory_cap_blocks_healthy") && a.inventoryCap !== null;
      out.push({
        kind: "queue_replenishment",
        dedupeKey: `queue_replenishment:${a.id}`,
        socialAccountId: a.id,
        finding:
          T.queue.finding(a.handle, cov.coveredDays === null ? null : n1(cov.coveredDays), cov.firstUncoveredSlot ? dt(cov.firstUncoveredSlot) : null, n0(cov.postsNeeded), n0(a.cadence.horizonDays), cov.state) +
          (capBlocks ? T.queue.capNote(n0(a.inventoryCap as number)) : ""),
        evidence: {
          rule: "queue_replenishment",
          observedAt: now.toISOString(),
          coverageState: cov.state,
          coveredDays: cov.coveredDays === null ? null : round(cov.coveredDays, 2),
          firstUncoveredSlot: cov.firstUncoveredSlot?.toISOString() ?? null,
          postsNeeded: cov.postsNeeded,
          scheduledCount: cov.scheduledCount,
          expectedSlots: cov.expectedSlots,
          horizonDays: a.cadence.horizonDays,
          isEstimate: cov.isEstimate,
          inventoryCap: a.inventoryCap,
          reasons: cov.reasons,
          sampleSize: cov.expectedSlots,
        },
        interpretation: T.queue.interpretation,
        action: T.queue.action(n0(cov.postsNeeded), cov.fillDeadline ? dt(cov.fillDeadline) : null),
        priority: cov.state === "warning" ? "medium" : "high",
        confidence: cov.isEstimate ? "medium" : "high",
        successMetric: T.queue.success(n0(a.cadence.warningDays)),
        evaluationWindowDays: 7,
      });
    }

    // --- Posting consistency over the last complete weeks ---------------------------------
    if (a.lastPublishedSyncAt !== null && a.cadence.mode !== "paused") {
      const weeks: WeekPeriod[] = [];
      let w = previousCompleteWeek(now, brand.timezone);
      for (let i = 0; i < R.consistency.weeks; i++) {
        weeks.push(w);
        w = weekBefore(w);
      }
      const results = weeks
        .filter((wk) => isPeriodComplete(wk, now))
        .map((wk) => ({ wk, cov: computeWeekSlotCoverage(a.cadence, wk, accountPosts.map((p) => ({ id: p.postId, at: p.publishedAt }))) }))
        .filter((r) => r.cov.plannedSlots !== null && r.cov.plannedSlots >= R.consistency.minPlannedSlotsPerWeek && r.cov.covered !== null);
      const last = results[0];
      if (last && (last.cov.covered as number) / (last.cov.plannedSlots as number) < R.consistency.maxCoverageRatio) {
        const lastRatio = (last.cov.covered as number) / (last.cov.plannedSlots as number);
        const allBelow = results.length === R.consistency.weeks && results.every((r) => (r.cov.covered as number) / (r.cov.plannedSlots as number) < R.consistency.maxCoverageRatio);
        out.push({
          kind: "posting_consistency",
          dedupeKey: `posting_consistency:${a.id}`,
          socialAccountId: a.id,
          finding:
            T.consistency.finding(
              a.handle,
              results.map((r) => ({
                start: fmtDate(L, r.wk.start),
                covered: n0(r.cov.covered as number),
                planned: n0(r.cov.plannedSlots as number),
                pct: fmtPct(L, ((r.cov.covered as number) / (r.cov.plannedSlots as number)) * 100, 0, false),
              })),
            ) + (last.cov.isEstimate ? T.consistency.estimateNote : ""),
          evidence: {
            rule: "posting_consistency",
            cadenceMode: a.cadence.mode,
            isEstimate: last.cov.isEstimate,
            weeks: results.map((r) => ({
              weekStart: r.wk.start,
              weekEnd: r.wk.end,
              plannedSlots: r.cov.plannedSlots,
              slotsCoveredByPublished: r.cov.covered,
              coveragePct: round(((r.cov.covered as number) / (r.cov.plannedSlots as number)) * 100, 1),
              offCadencePublished: r.cov.offCadence,
            })),
            sampleSize: results.reduce((s, r) => s + (r.cov.plannedSlots as number), 0),
            threshold: { maxCoverageRatio: R.consistency.maxCoverageRatio },
          },
          interpretation: T.consistency.interpretation,
          action: T.consistency.action(n0(last.cov.plannedSlots as number)),
          priority: lastRatio < R.consistency.highPriorityBelowRatio ? "high" : "medium",
          confidence: last.cov.isEstimate ? "low" : allBelow ? "medium" : "low",
          successMetric: T.consistency.success(fmtPct(L, R.consistency.maxCoverageRatio * 100, 0, false)),
          evaluationWindowDays: 14,
        });
      }
    }

    // --- Format mix -----------------------------------------------------------------------
    const perf = eligible(accountPosts, nowMs - R.performanceWindowDays * DAY_MS, nowMs, R.minObservationAgeHours);
    const byFormat = new Map<string, Eligible[]>();
    for (const e of perf) {
      const f = normFormat(e.post.format);
      if (!f) continue;
      byFormat.set(f, [...(byFormat.get(f) ?? []), e]);
    }
    const formats = [...byFormat.entries()]
      .filter(([, list]) => list.length >= R.formatMix.minPostsPerFormat)
      .map(([format, list]) => {
        const ers = list.map((e) => primaryEngagementRate(e.post.metrics, e.post.platform).result.value).filter((v): v is number => v !== null);
        return {
          format,
          list,
          sampleSize: list.length,
          medianViews: median(list.map((e) => e.views)) as number,
          medianAgeHours: median(list.map((e) => e.age)) as number,
          medianEngagementRate: median(ers),
          engagementSample: ers.length,
        };
      })
      .sort((x, y) => y.medianViews - x.medianViews || x.format.localeCompare(y.format));
    if (formats.length >= 2) {
      const top = formats[0]!;
      const other = formats.slice(1).sort((x, y) => y.sampleSize - x.sampleSize || x.format.localeCompare(y.format))[0]!;
      const ratio = other.medianViews > 0 ? top.medianViews / other.medianViews : null;
      const ageRatio = other.medianAgeHours > 0 ? top.medianAgeHours / other.medianAgeHours : null;
      const ageComparable = ageRatio !== null && ageRatio <= R.formatMix.maxMedianAgeRatio && ageRatio >= 1 / R.formatMix.maxMedianAgeRatio;
      if (ratio !== null && ratio >= R.formatMix.minRatio && ageComparable) {
        const erAvailable = top.medianEngagementRate !== null && other.medianEngagementRate !== null && top.engagementSample >= R.formatMix.minPostsPerFormat && other.engagementSample >= R.formatMix.minPostsPerFormat;
        const erAgrees = erAvailable && (top.medianEngagementRate as number) >= (other.medianEngagementRate as number);
        // The rule is based on views. A disagreeing secondary engagement-rate
        // signal prevents high confidence, but does not invalidate the view sample.
        const confidence: RecommendationCandidate["confidence"] =
          top.sampleSize >= R.formatMix.highConfidencePostsPerFormat && other.sampleSize >= R.formatMix.highConfidencePostsPerFormat && erAvailable && erAgrees ? "high" : "medium";
        const erDefinitionId = primaryEngagementRate({}, a.platform).definitionId;
        out.push({
          kind: "format_mix",
          dedupeKey: `format_mix:${a.id}:${top.format}`,
          socialAccountId: a.id,
          finding:
            T.formatMix.finding(a.handle, n0(R.performanceWindowDays), top.format, n0(top.medianViews), n0(top.sampleSize), other.format, n0(other.medianViews), n0(other.sampleSize), fmtRatio(L, ratio), n0(R.minObservationAgeHours), n0(top.medianAgeHours), n0(other.medianAgeHours)) +
            (erAvailable ? T.formatMix.erNote(fmtPct(L, top.medianEngagementRate as number, 2, false), fmtPct(L, other.medianEngagementRate as number, 2, false)) : ""),
          evidence: {
            rule: "format_mix",
            platform: a.platform,
            window: perfWindow,
            metric: "views",
            comparison: `${top.format} vs ${other.format}`,
            ratio: round(ratio),
            sampleSize: top.sampleSize + other.sampleSize,
            engagementRateDefinitionId: erDefinitionId,
            formats: [top, other].map((f) => ({
              format: f.format,
              sampleSize: f.sampleSize,
              medianViews: round(f.medianViews),
              medianAgeHours: round(f.medianAgeHours, 1),
              medianEngagementRate: f.medianEngagementRate === null ? null : round(f.medianEngagementRate),
              posts: [...f.list].sort((x, y) => y.views - x.views).slice(0, 10).map((e) => postRef(e.post, e.views)),
            })),
          },
          interpretation: T.formatMix.interpretation(top.format),
          action: T.formatMix.action(top.format, other.format),
          priority: "medium",
          confidence,
          successMetric: T.formatMix.success(top.format, other.format),
          evaluationWindowDays: 14,
        });
      }
    }

    // --- Content pillars / topics (post_tags) ---------------------------------------------
    const perfStart = new Date(nowMs - R.performanceWindowDays * DAY_MS);
    const ranked = rankContent(
      accountPosts.filter((p) => p.publishedAt.getTime() >= perfStart.getTime()),
      { period: { startUtc: perfStart, endUtcExclusive: now }, minObservationAgeHours: R.minObservationAgeHours, baselineWindowDays: R.performanceWindowDays },
    ).scored;
    const postById = new Map(accountPosts.map((p) => [p.postId, p]));
    const tagValues = new Map<string, { kind: "pillar" | "topic"; value: string }>();
    for (const item of ranked) {
      for (const t of postById.get(item.postId)?.tags ?? []) {
        if (t.kind === "pillar" || t.kind === "topic") tagValues.set(`${t.kind}:${t.value}`, { kind: t.kind, value: t.value });
      }
    }
    for (const [key, tag] of [...tagValues.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const hasTag = (id: string) => (postById.get(id)?.tags ?? []).some((t) => `${t.kind}:${t.value}` === key);
      const withTag = ranked.filter((r) => hasTag(r.postId));
      const without = ranked.filter((r) => !hasTag(r.postId));
      if (withTag.length < R.contentPillar.minPostsWithTag || without.length < R.contentPillar.minPostsWithoutTag) continue;
      const s1 = median(withTag.map((r) => r.score)) as number;
      const s2 = median(without.map((r) => r.score)) as number;
      if (s2 <= 0) continue;
      const rel = s1 / s2;
      const direction = rel >= R.contentPillar.minRatioAbove ? "above" : rel <= R.contentPillar.maxRatioBelow ? "below" : null;
      if (!direction) continue;
      const value = (excerpt(tag.value, R.contentPillar.maxTagChars) ?? "").replace(/"/g, "'");
      const high = withTag.length >= R.contentPillar.highConfidencePosts && without.length >= R.contentPillar.highConfidencePosts;
      out.push({
        kind: "content_pillar",
        dedupeKey: `content_pillar:${a.id}:${tag.kind}:${tag.value.toLowerCase()}:${direction}`,
        socialAccountId: a.id,
        finding: T.pillar.finding(a.handle, T.tagKind[tag.kind], value, fmtRatio(L, s1), n0(withTag.length), fmtRatio(L, s2), n0(without.length), n0(R.performanceWindowDays)),
        evidence: {
          rule: "content_pillar",
          window: perfWindow,
          tag: { kind: tag.kind, value },
          metric: "views_vs_cohort_median",
          method: "score = views ÷ median views of posts from the same account, platform and format (rankContent)",
          sampleSize: withTag.length + without.length,
          withTag: { sampleSize: withTag.length, medianScore: round(s1), posts: withTag.slice(0, 10).map((r) => postRef(postById.get(r.postId)!, round(r.score))) },
          withoutTag: { sampleSize: without.length, medianScore: round(s2) },
          relativeRatio: round(rel),
        },
        interpretation: direction === "above" ? T.pillar.interpretationAbove(value) : T.pillar.interpretationBelow(value),
        action: direction === "above" ? T.pillar.actionAbove(value) : T.pillar.actionBelow(value),
        priority: direction === "above" ? "medium" : "low",
        confidence: high ? "medium" : "low",
        successMetric: T.pillar.success(value),
        evaluationWindowDays: 14,
      });
    }

    // --- Timing experiment ----------------------------------------------------------------
    const timingStart = new Date(nowMs - R.timingWindowDays * DAY_MS);
    const timingScored = rankContent(
      accountPosts.filter((p) => p.publishedAt.getTime() >= timingStart.getTime()),
      { period: { startUtc: timingStart, endUtcExclusive: now }, minObservationAgeHours: R.minObservationAgeHours, baselineWindowDays: R.timingWindowDays },
    ).scored;
    const buckets = new Map<TimeBucket, typeof timingScored>();
    for (const item of timingScored) {
      const b = bucketOf(item.publishedAt, brand.timezone);
      buckets.set(b, [...(buckets.get(b) ?? []), item]);
    }
    const qualifying = [...buckets.entries()].filter(([, list]) => list.length >= R.timing.minPostsPerBucket).map(([bucket, list]) => ({ bucket, list, medianScore: median(list.map((x) => x.score)) as number }));
    if (qualifying.length >= 2) {
      const usual = [...qualifying].sort((x, y) => y.list.length - x.list.length || x.bucket.localeCompare(y.bucket))[0]!;
      const best = [...qualifying].filter((q) => q.bucket !== usual.bucket).sort((x, y) => y.medianScore - x.medianScore || x.bucket.localeCompare(y.bucket))[0];
      if (best && usual.medianScore > 0 && best.medianScore / usual.medianScore >= R.timing.minRatio) {
        const medium = best.list.length >= R.timing.mediumConfidencePostsPerBucket && usual.list.length >= R.timing.mediumConfidencePostsPerBucket;
        out.push({
          kind: "timing_experiment",
          dedupeKey: `timing_experiment:${a.id}:${best.bucket}`,
          socialAccountId: a.id,
          finding: T.timing.finding(a.handle, n0(R.timingWindowDays), T.bucket[best.bucket], fmtRatio(L, best.medianScore), n0(best.list.length), T.bucket[usual.bucket], fmtRatio(L, usual.medianScore), n0(usual.list.length)),
          evidence: {
            rule: "timing_experiment",
            window: { start: timingStart.toISOString(), endExclusive: now.toISOString() },
            timezone: brand.timezone,
            metric: "views_vs_cohort_median",
            sampleSize: best.list.length + usual.list.length,
            minPostsPerBucket: R.timing.minPostsPerBucket,
            buckets: qualifying
              .sort((x, y) => x.bucket.localeCompare(y.bucket))
              .map((q) => ({ bucket: q.bucket, sampleSize: q.list.length, medianScore: round(q.medianScore) })),
            candidateBucket: best.bucket,
            usualBucket: usual.bucket,
            posts: best.list.slice(0, 10).map((x) => postRef(postById.get(x.postId)!, round(x.score))),
            notABestTimeClaim: true,
          },
          interpretation: T.timing.interpretation,
          action: T.timing.action(T.bucket[best.bucket], T.bucket[usual.bucket]),
          priority: "low",
          confidence: medium ? "medium" : "low",
          successMetric: T.timing.success(T.bucket[best.bucket], T.bucket[usual.bucket]),
          evaluationWindowDays: 14,
        });
      }
    }
  }

  // --- Brand-level tagging gap ------------------------------------------------------------
  if (brand.contentPillars.length > 0) {
    const perfAll = eligible(input.posts, nowMs - R.performanceWindowDays * DAY_MS, nowMs, R.minObservationAgeHours);
    const tagged = perfAll.filter((e) => e.post.tags.some((t) => t.kind === "pillar" || t.kind === "topic"));
    if (perfAll.length >= R.tagging.minEligiblePosts && tagged.length / perfAll.length < R.tagging.maxTaggedShare) {
      const pillars = brand.contentPillars.map((p) => excerpt(p, R.contentPillar.maxTagChars)).filter((p): p is string => !!p).join(", ");
      out.push({
        kind: "tagging_gap",
        dedupeKey: "tagging_gap",
        socialAccountId: null,
        finding: T.tagging.finding(n0(tagged.length), n0(perfAll.length), n0(R.performanceWindowDays)),
        evidence: { rule: "tagging_gap", window: perfWindow, sampleSize: perfAll.length, taggedPosts: tagged.length, taggedShare: round(tagged.length / perfAll.length), untaggedPosts: perfAll.filter((e) => !tagged.includes(e)).slice(0, 10).map((e) => postRef(e.post)) },
        interpretation: T.tagging.interpretation,
        action: T.tagging.action(pillars),
        priority: "low",
        confidence: "high",
        successMetric: T.tagging.success,
        evaluationWindowDays: 28,
      });
    }
  }

  return out;
}
