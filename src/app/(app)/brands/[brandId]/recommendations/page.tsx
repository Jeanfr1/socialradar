import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge } from "@/components/ui/Demo";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { Banner, EmptyState } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { createExperimentAction, recommendationStatusAction, updateExperimentAction } from "@/server/actions/recommendations";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import type { Platform } from "@/domain/types";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadRecommendations, REC_PRIORITY_FILTERS, REC_STATUS_FILTERS, type RecommendationCardVM } from "@/server/queries/pages/recommendations";

export const metadata: Metadata = { title: "Recomendações e experimentos" };

const STATUS_FILTER_LABEL: Record<string, string> = { active: "Ativas (novas, aceitas, em teste)", proposed: "Novas", accepted: "Aceitas", in_experiment: "Em teste", dismissed: "Descartadas", done: "Concluídas", all: "Todas" };
const PRIORITY_LABEL: Record<string, string> = { high: "Alta", medium: "Média", low: "Baixa" };
const PRIORITY_FILTER_LABEL: Record<string, string> = { all: "Todas", high: "Alta", medium: "Média", low: "Baixa" };
const CONFIDENCE_LABEL: Record<string, string> = { high: "Alta", medium: "Média", low: "Baixa" };
const EXPERIMENT_STATUS_LABEL: Record<string, string> = { planned: "Planejado", running: "Em andamento", completed: "Concluído", abandoned: "Abandonado" };

function FactList({ title, facts }: { title: string; facts: { label: string; value: string }[] }) {
  if (facts.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-ink-2">{title}</p>
      <dl className="mt-0.5 grid gap-x-3 text-xs sm:grid-cols-2">
        {facts.map((f) => (
          <div key={f.label} className="flex min-w-0 gap-1">
            <dt className="shrink-0 text-ink-2">{f.label}:</dt>
            <dd className="min-w-0 break-words">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecCard({ c, brandId, canManage }: { c: RecommendationCardVM; brandId: string; canManage: boolean }) {
  const hidden = { brandId, recommendationId: c.id };
  return (
    <article aria-labelledby={`rec-${c.id}`} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={c.priority === "high" ? "critical" : c.priority === "medium" ? "warning" : "neutral"}>Prioridade: {PRIORITY_LABEL[c.priority] ?? c.priority}</Pill>
        <span className="inline-flex items-center">
          <Pill tone="accent">Confiança: {CONFIDENCE_LABEL[c.confidence] ?? c.confidence}</Pill>
          <InfoTip label="Sobre Confiança">{DEFINITIONS.confidence}</InfoTip>
        </span>
        <Pill>{c.statusLabel}</Pill>
        <span className="text-xs text-ink-2">
          {c.kindLabel}
          {c.account ? ` · ${c.account}` : ""} · atualizado {c.updated}
        </span>
        {c.isDemo ? <DemoBadge /> : null}
      </div>
      <h2 id={`rec-${c.id}`} className="sr-only">
        Recomendação de {c.kindLabel}
      </h2>

      <div lang={c.locale} className="mt-3 grid gap-3 lg:grid-cols-2">
        <section aria-label="Achado observado" className="rounded-md border border-line p-3">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
            <Icon name="eye" className="h-3.5 w-3.5" /> Observado
          </p>
          <p className="font-medium">{c.finding}</p>
          <div className="mt-2 space-y-2">
            <FactList title="Período de comparação" facts={c.periodFacts} />
            <FactList title="Tamanho da amostra" facts={c.sampleFacts} />
            <FactList title="Métricas de apoio" facts={c.otherFacts} />
            {c.posts.length ? (
              <div>
                <p className="text-xs font-semibold text-ink-2">Posts relacionados ({c.posts.length})</p>
                <ul className="mt-0.5 space-y-0.5 text-xs">
                  {c.posts.slice(0, 12).map((p, i) => (
                    <li key={`${p.postId}-${i}`}>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                          {p.group}
                          {p.published ? ` · ${p.published}` : ""}
                          {p.value ? ` · ${p.value}` : ""}
                          <Icon name="external" className="h-3 w-3" />
                          <span className="sr-only">(abre em uma nova aba)</span>
                        </a>
                      ) : (
                        <span>
                          {p.group}
                          {p.published ? ` · ${p.published}` : ""}
                          {p.value ? ` · ${p.value}` : ""}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
        <section aria-label="Hipótese" className="rounded-md border border-dashed border-line-strong bg-canvas p-3">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
            <Icon name="lightbulb" className="h-3.5 w-3.5" /> Hipótese — nossa interpretação, não um fato medido
          </p>
          <p className="italic">{c.interpretation}</p>
          <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-ink-2">Ação sugerida</p>
          <p>{c.action}</p>
          <p className="mt-2 text-xs text-ink-2">
            Métrica de sucesso: {c.successMetric} · Janela de avaliação: {c.evaluationWindowDays} dias
          </p>
        </section>
      </div>

      {c.experiment ? (
        <p className="mt-3 text-sm">
          <Icon name="flask" className="mr-1 inline h-4 w-4 text-accent" />
          {c.experiment.status === "running" ? "Em teste desde" : "Experimento"} {c.experiment.startDate ?? "—"} → {c.experiment.endDate ?? "—"} ({EXPERIMENT_STATUS_LABEL[c.experiment.status] ?? c.experiment.status})
        </p>
      ) : null}

      {canManage && c.status !== "superseded" ? (
        <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-line pt-3">
          {c.status === "proposed" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "accepted" }} submitLabel="Aceitar" variant="secondary" inline /> : null}
          {c.status === "proposed" || c.status === "accepted" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "dismissed" }} submitLabel="Descartar" variant="secondary" inline /> : null}
          {c.status === "accepted" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "done" }} submitLabel="Marcar como concluída" variant="secondary" inline /> : null}
          {c.status === "dismissed" || c.status === "done" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "proposed" }} submitLabel="Restaurar" variant="secondary" inline /> : null}
          {c.canStartExperiment ? (
            <details className="w-full">
              <summary className="link cursor-pointer text-sm">Marcar como em teste (criar experimento)</summary>
              <ActionForm action={createExperimentAction} hidden={hidden} submitLabel="Iniciar experimento" className="mt-2 max-w-xl">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`es-${c.id}`} className="label text-xs">
                      Data de início
                    </label>
                    <input id={`es-${c.id}`} name="startDate" type="date" required defaultValue={c.defaultStart} className="input" />
                  </div>
                  <div>
                    <label htmlFor={`ee-${c.id}`} className="label text-xs">
                      Data de término
                    </label>
                    <input id={`ee-${c.id}`} name="endDate" type="date" required defaultValue={c.defaultEnd} className="input" />
                  </div>
                </div>
                <div>
                  <label htmlFor={`eh-${c.id}`} className="label text-xs">
                    Hipótese (opcional; por padrão, usa a interpretação acima)
                  </label>
                  <textarea id={`eh-${c.id}`} name="hypothesis" rows={2} maxLength={2000} className="input" />
                </div>
              </ActionForm>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default async function RecommendationsPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const filters = {
    status: oneOf(param(sp, "status"), REC_STATUS_FILTERS, "active"),
    priority: oneOf(param(sp, "priority"), REC_PRIORITY_FILTERS, "all"),
    platform: oneOf(param(sp, "platform"), ["all", "instagram", "tiktok", "youtube", "other"] as const, "all") as Platform | "all",
  };
  const vm = await orNotFound(loadRecommendations(getDb(), user, brandId, new Date(), filters));
  const base = `/brands/${vm.brand.id}/recommendations`;

  return (
    <>
      <PageHeader
        title="Recomendações e experimentos"
        subtitle={`Achados a partir dos dados da própria marca, com a evidência por trás de cada um. O texto das recomendações usa o idioma de relatório da marca (${vm.brand.reportLocale}).`}
      />
      <Banner tone="info">
        {vm.lastGenerated ? `As recomendações foram geradas pela última vez em ${vm.lastGenerated}` : "As recomendações ainda não foram geradas"}
        {vm.dataAsOf ? `, com dados de ${vm.dataAsOf}.` : "."} Elas são atualizadas periodicamente, não em tempo real.
      </Banner>
      {!vm.canManage ? <p className="mb-3 text-sm text-ink-2">Você tem acesso somente leitura. Gerentes e proprietários podem aceitar, descartar ou acompanhar recomendações.</p> : null}

      <form method="get" action={base} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3" aria-label="Filtros de recomendações">
        <div>
          <label htmlFor="r-status" className="label text-xs">
            Status
          </label>
          <select id="r-status" name="status" defaultValue={vm.filters.status} className="input">
            {REC_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {STATUS_FILTER_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="r-priority" className="label text-xs">
            Prioridade
          </label>
          <select id="r-priority" name="priority" defaultValue={vm.filters.priority} className="input">
            {REC_PRIORITY_FILTERS.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_FILTER_LABEL[p] ?? p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="r-platform" className="label text-xs">
            Plataforma
          </label>
          <select id="r-platform" name="platform" defaultValue={vm.filters.platform} className="input">
            <option value="all">Todas</option>
            {vm.platforms.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          Aplicar
        </button>
        <Link href={base} className="btn btn-secondary">
          Limpar
        </Link>
      </form>

      {vm.cards.length === 0 ? (
        vm.filters.status === "active" && vm.filters.priority === "all" && vm.filters.platform === "all" ? (
          <EmptyState title="Ainda não há dados suficientes para gerar recomendações para esta marca.">Normalmente precisamos de {vm.emptyThreshold}.</EmptyState>
        ) : (
          <EmptyState title="Nenhuma recomendação corresponde a estes filtros." />
        )
      ) : (
        <ul className="space-y-3">
          {vm.cards.map((c) => (
            <li key={c.id}>
              <RecCard c={c} brandId={vm.brand.id} canManage={vm.canManage} />
            </li>
          ))}
        </ul>
      )}

      <Card labelledBy="experiments" className="mt-6">
        <CardTitle id="experiments">Experimentos</CardTitle>
        {vm.experiments.length === 0 ? (
          <p className="text-sm text-ink-2">Nenhum experimento ainda. Use &ldquo;Marcar como em teste&rdquo; em uma recomendação para acompanhá-la.</p>
        ) : (
          <ul className="space-y-3">
            {vm.experiments.map((e) => (
              <li key={e.id} className="rounded-md border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={e.status === "running" ? "accent" : e.status === "completed" ? "healthy" : "neutral"}>{EXPERIMENT_STATUS_LABEL[e.status] ?? e.status}</Pill>
                  <span className="text-xs text-ink-2">
                    {e.startDate ?? "—"} → {e.endDate ?? "—"} · criado {e.created}
                  </span>
                </div>
                <p className="mt-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">Hipótese: </span>
                  <span className="italic">{e.hypothesis}</span>
                </p>
                <p className="mt-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">Ação: </span>
                  {e.action}
                </p>
                <p className="mt-1 text-xs text-ink-2">Métrica de sucesso: {e.successMetric}</p>
                {e.resultSummary ? <p className="mt-1">Resultado: {e.resultSummary}</p> : null}
                {vm.canManage && !e.finished ? (
                  <details className="mt-2">
                    <summary className="link cursor-pointer text-sm">Atualizar experimento</summary>
                    <ActionForm action={updateExperimentAction} hidden={{ brandId: vm.brand.id, experimentId: e.id }} submitLabel="Salvar" className="mt-2 max-w-xl">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <label htmlFor={`xs-${e.id}`} className="label text-xs">
                            Status
                          </label>
                          <select id={`xs-${e.id}`} name="status" defaultValue={e.status} className="input">
                            <option value="planned">Planejado</option>
                            <option value="running">Em andamento</option>
                            <option value="completed">Concluído</option>
                            <option value="abandoned">Abandonado</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`xe-${e.id}`} className="label text-xs">
                            Data de término
                          </label>
                          <input id={`xe-${e.id}`} name="endDate" type="date" defaultValue={e.endDate ?? ""} className="input" />
                        </div>
                      </div>
                      <div>
                        <label htmlFor={`xr-${e.id}`} className="label text-xs">
                          Resumo do resultado
                        </label>
                        <textarea id={`xr-${e.id}`} name="resultSummary" rows={2} maxLength={4000} defaultValue={e.resultSummary ?? ""} className="input" />
                      </div>
                    </ActionForm>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
