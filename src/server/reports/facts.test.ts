import { describe, expect, it } from "vitest";
import { computeCoverage } from "@/domain/coverage";
import { METRIC_KEYS, PLATFORM_METRIC_CAPABILITIES } from "@/domain/metrics";
import { weekContaining } from "@/domain/periods";
import type { CadenceConfig, MetricKey, MetricValue, Platform } from "@/domain/types";
import { composeReport } from "./compose";
import { computeReportFacts, computeWeekSlotCoverage, type ObservationInput, type ReportInput, type ReportInputAccount, type ReportInputPost } from "./facts";

const TZ = "America/Sao_Paulo";
const HOUR = 3_600_000;
// Report week: Monday 2026-09-07 .. Sunday 2026-09-13 (São Paulo, UTC-3).
const PERIOD = weekContaining(new Date("2026-09-09T15:00:00Z"), TZ);
// Wednesday after the week: past the 24h published-sync grace period.
const NOW = new Date("2026-09-16T15:00:00Z");

const cadence = (tz = TZ): CadenceConfig => ({
  mode: "custom",
  timezone: tz,
  days: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => ({ day, paused: false, times: ["20:00"] })),
  postsPerWeek: null,
  matchMode: "same_day",
  matchToleranceMinutes: 90,
  horizonDays: 14,
  warningDays: 7,
  criticalDays: 3,
  staleAfterMinutes: 360,
});

function account(id: string, platform: Platform, overrides: Partial<ReportInputAccount> = {}): ReportInputAccount {
  const c = cadence();
  // Queue fully covered for the next 14 days (one post per day at 20:00 local = 23:00 UTC).
  const items = Array.from({ length: 15 }, (_, i) => ({ id: `q-${id}-${i}`, dueAt: new Date(Date.UTC(2026, 8, 16 + i, 23, 0)), status: "scheduled" as const }));
  const coverage = computeCoverage({ now: NOW, cadence: c, items, lastQueueSyncAt: new Date(NOW.getTime() - HOUR), queuePaused: false, accountDisconnected: false });
  return {
    id,
    handle: `${platform}_brand`,
    displayName: null,
    platform,
    connectionStatus: "active",
    isDisconnected: false,
    isQueuePaused: false,
    cadence: c,
    cadenceIsDefault: false,
    coverage,
    lastQueueSyncAt: new Date(NOW.getTime() - HOUR),
    lastPublishedSyncAt: new Date(NOW.getTime() - 2 * HOUR),
    overdueCount: 0,
    ...overrides,
  };
}

function metrics(platform: Platform, values: Partial<Record<MetricKey, number>>, pending = false): Partial<Record<MetricKey, MetricValue>> {
  const out: Partial<Record<MetricKey, MetricValue>> = {};
  for (const key of METRIC_KEYS) {
    if (PLATFORM_METRIC_CAPABILITIES[platform][key] === "unsupported") out[key] = { key, value: null, status: "unsupported" };
    else if (pending) out[key] = { key, value: null, status: "pending" };
    else if (values[key] === undefined) out[key] = { key, value: null, status: "not_reported" };
    else out[key] = { key, value: values[key]!, status: values[key] === 0 ? "reported_zero" : "reported" };
  }
  return out;
}

function post(id: string, accountId: string, platform: Platform, publishedAt: Date, latest: Partial<Record<MetricKey, number>> | null, metricsUpdatedAt: Date | null, format = "reel"): ReportInputPost {
  return {
    postId: id,
    socialAccountId: accountId,
    platform,
    format,
    publishedAt,
    metricsUpdatedAt,
    metrics: metrics(platform, latest ?? {}, latest === null),
    tags: [],
    externalUrl: `https://instagram.example/p/${id}`,
    text: `Caption ${id}`,
    title: null,
  };
}

function observe(postId: string, publishedAt: Date, ageHours: number, values: Partial<Record<MetricKey, number>>): ObservationInput[] {
  const at = new Date(publishedAt.getTime() + ageHours * HOUR);
  return Object.entries(values).map(([metricKey, value]) => ({ postId, metricKey, value: value as number, valueStatus: value === 0 ? "reported_zero" : "reported", providerUpdatedAt: at }));
}

const ig = (views: number) => ({ views, reach: views * 0.8, reactions: views / 10, comments: 2, shares: 1, saves: 1 });

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    brand: { id: "brand-1", name: "Marca Teste", timezone: TZ, reportLocale: "pt-BR", contentPillars: [] },
    period: PERIOD,
    now: NOW,
    accounts: [],
    posts: [],
    observations: [],
    failedPosts: [],
    ...overrides,
  };
}

describe("week-over-week comparison at equal post age", () => {
  it("uses the observation closest to the comparison age for both weeks and never sums snapshots", () => {
    const acc = account("acc-ig", "instagram");
    const cur = [new Date("2026-09-08T23:00:00Z"), new Date("2026-09-09T23:00:00Z"), new Date("2026-09-10T23:00:00Z")];
    const prev = [new Date("2026-09-01T23:00:00Z"), new Date("2026-09-02T23:00:00Z"), new Date("2026-09-03T23:00:00Z")];
    const posts: ReportInputPost[] = [];
    const observations: ObservationInput[] = [];
    cur.forEach((at, i) => {
      const id = `c${i}`;
      observations.push(...observe(id, at, 24, ig(150)), ...observe(id, at, 72, ig(250)));
      if (i === 0) observations.push(...observe(id, at, 168, ig(350)));
      posts.push(post(id, acc.id, "instagram", at, ig(i === 0 ? 350 : 250), new Date(at.getTime() + (i === 0 ? 168 : 72) * HOUR)));
    });
    prev.forEach((at, i) => {
      const id = `p${i}`;
      for (const [age, views] of [[24, 100], [72, 200], [168, 300], [300, 400]] as const) observations.push(...observe(id, at, age, ig(views)));
      posts.push(post(id, acc.id, "instagram", at, ig(400), new Date(at.getTime() + 300 * HOUR)));
    });

    const facts = computeReportFacts(baseInput({ accounts: [acc], posts, observations }));
    const kpis = facts.kpis[0]!;
    expect(kpis.comparisonAgeHours).toBe(72);
    const views = kpis.rows.find((r) => r.metricId === "views")!;
    // Latest lifetime values of the current week's posts (350 + 250 + 250).
    expect(views.latest.value).toBe(850);
    expect(views.comparison.current.value).toBe(750); // 3 × 250 at 72h
    expect(views.comparison.previous.value).toBe(600); // 3 × 200 at 72h — not 3 × (100+200+300+400)
    expect(views.comparison.absoluteChange).toBe(150);
    expect(views.comparison.percentChange).toBe(25);
    expect(views.comparison.previous.postsIncluded).toBe(3);

    const er = kpis.rows.find((r) => r.metricId === "engagement_rate_median")!;
    expect(er.definitionId).toBe("median:er_reach:instagram:v1");
    expect(er.comparison.current.value).not.toBeNull();

    const posts_ = kpis.rows.find((r) => r.metricId === "posts_published")!;
    expect(posts_.comparison.current.value).toBe(3);
    expect(posts_.comparison.previous.value).toBe(3);
  });

  it("withholds a sum comparison when a previous-week post has no observation near the comparison age", () => {
    const acc = account("acc-ig", "instagram");
    const cur = [new Date("2026-09-08T23:00:00Z"), new Date("2026-09-09T23:00:00Z"), new Date("2026-09-10T23:00:00Z")];
    const prev = [new Date("2026-09-01T23:00:00Z"), new Date("2026-09-02T23:00:00Z"), new Date("2026-09-03T23:00:00Z")];
    const posts: ReportInputPost[] = [];
    const observations: ObservationInput[] = [];
    cur.forEach((at, i) => {
      observations.push(...observe(`c${i}`, at, 72, ig(250)));
      posts.push(post(`c${i}`, acc.id, "instagram", at, ig(250), new Date(at.getTime() + 72 * HOUR)));
    });
    prev.forEach((at, i) => {
      // p0's history starts at 300h (BrandPulse was not syncing yet at 72h).
      const ages = i === 0 ? [300] : [72, 300];
      for (const age of ages) observations.push(...observe(`p${i}`, at, age, ig(age === 72 ? 200 : 400)));
      posts.push(post(`p${i}`, acc.id, "instagram", at, ig(400), new Date(at.getTime() + 300 * HOUR)));
    });
    const facts = computeReportFacts(baseInput({ accounts: [acc], posts, observations }));
    const views = facts.kpis[0]!.rows.find((r) => r.metricId === "views")!;
    expect(views.comparison.previous.status).toBe("partial");
    expect(views.comparison.previous.value).toBe(400); // lower bound: 2 posts × 200
    expect(views.comparison.absoluteChange).toBeNull();
    expect(views.comparison.na?.code).toBe("incomplete_sample");
  });

  it("reports N/A when current posts are too young for a fair comparison", () => {
    const acc = account("acc-ig", "instagram");
    const now = new Date(PERIOD.endUtcExclusive.getTime() + 10 * HOUR);
    const at = new Date(PERIOD.endUtcExclusive.getTime() - 3 * HOUR);
    const observations = observe("c0", at, 12, ig(90));
    const facts = computeReportFacts(baseInput({ now, accounts: [acc], posts: [post("c0", acc.id, "instagram", at, ig(90), new Date(at.getTime() + 12 * HOUR))], observations }));
    const views = facts.kpis[0]!.rows.find((r) => r.metricId === "views")!;
    expect(facts.kpis[0]!.comparisonAgeHours).toBeNull();
    expect(views.comparison.current.value).toBeNull();
    expect(views.comparison.na?.code).toBe("insufficient_post_age");
  });
});

describe("missing metrics", () => {
  it("renders unsupported and pending metrics as unavailable, never as 0, and audience as unsupported", () => {
    const acc = account("acc-yt", "youtube");
    const at = new Date("2026-09-12T15:00:00Z");
    const facts = computeReportFacts(baseInput({ accounts: [acc], posts: [post("y0", acc.id, "youtube", at, null, null, "short")] }));
    const rows = facts.kpis[0]!.rows;
    const shares = rows.find((r) => r.metricId === "shares")!;
    expect(shares.latest).toMatchObject({ value: null, status: "unsupported", na: { code: "unsupported_by_provider" } });
    const views = rows.find((r) => r.metricId === "views")!;
    expect(views.latest).toMatchObject({ value: null, status: "pending", na: { code: "metrics_pending" } });

    const content = composeReport(facts);
    const followers = content.audienceAndEngagementTrends.audience.accounts[0]!.followers;
    expect(followers).toMatchObject({ value: null, status: "unsupported" });
    expect(followers.na?.message).toMatch(/Requer conexão direta/);
    for (const row of content.kpiTable.accounts[0]!.rows) {
      for (const cell of [row.latest, row.comparison.current, row.comparison.previous]) {
        if (cell.status !== "available" && cell.status !== "partial") {
          expect(cell.value).toBeNull();
          expect(cell.na?.message).toBeTruthy();
        }
      }
    }
  });
});

describe("preliminary rules", () => {
  it("lists every preliminary reason", () => {
    const stale = account("acc-ig", "instagram");
    const cov = computeCoverage({ now: NOW, cadence: stale.cadence, items: [], lastQueueSyncAt: new Date(NOW.getTime() - 48 * HOUR), queuePaused: false, accountDisconnected: false });
    const acc = { ...stale, coverage: cov, lastPublishedSyncAt: new Date(PERIOD.endUtcExclusive.getTime() + 2 * HOUR) };
    const pending = post("c-pending", acc.id, "instagram", new Date("2026-09-13T20:00:00Z"), null, null);
    const old = post("c-old", acc.id, "instagram", new Date("2026-09-08T20:00:00Z"), ig(100), new Date("2026-09-12T20:00:00Z"));
    const facts = computeReportFacts(baseInput({ accounts: [acc], posts: [pending, old] }));
    expect(facts.preliminaryReasons.map((r) => r.code).sort()).toEqual(["post_metrics_not_refreshed", "post_metrics_pending", "published_sync_before_cutoff", "queue_sync_stale"]);

    const partialWeek = computeReportFacts(baseInput({ now: new Date("2026-09-12T12:00:00Z"), accounts: [account("a2", "tiktok")] }));
    expect(partialWeek.preliminaryReasons.map((r) => r.code)).toContain("period_incomplete");

    const neverSynced = computeReportFacts(baseInput({ accounts: [account("a3", "tiktok", { lastPublishedSyncAt: null })] }));
    expect(neverSynced.preliminaryReasons.map((r) => r.code)).toContain("published_sync_missing");
    const postsRow = neverSynced.kpis[0]!.rows.find((r) => r.metricId === "posts_published")!;
    expect(postsRow.latest).toMatchObject({ value: null, na: { code: "never_synced" } });
  });

  it("is final when syncs and metrics are fresh after the period", () => {
    const acc = account("acc-ig", "instagram");
    const p = post("c0", acc.id, "instagram", new Date("2026-09-10T23:00:00Z"), ig(100), new Date("2026-09-15T10:00:00Z"));
    const facts = computeReportFacts(baseInput({ accounts: [acc], posts: [p] }));
    expect(facts.preliminaryReasons).toEqual([]);
    const content = composeReport(facts);
    expect(content.status).toBe("final");
  });
});

describe("publication consistency", () => {
  it("matches published posts against planned slots of the week", () => {
    // Published at 20:00 local on Mon..Fri, plus a second post on Friday (off cadence).
    const published = [7, 8, 9, 10, 11].map((d, i) => ({ id: `p${i}`, at: new Date(Date.UTC(2026, 8, d, 23, 0)) }));
    published.push({ id: "extra", at: new Date(Date.UTC(2026, 8, 11, 15, 0)) });
    const week = computeWeekSlotCoverage(cadence(), PERIOD, published);
    expect(week).toMatchObject({ plannedSlots: 7, covered: 5, offCadence: 1, status: "below_plan" });

    const paused = computeWeekSlotCoverage({ ...cadence(), mode: "paused" }, PERIOD, published);
    expect(paused.status).toBe("paused");
    expect(paused.plannedSlots).toBeNull();
  });
});

describe("deterministic pt-BR composition", () => {
  it("writes the narrative in Portuguese with 3 to 5 actions and an always-present data quality section", () => {
    const acc = account("acc-ig", "instagram");
    const failed = { postId: "f1", socialAccountId: acc.id, dueAt: new Date("2026-09-10T23:00:00Z"), message: "Buffer has lost authorization to post on your behalf.", externalUrl: null };
    const p = post("c0", acc.id, "instagram", new Date("2026-09-10T23:00:00Z"), ig(100), new Date("2026-09-15T10:00:00Z"));
    const content = composeReport(computeReportFacts(baseInput({ accounts: [acc], posts: [p], failedPosts: [failed] })));
    expect(content.locale).toBe("pt-BR");
    expect(content.labels.sections.executiveSummary).toBe("1. Resumo executivo");
    expect(content.executiveSummary.narrative).toContain("Semana de 07/09/2026 a 13/09/2026: 1 post publicado em 1 conta");
    expect(content.executiveSummary.narrative).toContain("1 falha de publicação registrada");
    expect(content.actions.items.length).toBeGreaterThanOrEqual(3);
    expect(content.actions.items.length).toBeLessThanOrEqual(5);
    expect(content.actions.items[0]).toMatchObject({ kind: "fix_publish_failures", priority: "high" });
    expect(content.needsImprovement.items.some((i) => i.id === `failures:${acc.id}`)).toBe(true);
    expect(content.dataQuality.limitations.length).toBeGreaterThan(5);
    expect(content.bestContent.method).toContain("mediana");
  });

  it("supports en-US and es-ES templates and falls back to pt-BR for unknown locales", () => {
    const acc = account("acc-ig", "instagram");
    const en = composeReport(computeReportFacts(baseInput({ brand: { id: "b", name: "B", timezone: TZ, reportLocale: "en-US", contentPillars: [] }, accounts: [acc] })));
    expect(en.labels.sections.kpiTable).toBe("2. Account KPIs");
    const es = composeReport(computeReportFacts(baseInput({ brand: { id: "b", name: "B", timezone: TZ, reportLocale: "es-ES", contentPillars: [] }, accounts: [acc] })));
    expect(es.executiveSummary.narrative).toContain("Semana del");
    const fr = composeReport(computeReportFacts(baseInput({ brand: { id: "b", name: "B", timezone: TZ, reportLocale: "fr-FR", contentPillars: [] }, accounts: [acc] })));
    expect(fr.locale).toBe("pt-BR");
    expect(fr.dataQuality.limitations.some((l) => l.includes("fr-FR"))).toBe(true);
  });
});
