import type { Metadata } from "next";
import Link from "next/link";
import { ErCell, MetricCell } from "@/components/content/MetricCell";
import { SchedulingCard } from "@/components/health/SchedulingCard";
import { CoverageSlotsTimeline, PostingScheduleGrid } from "@/components/health/ScheduleViews";
import { Card, CardTitle, PageHeader, Stat } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge } from "@/components/ui/Demo";
import { Freshness } from "@/components/ui/Freshness";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { AudienceUnavailable, UnavailableState } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadAccountDetail, POST_STATUS_FILTERS } from "@/server/queries/pages/account-detail";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Detalhes da conta" };

const STATE_TONE = { Active: "healthy", "Queue paused": "neutral", Disconnected: "critical", Locked: "neutral" } as const;
const STATE_LABEL = { Active: "Ativa", "Queue paused": "Fila pausada", Disconnected: "Desconectada", Locked: "Bloqueada" } as const;
const POST_STATUS_LABEL: Record<string, string> = { all: "Todos", sent: "Enviados", scheduled: "Agendados", error: "Erro", draft: "Rascunho / aprovação" };

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ brandId: string; accountId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { brandId, accountId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const status = oneOf(param(sp, "status"), POST_STATUS_FILTERS, "all");
  const vm = await orNotFound(loadAccountDetail(getDb(), user, brandId, accountId, new Date(), { status }));
  const base = `/brands/${vm.brand.id}/accounts/${vm.account.id}`;
  const h = vm.health;

  return (
    <>
      <PageHeader
        title={`@${vm.account.handle.replace(/^@/, "")}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {vm.account.displayName ? <span>{vm.account.displayName}</span> : null}
            <span>{vm.account.platformLabel}</span>
            <span>· Conexão: {vm.account.connectionLabel}</span>
            {vm.account.isDemo ? <DemoBadge /> : null}
          </span>
        }
        meta={
          <>
            <Pill tone={STATE_TONE[vm.connectionState]}>
              <Icon name={vm.connectionState === "Disconnected" ? "unlink" : vm.connectionState === "Locked" ? "lock" : vm.connectionState === "Queue paused" ? "pause-circle" : "check-circle"} className="h-3 w-3" />
              {STATE_LABEL[vm.connectionState]}
            </Pill>
            <span>Fuso horário do canal: {vm.account.providerTimezone ?? "Desconhecido"}</span>
            <Freshness vm={vm.freshness} />
          </>
        }
        actions={
          <>
            {vm.account.externalUrl ? (
              <a href={vm.account.externalUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                Abrir perfil <Icon name="external" />
                <span className="sr-only">(abre em uma nova aba)</span>
              </a>
            ) : null}
            {vm.canManage ? (
              <Link href={`/settings/brands/${vm.brand.id}#cadence-${vm.account.id}`} className="btn btn-secondary">
                Editar cadência
              </Link>
            ) : null}
          </>
        }
      />

      {vm.account.removed || !h ? (
        <UnavailableState title="Este canal não é mais retornado pelo Buffer">
          A conexão dele foi removida ou o Buffer não lista mais o canal. O histórico de posts e métricas é mantido abaixo; a cobertura da fila não
          pode ser calculada.
        </UnavailableState>
      ) : (
        <SchedulingCard vm={h} headingId="scheduling-math" />
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card labelledBy="posting-schedule">
          <CardTitle id="posting-schedule">Agenda de publicação</CardTitle>
          <p className="mb-2 text-xs text-ink-2">Agenda de publicação do Buffer (fuso horário do canal: {vm.account.providerTimezone ?? "desconhecido"}).</p>
          <PostingScheduleGrid days={vm.providerSchedule} caption="Horários de publicação do Buffer por dia da semana" />
          {vm.cadenceSchedule ? (
            <>
              <p className="mb-2 mt-4 text-xs text-ink-2">Cadência personalizada do BrandPulse usada para a cobertura:</p>
              <PostingScheduleGrid days={vm.cadenceSchedule} caption="Horários da cadência personalizada por dia da semana" />
            </>
          ) : null}
          {vm.cadenceSummary.length ? (
            <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              {vm.cadenceSummary.map((c) => (
                <div key={c.label} className="flex gap-1">
                  <dt className="text-ink-2">{c.label}:</dt>
                  <dd>{c.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </Card>

        <Card labelledBy="failures">
          <CardTitle id="failures">Falhas e posts atrasados</CardTitle>
          {!h || (h.recentErrors.length === 0 && h.overdue.length === 0) ? (
            <p className="text-sm text-ink-2">Nenhuma falha de publicação nos últimos 14 dias e nenhum post agendado atrasado.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {h.recentErrors.map((e) => (
                <li key={e.postId} className="rounded-md border border-critical/30 bg-critical/5 p-2">
                  <p className="font-medium text-critical">Este post falhou ao publicar{e.due ? ` (previsto para ${e.due})` : ""}.</p>
                  <details className="mt-1">
                    <summary className="link cursor-pointer text-xs">Detalhes</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words text-ink">O Buffer informou: &ldquo;{e.message}&rdquo;</p>
                  </details>
                  {e.externalUrl ? (
                    <a href={e.externalUrl} target="_blank" rel="noopener noreferrer" className="link text-xs">
                      Abrir post <span className="sr-only">(abre em uma nova aba)</span>
                    </a>
                  ) : null}
                </li>
              ))}
              {h.overdue.map((o) => (
                <li key={o.postId} className="rounded-md border border-warning/30 bg-warning/5 p-2">
                  <p className="font-medium text-warning">Post agendado atrasado</p>
                  <p className="text-ink-2">Previsto para {o.due} e ainda não enviado. Verifique no Buffer.</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {h ? (
        <Card labelledBy="slots" className="mt-4">
          <CardTitle id="slots">Horários de cobertura</CardTitle>
          <p className="mb-3 text-xs text-ink-2">
            Horários previstos de agora até o fim do horizonte, em {h.cadenceTimezone} ({h.cadenceZoneLabel}). Dias hachurados contêm pelo menos um horário descoberto.
          </p>
          {h.scheduling.unavailable ? <p className="text-sm text-ink-2">{h.scheduling.unavailable}</p> : <CoverageSlotsTimeline days={vm.slotDays} />}
        </Card>
      ) : null}

      <Card labelledBy="recent-posts" className="mt-4">
        <CardTitle
          id="recent-posts"
          actions={
            <nav aria-label="Filtro de status dos posts" className="flex flex-wrap gap-1 text-sm">
              {POST_STATUS_FILTERS.map((f) => (
                <Link key={f} href={`${base}?status=${f}`} aria-current={f === vm.statusFilter ? "true" : undefined} className={`rounded-full border px-2.5 py-1 ${f === vm.statusFilter ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-2"}`}>
                  {POST_STATUS_LABEL[f] ?? f}
                </Link>
              ))}
            </nav>
          }
        >
          Posts recentes
        </CardTitle>
        <p className="mb-2 text-xs text-ink-2">Últimos 28 dias mais tudo o que está agendado. As métricas são totais acumulados até a última atualização do provedor.</p>
        {vm.recentPosts.length === 0 ? (
          <p className="text-sm text-ink-2">Nenhum post corresponde a este filtro.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <caption className="sr-only">Posts recentes desta conta</caption>
              <thead>
                <tr>
                  <th scope="col">Post</th>
                  <th scope="col">Status</th>
                  <th scope="col">Previsto / enviado</th>
                  <th scope="col">Views</th>
                  <th scope="col">Alcance</th>
                  <th scope="col">Reações</th>
                  <th scope="col">Comentários</th>
                  <th scope="col">Compartilhamentos</th>
                  <th scope="col">Salvamentos</th>
                  <th scope="col">
                    <span className="inline-flex items-center">
                      Taxa de eng.
                      <InfoTip label="Sobre Taxa de engajamento" align="right">
                        {DEFINITIONS.erReach} {DEFINITIONS.erViews}
                      </InfoTip>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {vm.recentPosts.map((p) => (
                  <tr key={p.id}>
                    <td className="max-w-xs">
                      <p className="line-clamp-2 break-words">{p.preview || <span className="italic text-ink-2">Sem legenda</span>}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                        {p.format ? <span>{p.format}</span> : null}
                        {p.externalUrl ? (
                          <a href={p.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                            Original <Icon name="external" className="h-3 w-3" />
                            <span className="sr-only">(abre em uma nova aba)</span>
                          </a>
                        ) : null}
                      </div>
                      {p.errorMessage ? (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-critical">Detalhes do erro</summary>
                          <p className="whitespace-pre-wrap break-words">O Buffer informou: &ldquo;{p.errorMessage}&rdquo;</p>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      <Pill tone={p.status === "error" ? "critical" : p.status === "sent" ? "healthy" : "neutral"}>{p.statusLabel}</Pill>
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {p.sent ? <div>Enviado {p.sent}</div> : null}
                      {p.due && !p.sent ? <div>Previsto {p.due}</div> : null}
                      {!p.due && !p.sent ? <div className="italic text-ink-2">Horário não confirmado</div> : null}
                      {p.metricsAsOf ? <div className="text-ink-2">Métricas de {p.metricsAsOf}</div> : null}
                    </td>
                    {p.metrics ? (
                      p.metrics.map((m) => (
                        <td key={m.key}>
                          <MetricCell cell={m} />
                        </td>
                      ))
                    ) : (
                      <td colSpan={6} className="text-xs italic text-ink-2">
                        {p.status === "sent" ? "Publicado há mais de 56 dias — veja Conteúdo" : "Ainda não publicado"}
                      </td>
                    )}
                    <td>{p.er ? <ErCell cell={p.er} /> : <span className="text-xs text-ink-2">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card labelledBy="perf-summary">
          <CardTitle id="perf-summary">Resumo de desempenho (28 dias)</CardTitle>
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="Posts publicados" value={vm.performance.posts} />
            <Stat label="Views medianos por post" value={vm.performance.medianViews} />
            <Stat label="Alcance mediano por post" value={vm.performance.medianReach} />
            <Stat label={<span className="inline-flex items-center">Taxa de engajamento mediana<InfoTip label="Sobre Taxa de engajamento">{`Id da definição ${vm.performance.erDefinitionId}.`}</InfoTip></span>} value={vm.performance.medianEr} />
          </dl>
          <div className="mt-3 text-sm">
            <p className="flex items-center font-medium">
              Melhor post
              <InfoTip label="Como os posts são classificados">{vm.performance.topPostNote}</InfoTip>
            </p>
            {vm.performance.topPost ? (
              <>
                <p>{vm.performance.topPost.title}</p>
                <p className="text-xs text-ink-2">{vm.performance.topPost.explanation}</p>
                {vm.performance.topPost.externalUrl ? (
                  <a href={vm.performance.topPost.externalUrl} target="_blank" rel="noopener noreferrer" className="link text-xs">
                    Abrir post original <span className="sr-only">(abre em uma nova aba)</span>
                  </a>
                ) : null}
              </>
            ) : (
              <p className="text-ink-2">Nenhum post superou claramente os posts comparáveis (são necessários pelo menos 5 posts comparáveis observados ≥72h após a publicação).</p>
            )}
          </div>
        </Card>
        <Card labelledBy="audience">
          <CardTitle id="audience">Crescimento de audiência</CardTitle>
          <AudienceUnavailable />
        </Card>
      </div>

      <Card labelledBy="availability" className="mt-4">
        <CardTitle id="availability">Disponibilidade de métricas no {vm.account.platformLabel}</CardTitle>
        <p className="mb-2 text-xs text-ink-2">O que o Buffer fornece para esta plataforma e o que foi de fato observado nos posts desta conta nos últimos 28 dias.</p>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Matriz de disponibilidade de métricas</caption>
            <thead>
              <tr>
                <th scope="col">Métrica</th>
                <th scope="col">Disponibilidade</th>
                <th scope="col">Semântica</th>
                <th scope="col">Observado (28 dias)</th>
                <th scope="col">Notas</th>
              </tr>
            </thead>
            <tbody>
              {vm.availability.map((m) => (
                <tr key={m.key}>
                  <th scope="row" className="font-medium">
                    {m.label}
                    <div className="text-xs font-normal text-ink-2">{m.description}</div>
                  </th>
                  <td>
                    {m.capability === "supported" ? (
                      <Pill tone="healthy">
                        <Icon name="check-circle" className="h-3 w-3" /> Suportado
                      </Pill>
                    ) : m.capability === "unsupported" ? (
                      <Pill>
                        <Icon name="circle-slash" className="h-3 w-3" /> Não suportado
                      </Pill>
                    ) : (
                      <Pill tone="warning">Requer conexão direta com a plataforma</Pill>
                    )}
                  </td>
                  <td className="text-xs">{m.semantics}</td>
                  <td className="text-xs tabular-nums">{m.observed}</td>
                  <td className="max-w-sm text-xs text-ink-2">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
