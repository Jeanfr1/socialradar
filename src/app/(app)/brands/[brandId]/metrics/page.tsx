import type { Metadata } from "next";
import { Delta, PeriodNav, PlatformTag, Section, Segmented, fmtCount, fmtRate, nf } from "@/components/app/bits";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadMetrics, type MetricValueVM } from "@/server/queries/pages/workspace";

export const metadata: Metadata = { title: "Métricas" };

function Kpi({ label, value, metric, hint }: { label: string; value: string; metric: MetricValueVM; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4" title={hint}>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink sm:text-[28px]">{value}</p>
      <div className="mt-1">
        <Delta value={metric.change} unit={metric.changeUnit} />
      </div>
    </div>
  );
}

export default async function MetricsPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const kind = oneOf(param(sp, "periodo"), ["semana", "mes"] as const, "semana") === "mes" ? "month" : "week";
  const user = await requireUser("page");
  const vm = await orNotFound(loadMetrics(getDb(), user, brandId, { kind, start: param(sp, "inicio") }, new Date()));
  const base = `/brands/${vm.brand.id}/metrics`;
  const periodParam = kind === "month" ? "mes" : "semana";
  const href = (start: string | null, k = periodParam) => `${base}?periodo=${k}${start ? `&inicio=${start}` : ""}`;
  const maxDaily = Math.max(1, ...vm.daily.map((d) => d.views));
  const t = vm.totals;

  return (
    <div className="space-y-5">
      <h1 className="sr-only">Métricas de {vm.brand.name}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          active={periodParam}
          options={[
            { key: "semana", label: "Semana", href: href(null, "semana") },
            { key: "mes", label: "Mês", href: href(null, "mes") },
          ]}
        />
        <PeriodNav
          label={vm.period.label}
          prevHref={href(vm.period.prevStart)}
          nextHref={vm.period.nextStart ? href(vm.period.nextStart) : null}
          badge={vm.period.inProgress ? "em andamento" : null}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Visualizações" value={fmtCount(t.views.value)} metric={t.views} hint="Soma das visualizações dos posts publicados no período (acumulado até hoje)." />
        <Kpi label="Engajamento" value={fmtCount(t.engagement.value)} metric={t.engagement} hint="Reações + comentários + compartilhamentos + salvamentos dos posts do período." />
        <Kpi label="Taxa de engajamento" value={fmtRate(t.rate.value)} metric={t.rate} hint="Engajamento ÷ visualizações. A variação é em pontos percentuais." />
        <Kpi label="Posts publicados" value={fmtCount(t.posts.value)} metric={t.posts} hint="Posts publicados no período." />
      </div>

      <Section title={vm.period.kind === "month" ? "Visualizações por dia de publicação" : "Visualizações por dia"}>
        {vm.daily.every((d) => d.views === 0) ? (
          <p className="text-sm text-ink-2">Sem visualizações registradas neste período.</p>
        ) : (
          <div className="flex h-40 items-end gap-1" role="img" aria-label={`Visualizações por dia de publicação em ${vm.period.label}`}>
            {vm.daily.map((d) => (
              <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${d.label}: ${nf.format(d.views)} visualizações`}>
                <div className="w-full rounded-t bg-accent/80" style={{ height: `${Math.max(d.views > 0 ? 3 : 0, (d.views / maxDaily) * 100)}%` }} />
                <span className="truncate text-[10px] text-ink-2">{d.label}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Por conta">
        {vm.accounts.length === 0 ? (
          <p className="text-sm text-ink-2">Nenhuma conta ligada a esta marca.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-2">
                  <th className="py-2 pr-3 font-medium">Conta</th>
                  <th className="px-3 py-2 text-right font-medium">Posts</th>
                  <th className="px-3 py-2 text-right font-medium">Visualizações</th>
                  <th className="px-3 py-2 text-right font-medium">Engajamento</th>
                  <th className="py-2 pl-3 text-right font-medium">Taxa</th>
                </tr>
              </thead>
              <tbody>
                {vm.accounts.map((r) => (
                  <tr key={r.account.id} className="border-b border-line last:border-0">
                    <td className="py-2.5 pr-3">
                      <span className="flex items-center gap-2">
                        <PlatformTag platform={r.account.platform} />
                        <span className="truncate font-medium text-ink">{r.account.handle}</span>
                      </span>
                    </td>
                    {[
                      [fmtCount(r.posts.value), r.posts],
                      [fmtCount(r.views.value), r.views],
                      [fmtCount(r.engagement.value), r.engagement],
                    ].map(([text, m], i) => (
                      <td key={i} className="px-3 py-2.5 text-right">
                        <div className="tabular-nums text-ink">{text as string}</div>
                        <Delta value={(m as MetricValueVM).change} unit={(m as MetricValueVM).changeUnit} />
                      </td>
                    ))}
                    <td className="py-2.5 pl-3 text-right">
                      <div className="tabular-nums text-ink">{fmtRate(r.rate.value)}</div>
                      <Delta value={r.rate.change} unit="pp" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Posts com mais visualizações">
        {vm.topPosts.length === 0 ? (
          <p className="text-sm text-ink-2">Nenhum post com visualizações neste período.</p>
        ) : (
          <ol className="divide-y divide-line">
            {vm.topPosts.map((p, i) => (
              <li key={p.id} className="flex items-center gap-3 py-2.5">
                <span className="w-5 text-center text-sm font-semibold text-ink-2">{i + 1}</span>
                <PlatformTag platform={p.platform} />
                <div className="min-w-0 flex-1">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="line-clamp-1 text-sm text-ink hover:text-accent">
                      {p.title ?? "Post sem legenda"}
                    </a>
                  ) : (
                    <p className="line-clamp-1 text-sm text-ink">{p.title ?? "Post sem legenda"}</p>
                  )}
                  <p className="text-xs text-ink-2">
                    @{p.handle} · {p.date}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold tabular-nums text-ink">{nf.format(p.views)}</p>
                  <p className="text-xs text-ink-2">{p.engagement === null ? "—" : `${nf.format(p.engagement)} engaj.`}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {vm.comparisonNote ? <p className="text-xs text-ink-2">{vm.comparisonNote}</p> : null}
    </div>
  );
}
