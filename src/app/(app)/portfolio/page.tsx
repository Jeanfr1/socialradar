import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DemoBadge, DemoBanner } from "@/components/ui/Demo";
import { Freshness } from "@/components/ui/Freshness";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { Banner, EmptyState, ErrorBanner } from "@/components/ui/States";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";
import { DEFINITIONS } from "@/components/ui/copy";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadPortfolio, type BrandCardVM, type SeverityCounts } from "@/server/queries/pages/portfolio";

export const metadata: Metadata = { title: "Portfólio" };

function AlertCounts({ counts, label }: { counts: SeverityCounts; label: string }) {
  return (
    <Link href="/alerts" className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 hover:border-accent" aria-label={`${label}: ${counts.critical} alertas críticos, ${counts.warning} de atenção e ${counts.info} informativos em aberto`}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      <Pill tone="critical">
        <Icon name="alert-octagon" className="h-3 w-3" /> {counts.critical} Críticos
      </Pill>
      <Pill tone="warning">
        <Icon name="alert-triangle" className="h-3 w-3" /> {counts.warning} Atenção
      </Pill>
      <Pill tone="accent">
        <Icon name="info" className="h-3 w-3" /> {counts.info} Informativos
      </Pill>
    </Link>
  );
}

function BrandCard({ card }: { card: BrandCardVM }) {
  const headingId = `brand-${card.id}`;
  return (
    <article aria-labelledby={headingId} className={`flex flex-col rounded-lg border bg-surface p-4 ${card.isDemo ? "border-demo/50" : "border-line"}`}>
      <div className="flex items-start gap-3">
        {card.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.logoUrl} alt="" className="h-10 w-10 rounded-md border border-line object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div aria-hidden className="flex h-10 w-10 items-center justify-center rounded-md bg-canvas font-semibold text-ink-2">
            {card.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <span className="truncate">{card.name}</span>
            {card.isDemo ? <DemoBadge /> : null}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {card.worst ? <StatusBadge status={card.worst} stale={card.stale} /> : <Pill>Nenhuma conta mapeada</Pill>}
            {card.connectionUnavailable ? (
              <span className="inline-flex items-center gap-0.5">
                <Pill tone="critical">Conexão indisponível</Pill>
                <InfoTip label="Sobre Conexão indisponível">
                  Não conseguimos acessar o Buffer para as contas desta marca agora. Isso não é o mesmo que não haver posts agendados — apenas
                  não conseguimos confirmar o status.
                </InfoTip>
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {card.attentionReasons.length ? (
        <ul className="mt-3 space-y-0.5 text-sm text-ink">
          {card.attentionReasons.map((r) => (
            <li key={r} className="flex items-center gap-1.5">
              <Icon name="alert-triangle" className="h-3.5 w-3.5 text-warning" /> {r}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-2">Contas</dt>
          <dd className="mt-0.5 flex flex-wrap gap-1">
            {card.platforms.length === 0 ? <span className="text-ink-2">Nenhuma</span> : null}
            {card.platforms.map((p) => (
              <span key={p.platform} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs">
                {p.label} ×{p.count}
                <span className="sr-only">pior status {p.worst}</span>
                <StatusDot status={p.worst} />
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Alertas em aberto</dt>
          <dd className="mt-0.5 tabular-nums">
            {card.openAlerts.critical} críticos · {card.openAlerts.warning} de atenção
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Posts publicados (7d)</dt>
          <dd className="mt-0.5 tabular-nums">{card.postsLast7d ?? "N/A"}</dd>
        </div>
      </dl>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <Freshness vm={card.freshness} prefix={card.accountCount > 1 ? "Conta mais antiga:" : undefined} />
        <Link href={`/brands/${card.id}`} className="btn btn-secondary">
          Ver marca
        </Link>
      </div>
    </article>
  );
}

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    healthy: "bg-healthy",
    warning: "bg-warning",
    critical: "bg-critical",
    empty: "bg-empty",
    paused: "bg-paused",
    disconnected: "bg-disconnected",
    locked: "bg-locked",
    unknown: "bg-line-strong",
  };
  return <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${color[status] ?? "bg-line-strong"}`} title={status} />;
}

export default async function PortfolioPage() {
  const user = await requireUser("page");
  const now = new Date();
  let vm;
  try {
    vm = await loadPortfolio(getDb(), user, now);
  } catch {
    return (
      <>
        <PageHeader title="Portfólio" />
        <ErrorBanner message="Não foi possível carregar seu portfólio." retryHref="/portfolio" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Portfólio" subtitle="O que precisa de atenção em todas as marcas às quais você tem acesso. Saúde operacional e desempenho de conteúdo aparecem separadamente." />
      {vm.totals.demo ? <DemoBanner scope="Marcas sinalizadas como Demo exibem dados fictícios. Elas são contabilizadas separadamente dos totais de produção abaixo." /> : null}

      {vm.brands.length === 0 ? (
        vm.isWorkspaceAdmin ? (
          <EmptyState
            title="Nenhuma marca ainda."
            action={
              <Link href="/settings/brands" className="btn btn-primary">
                Criar primeira marca
              </Link>
            }
          >
            Crie sua primeira marca para começar a monitorar.
          </EmptyState>
        ) : (
          <EmptyState title="Você ainda não tem marcas atribuídas.">Fale com o administrador para obter acesso.</EmptyState>
        )
      ) : (
        <>
          {vm.attentionAccountCount > 0 ? (
            <Banner tone="warning">
              <strong>{vm.attentionAccountCount === 1 ? "1 conta precisa" : `${vm.attentionAccountCount} contas precisam`} de atenção</strong>{" "}
              (crítica, vazia, desconectada, bloqueada, desatualizada ou com falha de sincronização).{" "}
              <Link href="/alerts" className="link">
                Ir para Alertas
              </Link>
            </Banner>
          ) : null}

          <section aria-label="Resumo de alertas em aberto" className="mb-5 flex flex-wrap gap-2">
            <AlertCounts counts={vm.totals.production.alerts} label={`Produção · ${vm.totals.production.brands} marcas, ${vm.totals.production.accounts} contas`} />
            {vm.totals.demo ? <AlertCounts counts={vm.totals.demo.alerts} label={`Demo · ${vm.totals.demo.brands} marcas, ${vm.totals.demo.accounts} contas`} /> : null}
            {vm.connectionAlerts ? <AlertCounts counts={vm.connectionAlerts} label="Conexões (admin)" /> : null}
          </section>

          <h2 className="sr-only">Marcas</h2>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {vm.brands.map((b) => (
              <BrandCard key={b.id} card={b} />
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card labelledBy="running-out">
              <CardTitle id="running-out">Contas mais próximas de ficar sem conteúdo</CardTitle>
              {vm.runningOut.length === 0 ? (
                <p className="text-ink-2">Nenhuma conta com cadência de publicação ativa para classificar.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table w-full text-sm">
                    <caption className="sr-only">Contas ordenadas por dias cobertos contínuos, do menor para o maior</caption>
                    <thead>
                      <tr>
                        <th scope="col">Conta</th>
                        <th scope="col">Status</th>
                        <th scope="col">
                          <span className="inline-flex items-center">
                            Cobertos
                            <InfoTip label="Sobre Cobertura">{DEFINITIONS.coverage}</InfoTip>
                          </span>
                        </th>
                        <th scope="col">Primeira lacuna</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vm.runningOut.map(({ brandId, brandName, isDemo, health: h }) => (
                        <tr key={h.accountId}>
                          <td>
                            <Link href={`/brands/${brandId}/accounts/${h.accountId}`} className="link font-medium">
                              @{h.handle.replace(/^@/, "")}
                            </Link>
                            <div className="flex flex-wrap items-center gap-1 text-xs text-ink-2">
                              {brandName} · {h.platformLabel} {isDemo ? <DemoBadge /> : null}
                            </div>
                          </td>
                          <td>
                            <StatusBadge status={h.status} stale={!!h.stale} staleLabel={h.stale?.label} note={h.statusNote} />
                          </td>
                          <td className="tabular-nums">
                            {h.scheduling.coveredDays ?? "N/A"}
                            <div className="text-xs text-ink-2">
                              {h.scheduling.coveragePct ?? "N/A"} dos horários
                            </div>
                          </td>
                          <td className="text-xs">{h.scheduling.firstUncoveredSlot ?? "Sem lacuna no horizonte"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card labelledBy="perf-changes">
              <CardTitle id="perf-changes">Mudanças relevantes de desempenho</CardTitle>
              <p className="mb-3 text-xs text-ink-2">
                Taxa de engajamento mediana por post, última semana completa vs. a semana anterior (fuso horário da marca). Só aparecem
                comparações válidas: mesma definição, semanas completas, pelo menos 3 posts em cada e posts com idades comparáveis. Taxas de
                engajamento nunca são comparadas entre plataformas.
              </p>
              {vm.sectionErrors.changes ? <ErrorBanner message={vm.sectionErrors.changes} retryHref="/portfolio" /> : null}
              {vm.changes && vm.changes.valid.length === 0 ? <p className="text-ink-2">Nenhuma comparação válida entre semanas nesta semana.</p> : null}
              {vm.changes && vm.changes.valid.length > 0 ? (
                <ul className="divide-y divide-line">
                  {vm.changes.valid.map((c) => (
                    <li key={c.accountId} className="py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/brands/${c.brandId}/content`} className="link font-medium">
                          {c.brandName} · @{c.handle.replace(/^@/, "")} ({c.platformLabel})
                        </Link>
                        <span className={`tabular-nums font-semibold ${c.direction === "down" ? "text-critical" : c.direction === "up" ? "text-healthy" : ""}`}>
                          {c.direction === "up" ? "▲ " : c.direction === "down" ? "▼ " : ""}
                          {c.change}
                        </span>
                      </div>
                      <p className="text-xs text-ink-2">
                        {c.metricLabel}: {c.previous} → {c.current} · {c.sample} · definição <code>{c.definitionId}</code> {c.isDemo ? <DemoBadge /> : null}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {vm.changes && vm.changes.unavailable.length > 0 ? (
                <details className="mt-3 text-sm">
                  <summary className="link cursor-pointer">Comparações não disponíveis ({vm.changes.unavailable.length})</summary>
                  <ul className="mt-2 space-y-1 text-ink-2">
                    {vm.changes.unavailable.map((c) => (
                      <li key={c.accountId}>
                        {c.brandName} · @{c.handle.replace(/^@/, "")}: N/A — {c.naReason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </Card>

            {vm.connectionFailures ? (
              <Card labelledBy="conn-failures" className="xl:col-span-2">
                <CardTitle
                  id="conn-failures"
                  actions={
                    <Link href="/settings/connections" className="link text-sm">
                      Gerenciar conexões
                    </Link>
                  }
                >
                  Falhas de conexão
                </CardTitle>
                {vm.sectionErrors.connections ? <ErrorBanner message={vm.sectionErrors.connections} retryHref="/portfolio" /> : null}
                {vm.connectionFailures.length === 0 ? (
                  <p className="text-ink-2">Todas as conexões com o Buffer estão ativas, sem falhas recentes.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {vm.connectionFailures.map((c) => (
                      <li key={c.id} className="py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{c.label}</span>
                          <Pill tone={c.status === "active" ? "warning" : "critical"}>{c.status}</Pill>
                          {c.keyHint ? <code className="text-xs text-ink-2">{c.keyHint}</code> : null}
                          <span className="text-xs text-ink-2">{c.failures} falhas consecutivas · último sucesso {c.lastSuccess}</span>
                        </div>
                        {c.lastError ? <p className="mt-0.5 break-words text-xs text-ink-2">Último erro: {c.lastError}</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
