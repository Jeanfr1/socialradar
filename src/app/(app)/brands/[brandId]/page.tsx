import type { Metadata } from "next";
import Link from "next/link";
import { SchedulingCard } from "@/components/health/SchedulingCard";
import { ErCell } from "@/components/content/MetricCell";
import { Card, CardTitle } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge } from "@/components/ui/Demo";
import { Freshness } from "@/components/ui/Freshness";
import { Icon } from "@/components/ui/Icon";
import { InfoTip, Term } from "@/components/ui/InfoTip";
import { AudienceUnavailable, Banner, EmptyState, ErrorBanner } from "@/components/ui/States";
import { Pill, SeverityBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import type { Platform } from "@/domain/types";
import { loadBrandDashboard } from "@/server/queries/pages/brand-dashboard";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Painel da marca" };

const PLATFORMS = ["all", "instagram", "tiktok", "youtube"] as const;

export default async function BrandDashboardPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const range = oneOf(param(sp, "range"), ["7d", "28d"] as const, "7d");
  const platform = oneOf(param(sp, "platform"), PLATFORMS, "all");
  const vm = await orNotFound(loadBrandDashboard(getDb(), user, brandId, new Date(), { range, platform: platform as Platform | "all" }));
  const base = `/brands/${vm.brand.id}`;
  const href = (next: { range?: string; platform?: string }) => `${base}?range=${next.range ?? range}&platform=${next.platform ?? platform}`;

  return (
    <>
      <h1 className="sr-only">Painel de {vm.brand.name}</h1>
      {vm.staleData ? (
        <Banner tone="stale">
          Alguns dados aqui têm mais de 24h ou são mais antigos que a janela de atualização definida.{" "}
          <a href="#scheduling-details" className="link">
            Ver detalhes da sincronização
          </a>
        </Banner>
      ) : null}

      {vm.accounts.length === 0 ? (
        <EmptyState title="Nenhuma conta está mapeada para esta marca ainda.">
          Um administrador do workspace pode mapear os canais do Buffer descobertos para esta marca em Configurações → Conexões. Canais não
          mapeados nunca aparecem nas métricas da marca.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card labelledBy="ops-health">
            <CardTitle id="ops-health">Saúde operacional</CardTitle>
            <p className="mb-3 text-xs text-ink-2">Apenas agendamento e publicação. Nunca misturado com desempenho de conteúdo.</p>
            {!vm.hasAnyPosts ? <p className="mb-3 rounded-md border border-line bg-canvas p-2 text-sm">Nenhum post agendado ou enviado foi encontrado para esta marca ainda.</p> : null}
            <ul className="divide-y divide-line">
              {vm.accounts.map((a) => (
                <li key={a.accountId} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`${base}/accounts/${a.accountId}`} className="link font-medium">
                      @{a.handle.replace(/^@/, "")}
                    </Link>
                    <span className="text-xs text-ink-2">{a.platformLabel}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} stale={!!a.stale} staleLabel={a.stale?.label} note={a.statusNote} />
                    {a.connectionIssue ? <Pill tone="critical">{a.connectionIssue}</Pill> : null}
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <dt className="text-ink-2">
                        <Term term="Cobertura" definition={DEFINITIONS.coverage} />:
                      </dt>
                      <dd className="tabular-nums">
                        {a.scheduling.unavailable ?? (a.scheduling.coveragePct ? `${a.scheduling.coveragePct} · ${a.scheduling.coveredDays ?? "0 dias"} contínuos` : "Sem horários previstos")}
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <dt className="text-ink-2">
                        <Term term="Primeiro horário descoberto" definition={DEFINITIONS.firstUncovered} />:
                      </dt>
                      <dd>{a.scheduling.unavailable ?? a.scheduling.firstUncoveredSlot ?? "Nenhum no horizonte"}</dd>
                    </div>
                  </dl>
                  {a.needsLine ? <p className="mt-1 text-sm font-medium text-ink">{a.needsLine}</p> : null}
                  <div className="mt-1">
                    <Freshness vm={a.freshness} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card labelledBy="content-perf">
            <CardTitle
              id="content-perf"
              actions={
                <div className="flex flex-wrap gap-1" role="group" aria-label="Período de desempenho">
                  {(["7d", "28d"] as const).map((r) => (
                    <Link key={r} href={href({ range: r })} aria-current={r === range ? "true" : undefined} className={`btn ${r === range ? "btn-primary" : "btn-secondary"} min-h-9 px-3`}>
                      {r === "7d" ? "Últimos 7 dias" : "Últimos 28 dias"}
                    </Link>
                  ))}
                </div>
              }
            >
              Desempenho de conteúdo
            </CardTitle>
            <nav aria-label="Filtro de plataforma" className="mb-3 flex flex-wrap gap-1 text-sm">
              {PLATFORMS.map((p) => (
                <Link key={p} href={href({ platform: p })} aria-current={p === platform ? "true" : undefined} className={`rounded-full border px-2.5 py-1 ${p === platform ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-2 hover:text-ink"}`}>
                  {p === "all" ? "Todas as plataformas" : p === "instagram" ? "Instagram" : p === "tiktok" ? "TikTok" : "YouTube"}
                </Link>
              ))}
            </nav>
            {vm.performance.error ? <ErrorBanner message={vm.performance.error} retryHref={href({})} /> : null}
            {!vm.performance.error && vm.performance.platforms.every((p) => p.postsPublished === 0) ? (
              <p className="rounded-md border border-line bg-canvas p-3 text-sm">Ainda não há dados de conteúdo — assim que houver posts publicados, o desempenho aparecerá aqui.</p>
            ) : null}
            {vm.performance.platforms.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="data-table w-full text-sm">
                  <caption className="sr-only">Métricas principais por plataforma; valores acumulados até a última atualização do provedor para cada post</caption>
                  <thead>
                    <tr>
                      <th scope="col">Plataforma</th>
                      <th scope="col">Posts</th>
                      <th scope="col">Views</th>
                      <th scope="col">Alcance mediano</th>
                      <th scope="col">
                        <span className="inline-flex items-center">
                          Taxa de eng. mediana
                          <InfoTip label="Sobre Taxa de engajamento" align="right">
                            {DEFINITIONS.erReach} {DEFINITIONS.erViews} As taxas usam definições diferentes por plataforma e nunca são comparadas entre plataformas.
                          </InfoTip>
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vm.performance.platforms.map((p) => (
                      <tr key={p.platform}>
                        <th scope="row" className="font-medium">
                          {p.label}
                          <div className="text-[11px] font-normal text-ink-2">{p.metricsAsOf ? `Métricas de ${p.metricsAsOf}` : "Sem métricas ainda"}</div>
                        </th>
                        <td className="tabular-nums">{p.postsPublished}</td>
                        <td className="tabular-nums">
                          <span className="inline-flex items-center">
                            {p.views.display}
                            {p.views.note ? <InfoTip label={`Sobre views no ${p.label}`}>{p.views.note}</InfoTip> : null}
                          </span>
                        </td>
                        <td className="tabular-nums">
                          <span className="inline-flex items-center">
                            <span className={p.medianReach.display === "Unsupported" ? "text-xs italic text-ink-2" : ""}>{p.medianReach.display}</span>
                            {p.medianReach.note ? <InfoTip label={`Sobre alcance no ${p.label}`}>{p.medianReach.note}</InfoTip> : null}
                          </span>
                        </td>
                        <td className="tabular-nums">
                          <span className="inline-flex items-center">
                            {p.medianEr.display}
                            <InfoTip label={`Sobre taxa de engajamento no ${p.label}`} align="right">
                              {p.medianEr.note} Id da definição: {p.medianEr.definitionId}.
                            </InfoTip>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <h3 className="mb-2 mt-4 flex items-center text-sm font-semibold">
              Melhores posts do período
              {vm.performance.rankingMethod ? <InfoTip label="Como os posts são classificados">{vm.performance.rankingMethod}</InfoTip> : null}
            </h3>
            {vm.performance.topPosts.length === 0 ? (
              <p className="text-sm text-ink-2">{vm.performance.rankingNote ?? "Nenhum post classificado neste período."}</p>
            ) : (
              <ol className="space-y-2">
                {vm.performance.topPosts.map((t, i) => (
                  <li key={t.postId} className="rounded-md border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 font-medium">
                        {i + 1}. {t.title}
                      </span>
                      <ErCell cell={t.er} />
                    </div>
                    <p className="text-xs text-ink-2">
                      @{t.handle.replace(/^@/, "")} · {t.platformLabel} · {t.publishedAt} ·{" "}
                      <span className="font-medium text-ink">{t.ratio}</span> · confiança {t.confidence}
                    </p>
                    <p className="mt-1 text-xs text-ink-2">{t.explanation}</p>
                    {t.externalUrl ? (
                      <a href={t.externalUrl} target="_blank" rel="noopener noreferrer" className="link mt-1 inline-flex items-center gap-1 text-xs">
                        Abrir post original <Icon name="external" className="h-3 w-3" />
                        <span className="sr-only">(abre em uma nova aba)</span>
                      </a>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3">
              <Link href={`${base}/content`} className="link text-sm">
                Desempenho de conteúdo completo
              </Link>
            </p>
          </Card>

          <Card labelledBy="this-week">
            <CardTitle id="this-week">Esta semana</CardTitle>
            {vm.thisWeek ? (
              <>
                <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  Semana {vm.thisWeek.periodLabel} <Pill tone={vm.thisWeek.status === "Final" ? "healthy" : "stale"}>{vm.thisWeek.status}</Pill> <Pill>{vm.thisWeek.locale.toUpperCase()}</Pill>
                </p>
                <div lang={vm.thisWeek.locale} className="text-sm">
                  <p className="line-clamp-6 whitespace-pre-line">{vm.thisWeek.summary}</p>
                  {vm.thisWeek.highlights.length ? (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5">
                      {vm.thisWeek.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <p className="mt-2">
                  <Link href={`${base}/reports/${vm.thisWeek.reportId}`} className="link text-sm">
                    Abrir relatório completo
                  </Link>
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-2">Ainda não há relatório semanal. Os relatórios resumem a consistência de publicação, os melhores conteúdos e as ações prioritárias.</p>
                <p className="mt-2">
                  <Link href={`${base}/reports`} className="link text-sm">
                    Abrir relatórios semanais
                  </Link>
                </p>
              </>
            )}
          </Card>

          <Card labelledBy="brand-alerts">
            <CardTitle
              id="brand-alerts"
              actions={
                <Link href={`/alerts?brand=${vm.brand.id}`} className="link text-sm">
                  Ver {vm.openAlertCount} alertas em aberto
                </Link>
              }
            >
              Alertas
            </CardTitle>
            {vm.alerts.length === 0 ? (
              <p className="text-sm text-ink-2">Nenhum alerta em aberto. Tudo está dentro dos limites configurados.</p>
            ) : (
              <ul className="space-y-2">
                {vm.alerts.map((a) => (
                  <li key={a.id} className="rounded-md border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={a.severity} />
                      <span className="font-medium">{a.title}</span>
                      {a.isDemo ? <DemoBadge /> : null}
                    </div>
                    <p className="mt-1 text-ink-2">{a.suggestedAction}</p>
                    <p className="mt-0.5 text-xs text-ink-2">{a.updated}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card labelledBy="audience" className="xl:col-span-2">
            <CardTitle id="audience">Crescimento de audiência</CardTitle>
            <AudienceUnavailable />
          </Card>
        </div>
      )}

      {vm.accounts.length > 0 ? (
        <section id="scheduling-details" aria-labelledby="sched-heading" className="mt-6">
          <h2 id="sched-heading" className="mb-3 text-lg font-semibold">
            Detalhes de agendamento por conta
          </h2>
          <div className="grid gap-4 2xl:grid-cols-2">
            {vm.accounts.map((a) => (
              <SchedulingCard key={a.accountId} vm={a} headingId={`sched-${a.accountId}`} detailHref={`${base}/accounts/${a.accountId}`} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
