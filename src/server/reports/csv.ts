/**
 * CSV export of a report version (RFC 4180: comma separator, CRLF line endings, double-quote escaping) with a UTF-8
 * BOM so spreadsheet tools detect the encoding.
 *
 * Formula-injection neutralization: TEXT cells starting with = + - @ TAB or CR get a leading apostrophe. Numeric
 * cells are serialized from finite JS numbers (digits, '.', '-', 'e' only) and are left untouched so negative changes
 * stay numeric; they cannot carry a formula payload. Missing values are empty cells with an explicit `status` and
 * `na_reason`, never 0.
 */
import type { WeeklyReportContent } from "./types";

export const CSV_COLUMNS = [
  "section",
  "account",
  "platform",
  "metric",
  "definition",
  "period",
  "basis",
  "value",
  "status",
  "change",
  "change_pct",
  "na_reason",
  "posts_included",
  "posts_total",
  "source",
  "observed_at",
  "post_id",
  "post_url",
] as const;

export type CsvValue = string | number | boolean | null | undefined;
type CsvRow = Partial<Record<(typeof CSV_COLUMNS)[number], CsvValue>>;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    s = String(value);
  } else {
    s = String(value);
    if (FORMULA_START.test(s)) s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvValue[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function reportCsvRows(content: WeeklyReportContent): CsvRow[] {
  const rows: CsvRow[] = [];
  const week = `${content.period.start}/${content.period.end}`;
  const previousWeek = `${content.period.previousStart}/${content.period.previousEnd}`;

  for (const a of content.kpiTable.accounts) {
    for (const r of a.rows) {
      const base = { section: "kpi", account: a.handle, platform: a.platform, metric: r.metricId, definition: r.definitionId, source: r.source };
      rows.push({
        ...base,
        period: week,
        basis: r.aggregation === "count" ? "count" : "lifetime_to_date",
        value: r.latest.value,
        status: r.latest.status,
        na_reason: r.latest.na?.code,
        posts_included: r.latest.postsIncluded,
        posts_total: r.latest.postsTotal,
        observed_at: r.latest.observedAtMax,
      });
      if (r.aggregation === "count") {
        rows.push({ ...base, period: previousWeek, basis: "count", value: r.comparison.previous.value, status: r.comparison.previous.status, na_reason: r.comparison.previous.na?.code });
        const last = rows[rows.length - 2]!;
        last.change = r.comparison.absoluteChange;
        last.change_pct = r.comparison.percentChange;
        if (r.comparison.na) last.na_reason = r.comparison.na.code;
        continue;
      }
      const basis = r.comparison.ageHours === null ? "age_matched" : `age_matched_${r.comparison.ageHours}h`;
      rows.push({
        ...base,
        period: week,
        basis,
        value: r.comparison.current.value,
        status: r.comparison.current.status,
        change: r.comparison.absoluteChange,
        change_pct: r.comparison.percentChange,
        na_reason: r.comparison.na?.code ?? r.comparison.percentNa?.code ?? r.comparison.current.na?.code,
        posts_included: r.comparison.current.postsIncluded,
        posts_total: r.comparison.current.postsTotal,
      });
      rows.push({
        ...base,
        period: previousWeek,
        basis,
        value: r.comparison.previous.value,
        status: r.comparison.previous.status,
        na_reason: r.comparison.previous.na?.code,
        posts_included: r.comparison.previous.postsIncluded,
        posts_total: r.comparison.previous.postsTotal,
      });
    }
  }

  for (const c of content.publicationConsistency.accounts) {
    const base = { section: "consistency", account: c.handle, platform: c.platform, definition: `cadence:${c.cadenceMode}${c.isEstimate ? ":estimate" : ""}`, period: week, source: "brandpulse:posts" };
    rows.push({ ...base, metric: "planned_slots", value: c.plannedSlots, status: c.plannedSlots === null ? "unavailable" : "available", na_reason: c.plannedSlots === null ? c.status : null });
    rows.push({ ...base, metric: "slots_covered_by_published", value: c.slotsCoveredByPublished, status: c.slotsCoveredByPublished === null ? "unavailable" : "available", change_pct: null });
    rows.push({ ...base, metric: "slot_coverage_pct", value: c.slotCoveragePct, status: c.slotCoveragePct === null ? "unavailable" : "available" });
    rows.push({ ...base, metric: "posts_published", value: c.publishedCount.value, status: c.publishedCount.status, na_reason: c.publishedCount.na?.code });
    rows.push({ ...base, metric: "publish_failures", value: c.failedCount, status: "available" });
    rows.push({
      ...base,
      metric: "queue_coverage_state_at_generation",
      basis: "at_generation",
      value: null,
      status: c.atGeneration.coverageState,
      na_reason: c.atGeneration.freshness === "fresh" ? null : c.atGeneration.freshness,
      observed_at: c.atGeneration.at,
      source: "buffer:queue",
    });
  }

  const content_rows = (section: string, items: WeeklyReportContent["bestContent"]["items"]) => {
    for (const it of items) {
      rows.push({
        section,
        account: it.handle,
        platform: it.platform,
        metric: "views_vs_cohort_median",
        definition: `rank:views_ratio:${it.format ?? "unknown"}`,
        period: week,
        basis: `rank_${it.rank}`,
        value: it.score,
        status: `confidence_${it.confidence}`,
        posts_included: it.cohortSize,
        source: "buffer:post_metrics",
        observed_at: it.metricsUpdatedAt,
        post_id: it.postId,
        post_url: it.externalUrl,
      });
    }
  };
  content_rows("best_content", content.bestContent.items);
  content_rows("underperforming_content", content.underperformingContent.items);

  for (const a of content.audienceAndEngagementTrends.audience.accounts) {
    rows.push({ section: "audience", account: a.handle, platform: a.platform, metric: "followers", period: week, status: a.followers.status, na_reason: a.followers.na?.code, source: "buffer" });
  }
  for (const a of content.audienceAndEngagementTrends.engagement) {
    for (const t of a.metrics) {
      const base = { section: "trend", account: a.handle, platform: a.platform, metric: t.metricId, definition: t.definitionId, source: "buffer:metric_observations" };
      for (const w of t.weeks) {
        rows.push({ ...base, period: w.weekStart, basis: `week_age_matched_${t.ageHours}h`, value: w.value, status: w.value === null ? "unavailable" : w.complete ? "available" : "partial", posts_included: w.postsIncluded });
      }
      rows.push({
        ...base,
        period: week,
        basis: "vs_baseline_4w_median",
        value: t.baseline.median,
        status: t.baseline.status === "available" ? "available" : "unavailable",
        change: t.vsBaseline.absoluteChange,
        change_pct: t.vsBaseline.percentChange,
        na_reason: t.vsBaseline.na?.code ?? t.baseline.na?.code,
      });
    }
  }
  return rows;
}

export function reportToCsv(content: WeeklyReportContent): string {
  const header = [...CSV_COLUMNS] as CsvValue[];
  return toCsv([header, ...reportCsvRows(content).map((r) => CSV_COLUMNS.map((c) => r[c]))]);
}
