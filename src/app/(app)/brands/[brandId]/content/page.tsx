import type { Metadata } from "next";
import Link from "next/link";
import { ErCell, MetricCell } from "@/components/content/MetricCell";
import { TrendChart } from "@/components/content/TrendChart";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { AudienceUnavailable, EmptyState, ErrorBanner } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { CONTENT_SORTS, loadContent, type ContentVM } from "@/server/queries/pages/content";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Desempenho de conteúdo" };

const SORT_LABEL: Record<string, string> = { recent: "Mais recentes", views: "Views", reach: "Alcance", er: "Taxa de engajamento", comments: "Comentários", shares: "Compartilhamentos" };

function pageHref(vm: ContentVM, page: number) {
  const q = new URLSearchParams();
  const f = vm.filters;
  for (const [k, v] of Object.entries({ q: f.q, account: f.account, platform: f.platform, format: f.format, tag: f.tag, from: f.from, to: f.to, sort: f.sort })) if (v) q.set(k, v);
  q.set("page", String(page));
  return `/brands/${vm.brand.id}/content?${q.toString()}`;
}

export default async function ContentPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const vm = await orNotFound(
    loadContent(getDb(), user, brandId, new Date(), {
      q: param(sp, "q"),
      account: param(sp, "account"),
      platform: param(sp, "platform"),
      format: param(sp, "format"),
      tag: param(sp, "tag"),
      from: param(sp, "from"),
      to: param(sp, "to"),
      sort: oneOf(param(sp, "sort"), CONTENT_SORTS, "recent"),
      page: Number(param(sp, "page") ?? 1) || 1,
    }),
  );
  const base = `/brands/${vm.brand.id}/content`;
  const f = vm.filters;

  return (
    <>
      <PageHeader title="Desempenho de conteúdo" subtitle={`Posts publicados e suas métricas acumuladas. Datas em ${vm.brand.timezone}.`} />

      <form method="get" action={base} className="mb-4 rounded-lg border border-line bg-surface p-3" aria-label="Filtros de conteúdo">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <div className="sm:col-span-2">
            <label htmlFor="f-q" className="label text-xs">
              Buscar nas legendas
            </label>
            <input id="f-q" name="q" type="search" defaultValue={f.q ?? ""} className="input" />
          </div>
          <div>
            <label htmlFor="f-account" className="label text-xs">
              Conta
            </label>
            <select id="f-account" name="account" defaultValue={f.account ?? ""} className="input">
              <option value="">Todas</option>
              {vm.options.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-platform" className="label text-xs">
              Plataforma
            </label>
            <select id="f-platform" name="platform" defaultValue={f.platform ?? ""} className="input">
              <option value="">Todas</option>
              {vm.options.platforms.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-format" className="label text-xs">
              Formato
            </label>
            <select id="f-format" name="format" defaultValue={f.format ?? ""} className="input">
              <option value="">Todos</option>
              {vm.options.formats.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-tag" className="label text-xs">
              Tag
            </label>
            <select id="f-tag" name="tag" defaultValue={f.tag ?? ""} className="input">
              <option value="">Todas</option>
              {vm.options.tags.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-from" className="label text-xs">
              De
            </label>
            <input id="f-from" name="from" type="date" defaultValue={f.from} className="input" />
          </div>
          <div>
            <label htmlFor="f-to" className="label text-xs">
              Até
            </label>
            <input id="f-to" name="to" type="date" defaultValue={f.to} className="input" />
          </div>
          <div>
            <label htmlFor="f-sort" className="label text-xs">
              Ordenar por
            </label>
            <select id="f-sort" name="sort" defaultValue={f.sort} className="input">
              {CONTENT_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary">
            Aplicar filtros
          </button>
          <Link href={base} className="btn btn-secondary">
            Limpar filtros
          </Link>
        </div>
      </form>

      {vm.error ? <ErrorBanner message={vm.error} retryHref={pageHref(vm, vm.page)} /> : null}

      {!vm.error ? (
        <>
          <section aria-label="Atualidade e modo das métricas" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
              <Icon name="clock-alert" className="h-3.5 w-3.5 text-ink-2" />
              Métricas atualizadas até {vm.metricsAsOf ?? "nenhuma sincronização ainda"}
              {vm.metricsOutdated ? <Pill tone="stale">Desatualizado</Pill> : null}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
              Exibindo valores <strong>acumulados</strong>
              <InfoTip label="Sobre Acumulado vs Período">
                {DEFINITIONS.lifetime} Valores por período não estão disponíveis: o Buffer só expõe os contadores acumulados atuais de cada post, então o BrandPulse
                reporta o desempenho acumulado dos posts publicados no intervalo selecionado.
              </InfoTip>
            </span>
            <span className="text-xs text-ink-2">
              {vm.totalFiltered} de {vm.totalInRange} posts publicados de {f.from} a {f.to}
            </span>
          </section>

          {vm.summaries.length ? (
            <div className="mb-4 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {vm.summaries.map((s) => (
                <Card key={s.platform} labelledBy={`sum-${s.platform}`}>
                  <CardTitle id={`sum-${s.platform}`}>{s.label}</CardTitle>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-ink-2">Posts publicados</dt>
                      <dd className="font-semibold tabular-nums">{s.posts}</dd>
                    </div>
                    <div>
                      <dt className="flex items-center text-xs text-ink-2">
                        Total de views <InfoTip label={`Sobre total de views no ${s.label}`}>{s.viewsNote}</InfoTip>
                      </dt>
                      <dd className="font-semibold tabular-nums">{s.views}</dd>
                    </div>
                    <div>
                      <dt className="flex items-center text-xs text-ink-2">
                        Engajamento total <InfoTip label={`Sobre engajamento total no ${s.label}`}>{s.engagementsNote}</InfoTip>
                      </dt>
                      <dd className="font-semibold tabular-nums">{s.engagements}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-2">Alcance mediano por post</dt>
                      <dd className="font-semibold tabular-nums">{s.medianReach}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="flex items-center text-xs text-ink-2">
                        Taxa de engajamento mediana
                        <InfoTip label={`Sobre taxa de engajamento no ${s.label}`}>
                          {s.platform === "instagram" ? DEFINITIONS.erReach : DEFINITIONS.erViews} Id da definição: {s.erDefinitionId}. A média das taxas não é fornecida; exibimos a mediana por post.
                        </InfoTip>
                      </dt>
                      <dd className="font-semibold tabular-nums">{s.medianEr}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 grid gap-3">
                    {s.charts.map((c) => (
                      <TrendChart key={c.id} id={c.id} title={c.title} yLabel={c.yLabel} unit={c.unit} points={c.points} summary={c.summary} />
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          ) : null}

          <Card labelledBy="posts-table">
            <CardTitle id="posts-table">Posts publicados</CardTitle>
            {vm.sortNote ? <p className="mb-2 text-xs text-ink-2">{vm.sortNote}</p> : null}
            <details className="mb-3 text-sm">
              <summary className="link cursor-pointer">Como funcionam os selos de classificação</summary>
              <p className="mt-1 text-ink-2">{vm.rankingMethod}</p>
            </details>
            {vm.rows.length === 0 ? (
              <EmptyState
                title="Nenhum post publicado encontrado para este filtro."
                action={
                  vm.filtersActive ? (
                    <Link href={base} className="btn btn-secondary">
                      Limpar filtros
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="data-table w-full text-sm">
                    <caption className="sr-only">Posts publicados com métricas acumuladas, taxa de engajamento, procedência e classificação</caption>
                    <thead>
                      <tr>
                        <th scope="col">Post</th>
                        <th scope="col">Publicado</th>
                        <th scope="col">Views</th>
                        <th scope="col">Alcance</th>
                        <th scope="col">Reações</th>
                        <th scope="col">Comentários</th>
                        <th scope="col">Compartilhamentos</th>
                        <th scope="col">Salvamentos</th>
                        <th scope="col">Taxa de eng.</th>
                        <th scope="col">Classificação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vm.rows.map((r) => (
                        <tr key={r.postId}>
                          <td className="min-w-56 max-w-xs">
                            <p className="line-clamp-2 break-words">{r.preview || <span className="italic text-ink-2">Sem legenda</span>}</p>
                            <p className="text-xs text-ink-2">
                              @{r.handle.replace(/^@/, "")} · {r.platformLabel}
                              {r.format ? ` · ${r.format}` : ""}
                            </p>
                            <details className="mt-1 text-xs">
                              <summary className="link cursor-pointer">Detalhes</summary>
                              <div className="mt-1 space-y-1">
                                <p className="text-ink-2">{r.provenance}</p>
                                {r.observedAge ? <p className="text-ink-2">{r.observedAge} (contadores acumulados crescem com o tempo)</p> : null}
                                {r.tags.length ? <p>Tags: {r.tags.join(", ")}</p> : null}
                                <ul className="grid grid-cols-2 gap-x-3">
                                  {r.extraMetrics.map((m) => (
                                    <li key={m.key} className="flex items-center justify-between gap-1">
                                      <span className="text-ink-2">{m.label}</span>
                                      <MetricCell cell={m} />
                                    </li>
                                  ))}
                                </ul>
                                {r.externalUrl ? (
                                  <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                                    Abrir post original <Icon name="external" className="h-3 w-3" />
                                    <span className="sr-only">(abre em uma nova aba)</span>
                                  </a>
                                ) : null}
                              </div>
                            </details>
                          </td>
                          <td className="whitespace-nowrap text-xs">{r.published}</td>
                          {r.metrics.map((m) => (
                            <td key={m.key}>
                              <MetricCell cell={m} />
                            </td>
                          ))}
                          <td>
                            <ErCell cell={r.er} />
                          </td>
                          <td className="text-xs">
                            {r.rank ? (
                              <span className="inline-flex items-center">
                                <Pill tone={r.rank.kind === "best" ? "healthy" : r.rank.kind === "under" ? "warning" : "neutral"}>{r.rank.label}</Pill>
                                <InfoTip label="Sobre esta classificação" align="right">
                                  {r.rank.explanation}
                                  {"confidence" in r.rank ? ` Confiança: ${r.rank.confidence}.` : ""}
                                </InfoTip>
                              </span>
                            ) : (
                              <span className="text-ink-2">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {vm.pageCount > 1 ? (
                  <nav aria-label="Paginação" className="mt-3 flex items-center justify-between text-sm">
                    {vm.page > 1 ? (
                      <Link href={pageHref(vm, vm.page - 1)} className="btn btn-secondary">
                        Anterior
                      </Link>
                    ) : (
                      <span />
                    )}
                    <span>
                      Página {vm.page} de {vm.pageCount}
                    </span>
                    {vm.page < vm.pageCount ? (
                      <Link href={pageHref(vm, vm.page + 1)} className="btn btn-secondary">
                        Próxima
                      </Link>
                    ) : (
                      <span />
                    )}
                  </nav>
                ) : null}
              </>
            )}
          </Card>
        </>
      ) : null}

      <Card labelledBy="audience-growth" className="mt-4">
        <CardTitle id="audience-growth">Crescimento de audiência</CardTitle>
        <AudienceUnavailable />
      </Card>
    </>
  );
}
