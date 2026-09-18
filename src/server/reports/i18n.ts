/**
 * Report-locale strings and formatters (pt-BR default, en-US, es-ES). Narrative templates only receive values that
 * already exist in the deterministic facts; they never introduce causes, benchmarks or new numbers.
 * Wording rule: findings are observations ("variou", "ficou abaixo"), interpretations are labeled hypotheses.
 */
import { DateTime } from "luxon";
import type { CoverageState, MetricKey, Platform } from "@/domain/types";
import type { RankingExclusionReason } from "@/domain/ranking";
import { SUPPORTED_REPORT_LOCALES, type CellStatus, type KpiMetricId, type PreliminaryReasonCode, type ReportLabels, type ReportLocale, type ReportNaCode } from "./types";

export function resolveReportLocale(raw: string | null | undefined): ReportLocale {
  const value = (raw ?? "").trim();
  const exact = SUPPORTED_REPORT_LOCALES.find((l) => l.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const lang = value.slice(0, 2).toLowerCase();
  if (lang === "en") return "en-US";
  if (lang === "es") return "es-ES";
  return "pt-BR";
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
export function fmtNumber(locale: ReportLocale, n: number, maxDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: maxDigits, minimumFractionDigits: 0 }).format(n);
}

export function fmtPct(locale: ReportLocale, n: number, digits = 1, signed = true): string {
  const s = fmtNumber(locale, Math.abs(n), digits);
  const sign = signed ? (n > 0 ? "+" : n < 0 ? "−" : "") : n < 0 ? "−" : "";
  return `${sign}${s}%`;
}

export function fmtRatio(locale: ReportLocale, n: number): string {
  return `${fmtNumber(locale, n, 1)}×`;
}

export function fmtDate(locale: ReportLocale, isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "UTC" }).setLocale(locale).toLocaleString(DateTime.DATE_SHORT);
}

export function fmtDateTime(locale: ReportLocale, isoInstant: string, timezone: string): string {
  return DateTime.fromISO(isoInstant, { zone: "UTC" }).setZone(timezone).setLocale(locale).toLocaleString(DateTime.DATETIME_SHORT);
}

export function fmtAge(locale: ReportLocale, hours: number): string {
  const m = messages(locale);
  return hours >= 24 ? `${fmtNumber(locale, hours / 24, 1)} ${m.labels.days}` : `${fmtNumber(locale, hours, 0)} ${m.labels.hours}`;
}

const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);

// ---------------------------------------------------------------------------
// Message catalog
// ---------------------------------------------------------------------------
export interface Messages {
  labels: ReportLabels;
  kpi: Record<KpiMetricId, string>;
  trend: { median_views_per_post: string; median_engagement_rate: string };
  metric: Record<MetricKey, string>;
  na: Record<ReportNaCode, string>;
  excluded: Record<RankingExclusionReason, string>;
  preliminary: Record<PreliminaryReasonCode, (handle: string | null) => string>;
  summary: {
    period: (start: string, end: string, posts: number, postsF: string, accounts: number, prevF: string) => string;
    noAccounts: string;
    viewsChange: (handle: string, age: string, pct: string) => string;
    best: (count: number, min: string, handle: string, score: string) => string;
    under: (count: number, max: string) => string;
    failures: (count: number) => string;
    coverageRisk: (count: number) => string;
    preliminary: string;
    final: string;
  };
  kpiNarrative: (accounts: number, cutoff: string) => string;
  comparisonNote: (target: string, minSample: string) => string;
  consistency: {
    narrative: (onTrack: number, withCadence: number, failed: number) => string;
    paused: string;
    noCadence: string;
    estimate: string;
    defaultCadence: string;
    currentCadence: string;
    neverSynced: string;
    atGeneration: (state: string, slot: string | null) => string;
    disconnected: string;
    queuePaused: string;
  };
  content: {
    method: (days: string, minAge: string, minCohort: string, best: string, under: string) => string;
    bestFairness: string;
    underFairness: (minAge: string) => string;
    explanation: (views: string, score: string, median: string, size: string, platform: string, format: string, days: string, age: string) => string;
    unknownFormat: string;
    bestNarrative: (count: number, min: string) => string;
    underNarrative: (count: number, max: string) => string;
    bestEmpty: (min: string) => string;
    underEmpty: (max: string) => string;
    noneRankable: string;
  };
  trends: {
    narrative: (weeks: string, minWeeks: string) => string;
    audience: string;
    line: (handle: string, label: string, value: string, baseline: string, pct: string) => string;
    insufficient: (handle: string) => string;
  };
  insights: {
    metricUp: (handle: string, label: string, pct: string, age: string) => string;
    metricDown: (handle: string, label: string, pct: string, age: string) => string;
    best: (count: number, handle: string, score: string) => string;
    allSlots: (handle: string, covered: string, planned: string) => string;
    missedSlots: (handle: string, missed: string, planned: string) => string;
    noFailures: (posts: string) => string;
    failures: (handle: string, count: number) => string;
    coverageRisk: (handle: string, state: string, postsNeeded: string, slot: string | null) => string;
    disconnected: (handle: string) => string;
    syncStale: (handle: string) => string;
    trendAbove: (handle: string, label: string, pct: string) => string;
    trendBelow: (handle: string, label: string, pct: string) => string;
    under: (count: number) => string;
    wentWellNarrative: (count: number) => string;
    needsNarrative: (count: number) => string;
    wentWellEmpty: string;
    needsEmpty: string;
  };
  actions: {
    narrative: string;
    reconnect_account: (handle: string) => [string, string, string];
    fix_publish_failures: (handle: string, count: number) => [string, string, string];
    replenish_queue: (handle: string, posts: string, deadline: string | null, days: string | null) => [string, string, string];
    restore_cadence: (handle: string, missed: string, planned: string) => [string, string, string];
    repeat_top_format: (handle: string, format: string, score: string) => [string, string, string];
    review_underperforming: (count: number) => [string, string, string];
    resolve_sync: (handle: string) => [string, string, string];
    wait_for_metrics: () => [string, string, string];
    tag_content_pillars: (tagged: boolean) => [string, string, string];
    maintain_cadence: () => [string, string, string];
    track_success_metrics: () => [string, string, string];
  };
  quality: {
    narrative: (cutoff: string, preliminary: boolean) => string;
    comparisonMethod: (target: string, minAge: string, tolerance: string, minSample: string) => string;
    complete: (cutoff: string) => string;
    incomplete: (parts: string[]) => string;
    pendingPart: (n: number) => string;
    notRefreshedPart: (n: number) => string;
    notReportedPart: (list: string) => string;
    likelyNotReportedPart: (list: string) => string;
    noComparisonPart: (n: number) => string;
    unsupportedNote: (list: string) => string;
    localeFallback: (requested: string) => string;
    limitations: string[];
  };
}

const PLATFORMS_EN: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", other: "Other" };

const ptBR: Messages = {
  labels: {
    reportTitle: "Relatório semanal",
    periodLabel: "Período",
    generatedAtLabel: "Gerado em",
    preliminaryBanner:
      "Este relatório foi gerado com dados que ainda podem estar em atualização. Uma versão final o substituirá quando todas as métricas forem sincronizadas.",
    finalBadge: "Final",
    preliminaryBadge: "Preliminar",
    sections: {
      executiveSummary: "1. Resumo executivo",
      kpiTable: "2. Métricas por conta",
      publicationConsistency: "3. Consistência de publicação e saúde do agendamento",
      bestContent: "4. Melhores conteúdos",
      underperformingContent: "5. Conteúdos abaixo do esperado",
      audienceAndEngagementTrends: "6. Audiência e tendências de engajamento",
      wentWell: "7. O que foi bem",
      needsImprovement: "8. O que precisa melhorar",
      actions: "9. Ações prioritárias",
      dataQuality: "10. Atualização dos dados, métricas ausentes e limitações",
    },
    columns: {
      account: "Conta",
      platform: "Plataforma",
      metric: "Métrica",
      latest: "Acumulado atual",
      current: "Semana (mesma idade)",
      previous: "Semana anterior (mesma idade)",
      change: "Variação",
      status: "Status",
      definition: "Definição",
      plannedSlots: "Horários planejados",
      published: "Publicados",
      failed: "Falhas",
      coverageNow: "Fila na geração",
      score: "Índice vs. mediana",
      views: "Visualizações",
      cohortMedian: "Mediana do grupo",
      confidence: "Confiança",
      baseline: "Linha de base (4 semanas)",
      priority: "Prioridade",
      successMetric: "Métrica de sucesso",
      evaluationWindow: "Janela de avaliação",
      lastSync: "Última sincronização",
      link: "Link",
    },
    statuses: { available: "Disponível", partial: "Parcial", unavailable: "Indisponível", unsupported: "Não suportado", pending: "Pendente" },
    priorities: { high: "Alta", medium: "Média", low: "Baixa" },
    confidences: { high: "Alta", medium: "Média", low: "Baixa" },
    platforms: { ...PLATFORMS_EN, other: "Outra" },
    coverageStates: { healthy: "Saudável", warning: "Atenção", critical: "Crítica", empty: "Vazia", paused: "Pausada", unknown: "Desconhecida" },
    audienceUnavailable: "Requer conexão direta com a plataforma",
    days: "dias",
    hours: "h",
  },
  kpi: {
    posts_published: "Posts publicados",
    views: "Visualizações (soma)",
    reactions: "Reações (soma)",
    comments: "Comentários (soma)",
    shares: "Compartilhamentos (soma)",
    saves: "Salvamentos (soma)",
    total_watch_time: "Tempo total assistido, min (soma)",
    reach_median: "Alcance por post (mediana)",
    engagement_rate_median: "Taxa de engajamento por post (mediana)",
    provider_engagement_rate_median: "Taxa de engajamento do Buffer (mediana)",
    avg_watch_time_median: "Tempo médio assistido, s (mediana)",
  },
  trend: { median_views_per_post: "Visualizações por post (mediana)", median_engagement_rate: "Taxa de engajamento por post (mediana)" },
  metric: {
    reactions: "reações",
    comments: "comentários",
    shares: "compartilhamentos",
    saves: "salvamentos",
    views: "visualizações",
    reach: "alcance",
    impressions: "impressões",
    clicks: "cliques",
    follows: "seguidores ganhos por post",
    provider_engagement_rate: "taxa de engajamento do Buffer",
    avg_watch_time_seconds: "tempo médio assistido",
    total_watch_time_minutes: "tempo total assistido",
    followers: "seguidores",
  },
  na: {
    numerator_unavailable: "Componentes da fórmula indisponíveis.",
    denominator_unavailable: "Denominador indisponível.",
    denominator_zero: "Valor anterior igual a 0: variação percentual indefinida.",
    starting_audience_not_positive: "Audiência inicial não positiva.",
    insufficient_sample: "Amostra insuficiente para comparar.",
    incompatible_definitions: "Definições diferentes não são comparáveis.",
    not_summable: "Esta métrica não pode ser somada entre posts.",
    partial_period: "Período incompleto: comparação suspensa.",
    unsupported_by_provider: "Não suportado por esta plataforma via Buffer.",
    no_data: "Sem dados utilizáveis.",
    no_posts: "Nenhum post publicado no período.",
    metrics_pending: "Métricas ainda não processadas pelo Buffer.",
    not_reported: "Métrica não informada pela plataforma.",
    never_synced: "Posts publicados ainda não sincronizados.",
    incomplete_sample: "Nem todos os posts têm este dado: a soma seria parcial e não é comparada.",
    insufficient_post_age: "Posts da semana ainda muito recentes para uma comparação justa.",
    no_comparable_observation: "Não há observação na mesma idade de post para comparar.",
    requires_direct_connection: "Requer conexão direta com a plataforma: o Buffer não fornece número de seguidores ou inscritos.",
  },
  excluded: {
    duplicate_observation: "observação duplicada",
    metrics_pending: "métricas pendentes",
    too_young_at_observation: "observado há menos de 72 h da publicação",
    primary_metric_unavailable: "visualizações indisponíveis",
    primary_metric_ambiguous_zero: "visualizações iguais a 0 (possível valor padrão)",
    cohort_too_small: "grupo com poucos posts",
    cohort_median_zero: "mediana do grupo igual a 0",
  },
  preliminary: {
    period_incomplete: () => "O período ainda não terminou.",
    published_sync_missing: (h) => `${h}: posts publicados nunca foram sincronizados com sucesso.`,
    published_sync_before_cutoff: (h) => `${h}: a última sincronização de métricas ocorreu antes de 24 h após o fim do período.`,
    queue_sync_stale: (h) => `${h}: dados da fila desatualizados.`,
    queue_sync_never: (h) => `${h}: a fila nunca foi sincronizada.`,
    post_metrics_pending: (h) => `${h}: há posts do período com métricas ainda não processadas pelo Buffer.`,
    post_metrics_not_refreshed: (h) => `${h}: há posts cujas métricas não foram atualizadas desde o fim do período.`,
  },
  summary: {
    period: (s, e, n, nf, a, pf) => `Semana de ${s} a ${e}: ${nf} ${plural(n, "post publicado", "posts publicados")} em ${a} ${plural(a, "conta", "contas")} (semana anterior: ${pf}).`,
    noAccounts: "Nenhuma conta está mapeada para esta marca, portanto não há dados para o período.",
    viewsChange: (h, age, pct) => `${h}: as visualizações dos posts da semana, comparadas na mesma idade (${age}), variaram ${pct} em relação à semana anterior.`,
    best: (c, min, h, s) => `${c} ${plural(c, "post ficou", "posts ficaram")} pelo menos ${min} acima da mediana do próprio grupo; o maior índice foi de ${h} (${s}).`,
    under: (c, max) => `${c} ${plural(c, "post ficou", "posts ficaram")} em até ${max} da mediana do próprio grupo.`,
    failures: (c) => `${c} ${plural(c, "falha de publicação registrada", "falhas de publicação registradas")} no período.`,
    coverageRisk: (c) => `${c} ${plural(c, "conta está", "contas estão")} com a fila em estado crítico ou vazia no momento da geração.`,
    preliminary: "Relatório preliminar: parte dos dados ainda está em atualização (ver seção 10).",
    final: "Relatório final: métricas sincronizadas após o fim do período.",
  },
  kpiNarrative: (a, cutoff) =>
    `Valores acumulados (vida útil) dos posts publicados na semana em ${a} ${plural(a, "conta", "contas")}, observados até ${cutoff}. Valores ausentes aparecem como Indisponível, Não suportado ou Pendente, nunca como zero.`,
  comparisonNote: (target, min) =>
    `A variação semanal compara posts na mesma idade: para cada post das duas semanas usa-se a observação mais próxima (sem ultrapassar) da idade indicada, preferencialmente ${target}. Somas só são comparadas quando todos os posts têm o dado; medianas exigem pelo menos ${min} posts em cada semana. Plataformas diferentes nunca são comparadas entre si.`,
  consistency: {
    narrative: (ok, withCadence, failed) =>
      `${ok} de ${withCadence} ${plural(withCadence, "conta com cadência cumpriu", "contas com cadência cumpriram")} todos os horários planejados; ${failed} ${plural(failed, "falha de publicação", "falhas de publicação")} no período.`,
    paused: "Cadência pausada: sem horários planejados.",
    noCadence: "Sem cadência configurada: horários planejados indisponíveis.",
    estimate: "Cadência irregular: horários planejados são uma estimativa.",
    defaultCadence: "Usando os horários de publicação do Buffer (cadência padrão).",
    currentCadence: "Horários planejados calculados com a cadência configurada atualmente.",
    neverSynced: "Posts publicados ainda não sincronizados.",
    atGeneration: (state, slot) => `No momento da geração: fila ${state}${slot ? `, primeiro horário sem post em ${slot}` : ""}.`,
    disconnected: "Conta desconectada no momento da geração.",
    queuePaused: "Fila pausada no Buffer no momento da geração.",
  },
  content: {
    method: (days, minAge, minCohort, best, under) =>
      `Classificação por visualizações em relação à mediana de visualizações dos posts da mesma conta, plataforma e formato publicados nos últimos ${days} dias (posts observados com pelo menos ${minAge} h de publicação; grupos com no mínimo ${minCohort} posts). A taxa de engajamento (Instagram: por alcance; TikTok e YouTube: por visualizações) aparece como evidência e só desempata. Contagens brutas nunca são comparadas entre plataformas ou contas. "Melhores" exigem pelo menos ${best} a mediana; "abaixo do esperado", no máximo ${under}. Métricas são totais acumulados até a última atualização de cada post.`,
    bestFairness: "Cada post é comparado apenas com posts do mesmo grupo (conta, plataforma e formato). Idades de observação muito diferentes reduzem a confiança.",
    underFairness: (minAge) =>
      `Comparação justa: somente com posts do mesmo grupo (conta, plataforma e formato), observados com pelo menos ${minAge} h. Ficar abaixo da mediana é uma observação, não indica a causa.`,
    explanation: (v, s, m, size, p, f, d, age) => `${v} visualizações, ${s} a mediana (${m}) de ${size} posts ${p} ${f} desta conta nos últimos ${d} dias; observado ${age} h após a publicação.`,
    unknownFormat: "de formato desconhecido",
    bestNarrative: (c, min) => `${c} ${plural(c, "post atingiu", "posts atingiram")} pelo menos ${min} a mediana do próprio grupo.`,
    underNarrative: (c, max) => `${c} ${plural(c, "post ficou", "posts ficaram")} em até ${max} da mediana do próprio grupo.`,
    bestEmpty: (min) => `Nenhum post elegível atingiu ${min} a mediana do próprio grupo.`,
    underEmpty: (max) => `Nenhum post elegível ficou em até ${max} da mediana do próprio grupo.`,
    noneRankable: "Nenhum post do período pôde ser classificado (ver motivos de exclusão).",
  },
  trends: {
    narrative: (w, min) =>
      `Tendências por conta usam a mediana por post, observada na mesma idade de post em todas as semanas, comparada à linha de base das ${w} semanas anteriores (mínimo de ${min} semanas completas com dados).`,
    audience: "Requer conexão direta com a plataforma: o Buffer não fornece número de seguidores ou inscritos. Crescimento de audiência não é exibido como zero.",
    line: (h, l, v, b, pct) => `${h}: ${l} de ${v} contra linha de base de ${b} (${pct}).`,
    insufficient: (h) => `${h}: semanas completas insuficientes para uma linha de base.`,
  },
  insights: {
    metricUp: (h, l, pct, age) => `${h}: ${l} ${pct} em relação à semana anterior (posts comparados na mesma idade: ${age}).`,
    metricDown: (h, l, pct, age) => `${h}: ${l} ${pct} em relação à semana anterior (posts comparados na mesma idade: ${age}).`,
    best: (c, h, s) => `${c} ${plural(c, "post ficou", "posts ficaram")} acima do esperado para o próprio grupo; destaque para ${h} (${s} a mediana).`,
    allSlots: (h, c, p) => `${h}: ${c} de ${p} horários planejados receberam publicação.`,
    missedSlots: (h, m, p) => `${h}: ${m} de ${p} horários planejados ficaram sem publicação.`,
    noFailures: (posts) => `Nenhuma falha de publicação registrada entre ${posts} posts publicados.`,
    failures: (h, c) => `${h}: ${c} ${plural(c, "falha de publicação", "falhas de publicação")} no período.`,
    coverageRisk: (h, s, n, slot) => `${h}: fila ${s} na geração do relatório; ${n} post(s) necessário(s)${slot ? `, primeiro horário sem post em ${slot}` : ""}.`,
    disconnected: (h) => `${h}: conta desconectada no Buffer.`,
    syncStale: (h) => `${h}: sincronização da fila desatualizada; a cobertura não pôde ser confirmada.`,
    trendAbove: (h, l, pct) => `${h}: ${l} ${pct} acima da linha de base de 4 semanas.`,
    trendBelow: (h, l, pct) => `${h}: ${l} ${pct} abaixo da linha de base de 4 semanas.`,
    under: (c) => `${c} ${plural(c, "post ficou", "posts ficaram")} abaixo do esperado para o próprio grupo.`,
    wentWellNarrative: (c) => `${c} ${plural(c, "ponto positivo observado", "pontos positivos observados")} nos dados da semana.`,
    needsNarrative: (c) => `${c} ${plural(c, "ponto de atenção observado", "pontos de atenção observados")} nos dados da semana.`,
    wentWellEmpty: "Nenhum destaque positivo pôde ser confirmado com os dados disponíveis.",
    needsEmpty: "Nenhum ponto de atenção identificado com os dados disponíveis.",
  },
  actions: {
    narrative: "Ações priorizadas a partir das observações acima. Cada uma tem uma métrica de sucesso e uma janela de avaliação; são hipóteses a testar, não garantias de resultado.",
    reconnect_account: (h) => [`Reconectar ${h} no Buffer`, "A conta aparece desconectada; posts agendados não serão publicados até a reconexão.", "Conta conectada e nenhuma falha de publicação"],
    fix_publish_failures: (h, c) => [
      `Resolver ${c} ${plural(c, "falha", "falhas")} de publicação em ${h}`,
      "Verifique a mensagem de erro de cada post, corrija a causa informada pelo Buffer e reagende o conteúdo.",
      "Nenhuma falha de publicação na próxima semana",
    ],
    replenish_queue: (h, n, deadline, days) => [
      `Agendar ${n} post(s) para ${h}${deadline ? ` até ${deadline}` : ""}`,
      days ? `A fila cobre ${days} dias dos horários planejados.` : "A fila não cobre os próximos horários planejados.",
      "Cobertura contínua da fila de pelo menos 7 dias",
    ],
    restore_cadence: (h, m, p) => [`Retomar a cadência planejada em ${h}`, `${m} de ${p} horários planejados ficaram sem publicação na semana.`, "Todos os horários planejados com publicação"],
    repeat_top_format: (h, f, s) => [
      `Testar mais posts no formato ${f} em ${h}`,
      `O melhor índice relativo da semana foi de um post ${f} (${s} a mediana do grupo). É uma hipótese a testar, não uma causa comprovada.`,
      "Mediana de visualizações por post do formato, na mesma idade, contra a linha de base de 4 semanas",
    ],
    review_underperforming: (c) => [
      `Revisar ${plural(c, "o post", `os ${c} posts`)} abaixo do esperado`,
      "Compare com os melhores posts do mesmo grupo antes de mudar a estratégia; a diferença pode ter causas externas aos dados.",
      "Quantidade de posts abaixo de 0,8× a mediana do grupo",
    ],
    resolve_sync: (h) => [`Restabelecer a sincronização de ${h}`, "Os dados da fila estão desatualizados, então a cobertura não pode ser confirmada.", "Fila sincronizada dentro do intervalo configurado"],
    wait_for_metrics: () => ["Revisar a versão final do relatório", "Parte das métricas ainda está em atualização no Buffer (até cerca de 24 h após a publicação).", "Relatório marcado como final"],
    tag_content_pillars: (tagged) => [
      "Marcar os posts com pilares de conteúdo",
      tagged ? "Continue marcando todos os posts com pilar ou tema para que a comparação por tema tenha amostra suficiente." : "Sem tags de pilar ou tema não é possível comparar o desempenho por tema.",
      "Percentual de posts da semana com tag de pilar",
    ],
    maintain_cadence: () => ["Manter a cadência planejada", "Continue cobrindo todos os horários planejados para manter a consistência observada.", "Todos os horários planejados com publicação"],
    track_success_metrics: () => [
      "Acompanhar as métricas de sucesso no próximo relatório",
      "Compare estas métricas com as da próxima semana, na mesma idade de post, antes de concluir que há uma tendência.",
      "Variação semanal na mesma idade disponível para todas as contas",
    ],
  },
  quality: {
    narrative: (cutoff, pre) => `Dados observados até ${cutoff}. ${pre ? "Versão preliminar: veja os motivos abaixo." : "Versão final."}`,
    comparisonMethod: (target, minAge, tol, min) =>
      `Comparação semanal na mesma idade de post (preferencialmente ${target}; nunca abaixo de ${minAge} h). Para cada post usa-se a observação mais próxima sem ultrapassar essa idade, com tolerância de até ${tol} h; posts sem observação adequada ficam fora e a soma não é comparada. Medianas exigem ${min} posts por semana.`,
    complete: (cutoff) => `Todas as métricas atualizadas até ${cutoff}. Nenhum dado ausente neste período.`,
    incomplete: (parts) => `Dados ausentes ou limitados: ${parts.join("; ")}.`,
    pendingPart: (n) => `${n} ${plural(n, "post com métricas pendentes", "posts com métricas pendentes")}`,
    notRefreshedPart: (n) => `${n} ${plural(n, "post sem atualização de métricas", "posts sem atualização de métricas")} após o fim do período`,
    notReportedPart: (l) => `métricas não informadas: ${l}`,
    likelyNotReportedPart: (l) => `sempre iguais a 0 (provavelmente não informadas): ${l}`,
    noComparisonPart: (n) => `${n} ${plural(n, "conta sem", "contas sem")} comparação semanal na mesma idade`,
    unsupportedNote: (l) => `Não suportadas via Buffer para esta plataforma: ${l}.`,
    localeFallback: (r) => `Idioma "${r}" não suportado nos relatórios; usado pt-BR.`,
    limitations: [
      "Zero ambíguo: o Buffer retorna 0 quando a rede não informa a métrica; um 0 pode não ser um zero real.",
      "Métricas sempre zeradas (por exemplo, seguidores ganhos por post no Instagram) são tratadas como provavelmente não informadas.",
      "As métricas são atualizadas cerca de uma vez por dia e ficam pendentes por até ~24 h após a publicação; posts recentes aparecem subestimados.",
      "O Buffer não fornece seguidores ou inscritos: crescimento de audiência requer conexão direta com a plataforma.",
      "A fórmula da taxa de engajamento do Buffer não é documentada e nunca é comparada com as taxas calculadas pelo BrandPulse.",
      "Alcance não pode ser somado nem deduplicado entre posts, contas ou plataformas; usamos a mediana por post.",
      "Os números são o desempenho acumulado dos posts publicados na semana, não a atividade ocorrida durante a semana.",
      "Não é possível separar alcance pago de orgânico via Buffer.",
      "Cada plataforma conta visualizações de forma diferente; visualizações só são comparadas dentro do mesmo grupo.",
      "A consistência usa a cadência configurada atualmente e a última sincronização; cadências irregulares são estimativas.",
    ],
  },
};

const enUS: Messages = {
  labels: {
    reportTitle: "Weekly report",
    periodLabel: "Period",
    generatedAtLabel: "Generated at",
    preliminaryBanner: "This report was generated with data that may still be updating. A finalized version will replace it once all metrics have synced.",
    finalBadge: "Final",
    preliminaryBadge: "Preliminary",
    sections: {
      executiveSummary: "1. Executive summary",
      kpiTable: "2. Account KPIs",
      publicationConsistency: "3. Publication consistency & scheduling health",
      bestContent: "4. Best content",
      underperformingContent: "5. Underperforming content",
      audienceAndEngagementTrends: "6. Audience & engagement trends",
      wentWell: "7. What went well",
      needsImprovement: "8. What needs improvement",
      actions: "9. Prioritized actions",
      dataQuality: "10. Data freshness, missing metrics & limitations",
    },
    columns: {
      account: "Account",
      platform: "Platform",
      metric: "Metric",
      latest: "Lifetime to date",
      current: "Week (same age)",
      previous: "Previous week (same age)",
      change: "Change",
      status: "Status",
      definition: "Definition",
      plannedSlots: "Planned slots",
      published: "Published",
      failed: "Failed",
      coverageNow: "Queue at generation",
      score: "Score vs. median",
      views: "Views",
      cohortMedian: "Cohort median",
      confidence: "Confidence",
      baseline: "Baseline (4 weeks)",
      priority: "Priority",
      successMetric: "Success metric",
      evaluationWindow: "Evaluation window",
      lastSync: "Last sync",
      link: "Link",
    },
    statuses: { available: "Available", partial: "Partial", unavailable: "Unavailable", unsupported: "Not supported", pending: "Pending" },
    priorities: { high: "High", medium: "Medium", low: "Low" },
    confidences: { high: "High", medium: "Medium", low: "Low" },
    platforms: PLATFORMS_EN,
    coverageStates: { healthy: "Healthy", warning: "Warning", critical: "Critical", empty: "Empty", paused: "Paused", unknown: "Unknown" },
    audienceUnavailable: "Requires direct platform connection",
    days: "days",
    hours: "h",
  },
  kpi: {
    posts_published: "Posts published",
    views: "Views (sum)",
    reactions: "Reactions (sum)",
    comments: "Comments (sum)",
    shares: "Shares (sum)",
    saves: "Saves (sum)",
    total_watch_time: "Total watch time, min (sum)",
    reach_median: "Reach per post (median)",
    engagement_rate_median: "Engagement rate per post (median)",
    provider_engagement_rate_median: "Buffer engagement rate (median)",
    avg_watch_time_median: "Average watch time, s (median)",
  },
  trend: { median_views_per_post: "Views per post (median)", median_engagement_rate: "Engagement rate per post (median)" },
  metric: {
    reactions: "reactions",
    comments: "comments",
    shares: "shares",
    saves: "saves",
    views: "views",
    reach: "reach",
    impressions: "impressions",
    clicks: "clicks",
    follows: "follows from post",
    provider_engagement_rate: "Buffer engagement rate",
    avg_watch_time_seconds: "average watch time",
    total_watch_time_minutes: "total watch time",
    followers: "followers",
  },
  na: {
    numerator_unavailable: "Formula components unavailable.",
    denominator_unavailable: "Denominator unavailable.",
    denominator_zero: "Previous value is 0: percent change undefined.",
    starting_audience_not_positive: "Starting audience is not positive.",
    insufficient_sample: "Sample too small to compare.",
    incompatible_definitions: "Different definitions are not comparable.",
    not_summable: "This metric cannot be summed across posts.",
    partial_period: "Period incomplete: comparison withheld.",
    unsupported_by_provider: "Not supported for this platform via Buffer.",
    no_data: "No usable data.",
    no_posts: "No posts published in the period.",
    metrics_pending: "Metrics not yet processed by Buffer.",
    not_reported: "Metric not reported by the platform.",
    never_synced: "Published posts not synchronized yet.",
    incomplete_sample: "Not every post has this value: the sum would be partial and is not compared.",
    insufficient_post_age: "This week's posts are still too recent for a fair comparison.",
    no_comparable_observation: "No observation at the same post age is available to compare.",
    requires_direct_connection: "Requires direct platform connection: Buffer does not provide follower or subscriber counts.",
  },
  excluded: {
    duplicate_observation: "duplicate observation",
    metrics_pending: "metrics pending",
    too_young_at_observation: "observed less than 72h after publishing",
    primary_metric_unavailable: "views unavailable",
    primary_metric_ambiguous_zero: "views reported as 0 (possible default)",
    cohort_too_small: "cohort too small",
    cohort_median_zero: "cohort median is 0",
  },
  preliminary: {
    period_incomplete: () => "The period has not ended yet.",
    published_sync_missing: (h) => `${h}: published posts were never synchronized successfully.`,
    published_sync_before_cutoff: (h) => `${h}: the last metrics sync happened earlier than 24h after the period end.`,
    queue_sync_stale: (h) => `${h}: queue data is stale.`,
    queue_sync_never: (h) => `${h}: the queue was never synchronized.`,
    post_metrics_pending: (h) => `${h}: some posts in the period have metrics not yet processed by Buffer.`,
    post_metrics_not_refreshed: (h) => `${h}: some posts' metrics have not been refreshed since the period ended.`,
  },
  summary: {
    period: (s, e, n, nf, a, pf) => `Week of ${s} to ${e}: ${nf} ${plural(n, "post", "posts")} published across ${a} ${plural(a, "account", "accounts")} (previous week: ${pf}).`,
    noAccounts: "No account is mapped to this brand, so there is no data for the period.",
    viewsChange: (h, age, pct) => `${h}: views of this week's posts, compared at the same post age (${age}), changed ${pct} versus the previous week.`,
    best: (c, min, h, s) => `${c} ${plural(c, "post was", "posts were")} at least ${min} their cohort median; the highest score was on ${h} (${s}).`,
    under: (c, max) => `${c} ${plural(c, "post was", "posts were")} at or below ${max} their cohort median.`,
    failures: (c) => `${c} publishing ${plural(c, "failure", "failures")} recorded in the period.`,
    coverageRisk: (c) => `${c} ${plural(c, "account has", "accounts have")} a critical or empty queue at generation time.`,
    preliminary: "Preliminary report: some data is still updating (see section 10).",
    final: "Final report: metrics synchronized after the period ended.",
  },
  kpiNarrative: (a, cutoff) =>
    `Lifetime totals of posts published this week across ${a} ${plural(a, "account", "accounts")}, observed up to ${cutoff}. Missing values show as Unavailable, Not supported or Pending, never as zero.`,
  comparisonNote: (target, min) =>
    `Week-over-week changes compare posts at the same age: for each post in both weeks, the observation closest to (but not after) the stated age is used, preferably ${target}. Sums are compared only when every post has the value; medians need at least ${min} posts per week. Different platforms are never compared with each other.`,
  consistency: {
    narrative: (ok, withCadence, failed) => `${ok} of ${withCadence} ${plural(withCadence, "account", "accounts")} with a cadence covered every planned slot; ${failed} publishing ${plural(failed, "failure", "failures")} in the period.`,
    paused: "Cadence paused: no planned slots.",
    noCadence: "No cadence configured: planned slots unavailable.",
    estimate: "Irregular cadence: planned slots are an estimate.",
    defaultCadence: "Using Buffer posting slots (default cadence).",
    currentCadence: "Planned slots computed from the currently configured cadence.",
    neverSynced: "Published posts not synchronized yet.",
    atGeneration: (state, slot) => `At generation time: queue ${state}${slot ? `, first uncovered slot at ${slot}` : ""}.`,
    disconnected: "Account disconnected at generation time.",
    queuePaused: "Queue paused in Buffer at generation time.",
  },
  content: {
    method: (days, minAge, minCohort, best, under) =>
      `Ranked by views relative to the median views of posts from the same account, platform and format published in the trailing ${days} days (posts observed at least ${minAge}h after publishing; cohorts need at least ${minCohort} posts). Engagement rate (Instagram: by reach; TikTok and YouTube: by views) is shown as supporting evidence and only breaks ties. Raw counts are never compared across platforms or accounts. "Best" requires at least ${best} the cohort median; "underperforming" at most ${under}. Metrics are lifetime totals as of each post's last refresh.`,
    bestFairness: "Each post is compared only with posts from the same cohort (account, platform and format). Very different observation ages lower the confidence.",
    underFairness: (minAge) => `Fair comparison: only against posts of the same cohort (account, platform and format) observed at least ${minAge}h after publishing. Being below the median is an observation, not a cause.`,
    explanation: (v, s, m, size, p, f, d, age) => `${v} views, ${s} the median (${m}) of ${size} ${p} ${f} posts from this account in the trailing ${d} days; observed ${age}h after publishing.`,
    unknownFormat: "unknown-format",
    bestNarrative: (c, min) => `${c} ${plural(c, "post reached", "posts reached")} at least ${min} their cohort median.`,
    underNarrative: (c, max) => `${c} ${plural(c, "post was", "posts were")} at or below ${max} their cohort median.`,
    bestEmpty: (min) => `No eligible post reached ${min} its cohort median.`,
    underEmpty: (max) => `No eligible post was at or below ${max} its cohort median.`,
    noneRankable: "No post in the period could be ranked (see exclusion reasons).",
  },
  trends: {
    narrative: (w, min) => `Per-account trends use the median per post, observed at the same post age every week, against the baseline of the ${w} previous weeks (at least ${min} complete weeks with data).`,
    audience: "Requires direct platform connection: Buffer does not provide follower or subscriber counts. Audience growth is never shown as zero.",
    line: (h, l, v, b, pct) => `${h}: ${l} of ${v} against a baseline of ${b} (${pct}).`,
    insufficient: (h) => `${h}: not enough complete weeks for a baseline.`,
  },
  insights: {
    metricUp: (h, l, pct, age) => `${h}: ${l} ${pct} versus the previous week (posts compared at the same age: ${age}).`,
    metricDown: (h, l, pct, age) => `${h}: ${l} ${pct} versus the previous week (posts compared at the same age: ${age}).`,
    best: (c, h, s) => `${c} ${plural(c, "post", "posts")} above expectations for their cohort; top: ${h} (${s} the median).`,
    allSlots: (h, c, p) => `${h}: ${c} of ${p} planned slots had a publication.`,
    missedSlots: (h, m, p) => `${h}: ${m} of ${p} planned slots had no publication.`,
    noFailures: (posts) => `No publishing failures among ${posts} published posts.`,
    failures: (h, c) => `${h}: ${c} publishing ${plural(c, "failure", "failures")} in the period.`,
    coverageRisk: (h, s, n, slot) => `${h}: queue ${s} at report generation; ${n} post(s) needed${slot ? `, first uncovered slot at ${slot}` : ""}.`,
    disconnected: (h) => `${h}: account disconnected in Buffer.`,
    syncStale: (h) => `${h}: queue sync is stale; coverage could not be confirmed.`,
    trendAbove: (h, l, pct) => `${h}: ${l} ${pct} above the 4-week baseline.`,
    trendBelow: (h, l, pct) => `${h}: ${l} ${pct} below the 4-week baseline.`,
    under: (c) => `${c} ${plural(c, "post", "posts")} below expectations for their cohort.`,
    wentWellNarrative: (c) => `${c} positive ${plural(c, "observation", "observations")} in this week's data.`,
    needsNarrative: (c) => `${c} ${plural(c, "point", "points")} needing attention in this week's data.`,
    wentWellEmpty: "No positive highlight could be confirmed with the available data.",
    needsEmpty: "No issue identified with the available data.",
  },
  actions: {
    narrative: "Actions prioritized from the observations above. Each has a success metric and an evaluation window; they are hypotheses to test, not guaranteed outcomes.",
    reconnect_account: (h) => [`Reconnect ${h} in Buffer`, "The account shows as disconnected; scheduled posts will not publish until it is reconnected.", "Account connected and no publishing failures"],
    fix_publish_failures: (h, c) => [`Resolve ${c} publishing ${plural(c, "failure", "failures")} on ${h}`, "Check each post's error message, fix the cause reported by Buffer and reschedule the content.", "No publishing failures next week"],
    replenish_queue: (h, n, deadline, days) => [
      `Schedule ${n} post(s) for ${h}${deadline ? ` before ${deadline}` : ""}`,
      days ? `The queue covers ${days} days of planned slots.` : "The queue does not cover the next planned slots.",
      "Continuous queue coverage of at least 7 days",
    ],
    restore_cadence: (h, m, p) => [`Restore the planned cadence on ${h}`, `${m} of ${p} planned slots had no publication this week.`, "Every planned slot published"],
    repeat_top_format: (h, f, s) => [
      `Test more ${f} posts on ${h}`,
      `This week's highest relative score was a ${f} post (${s} the cohort median). This is a hypothesis to test, not a proven cause.`,
      "Median views per post of that format, at the same age, against the 4-week baseline",
    ],
    review_underperforming: (c) => [`Review the ${c} underperforming ${plural(c, "post", "posts")}`, "Compare with the best posts of the same cohort before changing strategy; the gap may have causes outside this data.", "Number of posts at or below 0.8× the cohort median"],
    resolve_sync: (h) => [`Restore synchronization for ${h}`, "Queue data is stale, so coverage cannot be confirmed.", "Queue synchronized within the configured interval"],
    wait_for_metrics: () => ["Review the final version of this report", "Some metrics are still updating in Buffer (up to about 24h after publishing).", "Report marked as final"],
    tag_content_pillars: (tagged) => [
      "Tag posts with content pillars",
      tagged ? "Keep tagging every post with a pillar or topic so theme comparisons reach a usable sample." : "Without pillar or topic tags, performance cannot be compared by theme.",
      "Share of this week's posts with a pillar tag",
    ],
    maintain_cadence: () => ["Keep the planned cadence", "Keep covering every planned slot to maintain the observed consistency.", "Every planned slot published"],
    track_success_metrics: () => [
      "Track the success metrics in next week's report",
      "Compare these metrics with next week's, at the same post age, before concluding there is a trend.",
      "Same-age weekly comparison available for every account",
    ],
  },
  quality: {
    narrative: (cutoff, pre) => `Data observed up to ${cutoff}. ${pre ? "Preliminary version: see the reasons below." : "Final version."}`,
    comparisonMethod: (target, minAge, tol, min) =>
      `Week-over-week comparison at the same post age (preferably ${target}; never below ${minAge}h). Each post uses its observation closest to that age without exceeding it, within a ${tol}h tolerance; posts without a suitable observation are left out and the sum is not compared. Medians need ${min} posts per week.`,
    complete: (cutoff) => `All metrics current as of ${cutoff}. No missing data this period.`,
    incomplete: (parts) => `Missing or limited data: ${parts.join("; ")}.`,
    pendingPart: (n) => `${n} ${plural(n, "post", "posts")} with pending metrics`,
    notRefreshedPart: (n) => `${n} ${plural(n, "post", "posts")} without a metrics refresh after the period ended`,
    notReportedPart: (l) => `metrics not reported: ${l}`,
    likelyNotReportedPart: (l) => `always 0 (likely not reported): ${l}`,
    noComparisonPart: (n) => `${n} ${plural(n, "account", "accounts")} without a same-age weekly comparison`,
    unsupportedNote: (l) => `Not supported via Buffer for this platform: ${l}.`,
    localeFallback: (r) => `Report language "${r}" is not supported; pt-BR was used.`,
    limitations: [
      "Ambiguous zero: Buffer returns 0 when a network did not report a metric, so a 0 may not be a real zero.",
      "Always-zero metrics (e.g. Instagram follows from post) are treated as likely not reported.",
      "Metrics refresh about once a day and stay pending up to ~24h after publishing; recent posts are under-counted.",
      "Buffer provides no follower or subscriber counts: audience growth requires a direct platform connection.",
      "Buffer's engagement rate formula is undocumented and is never compared with BrandPulse rates.",
      "Reach cannot be summed or deduplicated across posts, accounts or platforms; the median per post is used.",
      "Figures are the lifetime performance of posts published in the week, not activity that happened during the week.",
      "Paid and organic distribution cannot be separated via Buffer.",
      "Each platform counts views differently; views are compared only within the same cohort.",
      "Consistency uses the currently configured cadence and the last sync; irregular cadences are estimates.",
    ],
  },
};

const esES: Messages = {
  labels: {
    reportTitle: "Informe semanal",
    periodLabel: "Periodo",
    generatedAtLabel: "Generado el",
    preliminaryBanner: "Este informe se generó con datos que aún pueden estar actualizándose. Una versión final lo sustituirá cuando todas las métricas se hayan sincronizado.",
    finalBadge: "Final",
    preliminaryBadge: "Preliminar",
    sections: {
      executiveSummary: "1. Resumen ejecutivo",
      kpiTable: "2. Métricas por cuenta",
      publicationConsistency: "3. Constancia de publicación y estado de la programación",
      bestContent: "4. Mejores contenidos",
      underperformingContent: "5. Contenidos por debajo de lo esperado",
      audienceAndEngagementTrends: "6. Audiencia y tendencias de interacción",
      wentWell: "7. Qué fue bien",
      needsImprovement: "8. Qué debe mejorar",
      actions: "9. Acciones prioritarias",
      dataQuality: "10. Actualización de datos, métricas ausentes y limitaciones",
    },
    columns: {
      account: "Cuenta",
      platform: "Plataforma",
      metric: "Métrica",
      latest: "Acumulado actual",
      current: "Semana (misma edad)",
      previous: "Semana anterior (misma edad)",
      change: "Variación",
      status: "Estado",
      definition: "Definición",
      plannedSlots: "Horarios planificados",
      published: "Publicados",
      failed: "Fallos",
      coverageNow: "Cola al generar",
      score: "Índice vs. mediana",
      views: "Visualizaciones",
      cohortMedian: "Mediana del grupo",
      confidence: "Confianza",
      baseline: "Línea base (4 semanas)",
      priority: "Prioridad",
      successMetric: "Métrica de éxito",
      evaluationWindow: "Ventana de evaluación",
      lastSync: "Última sincronización",
      link: "Enlace",
    },
    statuses: { available: "Disponible", partial: "Parcial", unavailable: "No disponible", unsupported: "No compatible", pending: "Pendiente" },
    priorities: { high: "Alta", medium: "Media", low: "Baja" },
    confidences: { high: "Alta", medium: "Media", low: "Baja" },
    platforms: { ...PLATFORMS_EN, other: "Otra" },
    coverageStates: { healthy: "Saludable", warning: "Atención", critical: "Crítica", empty: "Vacía", paused: "Pausada", unknown: "Desconocida" },
    audienceUnavailable: "Requiere conexión directa con la plataforma",
    days: "días",
    hours: "h",
  },
  kpi: {
    posts_published: "Publicaciones",
    views: "Visualizaciones (suma)",
    reactions: "Reacciones (suma)",
    comments: "Comentarios (suma)",
    shares: "Compartidos (suma)",
    saves: "Guardados (suma)",
    total_watch_time: "Tiempo total visto, min (suma)",
    reach_median: "Alcance por publicación (mediana)",
    engagement_rate_median: "Tasa de interacción por publicación (mediana)",
    provider_engagement_rate_median: "Tasa de interacción de Buffer (mediana)",
    avg_watch_time_median: "Tiempo medio visto, s (mediana)",
  },
  trend: { median_views_per_post: "Visualizaciones por publicación (mediana)", median_engagement_rate: "Tasa de interacción por publicación (mediana)" },
  metric: {
    reactions: "reacciones",
    comments: "comentarios",
    shares: "compartidos",
    saves: "guardados",
    views: "visualizaciones",
    reach: "alcance",
    impressions: "impresiones",
    clicks: "clics",
    follows: "seguidores ganados por publicación",
    provider_engagement_rate: "tasa de interacción de Buffer",
    avg_watch_time_seconds: "tiempo medio visto",
    total_watch_time_minutes: "tiempo total visto",
    followers: "seguidores",
  },
  na: {
    numerator_unavailable: "Componentes de la fórmula no disponibles.",
    denominator_unavailable: "Denominador no disponible.",
    denominator_zero: "El valor anterior es 0: variación porcentual indefinida.",
    starting_audience_not_positive: "La audiencia inicial no es positiva.",
    insufficient_sample: "Muestra insuficiente para comparar.",
    incompatible_definitions: "Definiciones distintas no son comparables.",
    not_summable: "Esta métrica no se puede sumar entre publicaciones.",
    partial_period: "Periodo incompleto: comparación suspendida.",
    unsupported_by_provider: "No compatible con esta plataforma a través de Buffer.",
    no_data: "Sin datos utilizables.",
    no_posts: "No se publicó nada en el periodo.",
    metrics_pending: "Métricas aún no procesadas por Buffer.",
    not_reported: "Métrica no informada por la plataforma.",
    never_synced: "Publicaciones aún no sincronizadas.",
    incomplete_sample: "No todas las publicaciones tienen este dato: la suma sería parcial y no se compara.",
    insufficient_post_age: "Las publicaciones de la semana aún son demasiado recientes para una comparación justa.",
    no_comparable_observation: "No hay observación a la misma edad de publicación para comparar.",
    requires_direct_connection: "Requiere conexión directa con la plataforma: Buffer no proporciona número de seguidores o suscriptores.",
  },
  excluded: {
    duplicate_observation: "observación duplicada",
    metrics_pending: "métricas pendientes",
    too_young_at_observation: "observada menos de 72 h después de publicar",
    primary_metric_unavailable: "visualizaciones no disponibles",
    primary_metric_ambiguous_zero: "visualizaciones iguales a 0 (posible valor por defecto)",
    cohort_too_small: "grupo con pocas publicaciones",
    cohort_median_zero: "mediana del grupo igual a 0",
  },
  preliminary: {
    period_incomplete: () => "El periodo aún no ha terminado.",
    published_sync_missing: (h) => `${h}: las publicaciones nunca se sincronizaron correctamente.`,
    published_sync_before_cutoff: (h) => `${h}: la última sincronización de métricas fue antes de 24 h tras el fin del periodo.`,
    queue_sync_stale: (h) => `${h}: datos de la cola desactualizados.`,
    queue_sync_never: (h) => `${h}: la cola nunca se sincronizó.`,
    post_metrics_pending: (h) => `${h}: hay publicaciones del periodo con métricas aún no procesadas por Buffer.`,
    post_metrics_not_refreshed: (h) => `${h}: hay publicaciones cuyas métricas no se actualizaron desde el fin del periodo.`,
  },
  summary: {
    period: (s, e, n, nf, a, pf) => `Semana del ${s} al ${e}: ${nf} ${plural(n, "publicación", "publicaciones")} en ${a} ${plural(a, "cuenta", "cuentas")} (semana anterior: ${pf}).`,
    noAccounts: "No hay cuentas asignadas a esta marca, por lo que no hay datos para el periodo.",
    viewsChange: (h, age, pct) => `${h}: las visualizaciones de las publicaciones de la semana, comparadas a la misma edad (${age}), variaron ${pct} respecto a la semana anterior.`,
    best: (c, min, h, s) => `${c} ${plural(c, "publicación quedó", "publicaciones quedaron")} al menos ${min} por encima de la mediana de su grupo; el índice más alto fue de ${h} (${s}).`,
    under: (c, max) => `${c} ${plural(c, "publicación quedó", "publicaciones quedaron")} en ${max} o menos de la mediana de su grupo.`,
    failures: (c) => `${c} ${plural(c, "fallo de publicación registrado", "fallos de publicación registrados")} en el periodo.`,
    coverageRisk: (c) => `${c} ${plural(c, "cuenta tiene", "cuentas tienen")} la cola en estado crítico o vacía al generar el informe.`,
    preliminary: "Informe preliminar: parte de los datos aún se está actualizando (ver sección 10).",
    final: "Informe final: métricas sincronizadas tras el fin del periodo.",
  },
  kpiNarrative: (a, cutoff) =>
    `Totales acumulados de las publicaciones de la semana en ${a} ${plural(a, "cuenta", "cuentas")}, observados hasta ${cutoff}. Los valores ausentes aparecen como No disponible, No compatible o Pendiente, nunca como cero.`,
  comparisonNote: (target, min) =>
    `La variación semanal compara publicaciones a la misma edad: para cada publicación de ambas semanas se usa la observación más cercana (sin superarla) a la edad indicada, preferiblemente ${target}. Las sumas solo se comparan cuando todas las publicaciones tienen el dato; las medianas requieren al menos ${min} publicaciones por semana. Nunca se comparan plataformas distintas entre sí.`,
  consistency: {
    narrative: (ok, withCadence, failed) =>
      `${ok} de ${withCadence} ${plural(withCadence, "cuenta con cadencia cubrió", "cuentas con cadencia cubrieron")} todos los horarios planificados; ${failed} ${plural(failed, "fallo de publicación", "fallos de publicación")} en el periodo.`,
    paused: "Cadencia pausada: sin horarios planificados.",
    noCadence: "Sin cadencia configurada: horarios planificados no disponibles.",
    estimate: "Cadencia irregular: los horarios planificados son una estimación.",
    defaultCadence: "Usando los horarios de publicación de Buffer (cadencia predeterminada).",
    currentCadence: "Horarios planificados calculados con la cadencia configurada actualmente.",
    neverSynced: "Publicaciones aún no sincronizadas.",
    atGeneration: (state, slot) => `Al generar el informe: cola ${state}${slot ? `, primer horario sin publicación el ${slot}` : ""}.`,
    disconnected: "Cuenta desconectada al generar el informe.",
    queuePaused: "Cola pausada en Buffer al generar el informe.",
  },
  content: {
    method: (days, minAge, minCohort, best, under) =>
      `Clasificación por visualizaciones respecto a la mediana de visualizaciones de las publicaciones de la misma cuenta, plataforma y formato publicadas en los últimos ${days} días (observadas al menos ${minAge} h después de publicar; grupos de al menos ${minCohort} publicaciones). La tasa de interacción (Instagram: por alcance; TikTok y YouTube: por visualizaciones) se muestra como evidencia y solo desempata. Nunca se comparan cifras brutas entre plataformas o cuentas. "Mejores" exige al menos ${best} la mediana; "por debajo de lo esperado", como máximo ${under}. Las métricas son totales acumulados hasta la última actualización de cada publicación.`,
    bestFairness: "Cada publicación se compara solo con publicaciones del mismo grupo (cuenta, plataforma y formato). Edades de observación muy distintas reducen la confianza.",
    underFairness: (minAge) =>
      `Comparación justa: solo con publicaciones del mismo grupo (cuenta, plataforma y formato) observadas al menos ${minAge} h después de publicar. Quedar por debajo de la mediana es una observación, no una causa.`,
    explanation: (v, s, m, size, p, f, d, age) => `${v} visualizaciones, ${s} la mediana (${m}) de ${size} publicaciones ${p} ${f} de esta cuenta en los últimos ${d} días; observada ${age} h después de publicar.`,
    unknownFormat: "de formato desconocido",
    bestNarrative: (c, min) => `${c} ${plural(c, "publicación alcanzó", "publicaciones alcanzaron")} al menos ${min} la mediana de su grupo.`,
    underNarrative: (c, max) => `${c} ${plural(c, "publicación quedó", "publicaciones quedaron")} en ${max} o menos de la mediana de su grupo.`,
    bestEmpty: (min) => `Ninguna publicación elegible alcanzó ${min} la mediana de su grupo.`,
    underEmpty: (max) => `Ninguna publicación elegible quedó en ${max} o menos de la mediana de su grupo.`,
    noneRankable: "Ninguna publicación del periodo pudo clasificarse (ver motivos de exclusión).",
  },
  trends: {
    narrative: (w, min) =>
      `Las tendencias por cuenta usan la mediana por publicación, observada a la misma edad cada semana, frente a la línea base de las ${w} semanas anteriores (mínimo ${min} semanas completas con datos).`,
    audience: "Requiere conexión directa con la plataforma: Buffer no proporciona número de seguidores o suscriptores. El crecimiento de audiencia nunca se muestra como cero.",
    line: (h, l, v, b, pct) => `${h}: ${l} de ${v} frente a una línea base de ${b} (${pct}).`,
    insufficient: (h) => `${h}: semanas completas insuficientes para una línea base.`,
  },
  insights: {
    metricUp: (h, l, pct, age) => `${h}: ${l} ${pct} respecto a la semana anterior (publicaciones comparadas a la misma edad: ${age}).`,
    metricDown: (h, l, pct, age) => `${h}: ${l} ${pct} respecto a la semana anterior (publicaciones comparadas a la misma edad: ${age}).`,
    best: (c, h, s) => `${c} ${plural(c, "publicación", "publicaciones")} por encima de lo esperado para su grupo; destaca ${h} (${s} la mediana).`,
    allSlots: (h, c, p) => `${h}: ${c} de ${p} horarios planificados tuvieron publicación.`,
    missedSlots: (h, m, p) => `${h}: ${m} de ${p} horarios planificados quedaron sin publicación.`,
    noFailures: (posts) => `Ningún fallo de publicación entre ${posts} publicaciones.`,
    failures: (h, c) => `${h}: ${c} ${plural(c, "fallo de publicación", "fallos de publicación")} en el periodo.`,
    coverageRisk: (h, s, n, slot) => `${h}: cola ${s} al generar el informe; ${n} publicación(es) necesaria(s)${slot ? `, primer horario sin publicación el ${slot}` : ""}.`,
    disconnected: (h) => `${h}: cuenta desconectada en Buffer.`,
    syncStale: (h) => `${h}: sincronización de la cola desactualizada; no se pudo confirmar la cobertura.`,
    trendAbove: (h, l, pct) => `${h}: ${l} ${pct} por encima de la línea base de 4 semanas.`,
    trendBelow: (h, l, pct) => `${h}: ${l} ${pct} por debajo de la línea base de 4 semanas.`,
    under: (c) => `${c} ${plural(c, "publicación", "publicaciones")} por debajo de lo esperado para su grupo.`,
    wentWellNarrative: (c) => `${c} ${plural(c, "aspecto positivo observado", "aspectos positivos observados")} en los datos de la semana.`,
    needsNarrative: (c) => `${c} ${plural(c, "punto de atención observado", "puntos de atención observados")} en los datos de la semana.`,
    wentWellEmpty: "No se pudo confirmar ningún aspecto positivo con los datos disponibles.",
    needsEmpty: "No se identificó ningún punto de atención con los datos disponibles.",
  },
  actions: {
    narrative: "Acciones priorizadas a partir de las observaciones anteriores. Cada una tiene una métrica de éxito y una ventana de evaluación; son hipótesis a probar, no resultados garantizados.",
    reconnect_account: (h) => [`Reconectar ${h} en Buffer`, "La cuenta aparece desconectada; las publicaciones programadas no saldrán hasta reconectarla.", "Cuenta conectada y ningún fallo de publicación"],
    fix_publish_failures: (h, c) => [`Resolver ${c} ${plural(c, "fallo", "fallos")} de publicación en ${h}`, "Revisa el mensaje de error de cada publicación, corrige la causa indicada por Buffer y vuelve a programar el contenido.", "Ningún fallo de publicación la próxima semana"],
    replenish_queue: (h, n, deadline, days) => [
      `Programar ${n} publicación(es) para ${h}${deadline ? ` antes del ${deadline}` : ""}`,
      days ? `La cola cubre ${days} días de horarios planificados.` : "La cola no cubre los próximos horarios planificados.",
      "Cobertura continua de la cola de al menos 7 días",
    ],
    restore_cadence: (h, m, p) => [`Recuperar la cadencia planificada en ${h}`, `${m} de ${p} horarios planificados quedaron sin publicación esta semana.`, "Todos los horarios planificados con publicación"],
    repeat_top_format: (h, f, s) => [
      `Probar más publicaciones en formato ${f} en ${h}`,
      `El índice relativo más alto de la semana fue de una publicación ${f} (${s} la mediana del grupo). Es una hipótesis a probar, no una causa demostrada.`,
      "Mediana de visualizaciones por publicación del formato, a la misma edad, frente a la línea base de 4 semanas",
    ],
    review_underperforming: (c) => [`Revisar ${plural(c, "la publicación", `las ${c} publicaciones`)} por debajo de lo esperado`, "Compáralas con las mejores del mismo grupo antes de cambiar la estrategia; la diferencia puede tener causas ajenas a estos datos.", "Número de publicaciones en 0,8× o menos de la mediana del grupo"],
    resolve_sync: (h) => [`Restablecer la sincronización de ${h}`, "Los datos de la cola están desactualizados, así que no se puede confirmar la cobertura.", "Cola sincronizada dentro del intervalo configurado"],
    wait_for_metrics: () => ["Revisar la versión final del informe", "Parte de las métricas aún se está actualizando en Buffer (hasta unas 24 h después de publicar).", "Informe marcado como final"],
    tag_content_pillars: (tagged) => [
      "Etiquetar las publicaciones con pilares de contenido",
      tagged ? "Sigue etiquetando cada publicación con pilar o tema para que la comparación por tema tenga muestra suficiente." : "Sin etiquetas de pilar o tema no se puede comparar el rendimiento por tema.",
      "Porcentaje de publicaciones de la semana con etiqueta de pilar",
    ],
    maintain_cadence: () => ["Mantener la cadencia planificada", "Sigue cubriendo todos los horarios planificados para mantener la constancia observada.", "Todos los horarios planificados con publicación"],
    track_success_metrics: () => [
      "Seguir las métricas de éxito en el próximo informe",
      "Compara estas métricas con las de la próxima semana, a la misma edad de publicación, antes de concluir que hay una tendencia.",
      "Variación semanal a la misma edad disponible para todas las cuentas",
    ],
  },
  quality: {
    narrative: (cutoff, pre) => `Datos observados hasta ${cutoff}. ${pre ? "Versión preliminar: ver los motivos abajo." : "Versión final."}`,
    comparisonMethod: (target, minAge, tol, min) =>
      `Comparación semanal a la misma edad de publicación (preferiblemente ${target}; nunca por debajo de ${minAge} h). Cada publicación usa la observación más cercana a esa edad sin superarla, con una tolerancia de hasta ${tol} h; las publicaciones sin observación adecuada quedan fuera y la suma no se compara. Las medianas requieren ${min} publicaciones por semana.`,
    complete: (cutoff) => `Todas las métricas actualizadas hasta ${cutoff}. No faltan datos en este periodo.`,
    incomplete: (parts) => `Datos ausentes o limitados: ${parts.join("; ")}.`,
    pendingPart: (n) => `${n} ${plural(n, "publicación con métricas pendientes", "publicaciones con métricas pendientes")}`,
    notRefreshedPart: (n) => `${n} ${plural(n, "publicación sin actualización de métricas", "publicaciones sin actualización de métricas")} tras el fin del periodo`,
    notReportedPart: (l) => `métricas no informadas: ${l}`,
    likelyNotReportedPart: (l) => `siempre iguales a 0 (probablemente no informadas): ${l}`,
    noComparisonPart: (n) => `${n} ${plural(n, "cuenta sin", "cuentas sin")} comparación semanal a la misma edad`,
    unsupportedNote: (l) => `No compatibles a través de Buffer para esta plataforma: ${l}.`,
    localeFallback: (r) => `El idioma "${r}" no es compatible con los informes; se usó pt-BR.`,
    limitations: [
      "Cero ambiguo: Buffer devuelve 0 cuando la red no informa una métrica, así que un 0 puede no ser un cero real.",
      "Las métricas siempre en cero (por ejemplo, seguidores ganados por publicación en Instagram) se tratan como probablemente no informadas.",
      "Las métricas se actualizan aproximadamente una vez al día y quedan pendientes hasta ~24 h después de publicar; las publicaciones recientes aparecen infravaloradas.",
      "Buffer no proporciona seguidores ni suscriptores: el crecimiento de audiencia requiere conexión directa con la plataforma.",
      "La fórmula de la tasa de interacción de Buffer no está documentada y nunca se compara con las tasas calculadas por BrandPulse.",
      "El alcance no se puede sumar ni deduplicar entre publicaciones, cuentas o plataformas; se usa la mediana por publicación.",
      "Las cifras son el rendimiento acumulado de las publicaciones de la semana, no la actividad ocurrida durante la semana.",
      "No es posible separar distribución pagada y orgánica a través de Buffer.",
      "Cada plataforma cuenta las visualizaciones de forma distinta; solo se comparan dentro del mismo grupo.",
      "La constancia usa la cadencia configurada actualmente y la última sincronización; las cadencias irregulares son estimaciones.",
    ],
  },
};

const CATALOG: Record<ReportLocale, Messages> = { "pt-BR": ptBR, "en-US": enUS, "es-ES": esES };

/**
 * Monthly wording is derived from the weekly catalog by ordered, grammar-aware replacements
 * (Portuguese/Spanish "semana" is feminine, "mês/mes" masculine), so the three catalogs stay single-sourced.
 * Longer phrases come first so agreement words ("na", "da", "durante a", "completas") change together.
 */
const MONTH_REPLACEMENTS: Record<ReportLocale, [string, string][]> = {
  "pt-BR": [
    ["Relatório semanal", "Relatório mensal"],
    ["Semana anterior", "Mês anterior"],
    ["Semana de ", "Mês de "],
    ["das duas semanas", "dos dois meses"],
    ["todas as semanas", "todos os meses"],
    ["semanas completas", "meses completos"],
    ["semanas anteriores", "meses anteriores"],
    ["na próxima semana", "no próximo mês"],
    ["da próxima semana", "do próximo mês"],
    ["durante a semana", "durante o mês"],
    ["em cada semana", "em cada mês"],
    ["por semana", "por mês"],
    ["semana anterior", "mês anterior"],
    ["da semana", "do mês"],
    ["na semana", "no mês"],
    ["Variação semanal", "Variação mensal"],
    ["Comparação semanal", "Comparação mensal"],
    ["variação semanal", "variação mensal"],
    ["comparação semanal", "comparação mensal"],
    ["semanas", "meses"],
    ["Semana", "Mês"],
    ["semana", "mês"],
  ],
  "es-ES": [
    ["Informe semanal", "Informe mensual"],
    ["Semana anterior", "Mes anterior"],
    ["Semana del", "Mes del"],
    ["de ambas semanas", "de ambos meses"],
    ["semanas completas", "meses completos"],
    ["semanas anteriores", "meses anteriores"],
    ["a la semana anterior", "al mes anterior"],
    ["la próxima semana", "el próximo mes"],
    ["durante la semana", "durante el mes"],
    ["esta semana", "este mes"],
    ["de la semana", "del mes"],
    ["cada semana", "cada mes"],
    ["por semana", "por mes"],
    ["semana anterior", "mes anterior"],
    ["Variación semanal", "Variación mensual"],
    ["Comparación semanal", "Comparación mensual"],
    ["variación semanal", "variación mensual"],
    ["comparación semanal", "comparación mensual"],
    ["semanas", "meses"],
    ["Semana", "Mes"],
    ["semana", "mes"],
  ],
  "en-US": [
    ["Weekly", "Monthly"],
    ["weekly", "monthly"],
    ["Weeks", "Months"],
    ["weeks", "months"],
    ["Week", "Month"],
    ["week", "month"],
  ],
};

function toMonthWording(locale: ReportLocale, text: string): string {
  let out = text;
  for (const [from, to] of MONTH_REPLACEMENTS[locale]) out = out.split(from).join(to);
  return out;
}

function monthify<T>(value: T, locale: ReportLocale): T {
  if (typeof value === "string") return toMonthWording(locale, value) as T;
  if (typeof value === "function") {
    const fn = value as unknown as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => monthify(fn(...args), locale)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => monthify(v, locale)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, monthify(v, locale)])) as T;
  }
  return value;
}

const MONTH_CATALOG = new Map<ReportLocale, Messages>();

export function messages(locale: ReportLocale, kind: "week" | "month" = "week"): Messages {
  if (kind === "week") return CATALOG[locale];
  let monthly = MONTH_CATALOG.get(locale);
  if (!monthly) {
    monthly = monthify(CATALOG[locale], locale);
    MONTH_CATALOG.set(locale, monthly);
  }
  return monthly;
}

export function statusLabel(locale: ReportLocale, status: CellStatus): string {
  return CATALOG[locale].labels.statuses[status];
}

export function coverageStateLabel(locale: ReportLocale, state: CoverageState): string {
  return CATALOG[locale].labels.coverageStates[state];
}
