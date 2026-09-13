/**
 * PDF rendering of a report version with pdfkit standard fonts (Helvetica, WinAnsi encoding). WinAnsi covers the
 * Portuguese/Spanish accented letters (á à â ã é ê í ó ô õ ú ç ñ ¿ ¡); characters outside it are mapped to ASCII
 * equivalents (− ≥ ≤ → narrow spaces) or replaced, so text never renders as missing glyphs.
 */
import PDFDocument from "pdfkit";
import { fmtDate, fmtDateTime, fmtNumber, fmtPct, fmtRatio } from "./i18n";
import type { MetricCell, ReportLocale, WeeklyReportContent } from "./types";

/** Unicode code points (> 255) that pdfkit maps into WinAnsi. */
const WIN_ANSI_EXTRA = new Set([402, 8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224, 8225, 8226, 8230, 8364, 8240, 8249, 8250, 710, 8482, 338, 339, 732, 352, 353, 376, 381, 382]);
const REPLACEMENTS: Record<string, string> = { "−": "-", "≥": ">=", "≤": "<=", "→": "->", " ": " ", " ": " ", " ": " ", " ": " " };

export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if (cp === 10 || (cp >= 32 && cp < 127) || (cp >= 160 && cp <= 255) || WIN_ANSI_EXTRA.has(cp)) out += ch;
    else if (cp < 32 || (cp >= 127 && cp < 160)) out += " ";
    else out += "?";
  }
  return out;
}

function formatValue(locale: ReportLocale, c: MetricCell, labels: WeeklyReportContent["labels"]): string {
  if (c.value === null) return labels.statuses[c.status];
  const v = c.unit === "percent" ? fmtPct(locale, c.value, 2, false) : fmtNumber(locale, c.value, c.unit === "count" || c.unit === "posts" || c.unit === "people" ? 0 : 1);
  const partial = c.status === "partial" ? ` (${labels.statuses.partial.toLowerCase()} ${c.postsIncluded}/${c.postsTotal})` : "";
  return `${v}${c.containsZeroUncertainty ? "*" : ""}${partial}`;
}

export async function buildReportPdf(content: WeeklyReportContent, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const locale = content.locale;
  const L = content.labels;
  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    compress: opts.compress ?? true,
    info: {
      Title: toWinAnsi(`${L.reportTitle} - ${content.brand.name} - ${content.period.start}`),
      Author: "BrandPulse",
      Creator: "BrandPulse",
      CreationDate: new Date(content.generatedAt),
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  const ensure = (h: number) => {
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
  };
  const heading = (t: string, size = 14) => {
    ensure(40);
    doc.moveDown(0.6).font("Helvetica-Bold").fontSize(size).fillColor("#111111").text(toWinAnsi(t), left, doc.y, { width });
    doc.moveDown(0.25);
  };
  const para = (t: string, size = 10, color = "#222222") => {
    if (!t) return;
    ensure(24);
    doc.font("Helvetica").fontSize(size).fillColor(color).text(toWinAnsi(t), left, doc.y, { width });
    doc.moveDown(0.3);
  };
  const bullet = (t: string) => {
    ensure(20);
    doc.font("Helvetica").fontSize(10).fillColor("#222222").text(toWinAnsi(`• ${t}`), left + 8, doc.y, { width: width - 8 });
    doc.moveDown(0.15);
  };
  const row = (cols: string[], widths: number[], bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor("#222222");
    const texts = cols.map((c) => toWinAnsi(c));
    const h = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: (widths[i] as number) - 4 })));
    ensure(h + 4);
    const y = doc.y;
    let x = left;
    texts.forEach((t, i) => {
      doc.text(t, x, y, { width: (widths[i] as number) - 4 });
      x += widths[i] as number;
    });
    doc.x = left;
    doc.y = y + h + 3;
  };
  const change = (abs: number | null, pct: number | null, na: { message: string } | null, percentNa: { message: string } | null) => {
    if (abs === null) return na ? `${L.statuses.unavailable}: ${na.message}` : L.statuses.unavailable;
    const absText = `${abs > 0 ? "+" : abs < 0 ? "-" : ""}${fmtNumber(locale, Math.abs(abs), 1)}`;
    return pct === null ? `${absText}${percentNa ? ` (${percentNa.message})` : ""}` : `${fmtPct(locale, pct, 1)} (${absText})`;
  };

  // Header
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111111").text(toWinAnsi(`${L.reportTitle}: ${content.brand.name}`), left, doc.y, { width });
  para(`${L.periodLabel}: ${fmtDate(locale, content.period.start)} - ${fmtDate(locale, content.period.end)} (${content.timezone})`);
  para(`${L.generatedAtLabel}: ${fmtDateTime(locale, content.generatedAt, content.timezone)} · ${content.status === "preliminary" ? L.preliminaryBadge : L.finalBadge}`);
  if (content.status === "preliminary") para(L.preliminaryBanner, 10, "#946200");

  // 1
  heading(L.sections.executiveSummary);
  para(content.executiveSummary.narrative);

  // 2
  heading(L.sections.kpiTable);
  para(content.kpiTable.narrative);
  para(content.kpiTable.comparisonNote, 8.5, "#555555");
  const kw = [width * 0.26, width * 0.17, width * 0.17, width * 0.17, width * 0.23];
  for (const a of content.kpiTable.accounts) {
    heading(`${a.handle} · ${L.platforms[a.platform]}`, 11);
    row([L.columns.metric, L.columns.latest, L.columns.current, L.columns.previous, L.columns.change], kw, true);
    for (const r of a.rows) {
      row([r.label, formatValue(locale, r.latest, L), formatValue(locale, r.comparison.current, L), formatValue(locale, r.comparison.previous, L), change(r.comparison.absoluteChange, r.comparison.percentChange, r.comparison.na, r.comparison.percentNa)], kw);
    }
  }

  // 3
  heading(L.sections.publicationConsistency);
  para(content.publicationConsistency.narrative);
  for (const c of content.publicationConsistency.accounts) {
    heading(`${c.handle} · ${L.platforms[c.platform]}`, 11);
    para(
      `${L.columns.plannedSlots}: ${c.plannedSlots ?? L.statuses.unavailable} · ${L.columns.published}: ${formatValue(locale, c.publishedCount, L)} · ${L.columns.failed}: ${c.failedCount} · ${L.columns.coverageNow}: ${L.coverageStates[c.atGeneration.coverageState]}`,
    );
    c.notes.forEach(bullet);
    c.failedPosts.forEach((f) => bullet(`${f.dueAt ? fmtDateTime(locale, f.dueAt, content.timezone) : "-"}: ${f.message}`));
  }

  // 4 & 5
  for (const [title, section] of [
    [L.sections.bestContent, content.bestContent],
    [L.sections.underperformingContent, content.underperformingContent],
  ] as const) {
    heading(title);
    para(section.narrative);
    para(section.method, 8.5, "#555555");
    para(section.fairnessNote, 8.5, "#555555");
    for (const it of section.items) {
      bullet(`#${it.rank} ${it.handle} · ${L.platforms[it.platform]} · ${it.format ?? "-"} · ${L.columns.score}: ${fmtRatio(locale, it.score)} · ${L.columns.confidence}: ${L.confidences[it.confidence]}`);
      para(it.explanation, 9);
      if (it.externalUrl) para(`${L.columns.link}: ${it.externalUrl}`, 8.5, "#1a4d8f");
    }
    if (section.excluded.length) para(section.excluded.map((e) => `${e.label}: ${e.count}`).join(" · "), 8.5, "#555555");
  }

  // 6
  heading(L.sections.audienceAndEngagementTrends);
  para(`${L.audienceUnavailable}. ${content.audienceAndEngagementTrends.audience.message}`);
  para(content.audienceAndEngagementTrends.narrative);
  for (const a of content.audienceAndEngagementTrends.engagement) {
    for (const t of a.metrics) {
      const fmt = (v: number) => (t.unit === "percent" ? fmtPct(locale, v, 2, false) : fmtNumber(locale, v, 1));
      const current = t.current.value === null ? `${L.statuses[t.current.status]}${t.current.na ? ` (${t.current.na.message})` : ""}` : fmt(t.current.value);
      const baseline = t.baseline.median === null ? `${L.statuses.unavailable}${t.baseline.na ? ` (${t.baseline.na.message})` : ""}` : fmt(t.baseline.median);
      bullet(`${a.handle} · ${t.label}: ${current} · ${L.columns.baseline}: ${baseline} · ${L.columns.change}: ${change(t.vsBaseline.absoluteChange, t.vsBaseline.percentChange, t.vsBaseline.na, t.vsBaseline.percentNa)}`);
    }
  }

  // 7, 8
  heading(L.sections.wentWell);
  para(content.wentWell.narrative);
  content.wentWell.items.forEach((i) => bullet(i.text));
  heading(L.sections.needsImprovement);
  para(content.needsImprovement.narrative);
  content.needsImprovement.items.forEach((i) => bullet(i.text));

  // 9
  heading(L.sections.actions);
  para(content.actions.narrative);
  for (const a of content.actions.items) {
    bullet(`${a.rank}. [${L.priorities[a.priority]}] ${a.title}`);
    para(`${a.description} ${L.columns.successMetric}: ${a.successMetric}. ${L.columns.evaluationWindow}: ${a.evaluationWindowDays} ${L.days}.`, 9);
  }

  // 10
  heading(L.sections.dataQuality);
  para(content.dataQuality.narrative);
  para(content.dataQuality.missingDataStatement);
  content.dataQuality.preliminaryReasons.forEach((r) => bullet(r.message));
  para(content.dataQuality.comparisonMethod, 8.5, "#555555");
  for (const q of content.dataQuality.accounts) {
    bullet(`${q.handle} · ${L.platforms[q.platform]} · ${L.columns.lastSync}: ${q.lastPublishedSyncAt ? fmtDateTime(locale, q.lastPublishedSyncAt, content.timezone) : L.statuses.unavailable}`);
  }
  content.dataQuality.limitations.forEach(bullet);

  doc.end();
  return done;
}
