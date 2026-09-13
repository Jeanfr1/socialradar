import { describe, expect, it } from "vitest";
import {
  aggregatePostMetrics,
  audienceGrowthPct,
  canonicalMetricKey,
  classifyProviderMetrics,
  clickThroughRate,
  compareValues,
  detectAlwaysZeroSeries,
  engagementRateByReach,
  engagementRateByViews,
  median,
  medianMetric,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  na,
  netAudienceGrowth,
  ok,
  postAgeAtObservationHours,
  primaryEngagementRate,
  rollingBaseline,
} from "./metrics";
import type { MetricKey, MetricValue, Platform, PostPerformance, ValueStatus } from "./types";

const UPDATED = new Date("2026-09-12T06:00:00Z");

const mv = (key: MetricKey, value: number | null, status?: ValueStatus): MetricValue => ({
  key,
  value,
  status: status ?? (value === null ? "not_reported" : value === 0 ? "reported_zero" : "reported"),
});

function post(id: string, metrics: Partial<Record<MetricKey, MetricValue>>, extra: Partial<PostPerformance> = {}): PostPerformance {
  return {
    postId: id,
    socialAccountId: "acc",
    platform: "instagram",
    format: "reel",
    publishedAt: new Date("2026-09-08T18:00:00Z"),
    metricsUpdatedAt: UPDATED,
    metrics,
    tags: [],
    externalUrl: null,
    ...extra,
  };
}

describe("metric definitions", () => {
  it("defines every canonical key with consistent summability", () => {
    expect(Object.keys(METRIC_DEFINITIONS).sort()).toEqual([...METRIC_KEYS].sort());
    for (const key of METRIC_KEYS) expect(METRIC_DEFINITIONS[key].key).toBe(key);
    expect(METRIC_DEFINITIONS.reach.summableAcrossPosts).toBe(false);
    expect(METRIC_DEFINITIONS.provider_engagement_rate.summableAcrossPosts).toBe(false);
    expect(METRIC_DEFINITIONS.avg_watch_time_seconds.summableAcrossPosts).toBe(false);
    expect(METRIC_DEFINITIONS.followers.summableAcrossPosts).toBe(false);
    expect(METRIC_DEFINITIONS.views.summableAcrossPosts).toBe(true);
    expect(METRIC_DEFINITIONS.views.semantics).toBe("lifetime_cumulative");
  });

  it("maps provider types to canonical keys without prototype leaks", () => {
    expect(canonicalMetricKey("engagementRate")).toBe("provider_engagement_rate");
    expect(canonicalMetricKey("averageTimeWatched")).toBe("avg_watch_time_seconds");
    expect(canonicalMetricKey("totalTimeWatched")).toBe("total_watch_time_minutes");
    expect(canonicalMetricKey("toString")).toBeNull();
    expect(canonicalMetricKey("followers")).toBeNull();
  });
});

describe("classifyProviderMetrics", () => {
  const raw = [
    { type: "reactions", unit: "count", value: 10 },
    { type: "comments", unit: "count", value: 0 },
    { type: "views", unit: "count", value: 100 },
    { type: "reach", unit: "count", value: 80 },
    { type: "engagementRate", unit: "percentage", value: 12.5 },
    { type: "mysteryMetric", unit: "count", value: 7 },
  ];

  it("distinguishes reported, reported_zero, not_reported and unsupported", () => {
    const m = classifyProviderMetrics(raw, { metricsUpdatedAt: UPDATED, platform: "instagram" });
    expect(m.reactions).toEqual({ key: "reactions", value: 10, status: "reported" });
    expect(m.comments).toEqual({ key: "comments", value: 0, status: "reported_zero" });
    expect(m.shares).toEqual({ key: "shares", value: null, status: "not_reported" });
    expect(m.impressions.status).toBe("unsupported");
    expect(m.followers.status).toBe("unsupported");
    expect(m.provider_engagement_rate).toEqual({ key: "provider_engagement_rate", value: 12.5, status: "reported" });
    expect(Object.keys(m)).toHaveLength(METRIC_KEYS.length);
  });

  it("metricsUpdatedAt null → pending, even when the list contains default zeros; structural unsupported wins", () => {
    const zeros = [{ type: "views", unit: "count", value: 0 }, { type: "reactions", unit: "count", value: 0 }];
    const m = classifyProviderMetrics(zeros, { metricsUpdatedAt: null, platform: "youtube" });
    expect(m.views).toEqual({ key: "views", value: null, status: "pending" });
    expect(m.comments.status).toBe("pending");
    expect(m.reach.status).toBe("unsupported");
    expect(m.shares.status).toBe("unsupported");
  });

  it("YouTube: absent shares are unsupported, but a present metric is trusted", () => {
    const absent = classifyProviderMetrics([{ type: "views", unit: "count", value: 5 }], { metricsUpdatedAt: UPDATED, platform: "youtube" });
    expect(absent.shares.status).toBe("unsupported");
    expect(absent.comments.status).toBe("not_reported");
    const present = classifyProviderMetrics([{ type: "shares", unit: "count", value: 3 }], { metricsUpdatedAt: UPDATED, platform: "youtube" });
    expect(present.shares).toEqual({ key: "shares", value: 3, status: "reported" });
  });

  it("null list after ingestion → not_reported; non-finite → not_reported; duplicates keep first", () => {
    const none = classifyProviderMetrics(null, { metricsUpdatedAt: UPDATED, platform: "tiktok" });
    expect(none.views.status).toBe("not_reported");
    expect(none.saves.status).toBe("unsupported");
    const weird = classifyProviderMetrics(
      [
        { type: "views", unit: "count", value: Number.NaN },
        { type: "reach", unit: "count", value: 9 },
        { type: "reach", unit: "count", value: 999 },
      ],
      { metricsUpdatedAt: UPDATED, platform: "tiktok" },
    );
    expect(weird.views.status).toBe("not_reported");
    expect(weird.reach.value).toBe(9);
  });
});

describe("detectAlwaysZeroSeries", () => {
  it("flags a metric that is 0 on every post of a large sample without rewriting values", () => {
    const posts = Array.from({ length: 78 }, (_, i) => post(`p${i}`, { follows: mv("follows", 0) }));
    const info = detectAlwaysZeroSeries(posts, "follows", 20);
    expect(info).toMatchObject({ sampleSize: 78, zeroCount: 78, likelyNotReported: true, insufficientSample: false });
    expect(posts[0]!.metrics.follows).toEqual({ key: "follows", value: 0, status: "reported_zero" });
  });

  it("one non-zero value, a small sample, or pending values prevent the flag", () => {
    const withOne = [...Array.from({ length: 30 }, (_, i) => post(`p${i}`, { follows: mv("follows", 0) })), post("x", { follows: mv("follows", 2) })];
    expect(detectAlwaysZeroSeries(withOne, "follows", 20).likelyNotReported).toBe(false);

    const small = Array.from({ length: 3 }, (_, i) => post(`p${i}`, { follows: mv("follows", 0) }));
    const pending = Array.from({ length: 10 }, (_, i) => post(`q${i}`, { follows: mv("follows", null, "pending") }));
    const info = detectAlwaysZeroSeries([...small, ...pending], "follows", 5);
    expect(info).toMatchObject({ sampleSize: 3, insufficientSample: true, likelyNotReported: false });
  });

  it("counts a post observed twice only once", () => {
    const dupes = Array.from({ length: 5 }, () => post("same", { follows: mv("follows", 0) }));
    expect(detectAlwaysZeroSeries(dupes, "follows", 5)).toMatchObject({ sampleSize: 1, insufficientSample: true });
  });
});

describe("engagement rates", () => {
  const ig = {
    reactions: mv("reactions", 10),
    comments: mv("comments", 5),
    shares: mv("shares", 3),
    saves: mv("saves", 2),
    reach: mv("reach", 400),
    views: mv("views", 1000),
  };

  it("Instagram by reach uses reactions+comments+shares+saves", () => {
    const r = engagementRateByReach(ig, "instagram");
    expect(r.result).toEqual({ value: 5, na: null });
    expect(r.definitionId).toBe("er_reach:instagram:v1");
    expect(r.components).toEqual(["reactions", "comments", "shares", "saves"]);
    expect(r.containsZeroUncertainty).toBe(false);
    expect(primaryEngagementRate(ig, "instagram").definitionId).toBe("er_reach:instagram:v1");
  });

  it("a not_reported component makes the rate N/A; a reported zero computes but is flagged", () => {
    const missing = engagementRateByReach({ ...ig, saves: mv("saves", null, "not_reported") }, "instagram");
    expect(missing.result.na?.code).toBe("numerator_unavailable");
    expect(missing.result.value).toBeNull();

    const zero = engagementRateByReach({ ...ig, saves: mv("saves", 0) }, "instagram");
    expect(zero.result.value).toBe(4.5);
    expect(zero.containsZeroUncertainty).toBe(true);
  });

  it("TikTok by views ignores saves; YouTube by views uses reactions+comments only", () => {
    const tt = engagementRateByViews(
      { reactions: mv("reactions", 50), comments: mv("comments", 10), shares: mv("shares", 40), saves: mv("saves", 1000), views: mv("views", 2000) },
      "tiktok",
    );
    expect(tt.result.value).toBe(5);
    expect(tt.definitionId).toBe("er_views:tiktok:v1");

    const yt = engagementRateByViews(
      { reactions: mv("reactions", 30), comments: mv("comments", 10), shares: mv("shares", null, "unsupported"), views: mv("views", 1000) },
      "youtube",
    );
    expect(yt.result.value).toBe(4);
    expect(primaryEngagementRate({ reactions: mv("reactions", 1), comments: mv("comments", 1), views: mv("views", 10) }, "youtube").definitionId).toBe("er_views:youtube:v1");
  });

  it("denominator: unsupported, unavailable and zero are distinct N/A reasons", () => {
    const yt = { reactions: mv("reactions", 30), comments: mv("comments", 10), views: mv("views", 1000) };
    expect(engagementRateByReach(yt, "youtube").result.na?.code).toBe("unsupported_by_provider");
    expect(engagementRateByReach({ ...ig, reach: mv("reach", null, "pending") }, "instagram").result.na?.code).toBe("denominator_unavailable");
    expect(engagementRateByReach({ ...ig, reach: mv("reach", 0) }, "instagram").result.na?.code).toBe("denominator_zero");
    expect(engagementRateByViews(ig, "other").result.na?.code).toBe("unsupported_by_provider");
  });

  it("click-through rate", () => {
    expect(clickThroughRate(mv("clicks", 5), mv("impressions", 200)).result.value).toBe(2.5);
    expect(clickThroughRate(mv("clicks", 5), mv("impressions", 0)).result.na?.code).toBe("denominator_zero");
    expect(clickThroughRate(mv("clicks", 5), mv("impressions", null, "unsupported")).result.na?.code).toBe("unsupported_by_provider");
    expect(clickThroughRate(mv("clicks", null, "not_reported"), mv("impressions", 100)).result.na?.code).toBe("numerator_unavailable");
    expect(clickThroughRate(undefined, undefined).result.na?.code).toBe("denominator_unavailable");
    const zero = clickThroughRate(mv("clicks", 0), mv("impressions", 100));
    expect(zero.result.value).toBe(0);
    expect(zero.containsZeroUncertainty).toBe(true);
  });
});

describe("audience growth never invents history", () => {
  it("net growth", () => {
    expect(netAudienceGrowth(null, 100).na?.code).toBe("no_data");
    expect(netAudienceGrowth(100, null).na?.code).toBe("no_data");
    expect(netAudienceGrowth(100, 90)).toEqual({ value: -10, na: null });
  });

  it("growth percentage requires a positive start", () => {
    expect(audienceGrowthPct(0, 10).na?.code).toBe("starting_audience_not_positive");
    expect(audienceGrowthPct(null, 10).na?.code).toBe("no_data");
    expect(audienceGrowthPct(200, 250).value).toBe(25);
  });
});

describe("compareValues", () => {
  const ctx = { currentDefinitionId: "er_reach:instagram:v1", previousDefinitionId: "er_reach:instagram:v1", currentComplete: true, previousComplete: true };

  it("absolute and percentage change", () => {
    expect(compareValues(ok(120), ok(100), ctx)).toEqual({ absoluteChange: ok(20), percentChange: ok(20) });
    const negativeBase = compareValues(ok(-5), ok(-10), ctx);
    expect(negativeBase.absoluteChange.value).toBe(5);
    expect(negativeBase.percentChange.value).toBe(50);
  });

  it("previous 0 → percentage N/A but absolute valid", () => {
    const r = compareValues(ok(7), ok(0), ctx);
    expect(r.absoluteChange.value).toBe(7);
    expect(r.percentChange.na?.code).toBe("denominator_zero");
  });

  it("refuses incompatible definitions (e.g. ER by reach vs ER by views)", () => {
    const r = compareValues(ok(5), ok(4), { ...ctx, previousDefinitionId: "er_views:instagram:v1" });
    expect(r.absoluteChange.na?.code).toBe("incompatible_definitions");
    expect(r.percentChange.na?.code).toBe("incompatible_definitions");
  });

  it("refuses partial periods on either side", () => {
    expect(compareValues(ok(5), ok(4), { ...ctx, currentComplete: false }).percentChange.na?.code).toBe("partial_period");
    expect(compareValues(ok(5), ok(4), { ...ctx, previousComplete: false }).absoluteChange.na?.code).toBe("partial_period");
  });

  it("propagates N/A inputs instead of treating them as zero", () => {
    const r = compareValues(ok(5), na("insufficient_sample", "only 2 weeks"), ctx);
    expect(r.absoluteChange.na?.code).toBe("insufficient_sample");
    expect(r.percentChange.value).toBeNull();
  });
});

describe("aggregatePostMetrics", () => {
  it("uses only the latest observation per post (no lifetime double counting), in any order", () => {
    const older = post("a", { views: mv("views", 100) }, { metricsUpdatedAt: new Date("2026-09-10T06:00:00Z") });
    const newer = post("a", { views: mv("views", 150) }, { metricsUpdatedAt: new Date("2026-09-11T06:00:00Z") });
    const other = post("b", { views: mv("views", 50) });
    for (const posts of [[older, newer, other], [newer, other, older]]) {
      const r = aggregatePostMetrics(posts, "views");
      expect(r.result.value).toBe(200);
      expect(r.postsIncluded).toBe(2);
      expect(r.postsExcluded).toEqual([{ postId: "a", reason: "duplicate_observation" }]);
      expect(r.isComplete).toBe(true);
    }
  });

  it("excludes unusable posts with reasons and marks the total as a lower bound", () => {
    const r = aggregatePostMetrics(
      [post("a", { views: mv("views", 100) }), post("b", { views: mv("views", null, "pending") }, { metricsUpdatedAt: null }), post("c", {})],
      "views",
    );
    expect(r.result.value).toBe(100);
    expect(r.postsExcluded).toEqual([
      { postId: "b", reason: "pending" },
      { postId: "c", reason: "missing" },
    ]);
    expect(r.isComplete).toBe(false);
  });

  it("refuses non-summable metrics", () => {
    const posts = [post("a", { reach: mv("reach", 100) }), post("b", { reach: mv("reach", 100) })];
    expect(aggregatePostMetrics(posts, "reach").result.na?.code).toBe("not_summable");
    expect(aggregatePostMetrics(posts, "provider_engagement_rate").result.value).toBeNull();
  });

  it("no usable data is N/A, never 0; reported zeros are included but flagged", () => {
    expect(aggregatePostMetrics([], "views").result.na?.code).toBe("no_data");
    expect(aggregatePostMetrics([post("a", { saves: mv("saves", null, "not_reported") })], "saves").result.na?.code).toBe("no_data");
    const zero = aggregatePostMetrics([post("a", { saves: mv("saves", 0) }), post("b", { saves: mv("saves", 4) })], "saves");
    expect(zero.result.value).toBe(4);
    expect(zero.containsZeroUncertainty).toBe(true);
  });
});

describe("median helpers", () => {
  it("median of odd/even/empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([100, 300, 200, 1000])).toBe(250);
    expect(median([])).toBeNull();
  });

  it("medianMetric works for non-summable reach over distinct posts", () => {
    const posts = [
      post("a", { reach: mv("reach", 100) }),
      post("b", { reach: mv("reach", 300) }),
      post("c", { reach: mv("reach", 200) }),
      post("d", { reach: mv("reach", 1000) }),
      post("e", { reach: mv("reach", null, "not_reported") }),
    ];
    const r = medianMetric(posts, "reach");
    expect(r.result.value).toBe(250);
    expect(r.sampleSize).toBe(4);
    expect(r.postsExcluded).toEqual([{ postId: "e", reason: "not_reported" }]);
    expect(medianMetric([], "reach").result.na?.code).toBe("no_data");
  });
});

describe("rollingBaseline", () => {
  const w = (weekStart: string, value: number | null, complete = true) => ({ weekStart, value, complete });

  it("mean and median of the most recent complete weeks (input order irrelevant)", () => {
    const r = rollingBaseline([w("2026-08-24", 30), w("2026-08-10", 10), w("2026-08-31", 40), w("2026-08-17", 20), w("2026-08-03", 999)]);
    expect(r.windowWeeks).toEqual(["2026-08-31", "2026-08-24", "2026-08-17", "2026-08-10"]);
    expect(r.mean.value).toBe(25);
    expect(r.median.value).toBe(25);
  });

  it("an incomplete week inside the window is skipped; older weeks are not pulled in to compensate", () => {
    const r = rollingBaseline([w("2026-08-31", 40, false), w("2026-08-24", 30), w("2026-08-17", 20), w("2026-08-10", 10), w("2026-08-03", 999)]);
    expect(r.weeksUsed).toEqual(["2026-08-24", "2026-08-17", "2026-08-10"]);
    expect(r.mean.value).toBe(20);
    expect(r.weeksExcluded).toEqual([{ weekStart: "2026-08-31", reason: "incomplete" }]);
  });

  it("insufficient sample when fewer than minWeeks usable weeks (missing ≠ zero)", () => {
    const r = rollingBaseline([w("2026-08-31", null), w("2026-08-24", 30), w("2026-08-17", 20, false), w("2026-08-10", 10)]);
    expect(r.mean.na?.code).toBe("insufficient_sample");
    expect(r.median.na?.code).toBe("insufficient_sample");
    expect(r.weeksExcluded.map((x) => x.reason)).toEqual(["no_value", "incomplete"]);
  });

  it("a duplicated week is excluded as ambiguous", () => {
    const r = rollingBaseline([w("2026-08-31", 40), w("2026-08-31", 80), w("2026-08-24", 30), w("2026-08-17", 20), w("2026-08-10", 10)]);
    expect(r.weeksExcluded).toEqual([{ weekStart: "2026-08-31", reason: "duplicate_week" }]);
    expect(r.mean.value).toBe(20);
  });
});

describe("postAgeAtObservationHours", () => {
  it("measures age at the provider refresh, not now", () => {
    expect(postAgeAtObservationHours(new Date("2026-09-08T18:00:00Z"), new Date("2026-09-11T18:00:00Z"))).toBe(72);
    expect(postAgeAtObservationHours(new Date("2026-09-08T18:00:00Z"), null)).toBeNull();
    expect(postAgeAtObservationHours(new Date("2026-09-08T18:00:00Z"), new Date("2026-09-08T17:00:00Z"))).toBe(0);
  });
});

// Type-level guard: every platform has a primary engagement definition id.
const platforms: Platform[] = ["instagram", "tiktok", "youtube", "other"];
describe("primaryEngagementRate", () => {
  it("returns a definition id for every platform", () => {
    for (const p of platforms) expect(primaryEngagementRate({}, p).definitionId).toMatch(new RegExp(`:${p}:v1$`));
  });
});
