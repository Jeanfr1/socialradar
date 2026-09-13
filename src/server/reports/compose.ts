/**
 * Deterministic composition: ReportFacts (numbers) → WeeklyReportContent (localized document).
 * This path is complete on its own and is used whenever AI narratives are disabled, fail or are rejected.
 * Only numbers present in the facts are formatted into text; no causes, benchmarks or estimates are added.
 */
import type { RankingExclusionReason } from "@/domain/ranking";
import { COMPARISON_PARAMETERS, RANKING_PARAMETERS, TREND_MIN_WEEKS, TREND_WEEKS } from "./facts";
import { fmtAge, fmtDate, fmtDateTime, fmtNumber, fmtPct, fmtRatio, messages, type Messages } from "./i18n";
import {
  REPORT_SCHEMA_VERSION,
  type AccountConsistency,
  type ContentSection,
  type FactCell,
  type FactContentList,
  type FactNA,
  type MetricCell,
  type ReportAction,
  type ReportActionKind,
  type ReportFacts,
  type ReportInsightItem,
  type ReportLocale,
  type ReportNA,
  type WeeklyReportContent,
} from "./types";

/** Minimum absolute percent change (or change vs baseline) that is called out in sections 7/8. */
export const NOTABLE_CHANGE_PCT = 10;
export const MAX_ACTIONS = 5;
export const MIN_ACTIONS = 3;

const ACTION_WINDOW_DAYS: Record<ReportActionKind, number> = {
  reconnect_account: 7,
  fix_publish_failures: 7,
  replenish_queue: 7,
  resolve_sync: 3,
  restore_cadence: 14,
  repeat_top_format: 14,
  review_underperforming: 14,
  wait_for_metrics: 3,
  tag_content_pillars: 14,
  maintain_cadence: 7,
  track_success_metrics: 7,
};

/** Recommendation dedupe key (see src/server/insights/rules.ts) matching a report action, when one exists. */
export function actionDedupeKey(kind: ReportActionKind, accountId: string | null): string | null {
  if (!accountId) return null;
  switch (kind) {
    case "reconnect_account":
      return `reconnect_account:${accountId}`;
    case "fix_publish_failures":
      return `publish_failures:${accountId}`;
    case "replenish_queue":
      return `queue_replenishment:${accountId}`;
    case "restore_cadence":
      return `posting_consistency:${accountId}`;
    default:
      return null;
  }
}

function naOf(m: Messages, na: FactNA | null): ReportNA | null {
  return na ? { code: na.code, message: m.na[na.code] } : null;
}

function cellOf(m: Messages, c: FactCell): MetricCell {
  return { ...c, na: naOf(m, c.na) };
}

export function composeReport(facts: ReportFacts): WeeklyReportContent {
  const locale: ReportLocale = facts.brand.locale;
  const tz = facts.brand.timezone;
  const m = messages(locale);
  const n0 = (v: number) => fmtNumber(locale, v, 0);
  const n1 = (v: number) => fmtNumber(locale, v, 1);
  const pct = (v: number) => fmtPct(locale, v, 1);
  const dt = (iso: string) => fmtDateTime(locale, iso, tz);
  const cutoff = dt(facts.observationCutoff);
  const isPreliminary = facts.preliminaryReasons.length > 0;
  const handleOf = new Map(facts.kpis.map((k) => [k.accountId, k.handle]));

  // ---- 2. KPI table ------------------------------------------------------------------------
  const kpiAccounts = facts.kpis.map((a) => ({
    accountId: a.accountId,
    handle: a.handle,
    displayName: a.displayName,
    platform: a.platform,
    rows: a.rows.map((r) => ({
      metricId: r.metricId,
      definitionId: r.definitionId,
      label: m.kpi[r.metricId],
      aggregation: r.aggregation,
      unit: r.unit,
      source: r.source,
      latest: { ...cellOf(m, r.latest), observedAtMin: r.latest.observedAtMin, observedAtMax: r.latest.observedAtMax },
      comparison: {
        basis: r.comparison.basis,
        ageHours: r.comparison.ageHours,
        current: cellOf(m, r.comparison.current),
        previous: cellOf(m, r.comparison.previous),
        absoluteChange: r.comparison.absoluteChange,
        percentChange: r.comparison.percentChange,
        na: naOf(m, r.comparison.na),
        percentNa: naOf(m, r.comparison.percentNa),
      },
      status: r.status,
    })),
  }));

  // ---- 3. Consistency ----------------------------------------------------------------------
  const consistencyAccounts: AccountConsistency[] = facts.consistency.map((c) => {
    const notes: string[] = [];
    if (c.status === "unknown") notes.push(m.consistency.neverSynced);
    if (c.status === "paused") notes.push(m.consistency.paused);
    else if (c.status === "no_cadence") notes.push(m.consistency.noCadence);
    else {
      if (c.isEstimate) notes.push(m.consistency.estimate);
      if (c.cadenceIsDefault) notes.push(m.consistency.defaultCadence);
      notes.push(m.consistency.currentCadence);
    }
    if (c.atGeneration.isDisconnected) notes.push(m.consistency.disconnected);
    if (c.atGeneration.isQueuePaused) notes.push(m.consistency.queuePaused);
    notes.push(m.consistency.atGeneration(m.labels.coverageStates[c.atGeneration.coverageState], c.atGeneration.firstUncoveredSlot ? dt(c.atGeneration.firstUncoveredSlot) : null));
    const { cadenceIsDefault: _d, missedSlots: _m, publishedCount, ...rest } = c;
    return { ...rest, publishedCount: cellOf(m, publishedCount), notes };
  });
  const withCadence = facts.consistency.filter((c) => c.plannedSlots !== null && c.status !== "unknown");
  const consistencyNarrative = m.consistency.narrative(withCadence.filter((c) => c.status === "on_track").length, withCadence.length, facts.totals.failedPosts);

  // ---- 4/5. Content ------------------------------------------------------------------------
  const method = m.content.method(n0(RANKING_PARAMETERS.baselineWindowDays), n0(RANKING_PARAMETERS.minObservationAgeHours), n0(RANKING_PARAMETERS.minCohortSize), fmtRatio(locale, RANKING_PARAMETERS.bestMinRatio), fmtRatio(locale, RANKING_PARAMETERS.underperformingMaxRatio));
  const contentSection = (list: FactContentList, kind: "best" | "under"): ContentSection => {
    const min = fmtRatio(locale, RANKING_PARAMETERS.bestMinRatio);
    const max = fmtRatio(locale, RANKING_PARAMETERS.underperformingMaxRatio);
    const items = list.items.map((it) => ({
      ...it,
      secondary: { ...it.secondary, na: naOf(m, it.secondary.na) },
      explanation: m.content.explanation(
        n0(it.views),
        fmtRatio(locale, it.score),
        n1(it.cohortMedianViews),
        n0(it.cohortSize),
        m.labels.platforms[it.platform],
        it.format ?? m.content.unknownFormat,
        n0(RANKING_PARAMETERS.baselineWindowDays),
        n0(it.ageAtObservationHours),
      ),
    }));
    const empty = items.length === 0 ? (list.scoredCount === 0 ? m.content.noneRankable : kind === "best" ? m.content.bestEmpty(min) : m.content.underEmpty(max)) : null;
    return {
      narrative: empty ?? (kind === "best" ? m.content.bestNarrative(items.length, min) : m.content.underNarrative(items.length, max)),
      method,
      fairnessNote: kind === "best" ? m.content.bestFairness : m.content.underFairness(n0(RANKING_PARAMETERS.minObservationAgeHours)),
      items,
      excluded: list.excluded.map((e) => ({ reason: e.reason, label: m.excluded[e.reason as RankingExclusionReason] ?? e.reason, count: e.count })),
      emptyReason: empty,
    };
  };
  const bestContent = contentSection(facts.bestContent, "best");
  const underperformingContent = contentSection(facts.underperformingContent, "under");

  // ---- 6. Trends ---------------------------------------------------------------------------
  const trendLines: string[] = [];
  const engagement = facts.trends.map((a) => ({
    accountId: a.accountId,
    handle: a.handle,
    displayName: a.displayName,
    platform: a.platform,
    metrics: a.metrics.map((t) => {
      const label = m.trend[t.metricId];
      if (t.current.value !== null && t.baseline.median !== null && t.vsBaseline.percentChange !== null) {
        const fmt = t.unit === "percent" ? (v: number) => fmtPct(locale, v, 1, false) : n1;
        trendLines.push(m.trends.line(a.handle, label.toLowerCase(), fmt(t.current.value), fmt(t.baseline.median), pct(t.vsBaseline.percentChange)));
      }
      return {
        ...t,
        label,
        current: cellOf(m, t.current),
        baseline: { ...t.baseline, na: naOf(m, t.baseline.na) },
        vsBaseline: { ...t.vsBaseline, na: naOf(m, t.vsBaseline.na), percentNa: naOf(m, t.vsBaseline.percentNa) },
      };
    }),
  }));
  const trendsNarrative = [m.trends.narrative(n0(TREND_WEEKS), n0(TREND_MIN_WEEKS)), ...trendLines].join(" ");

  // ---- 7/8. Went well / needs improvement --------------------------------------------------
  const wentWell: ReportInsightItem[] = [];
  const needs: ReportInsightItem[] = [];
  for (const a of facts.kpis) {
    for (const row of a.rows) {
      if (row.metricId !== "views" && row.metricId !== "engagement_rate_median") continue;
      const p = row.comparison.percentChange;
      if (p === null || Math.abs(p) < NOTABLE_CHANGE_PCT || row.comparison.ageHours === null) continue;
      const item: ReportInsightItem = {
        id: `${row.metricId}_${p > 0 ? "up" : "down"}:${a.accountId}`,
        text: (p > 0 ? m.insights.metricUp : m.insights.metricDown)(a.handle, m.kpi[row.metricId], pct(p), fmtAge(locale, row.comparison.ageHours)),
        accountId: a.accountId,
        evidence: { metricId: row.metricId, values: { current: row.comparison.current.value, previous: row.comparison.previous.value, percentChange: p, ageHours: row.comparison.ageHours } },
      };
      (p > 0 ? wentWell : needs).push(item);
    }
  }
  for (const c of facts.consistency) {
    if (c.status === "on_track" && c.plannedSlots !== null && c.slotsCoveredByPublished !== null) {
      wentWell.push({ id: `all_slots:${c.accountId}`, text: m.insights.allSlots(c.handle, n0(c.slotsCoveredByPublished), n0(c.plannedSlots)), accountId: c.accountId, evidence: { values: { planned: c.plannedSlots, covered: c.slotsCoveredByPublished } } });
    } else if (c.status === "below_plan" && c.plannedSlots !== null && c.missedSlots !== null) {
      needs.push({ id: `missed_slots:${c.accountId}`, text: m.insights.missedSlots(c.handle, n0(c.missedSlots), n0(c.plannedSlots)), accountId: c.accountId, evidence: { values: { planned: c.plannedSlots, missed: c.missedSlots } } });
    }
    if (c.failedCount > 0) {
      needs.push({ id: `failures:${c.accountId}`, text: m.insights.failures(c.handle, c.failedCount), accountId: c.accountId, evidence: { postIds: c.failedPosts.map((f) => f.postId), values: { failed: c.failedCount } } });
    }
    const g = c.atGeneration;
    if (g.isDisconnected) needs.push({ id: `disconnected:${c.accountId}`, text: m.insights.disconnected(c.handle), accountId: c.accountId, evidence: {} });
    else if (g.freshness !== "fresh") needs.push({ id: `sync_stale:${c.accountId}`, text: m.insights.syncStale(c.handle), accountId: c.accountId, evidence: { values: { freshness: g.freshness } } });
    else if (g.coverageState === "critical" || g.coverageState === "empty" || g.coverageState === "warning") {
      needs.push({
        id: `coverage:${c.accountId}`,
        text: m.insights.coverageRisk(c.handle, m.labels.coverageStates[g.coverageState].toLowerCase(), n0(g.postsNeeded), g.firstUncoveredSlot ? dt(g.firstUncoveredSlot) : null),
        accountId: c.accountId,
        evidence: { values: { coverageState: g.coverageState, postsNeeded: g.postsNeeded, coveredDays: g.coveredDays } },
      });
    }
  }
  if (facts.totals.failedPosts === 0 && facts.totals.postsPublished > 0) {
    wentWell.push({ id: "no_failures", text: m.insights.noFailures(n0(facts.totals.postsPublished)), accountId: null, evidence: { values: { posts: facts.totals.postsPublished, failed: 0 } } });
  }
  const top = facts.bestContent.items[0];
  if (top) {
    wentWell.push({ id: "best_content", text: m.insights.best(facts.bestContent.items.length, top.handle, fmtRatio(locale, top.score)), accountId: null, evidence: { postIds: facts.bestContent.items.map((i) => i.postId) } });
  }
  if (facts.underperformingContent.items.length > 0) {
    needs.push({ id: "underperforming_content", text: m.insights.under(facts.underperformingContent.items.length), accountId: null, evidence: { postIds: facts.underperformingContent.items.map((i) => i.postId) } });
  }
  for (const a of facts.trends) {
    for (const t of a.metrics) {
      const p = t.vsBaseline.percentChange;
      if (p === null || Math.abs(p) < NOTABLE_CHANGE_PCT) continue;
      const item: ReportInsightItem = {
        id: `trend_${t.metricId}_${p > 0 ? "above" : "below"}:${a.accountId}`,
        text: (p > 0 ? m.insights.trendAbove : m.insights.trendBelow)(a.handle, m.trend[t.metricId].toLowerCase(), fmtPct(locale, p, 1, false)),
        accountId: a.accountId,
        evidence: { metricId: t.metricId, values: { current: t.current.value, baselineMedian: t.baseline.median, percentChange: p } },
      };
      (p > 0 ? wentWell : needs).push(item);
    }
  }

  // ---- 9. Actions --------------------------------------------------------------------------
  const actions: Omit<ReportAction, "rank">[] = [];
  const addAction = (kind: ReportActionKind, priority: ReportAction["priority"], accountId: string | null, text: [string, string, string]) => {
    if (actions.some((x) => x.kind === kind && x.accountId === accountId)) return;
    actions.push({ kind, priority, accountId, title: text[0], description: text[1], successMetric: text[2], evaluationWindowDays: ACTION_WINDOW_DAYS[kind], relatedRecommendationId: null });
  };
  for (const c of facts.consistency) {
    if (c.atGeneration.isDisconnected) addAction("reconnect_account", "high", c.accountId, m.actions.reconnect_account(c.handle));
  }
  for (const c of facts.consistency) {
    if (c.failedCount > 0) addAction("fix_publish_failures", "high", c.accountId, m.actions.fix_publish_failures(c.handle, c.failedCount));
  }
  for (const c of facts.consistency) {
    const g = c.atGeneration;
    if (g.isDisconnected || g.freshness !== "fresh") continue;
    if (g.coverageState === "critical" || g.coverageState === "empty" || g.coverageState === "warning") {
      addAction(
        "replenish_queue",
        g.coverageState === "warning" ? "medium" : "high",
        c.accountId,
        m.actions.replenish_queue(c.handle, n0(g.postsNeeded), g.firstUncoveredSlot ? dt(g.firstUncoveredSlot) : null, g.coveredDays === null ? null : n1(g.coveredDays)),
      );
    }
  }
  for (const c of facts.consistency) {
    if (!c.atGeneration.isDisconnected && c.atGeneration.freshness !== "fresh" && c.cadenceMode !== "paused") addAction("resolve_sync", "medium", c.accountId, m.actions.resolve_sync(c.handle));
  }
  for (const c of facts.consistency) {
    if (c.status === "below_plan" && c.missedSlots !== null && c.plannedSlots !== null) addAction("restore_cadence", "medium", c.accountId, m.actions.restore_cadence(c.handle, n0(c.missedSlots), n0(c.plannedSlots)));
  }
  if (top) addAction("repeat_top_format", "medium", top.accountId, m.actions.repeat_top_format(top.handle, top.format ?? m.content.unknownFormat, fmtRatio(locale, top.score)));
  if (facts.underperformingContent.items.length > 0) addAction("review_underperforming", "low", null, m.actions.review_underperforming(facts.underperformingContent.items.length));
  if (isPreliminary) addAction("wait_for_metrics", "low", null, m.actions.wait_for_metrics());
  if (!facts.hasTaggedPosts && facts.totals.postsPublished > 0) addAction("tag_content_pillars", "low", null, m.actions.tag_content_pillars(false));
  if (facts.consistency.some((c) => c.status === "on_track")) addAction("maintain_cadence", "low", null, m.actions.maintain_cadence());
  const rankOf = { high: 0, medium: 1, low: 2 } as const;
  const prioritized = actions.map((a, i) => ({ a, i })).sort((x, y) => rankOf[x.a.priority] - rankOf[y.a.priority] || x.i - y.i).map((x) => x.a).slice(0, MAX_ACTIONS);
  if (facts.totals.accounts > 0) {
    const fillers: [ReportActionKind, () => [string, string, string]][] = [
      ["maintain_cadence", () => m.actions.maintain_cadence()],
      ["track_success_metrics", () => m.actions.track_success_metrics()],
      ["tag_content_pillars", () => m.actions.tag_content_pillars(facts.hasTaggedPosts)],
    ];
    for (const [kind, text] of fillers) {
      if (prioritized.length >= MIN_ACTIONS) break;
      if (prioritized.some((x) => x.kind === kind)) continue;
      const t = text();
      prioritized.push({ kind, priority: "low", accountId: null, title: t[0], description: t[1], successMetric: t[2], evaluationWindowDays: ACTION_WINDOW_DAYS[kind], relatedRecommendationId: null });
    }
  }
  const actionItems: ReportAction[] = prioritized.map((a, i) => ({ ...a, rank: i + 1 }));

  // ---- 1. Executive summary ----------------------------------------------------------------
  const highlights: string[] = [];
  if (facts.totals.accounts === 0) highlights.push(m.summary.noAccounts);
  else {
    highlights.push(
      m.summary.period(fmtDate(locale, facts.period.start), fmtDate(locale, facts.period.end), facts.totals.postsPublished, n0(facts.totals.postsPublished), facts.totals.accounts, n0(facts.totals.postsPublishedPrevious)),
    );
    let viewsLines = 0;
    for (const a of facts.kpis) {
      const views = a.rows.find((r) => r.metricId === "views");
      if (!views || views.comparison.percentChange === null || views.comparison.ageHours === null || viewsLines >= 2) continue;
      highlights.push(m.summary.viewsChange(a.handle, fmtAge(locale, views.comparison.ageHours), pct(views.comparison.percentChange)));
      viewsLines++;
    }
    if (top) highlights.push(m.summary.best(facts.bestContent.items.length, fmtRatio(locale, RANKING_PARAMETERS.bestMinRatio), top.handle, fmtRatio(locale, top.score)));
    if (facts.underperformingContent.items.length > 0) highlights.push(m.summary.under(facts.underperformingContent.items.length, fmtRatio(locale, RANKING_PARAMETERS.underperformingMaxRatio)));
    if (facts.totals.failedPosts > 0) highlights.push(m.summary.failures(facts.totals.failedPosts));
    const atRisk = facts.consistency.filter((c) => c.atGeneration.freshness === "fresh" && (c.atGeneration.coverageState === "critical" || c.atGeneration.coverageState === "empty")).length;
    if (atRisk > 0) highlights.push(m.summary.coverageRisk(atRisk));
  }
  highlights.push(isPreliminary ? m.summary.preliminary : m.summary.final);

  // ---- 10. Data quality --------------------------------------------------------------------
  const parts: string[] = [];
  const pending = facts.dataQuality.reduce((s, q) => s + q.metricsPendingPosts, 0);
  const notRefreshed = facts.dataQuality.reduce((s, q) => s + q.metricsNotRefreshedAfterPeriodEnd, 0);
  if (pending > 0) parts.push(m.quality.pendingPart(pending));
  if (notRefreshed > 0) parts.push(m.quality.notRefreshedPart(notRefreshed));
  for (const q of facts.dataQuality) {
    if (q.notReportedMetrics.length) parts.push(`${q.handle}: ${m.quality.notReportedPart(q.notReportedMetrics.map((k) => m.metric[k as keyof Messages["metric"]] ?? k).join(", "))}`);
    if (q.likelyNotReportedMetrics.length) parts.push(`${q.handle}: ${m.quality.likelyNotReportedPart(q.likelyNotReportedMetrics.map((k) => m.metric[k as keyof Messages["metric"]] ?? k).join(", "))}`);
  }
  const noComparison = facts.dataQuality.filter((q) => q.postsInPeriod > 0 && q.comparisonAgeHours === null).length;
  if (noComparison > 0) parts.push(m.quality.noComparisonPart(noComparison));
  const limitations = [...m.quality.limitations];
  const platformsSeen = [...new Set(facts.dataQuality.map((q) => q.platform))].sort();
  for (const p of platformsSeen) {
    const q = facts.dataQuality.find((x) => x.platform === p)!;
    limitations.push(`${m.labels.platforms[p]}: ${m.quality.unsupportedNote(q.unsupportedMetrics.map((k) => m.metric[k as keyof Messages["metric"]] ?? k).join(", "))}`);
  }
  if (facts.brand.requestedLocale.trim().toLowerCase() !== locale.toLowerCase()) limitations.push(m.quality.localeFallback(facts.brand.requestedLocale));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    locale,
    timezone: tz,
    brand: { id: facts.brand.id, name: facts.brand.name },
    period: facts.period,
    generatedAt: facts.observationCutoff,
    status: isPreliminary ? "preliminary" : "final",
    narrativeSource: "deterministic",
    narrativeMeta: { source: "deterministic", model: null, fallbackReason: null },
    labels: m.labels,
    executiveSummary: { narrative: highlights.join(" "), highlights },
    kpiTable: {
      narrative: m.kpiNarrative(facts.totals.accounts, cutoff),
      comparisonNote: m.comparisonNote(fmtAge(locale, COMPARISON_PARAMETERS.targetAgeHours), n0(COMPARISON_PARAMETERS.minMedianSample)),
      accounts: kpiAccounts,
    },
    publicationConsistency: { narrative: consistencyNarrative, accounts: consistencyAccounts },
    bestContent,
    underperformingContent,
    audienceAndEngagementTrends: {
      narrative: trendsNarrative,
      audience: {
        status: "unsupported",
        message: m.trends.audience,
        accounts: facts.kpis.map((a) => ({
          accountId: a.accountId,
          handle: a.handle,
          displayName: a.displayName,
          platform: a.platform,
          followers: { value: null, status: "unsupported", na: { code: "requires_direct_connection", message: m.na.requires_direct_connection }, unit: "people", postsIncluded: 0, postsTotal: 0, containsZeroUncertainty: false },
        })),
      },
      engagement,
    },
    wentWell: { narrative: wentWell.length ? m.insights.wentWellNarrative(wentWell.length) : m.insights.wentWellEmpty, items: wentWell },
    needsImprovement: { narrative: needs.length ? m.insights.needsNarrative(needs.length) : m.insights.needsEmpty, items: needs },
    actions: { narrative: m.actions.narrative, items: actionItems },
    dataQuality: {
      narrative: m.quality.narrative(cutoff, isPreliminary),
      generatedAt: facts.observationCutoff,
      observationCutoff: facts.observationCutoff,
      isPreliminary,
      preliminaryReasons: facts.preliminaryReasons.map((r) => ({ ...r, message: m.preliminary[r.code](r.accountId ? handleOf.get(r.accountId) ?? r.accountId : null) })),
      comparisonMethod: m.quality.comparisonMethod(
        fmtAge(locale, COMPARISON_PARAMETERS.targetAgeHours),
        n0(COMPARISON_PARAMETERS.minComparisonAgeHours),
        n0(COMPARISON_PARAMETERS.maxToleranceHours),
        n0(COMPARISON_PARAMETERS.minMedianSample),
      ),
      accounts: facts.dataQuality,
      missingDataStatement: parts.length === 0 ? m.quality.complete(cutoff) : m.quality.incomplete(parts),
      limitations,
    },
  };
}
