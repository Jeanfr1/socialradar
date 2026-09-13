/**
 * Recommendation text per locale (pt-BR default, en-US, es-ES). Findings state observed facts; interpretations are
 * always prefixed as hypotheses and never causal; actions are concrete. Values arrive pre-formatted from facts.
 */
import type { ReportLocale } from "@/server/reports/types";

export type TimeBucket = "night" | "morning" | "afternoon" | "evening";

export interface RecommendationTemplates {
  bucket: Record<TimeBucket, string>;
  reconnect: { finding: (h: string, status: string) => string; interpretation: string; action: string; success: string };
  failures: { finding: (h: string, n: number, days: string) => string; interpretation: string; action: (n: number) => string; success: string };
  queue: {
    finding: (h: string, days: string | null, slot: string | null, needed: string, horizon: string, state: string) => string;
    interpretation: string;
    action: (needed: string, deadline: string | null) => string;
    capNote: (cap: string) => string;
    success: (days: string) => string;
  };
  consistency: {
    finding: (h: string, weeks: { start: string; covered: string; planned: string; pct: string }[]) => string;
    interpretation: string;
    action: (planned: string) => string;
    estimateNote: string;
    success: (pct: string) => string;
  };
  formatMix: {
    finding: (h: string, days: string, top: string, v1: string, n1: string, other: string, v2: string, n2: string, ratio: string, minAge: string, a1: string, a2: string) => string;
    erNote: (e1: string, e2: string) => string;
    interpretation: (top: string) => string;
    action: (top: string, other: string) => string;
    success: (top: string, other: string) => string;
  };
  pillar: {
    finding: (h: string, kind: string, value: string, s1: string, n1: string, s2: string, n2: string, days: string) => string;
    interpretationAbove: (value: string) => string;
    interpretationBelow: (value: string) => string;
    actionAbove: (value: string) => string;
    actionBelow: (value: string) => string;
    success: (value: string) => string;
  };
  tagging: { finding: (tagged: string, total: string, days: string) => string; interpretation: string; action: (pillars: string) => string; success: string };
  timing: {
    finding: (h: string, days: string, bucket: string, s1: string, n1: string, usual: string, s2: string, n2: string) => string;
    interpretation: string;
    action: (bucket: string, usual: string) => string;
    success: (bucket: string, usual: string) => string;
  };
  tagKind: Record<"pillar" | "topic", string>;
}

const pt: RecommendationTemplates = {
  bucket: { night: "de madrugada (0h–6h)", morning: "de manhã (6h–12h)", afternoon: "à tarde (12h–18h)", evening: "à noite (18h–24h)" },
  reconnect: {
    finding: (h, s) => `${h} aparece desconectada no Buffer ou com credencial rejeitada (status da conexão: ${s}).`,
    interpretation: "Hipótese: enquanto a conta estiver desconectada, os posts agendados podem não ser publicados.",
    action: "Reconecte a conta no Buffer e confirme que os próximos posts agendados são publicados.",
    success: "Conta conectada e nenhuma falha de publicação",
  },
  failures: {
    finding: (h, n, d) => `${n} ${n === 1 ? "post falhou" : "posts falharam"} ao publicar em ${h} nos últimos ${d} dias.`,
    interpretation: "Hipótese: as mensagens de erro do Buffer indicam a causa; corrigi-la deve evitar novas falhas.",
    action: (n) => `Revise a mensagem de erro ${n === 1 ? "do post" : `dos ${n} posts`}, corrija a causa e reagende o conteúdo afetado.`,
    success: "Nenhuma falha de publicação",
  },
  queue: {
    finding: (h, days, slot, needed, horizon, state) =>
      `A fila de ${h} está ${state}: ${days !== null ? `cobre ${days} dias dos horários planejados` : "não cobre os próximos horários planejados"}${slot ? `; primeiro horário sem post em ${slot}` : ""}; faltam ${needed} post(s) para cobrir os próximos ${horizon} dias.`,
    interpretation: "Hipótese: sem reposição, a conta deixará de publicar a partir do primeiro horário sem post.",
    action: (needed, deadline) => `Agende ${needed} post(s)${deadline ? ` antes de ${deadline}` : ""}.`,
    capNote: (cap) => ` O plano do Buffer permite no máximo ${cap} posts agendados, o que limita a cobertura possível.`,
    success: (days) => `Cobertura contínua da fila de pelo menos ${days} dias`,
  },
  consistency: {
    finding: (h, weeks) => `${h} publicou em ${weeks.map((w) => `${w.covered} de ${w.planned} horários planejados na semana de ${w.start} (${w.pct})`).join("; ")}.`,
    interpretation: "Hipótese: a cadência configurada pode não refletir mais o plano atual, ou faltou conteúdo pronto para os horários.",
    action: (planned) => `Planeje conteúdo para os ${planned} horários semanais planejados ou ajuste a cadência configurada para refletir o plano real.`,
    estimateNote: " Cadência irregular: os horários planejados são uma estimativa.",
    success: (pct) => `Pelo menos ${pct} dos horários planejados com publicação`,
  },
  formatMix: {
    finding: (h, d, top, v1, n1, other, v2, n2, ratio, minAge, a1, a2) =>
      `Nos últimos ${d} dias, posts ${top} de ${h} tiveram mediana de ${v1} visualizações (n=${n1}) contra ${v2} dos posts ${other} (n=${n2}), ${ratio} (posts observados com pelo menos ${minAge} h; idade mediana ${a1} h vs ${a2} h).`,
    erNote: (e1, e2) => ` Taxa de engajamento mediana: ${e1} vs ${e2}.`,
    interpretation: (top) => `Hipótese (correlação, não causa): o formato ${top} pode estar distribuindo melhor nesta conta; tema, horário e impulsionamento pago não foram controlados.`,
    action: (top, other) => `Nas próximas 2 semanas, use o formato ${top} em parte dos horários hoje ocupados por ${other}, com temas semelhantes, e compare a mediana de visualizações por formato.`,
    success: (top, other) => `Mediana de visualizações por post ${top} (observados com 72 h ou mais) acima da mediana dos posts ${other}`,
  },
  pillar: {
    finding: (h, kind, value, s1, n1, s2, n2, d) =>
      `Posts de ${h} com ${kind} "${value}" tiveram índice mediano de ${s1} a mediana do próprio grupo (n=${n1}) contra ${s2} dos demais posts (n=${n2}) nos últimos ${d} dias.`,
    interpretationAbove: (v) => `Hipótese (correlação): o tema "${v}" pode ressoar melhor com a audiência desta conta; outros fatores além de conta, plataforma e formato não foram controlados.`,
    interpretationBelow: (v) => `Hipótese (correlação): a abordagem atual do tema "${v}" pode estar ressoando menos; outros fatores além de conta, plataforma e formato não foram controlados.`,
    actionAbove: (v) => `Planeje mais posts do tema "${v}" nas próximas 2 semanas e acompanhe o índice em relação à mediana do grupo.`,
    actionBelow: (v) => `Antes de reduzir o tema "${v}", teste nas próximas 2 semanas uma variação de abordagem (gancho ou formato) e compare o índice.`,
    success: (v) => `Índice mediano (visualizações ÷ mediana do grupo) dos posts "${v}"`,
  },
  tagging: {
    finding: (t, n, d) => `${t} de ${n} posts elegíveis dos últimos ${d} dias têm tag de pilar ou tema.`,
    interpretation: "Hipótese: com mais posts marcados será possível identificar quais pilares têm melhor desempenho.",
    action: (p) => `Marque os posts com os pilares configurados (${p}) para permitir a comparação por tema.`,
    success: "Pelo menos 80% dos posts com tag de pilar ou tema",
  },
  timing: {
    finding: (h, d, b, s1, n1, u, s2, n2) => `Nos últimos ${d} dias, posts de ${h} publicados ${b} tiveram índice mediano de ${s1} a mediana do grupo (n=${n1}) contra ${s2} no período mais usado, ${u} (n=${n2}).`,
    interpretation: "Hipótese a testar, não um \"melhor horário\": a diferença pode vir de tema, formato ou acaso. Só um experimento controlado pode confirmar.",
    action: (b, u) => `Faça um experimento de 2 semanas: publique parte dos posts (mesmo formato, temas semelhantes) ${b} em vez de ${u} e compare o índice em relação à mediana do grupo.`,
    success: (b, u) => `Índice mediano dos posts publicados ${b} vs. ${u} durante o experimento`,
  },
  tagKind: { pillar: "o pilar", topic: "o tema" },
};

const en: RecommendationTemplates = {
  bucket: { night: "overnight (0:00–6:00)", morning: "in the morning (6:00–12:00)", afternoon: "in the afternoon (12:00–18:00)", evening: "in the evening (18:00–24:00)" },
  reconnect: {
    finding: (h, s) => `${h} shows as disconnected in Buffer or its credential was rejected (connection status: ${s}).`,
    interpretation: "Hypothesis: while the account is disconnected, scheduled posts may not publish.",
    action: "Reconnect the account in Buffer and confirm the next scheduled posts publish.",
    success: "Account connected and no publishing failures",
  },
  failures: {
    finding: (h, n, d) => `${n} ${n === 1 ? "post" : "posts"} failed to publish on ${h} in the last ${d} days.`,
    interpretation: "Hypothesis: Buffer's error messages indicate the cause; fixing it should prevent further failures.",
    action: (n) => `Review the error message of ${n === 1 ? "the post" : `the ${n} posts`}, fix the cause and reschedule the affected content.`,
    success: "No publishing failures",
  },
  queue: {
    finding: (h, days, slot, needed, horizon, state) =>
      `${h}'s queue is ${state}: ${days !== null ? `it covers ${days} days of planned slots` : "it does not cover the next planned slots"}${slot ? `; first uncovered slot at ${slot}` : ""}; ${needed} more post(s) are needed to cover the next ${horizon} days.`,
    interpretation: "Hypothesis: without replenishment the account will stop publishing from the first uncovered slot.",
    action: (needed, deadline) => `Schedule ${needed} post(s)${deadline ? ` before ${deadline}` : ""}.`,
    capNote: (cap) => ` The Buffer plan allows at most ${cap} scheduled posts, which limits achievable coverage.`,
    success: (days) => `Continuous queue coverage of at least ${days} days`,
  },
  consistency: {
    finding: (h, weeks) => `${h} published in ${weeks.map((w) => `${w.covered} of ${w.planned} planned slots in the week of ${w.start} (${w.pct})`).join("; ")}.`,
    interpretation: "Hypothesis: the configured cadence may no longer reflect the current plan, or content was not ready for the slots.",
    action: (planned) => `Plan content for the ${planned} weekly planned slots, or adjust the configured cadence to reflect the real plan.`,
    estimateNote: " Irregular cadence: planned slots are an estimate.",
    success: (pct) => `At least ${pct} of planned slots published`,
  },
  formatMix: {
    finding: (h, d, top, v1, n1, other, v2, n2, ratio, minAge, a1, a2) =>
      `In the last ${d} days, ${top} posts on ${h} had a median of ${v1} views (n=${n1}) versus ${v2} for ${other} posts (n=${n2}), ${ratio} (posts observed at least ${minAge}h after publishing; median age ${a1}h vs ${a2}h).`,
    erNote: (e1, e2) => ` Median engagement rate: ${e1} vs ${e2}.`,
    interpretation: (top) => `Hypothesis (correlation, not causation): the ${top} format may be getting more distribution on this account; topic, timing and paid promotion were not controlled.`,
    action: (top, other) => `For the next 2 weeks, use the ${top} format in some of the slots currently used for ${other}, with similar topics, and compare median views per format.`,
    success: (top, other) => `Median views per ${top} post (observed at 72h or later) above the median of ${other} posts`,
  },
  pillar: {
    finding: (h, kind, value, s1, n1, s2, n2, d) => `Posts on ${h} tagged with ${kind} "${value}" had a median score of ${s1} their cohort median (n=${n1}) versus ${s2} for other posts (n=${n2}) in the last ${d} days.`,
    interpretationAbove: (v) => `Hypothesis (correlation): the "${v}" theme may resonate better with this account's audience; factors beyond account, platform and format were not controlled.`,
    interpretationBelow: (v) => `Hypothesis (correlation): the current approach to "${v}" may be resonating less; factors beyond account, platform and format were not controlled.`,
    actionAbove: (v) => `Plan more "${v}" posts over the next 2 weeks and track their score against the cohort median.`,
    actionBelow: (v) => `Before cutting "${v}", test a different approach (hook or format) over the next 2 weeks and compare the score.`,
    success: (v) => `Median score (views ÷ cohort median) of "${v}" posts`,
  },
  tagging: {
    finding: (t, n, d) => `${t} of ${n} eligible posts from the last ${d} days have a pillar or topic tag.`,
    interpretation: "Hypothesis: with more tagged posts it will be possible to see which pillars perform better.",
    action: (p) => `Tag posts with the configured pillars (${p}) so performance can be compared by theme.`,
    success: "At least 80% of posts with a pillar or topic tag",
  },
  timing: {
    finding: (h, d, b, s1, n1, u, s2, n2) => `In the last ${d} days, posts on ${h} published ${b} had a median score of ${s1} their cohort median (n=${n1}) versus ${s2} for the most used time, ${u} (n=${n2}).`,
    interpretation: "Hypothesis to test, not a \"best posting time\": the gap may come from topic, format or chance. Only a controlled experiment can confirm it.",
    action: (b, u) => `Run a 2-week experiment: publish some posts (same format, similar topics) ${b} instead of ${u} and compare their score against the cohort median.`,
    success: (b, u) => `Median score of posts published ${b} vs ${u} during the experiment`,
  },
  tagKind: { pillar: "pillar", topic: "topic" },
};

const es: RecommendationTemplates = {
  bucket: { night: "de madrugada (0–6 h)", morning: "por la mañana (6–12 h)", afternoon: "por la tarde (12–18 h)", evening: "por la noche (18–24 h)" },
  reconnect: {
    finding: (h, s) => `${h} aparece desconectada en Buffer o con la credencial rechazada (estado de la conexión: ${s}).`,
    interpretation: "Hipótesis: mientras la cuenta esté desconectada, las publicaciones programadas pueden no salir.",
    action: "Reconecta la cuenta en Buffer y confirma que las próximas publicaciones programadas salen.",
    success: "Cuenta conectada y ningún fallo de publicación",
  },
  failures: {
    finding: (h, n, d) => `${n} ${n === 1 ? "publicación falló" : "publicaciones fallaron"} en ${h} en los últimos ${d} días.`,
    interpretation: "Hipótesis: los mensajes de error de Buffer indican la causa; corregirla debería evitar nuevos fallos.",
    action: (n) => `Revisa el mensaje de error de ${n === 1 ? "la publicación" : `las ${n} publicaciones`}, corrige la causa y vuelve a programar el contenido afectado.`,
    success: "Ningún fallo de publicación",
  },
  queue: {
    finding: (h, days, slot, needed, horizon, state) =>
      `La cola de ${h} está ${state}: ${days !== null ? `cubre ${days} días de horarios planificados` : "no cubre los próximos horarios planificados"}${slot ? `; primer horario sin publicación el ${slot}` : ""}; faltan ${needed} publicación(es) para cubrir los próximos ${horizon} días.`,
    interpretation: "Hipótesis: sin reposición, la cuenta dejará de publicar a partir del primer horario sin publicación.",
    action: (needed, deadline) => `Programa ${needed} publicación(es)${deadline ? ` antes del ${deadline}` : ""}.`,
    capNote: (cap) => ` El plan de Buffer permite como máximo ${cap} publicaciones programadas, lo que limita la cobertura posible.`,
    success: (days) => `Cobertura continua de la cola de al menos ${days} días`,
  },
  consistency: {
    finding: (h, weeks) => `${h} publicó en ${weeks.map((w) => `${w.covered} de ${w.planned} horarios planificados en la semana del ${w.start} (${w.pct})`).join("; ")}.`,
    interpretation: "Hipótesis: la cadencia configurada puede no reflejar el plan actual, o faltó contenido listo para los horarios.",
    action: (planned) => `Planifica contenido para los ${planned} horarios semanales planificados o ajusta la cadencia configurada al plan real.`,
    estimateNote: " Cadencia irregular: los horarios planificados son una estimación.",
    success: (pct) => `Al menos el ${pct} de los horarios planificados con publicación`,
  },
  formatMix: {
    finding: (h, d, top, v1, n1, other, v2, n2, ratio, minAge, a1, a2) =>
      `En los últimos ${d} días, las publicaciones ${top} de ${h} tuvieron una mediana de ${v1} visualizaciones (n=${n1}) frente a ${v2} de las publicaciones ${other} (n=${n2}), ${ratio} (observadas al menos ${minAge} h después de publicar; edad mediana ${a1} h frente a ${a2} h).`,
    erNote: (e1, e2) => ` Tasa de interacción mediana: ${e1} frente a ${e2}.`,
    interpretation: (top) => `Hipótesis (correlación, no causa): el formato ${top} puede estar teniendo más distribución en esta cuenta; tema, horario y promoción pagada no se controlaron.`,
    action: (top, other) => `Durante las próximas 2 semanas, usa el formato ${top} en parte de los horarios que hoy ocupa ${other}, con temas similares, y compara la mediana de visualizaciones por formato.`,
    success: (top, other) => `Mediana de visualizaciones por publicación ${top} (observadas a 72 h o más) por encima de la mediana de ${other}`,
  },
  pillar: {
    finding: (h, kind, value, s1, n1, s2, n2, d) =>
      `Las publicaciones de ${h} con ${kind} "${value}" tuvieron un índice mediano de ${s1} la mediana de su grupo (n=${n1}) frente a ${s2} del resto (n=${n2}) en los últimos ${d} días.`,
    interpretationAbove: (v) => `Hipótesis (correlación): el tema "${v}" puede conectar mejor con la audiencia de esta cuenta; no se controlaron factores más allá de cuenta, plataforma y formato.`,
    interpretationBelow: (v) => `Hipótesis (correlación): el enfoque actual de "${v}" puede estar conectando menos; no se controlaron factores más allá de cuenta, plataforma y formato.`,
    actionAbove: (v) => `Planifica más publicaciones de "${v}" en las próximas 2 semanas y sigue su índice frente a la mediana del grupo.`,
    actionBelow: (v) => `Antes de reducir "${v}", prueba otro enfoque (gancho o formato) durante las próximas 2 semanas y compara el índice.`,
    success: (v) => `Índice mediano (visualizaciones ÷ mediana del grupo) de las publicaciones "${v}"`,
  },
  tagging: {
    finding: (t, n, d) => `${t} de ${n} publicaciones elegibles de los últimos ${d} días tienen etiqueta de pilar o tema.`,
    interpretation: "Hipótesis: con más publicaciones etiquetadas será posible ver qué pilares rinden mejor.",
    action: (p) => `Etiqueta las publicaciones con los pilares configurados (${p}) para poder comparar por tema.`,
    success: "Al menos el 80% de las publicaciones con etiqueta de pilar o tema",
  },
  timing: {
    finding: (h, d, b, s1, n1, u, s2, n2) =>
      `En los últimos ${d} días, las publicaciones de ${h} realizadas ${b} tuvieron un índice mediano de ${s1} la mediana del grupo (n=${n1}) frente a ${s2} en la franja más usada, ${u} (n=${n2}).`,
    interpretation: "Hipótesis a probar, no un \"mejor horario\": la diferencia puede deberse al tema, al formato o al azar. Solo un experimento controlado puede confirmarlo.",
    action: (b, u) => `Haz un experimento de 2 semanas: publica parte del contenido (mismo formato, temas similares) ${b} en lugar de ${u} y compara el índice frente a la mediana del grupo.`,
    success: (b, u) => `Índice mediano de las publicaciones realizadas ${b} frente a ${u} durante el experimento`,
  },
  tagKind: { pillar: "el pilar", topic: "el tema" },
};

const CATALOG: Record<ReportLocale, RecommendationTemplates> = { "pt-BR": pt, "en-US": en, "es-ES": es };

export function recommendationTemplates(locale: ReportLocale): RecommendationTemplates {
  return CATALOG[locale];
}
