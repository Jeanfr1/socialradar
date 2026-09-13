import { describe, expect, it } from "vitest";
import { cohortKeyOf, rankContent } from "./ranking";
import type { MetricKey, MetricValue, Platform, PostPerformance } from "./types";

const H = 3_600_000;
const PERIOD = { startUtc: new Date("2026-09-07T03:00:00Z"), endUtcExclusive: new Date("2026-09-14T03:00:00Z") };

const mv = (key: MetricKey, value: number | null, status?: MetricValue["status"]): MetricValue => ({
  key,
  value,
  status: status ?? (value === null ? "not_reported" : value === 0 ? "reported_zero" : "reported"),
});

interface PostOpts {
  account?: string;
  platform?: Platform;
  format?: string | null;
  publishedAt?: string;
  ageHours?: number | null;
  reactions?: number;
  metrics?: Partial<Record<MetricKey, MetricValue>>;
}

function post(id: string, views: number | null, o: PostOpts = {}): PostPerformance {
  const publishedAt = new Date(o.publishedAt ?? "2026-09-08T18:00:00Z");
  const age = o.ageHours === undefined ? 100 : o.ageHours;
  return {
    postId: id,
    socialAccountId: o.account ?? "acc1",
    platform: o.platform ?? "tiktok",
    format: o.format === undefined ? "video" : o.format,
    publishedAt,
    metricsUpdatedAt: age === null ? null : new Date(publishedAt.getTime() + age * H),
    metrics: {
      views: mv("views", views),
      reactions: mv("reactions", o.reactions ?? 10),
      comments: mv("comments", 2),
      shares: mv("shares", 1),
      ...o.metrics,
    },
    tags: [],
    externalUrl: null,
  };
}

/** TikTok cohort: 3 posts in the period + 3 in the trailing baseline. Median views = 1050. */
function tiktokCohort(): PostPerformance[] {
  return [
    post("hit", 5000, { publishedAt: "2026-09-09T20:00:00Z" }),
    post("flop", 300, { publishedAt: "2026-09-10T20:00:00Z" }),
    post("average", 1000, { publishedAt: "2026-09-11T20:00:00Z" }),
    post("old1", 1200, { publishedAt: "2026-08-25T20:00:00Z" }),
    post("old2", 800, { publishedAt: "2026-08-28T20:00:00Z" }),
    post("old3", 1100, { publishedAt: "2026-09-02T20:00:00Z" }),
  ];
}

describe("rankContent", () => {
  it("scores candidates against their cohort median with explainable evidence", () => {
    const r = rankContent(tiktokCohort(), { period: PERIOD });
    expect(r.best.map((x) => x.postId)).toEqual(["hit"]);
    expect(r.underperforming.map((x) => x.postId)).toEqual(["flop"]);
    expect(r.scored.map((x) => x.postId)).toEqual(["hit", "average", "flop"]);

    const hit = r.best[0]!;
    expect(hit.score).toBeCloseTo(5000 / 1050, 10);
    expect(hit.evidence).toMatchObject({ metric: "views", value: 5000, cohortMedian: 1050, cohortSize: 6, ageAtObservationHours: 100 });
    expect(hit.evidence.baselineWindow).toEqual({ start: "2026-08-17T03:00:00.000Z", endExclusive: "2026-09-14T03:00:00.000Z" });
    expect(hit.evidence.secondary.definitionId).toBe("er_views:tiktok:v1");
    expect(hit.evidence.secondary.value).toBeCloseTo((13 / 5000) * 100, 10);
    expect(hit.explanation).toContain("4.76x the median (1050) of 6 TikTok video posts");
    expect(r.method).toContain("same account, platform and format");
    expect(r.method).toContain("72h");
  });

  it("never lets another platform's raw counts affect a cohort", () => {
    const instagram = Array.from({ length: 5 }, (_, i) => post(`ig${i}`, 100_000, { platform: "instagram", format: "reel", metrics: { reach: mv("reach", 50_000), saves: mv("saves", 5) } }));
    const r = rankContent([...tiktokCohort(), ...instagram], { period: PERIOD });
    expect(r.best.map((x) => x.postId)).toEqual(["hit"]);
    expect(r.scored.find((x) => x.postId === "hit")!.evidence.cohortMedian).toBe(1050);
    const ig = r.scored.find((x) => x.postId === "ig0")!;
    expect(ig.score).toBe(1);
    expect(ig.evidence.secondary.definitionId).toBe("er_reach:instagram:v1");
    expect(r.cohorts.map((c) => c.cohortKey)).toEqual(["acc1|instagram|reel", "acc1|tiktok|video"]);
  });

  it("excludes young, pending, unavailable and ambiguous-zero posts with reasons", () => {
    const posts = [
      ...tiktokCohort(),
      post("young", 90_000, { ageHours: 48 }),
      post("pending", null, { ageHours: null, metrics: { views: mv("views", null, "pending") } }),
      post("noviews", null),
      post("zero", 0),
    ];
    const r = rankContent(posts, { period: PERIOD });
    const reasons = Object.fromEntries(r.excluded.map((e) => [e.postId, e.reason]));
    expect(reasons).toEqual({
      young: "too_young_at_observation",
      pending: "metrics_pending",
      noviews: "primary_metric_unavailable",
      zero: "primary_metric_ambiguous_zero",
    });
    // Excluded posts do not move the cohort median.
    expect(r.scored.find((x) => x.postId === "hit")!.evidence.cohortMedian).toBe(1050);
  });

  it("age is measured at metricsUpdatedAt, not at the time of ranking", () => {
    const r = rankContent([...tiktokCohort(), post("stale-young", 4000, { ageHours: 30, publishedAt: "2026-09-08T00:00:00Z" })], { period: PERIOD });
    expect(r.excluded).toEqual([expect.objectContaining({ postId: "stale-young", reason: "too_young_at_observation" })]);
  });

  it("small cohorts are not ranked", () => {
    const r = rankContent(tiktokCohort().slice(0, 4), { period: PERIOD });
    expect(r.scored).toEqual([]);
    expect(r.best).toEqual([]);
    expect(new Set(r.excluded.map((e) => e.reason))).toEqual(new Set(["cohort_too_small"]));
    expect(r.cohorts[0]).toMatchObject({ size: 4, eligibleForRanking: false });
  });

  it("uses only the latest observation of each post", () => {
    const older = { ...post("hit", 200, { publishedAt: "2026-09-09T20:00:00Z", ageHours: 80 }) };
    const r = rankContent([older, ...tiktokCohort()], { period: PERIOD });
    expect(r.cohorts.find((c) => c.cohortKey === "acc1|tiktok|video")!.size).toBe(6);
    expect(r.best[0]!.evidence.value).toBe(5000);
    expect(r.excluded).toEqual([expect.objectContaining({ postId: "hit", reason: "duplicate_observation" })]);
  });

  it("breaks score ties with engagement rate, then publish time", () => {
    const posts = [...tiktokCohort(), post("tieLowEr", 5000, { reactions: 1, publishedAt: "2026-09-12T10:00:00Z" })];
    const r = rankContent(posts, { period: PERIOD });
    expect(r.best.map((x) => x.postId)).toEqual(["hit", "tieLowEr"]);
  });

  it("null format forms its own cohort", () => {
    expect(cohortKeyOf({ socialAccountId: "a", platform: "youtube", format: null })).toBe("a|youtube|unknown");
    expect(cohortKeyOf({ socialAccountId: "a", platform: "youtube", format: " Short " })).toBe("a|youtube|short");
  });

  it("confidence reflects cohort size and age comparability", () => {
    const day = (i: number) => String((i % 6) + 7).padStart(2, "0"); // 07..12 Sep, inside the period
    const big = Array.from({ length: 10 }, (_, i) => post(`b${i}`, 1000 + i * 10, { publishedAt: `2026-09-${day(i)}T12:00:00Z` }));
    const r = rankContent([...big, post("veteran", 3000, { publishedAt: "2026-09-08T12:00:00Z", ageHours: 600 })], { period: PERIOD });
    expect(r.scored.find((x) => x.postId === "b0")!.confidence).toBe("high");
    expect(r.scored.find((x) => x.postId === "veteran")!.confidence).toBe("low");
  });

  it("is deterministic regardless of input order", () => {
    const posts = tiktokCohort();
    expect(rankContent(posts, { period: PERIOD })).toEqual(rankContent([...posts].reverse(), { period: PERIOD }));
  });
});
