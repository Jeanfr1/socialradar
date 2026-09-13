import { describe, expect, it } from "vitest";
import { computeCoverage } from "@/domain/coverage";
import { METRIC_KEYS, PLATFORM_METRIC_CAPABILITIES } from "@/domain/metrics";
import type { CadenceConfig, MetricKey, MetricValue } from "@/domain/types";
import type { ReportInputPost } from "@/server/reports/facts";
import { buildRecommendationCandidates, type InsightAccount, type InsightInput } from "./rules";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-09-16T15:00:00Z");
const DAY = 86_400_000;

const cadence: CadenceConfig = {
  mode: "provider_schedule",
  timezone: TZ,
  days: [],
  postsPerWeek: null,
  matchMode: "same_day",
  matchToleranceMinutes: 90,
  horizonDays: 14,
  warningDays: 7,
  criticalDays: 3,
  staleAfterMinutes: 360,
};

const account: InsightAccount = {
  id: "acc-1",
  handle: "marca",
  platform: "instagram",
  isDisconnected: false,
  connectionStatus: "active",
  cadence,
  coverage: computeCoverage({ now: NOW, cadence, items: [], lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false }),
  lastPublishedSyncAt: NOW,
  recentErrors: [],
  inventoryCap: null,
};

function post(i: number, publishedAt: Date, views: number, format = "reel"): ReportInputPost {
  const metrics: Partial<Record<MetricKey, MetricValue>> = {};
  const values: Partial<Record<MetricKey, number>> = { views, reach: views * 0.8, reactions: views / 10, comments: 1, shares: 1, saves: 1 };
  for (const key of METRIC_KEYS) {
    metrics[key] = PLATFORM_METRIC_CAPABILITIES.instagram[key] === "unsupported" ? { key, value: null, status: "unsupported" } : values[key] !== undefined ? { key, value: values[key]!, status: "reported" } : { key, value: null, status: "not_reported" };
  }
  return { postId: `p${i}`, socialAccountId: "acc-1", platform: "instagram", format, publishedAt, metricsUpdatedAt: new Date(NOW.getTime() - 3_600_000), metrics, tags: [], externalUrl: `https://x.example/${i}`, text: null, title: null };
}

const input = (posts: ReportInputPost[], locale: InsightInput["brand"]["locale"] = "pt-BR"): InsightInput => ({ brand: { id: "b", timezone: TZ, locale, contentPillars: [] }, now: NOW, accounts: [account], posts });

/** Local São Paulo time `hour`:00 on the day `daysAgo` before NOW. */
const localAt = (daysAgo: number, hour: number) => new Date(Date.UTC(2026, 8, 16 - daysAgo, hour + 3, 0));

describe("timing experiments", () => {
  it("are proposed only with at least 8 posts per time bucket, never with high confidence, as experiments", () => {
    const posts: ReportInputPost[] = [];
    // 10 morning posts (usual) and 9 evening posts with higher views, all same format, 4–50 days old.
    for (let i = 0; i < 10; i++) posts.push(post(i, localAt(4 + i * 4, 9), 500 + i));
    for (let i = 0; i < 9; i++) posts.push(post(100 + i, localAt(5 + i * 5, 19), 1200 + i));
    const timing = buildRecommendationCandidates(input(posts)).find((c) => c.kind === "timing_experiment");
    expect(timing).toBeDefined();
    expect(timing!.confidence).not.toBe("high");
    expect(timing!.priority).toBe("low");
    expect(timing!.evidence).toMatchObject({ candidateBucket: "evening", usualBucket: "morning", notABestTimeClaim: true });
    expect(timing!.interpretation).toContain("não um \"melhor horário\"");

    const fewer = buildRecommendationCandidates(input([...posts.slice(0, 10), ...posts.slice(10, 17)])).find((c) => c.kind === "timing_experiment");
    expect(fewer).toBeUndefined();
  });
});

describe("format mix", () => {
  it("requires 5 posts per format and comparable observation ages", () => {
    const posts: ReportInputPost[] = [];
    for (let i = 0; i < 5; i++) posts.push(post(i, new Date(NOW.getTime() - (5 + i) * DAY), 1000, "reel"));
    for (let i = 0; i < 5; i++) posts.push(post(10 + i, new Date(NOW.getTime() - (6 + i) * DAY), 400, "carousel"));
    const candidates = buildRecommendationCandidates(input(posts, "en-US"));
    const fm = candidates.find((c) => c.kind === "format_mix")!;
    expect(fm.finding).toContain("reel posts on marca had a median of 1,000 views (n=5) versus 400 for carousel posts (n=5)");
    expect(fm.interpretation.startsWith("Hypothesis")).toBe(true);
    expect(fm.confidence).toBe("medium");

    const fourCarousels = buildRecommendationCandidates(input(posts.slice(0, 9))).find((c) => c.kind === "format_mix");
    expect(fourCarousels).toBeUndefined();

    // Carousels observed much older (≥ 2× median age) → unfair comparison, no recommendation.
    const oldCarousels = [...posts.slice(0, 5), ...posts.slice(5).map((p, i) => ({ ...p, publishedAt: new Date(NOW.getTime() - (25 + i) * DAY) }))];
    expect(buildRecommendationCandidates(input(oldCarousels)).find((c) => c.kind === "format_mix")).toBeUndefined();
  });
});
