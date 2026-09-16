/**
 * In-app renderer for WeeklyReportContent (schemaVersion 1). Narratives, labels and NA messages are already in the
 * report locale and are rendered as plain text. Captions and provider messages are untrusted and never parsed.
 */
import type { MetricCell, ReportUnit, WeeklyReportContent } from "@/server/reports/types";
import { Icon } from "@/components/ui/Icon";

type C = WeeklyReportContent;

function unitSuffix(unit: ReportUnit): string {
  return unit === "percent" ? "%" : unit === "seconds" ? " s" : unit === "minutes" ? " min" : unit === "hours" ? " h" : unit === "days" ? " d" : unit === "ratio" ? "×" : "";
}

function num(c: C, n: number, digits = 1): string {
  return new Intl.NumberFormat(c.locale, { maximumFractionDigits: digits }).format(n);
}

function cell(c: C, m: MetricCell): string {
  if (m.value === null) return m.na?.message ?? c.labels.statuses[m.status];
  const digits = m.unit === "percent" ? 2 : 1;
  return `${num(c, m.value, digits)}${unitSuffix(m.unit)}${m.containsZeroUncertainty ? "*" : ""}${m.status === "partial" ? ` (${c.labels.statuses.partial})` : ""}`;
}

function when(c: C, iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(c.locale, { dateStyle: "medium", timeStyle: "short", timeZone: c.timezone, timeZoneName: "short" }).format(d);
}

function Narrative({ text }: { text: string }) {
  return text ? <p className="whitespace-pre-line leading-relaxed">{text}</p> : null;
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`rs-${n}`} className="rounded-lg border border-line bg-surface p-4 sm:p-6">
      <h2 id={`rs-${n}`} className="mb-3 text-lg font-semibold">
        <span className="mr-2 text-ink-2">{n}.</span>
        {title}
      </h2>
      <div className="space-y-3 text-sm">{children}</div>
    </section>
  );
}

function change(c: C, abs: number | null, pct: number | null, unit: ReportUnit, na: { message: string } | null, percentNa?: { message: string } | null) {
  if (abs === null) return <span className="text-ink-2">{na?.message ?? "—"}</span>;
  const u = unit === "percent" ? " pp" : unitSuffix(unit);
  return (
    <span className={abs > 0 ? "text-healthy" : abs < 0 ? "text-critical" : ""}>
      {abs > 0 ? "+" : ""}
      {num(c, abs, 2)}
      {u}
      {pct !== null ? ` (${pct > 0 ? "+" : ""}${num(c, pct, 1)}%)` : percentNa ? <span className="block text-xs text-ink-2">{percentNa.message}</span> : null}
    </span>
  );
}

export function ReportView({ content: c }: { content: WeeklyReportContent }) {
  const L = c.labels;
  const acct = (a: { handle: string; platform: keyof typeof L.platforms }) => `@${a.handle.replace(/^@/, "")} · ${L.platforms[a.platform]}`;
  return (
    <article lang={c.locale} className="space-y-4">
      <Section n={1} title={L.sections.executiveSummary}>
        <Narrative text={c.executiveSummary.narrative} />
        {c.executiveSummary.highlights.length ? (
          <ul className="list-disc space-y-1 pl-5">
            {c.executiveSummary.highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section n={2} title={L.sections.kpiTable}>
        <Narrative text={c.kpiTable.narrative} />
        <p className="text-xs text-ink-2">{c.kpiTable.comparisonNote}</p>
        {c.kpiTable.accounts.map((a) => (
          <div key={a.accountId} className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <caption className="py-1 text-left font-semibold">{acct(a)}</caption>
              <thead>
                <tr>
                  <th scope="col">{L.columns.metric}</th>
                  <th scope="col">{L.columns.latest}</th>
                  <th scope="col">{L.columns.current}</th>
                  <th scope="col">{L.columns.previous}</th>
                  <th scope="col">{L.columns.change}</th>
                  <th scope="col">{L.columns.definition}</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr key={r.definitionId}>
                    <th scope="row" className="font-medium">
                      {r.label}
                    </th>
                    <td className="tabular-nums">{cell(c, r.latest)}</td>
                    <td className="tabular-nums">{cell(c, r.comparison.current)}</td>
                    <td className="tabular-nums">{cell(c, r.comparison.previous)}</td>
                    <td className="tabular-nums">{change(c, r.comparison.absoluteChange, r.comparison.percentChange, r.unit, r.comparison.na, r.comparison.percentNa)}</td>
                    <td>
                      <code className="text-[11px] text-ink-2">{r.definitionId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Section>

      <Section n={3} title={L.sections.publicationConsistency}>
        <Narrative text={c.publicationConsistency.narrative} />
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th scope="col">{L.columns.account}</th>
                <th scope="col">{L.columns.plannedSlots}</th>
                <th scope="col">{L.columns.published}</th>
                <th scope="col">{L.columns.failed}</th>
                <th scope="col">{L.columns.coverageNow}</th>
                <th scope="col">{L.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {c.publicationConsistency.accounts.map((a) => (
                <tr key={a.accountId}>
                  <th scope="row" className="font-medium">
                    {acct(a)}
                    {a.notes.length ? (
                      <ul className="mt-1 list-disc pl-4 text-xs font-normal text-ink-2">
                        {a.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    ) : null}
                  </th>
                  <td className="tabular-nums">
                    {a.plannedSlots ?? "—"}
                    {a.isEstimate ? "*" : ""}
                    {a.slotCoveragePct !== null ? <div className="text-xs text-ink-2">{num(c, a.slotCoveragePct, 0)}%</div> : null}
                  </td>
                  <td className="tabular-nums">{cell(c, a.publishedCount)}</td>
                  <td className="tabular-nums">
                    {a.failedCount}
                    {a.failedPosts.map((f) => (
                      <p key={f.postId} className="mt-1 max-w-xs whitespace-pre-wrap break-words text-xs text-critical">
                        {f.message}
                      </p>
                    ))}
                  </td>
                  <td className="text-xs">
                    {L.coverageStates[a.atGeneration.coverageState]}
                    {a.atGeneration.firstUncoveredSlot ? <div className="text-ink-2">{when(c, a.atGeneration.firstUncoveredSlot)}</div> : null}
                  </td>
                  <td className="text-xs">{a.status.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {([
        [4, L.sections.bestContent, c.bestContent],
        [5, L.sections.underperformingContent, c.underperformingContent],
      ] as const).map(([n, title, s]) => (
        <Section key={n} n={n} title={title}>
          <Narrative text={s.narrative} />
          <p className="rounded-md bg-canvas p-2 text-xs">{s.method}</p>
          <p className="text-xs text-ink-2">{s.fairnessNote}</p>
          {s.items.length === 0 ? (
            <p className="text-ink-2">{s.emptyReason}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{L.columns.account}</th>
                    <th scope="col">{L.columns.score}</th>
                    <th scope="col">{L.columns.views}</th>
                    <th scope="col">{L.columns.cohortMedian}</th>
                    <th scope="col">{L.columns.confidence}</th>
                    <th scope="col">{L.columns.link}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.items.map((it) => (
                    <tr key={it.postId}>
                      <td className="tabular-nums">{it.rank}</td>
                      <td className="max-w-xs">
                        <p className="font-medium">{acct(it)}</p>
                        <p className="text-xs text-ink-2">
                          {it.format ?? "—"} · {when(c, it.publishedAt)}
                        </p>
                        {it.textExcerpt ? <p className="mt-1 line-clamp-3 break-words text-xs">{it.textExcerpt}</p> : null}
                        <p className="mt-1 text-xs text-ink-2">{it.explanation}</p>
                      </td>
                      <td className="tabular-nums">{num(c, it.score, 2)}×</td>
                      <td className="tabular-nums">{num(c, it.views, 0)}</td>
                      <td className="tabular-nums">
                        {num(c, it.cohortMedianViews, 0)} <span className="text-xs text-ink-2">(n={it.cohortSize})</span>
                      </td>
                      <td>{L.confidences[it.confidence]}</td>
                      <td>
                        {it.externalUrl ? (
                          <a href={it.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                            <Icon name="external" className="h-3.5 w-3.5" />
                            <span className="sr-only">Abrir post original (abre em uma nova aba)</span>
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.excluded.length ? (
            <p className="text-xs text-ink-2">{s.excluded.map((e) => `${e.label}: ${e.count}`).join(" · ")}</p>
          ) : null}
        </Section>
      ))}

      <Section n={6} title={L.sections.audienceAndEngagementTrends}>
        <Narrative text={c.audienceAndEngagementTrends.narrative} />
        <div className="hatch-unavailable rounded-md border border-locked/30 p-2">
          <p className="rounded bg-surface/95 p-2 font-medium text-locked">{c.audienceAndEngagementTrends.audience.message}</p>
        </div>
        {c.audienceAndEngagementTrends.engagement.map((a) => (
          <div key={a.accountId}>
            <h3 className="mb-1 font-semibold">{acct(a)}</h3>
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <thead>
                  <tr>
                    <th scope="col">{L.columns.metric}</th>
                    {a.metrics[0]?.weeks.map((w) => (
                      <th key={w.weekStart} scope="col">
                        {w.weekStart}
                      </th>
                    ))}
                    <th scope="col">{L.columns.baseline}</th>
                    <th scope="col">{L.columns.change}</th>
                  </tr>
                </thead>
                <tbody>
                  {a.metrics.map((m) => (
                    <tr key={m.definitionId}>
                      <th scope="row" className="font-medium">
                        {m.label}
                        <div className="text-[11px] font-normal text-ink-2">
                          <code>{m.definitionId}</code>
                        </div>
                      </th>
                      {m.weeks.map((w) => (
                        <td key={w.weekStart} className="tabular-nums">
                          {w.value === null ? "—" : `${num(c, w.value, m.unit === "percent" ? 2 : 0)}${unitSuffix(m.unit)}`}
                          {!w.complete ? "†" : ""}
                        </td>
                      ))}
                      <td className="tabular-nums">{m.baseline.median === null ? (m.baseline.na?.message ?? "—") : `${num(c, m.baseline.median, 2)}${unitSuffix(m.unit)}`}</td>
                      <td className="tabular-nums">{change(c, m.vsBaseline.absoluteChange, m.vsBaseline.percentChange, m.unit, m.vsBaseline.na, m.vsBaseline.percentNa)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Section>

      {([
        [7, L.sections.wentWell, c.wentWell],
        [8, L.sections.needsImprovement, c.needsImprovement],
      ] as const).map(([n, title, s]) => (
        <Section key={n} n={n} title={title}>
          <Narrative text={s.narrative} />
          {s.items.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {s.items.map((it) => (
                <li key={it.id}>{it.text}</li>
              ))}
            </ul>
          ) : null}
        </Section>
      ))}

      <Section n={9} title={L.sections.actions}>
        <Narrative text={c.actions.narrative} />
        <ol className="space-y-2">
          {c.actions.items.map((a) => (
            <li key={`${a.rank}-${a.kind}`} className="rounded-md border border-line p-3">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                <span className="text-ink-2">{a.rank}.</span> {a.title}
                <span className={`rounded-full border px-2 py-0.5 text-xs ${a.priority === "high" ? "border-critical/40 text-critical" : a.priority === "medium" ? "border-warning/40 text-warning" : "border-line text-ink-2"}`}>
                  {L.columns.priority}: {L.priorities[a.priority]}
                </span>
              </p>
              <p className="mt-1">{a.description}</p>
              <p className="mt-1 text-xs text-ink-2">
                {L.columns.successMetric}: {a.successMetric} · {L.columns.evaluationWindow}: {a.evaluationWindowDays} {L.days}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section n={10} title={L.sections.dataQuality}>
        <Narrative text={c.dataQuality.narrative} />
        <p className="text-xs text-ink-2">
          {L.generatedAtLabel}: {when(c, c.dataQuality.generatedAt)} · corte de observação {when(c, c.dataQuality.observationCutoff)}
        </p>
        <p className="font-medium">{c.dataQuality.missingDataStatement}</p>
        {c.dataQuality.preliminaryReasons.length ? (
          <ul className="list-disc space-y-1 pl-5 text-stale">
            {c.dataQuality.preliminaryReasons.map((r, i) => (
              <li key={i}>{r.message}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs">{c.dataQuality.comparisonMethod}</p>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-xs">
            <thead>
              <tr>
                <th scope="col">{L.columns.account}</th>
                <th scope="col">{L.columns.lastSync}</th>
                <th scope="col">Posts</th>
                <th scope="col">Pendente</th>
                <th scope="col">Não suportado / não reportado</th>
              </tr>
            </thead>
            <tbody>
              {c.dataQuality.accounts.map((a) => (
                <tr key={a.accountId}>
                  <th scope="row" className="font-medium">
                    {acct(a)}
                  </th>
                  <td>
                    {when(c, a.lastPublishedSyncAt)}
                    <div className="text-ink-2">fila: {when(c, a.lastQueueSyncAt)} ({a.queueFreshness.replace(/_/g, " ")})</div>
                  </td>
                  <td className="tabular-nums">{a.postsInPeriod}</td>
                  <td className="tabular-nums">{a.metricsPendingPosts}</td>
                  <td className="max-w-xs break-words">
                    {[...a.unsupportedMetrics, ...a.notReportedMetrics, ...a.likelyNotReportedMetrics.map((m) => `${m}?`)].join(", ") || "—"}
                    {a.zeroUncertaintyMetrics.length ? <div className="text-ink-2">0*: {a.zeroUncertaintyMetrics.join(", ")}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {c.dataQuality.limitations.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">
            {c.dataQuality.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null}
      </Section>
    </article>
  );
}
