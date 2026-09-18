/**
 * Alert rules: pure evaluation of alert candidates from already-computed facts.
 *
 * Dedupe keys identify the underlying CONDITION, not its severity, so a changing severity updates the same
 * alert in place:
 *   queue_coverage:<accountId>        queue_empty AND queue_coverage (warning/critical) share this key —
 *                                     depletion is one condition; the persistence layer must update `type` too.
 *   sync_stale:<accountId>            account queue data stale / never synced
 *   sync_stale:connection:<id>        connection has not synced successfully within its staleness window
 *   queue_paused:<accountId>
 *   account_disconnected:<accountId>
 *   publish_failed:<postId>           one per failed post
 *   post_overdue:<accountId>          one per account listing every overdue post id
 *   unresolved_times:<accountId>
 *   connection_failing:<connectionId>
 *
 * Suppression rules (avoid contradictory or misleading alerts)
 * - Coverage is stale or never synced → emit sync_stale, NEVER queue_empty/queue_coverage
 *   (stale data must not be presented as confirmed depletion).
 * - Account disconnected → emit account_disconnected only; no queue_* and no sync_stale (the disconnection explains both).
 * - Queue paused → emit queue_paused; no queue_* (coverage cannot deplete while nothing publishes).
 * - A post in recentErrors is not also reported as overdue.
 * - connection_failing suppresses the connection-level sync_stale.
 *
 * `resolveMissing` must receive the open keys of exactly the scope that was evaluated (one account or one connection);
 * otherwise alerts of other scopes would be auto-resolved.
 */
import { DateTime } from "luxon";
import { evaluateNextDayGap, type DayPost } from "./next-day-gap";
import type { CoverageResult, Platform } from "./types";

export type AlertType =
  | "queue_empty"
  | "queue_coverage"
  | "sync_stale"
  | "queue_paused"
  | "account_disconnected"
  | "publish_failed"
  | "post_overdue"
  | "unresolved_times"
  | "connection_failing"
  | "next_day_gap";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertCandidate {
  dedupeKey: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  /** Observed facts only: numbers, ISO dates, post ids. */
  evidence: Record<string, unknown>;
  suggestedAction: string;
  brandId: string | null;
  socialAccountId: string | null;
  connectionId: string | null;
}

/** Formats an instant for alert copy. Default: "Tue 16 Sep 20:00 (America/Sao_Paulo)". */
export type DateFormatter = (at: Date, timezone: string) => string;

export const defaultDateFormatter: DateFormatter = (at, timezone) =>
  `${DateTime.fromJSDate(at, { zone: timezone }).setLocale("pt-BR").toFormat("ccc d LLL HH:mm")} (${timezone})`;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_PROVIDER_MESSAGE = 500;

const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", other: "Outra" };

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function roundDays(days: number): number {
  return Math.round(days * 10) / 10;
}

export interface AccountAlertInput {
  accountId: string;
  brandId: string;
  handle: string;
  platform: Platform;
  coverage: CoverageResult;
  recentErrors: { postId: string; dueAt: Date | null; message: string }[];
  /** Scheduled posts with dueAt < now − grace that are still not sent. */
  overdue: { postId: string; dueAt: Date }[];
  isDisconnected: boolean;
  isQueuePaused: boolean;
  now: Date;
  /** Cadence timezone for human-readable dates (default UTC). */
  timezone?: string;
  lastQueueSyncAt?: Date | null;
  /** Provider cap on pending scheduled posts for this account (see coverage.ts). */
  inventoryCap?: number | null;
  formatDate?: DateFormatter;
}

function coverageAction(input: AccountAlertInput, fmt: DateFormatter, tz: string): string {
  const c = input.coverage;
  const horizonDays = Math.round((c.horizonEnd.getTime() - c.horizonStart.getTime()) / DAY_MS);
  if (c.postsNeeded === 0) {
    return `Todos os horários previstos nos próximos ${plural(horizonDays, "dia")} estão cobertos, mas o horizonte de cobertura é menor que o limite de atenção. Aumente o horizonte nas configurações de cadência desta conta para que a cobertura saudável possa ser confirmada.`;
  }
  const deadline = c.fillDeadline ? fmt(c.fillDeadline, tz) : null;
  const cap = input.inventoryCap ?? (c as Partial<{ inventoryCap: number | null }>).inventoryCap ?? null;
  const remaining = cap === null ? null : Math.max(0, cap - c.scheduledCount);
  if (remaining !== null && remaining < c.postsNeeded) {
    if (remaining === 0) {
      return `O limite de posts agendados do provedor (${cap}) foi atingido, então os próximos ${horizonDays} dias não podem ser totalmente cobertos. Reabasteça a fila conforme os posts forem publicados${deadline ? `, no máximo até ${deadline}` : ""}.`;
    }
    return `Agende ${plural(remaining, "post")}${deadline ? ` até ${deadline}` : ""} (o limite de ${cap} posts agendados do provedor impede cobrir todos os ${horizonDays} dias) e reabasteça a fila conforme os posts forem publicados.`;
  }
  return `Agende ${plural(c.postsNeeded, "post")}${deadline ? ` até ${deadline}` : ""} para cobrir os próximos ${plural(horizonDays, "dia")}.`;
}

export function evaluateAccountAlerts(input: AccountAlertInput): AlertCandidate[] {
  const fmt = input.formatDate ?? defaultDateFormatter;
  const tz = input.timezone ?? "UTC";
  const c = input.coverage;
  const who = `@${input.handle.replace(/^@/, "")} (${PLATFORM_LABEL[input.platform]})`;
  const scope = { brandId: input.brandId, socialAccountId: input.accountId, connectionId: null };
  const out: AlertCandidate[] = [];

  if (input.isDisconnected) {
    out.push({
      ...scope,
      dedupeKey: `account_disconnected:${input.accountId}`,
      type: "account_disconnected",
      severity: "critical",
      title: `${who} está desconectado do Buffer`,
      evidence: { accountId: input.accountId, platform: input.platform, handle: input.handle, lastQueueSyncAt: iso(input.lastQueueSyncAt), scheduledCountAtLastSync: c.scheduledCount },
      suggestedAction: `Reconecte ${who} diretamente no Buffer. O SocialRadar não reconecta canais; os posts agendados não serão publicados e a cobertura não pode ser confirmada até a reconexão.`,
    });
  }

  if (input.isQueuePaused && !input.isDisconnected) {
    out.push({
      ...scope,
      dedupeKey: `queue_paused:${input.accountId}`,
      type: "queue_paused",
      severity: "warning",
      title: `Fila pausada em ${who}`,
      evidence: { accountId: input.accountId, scheduledCount: c.scheduledCount, nextScheduledAt: iso(c.nextScheduledAt) },
      suggestedAction: `Retome a fila de ${who} no Buffer se a pausa não for intencional; ${plural(c.scheduledCount, "post agendado", "posts agendados")} não serão publicados enquanto ela estiver pausada.`,
    });
  }

  if (!input.isDisconnected) {
    if (c.freshness !== "fresh") {
      const never = c.freshness === "never_synced";
      out.push({
        ...scope,
        dedupeKey: `sync_stale:${input.accountId}`,
        type: "sync_stale",
        severity: never ? "info" : "warning",
        title: never ? `Ainda não há dados da fila de ${who}` : `Os dados da fila de ${who} estão desatualizados`,
        evidence: {
          accountId: input.accountId,
          freshness: c.freshness,
          lastQueueSyncAt: iso(input.lastQueueSyncAt),
          lastKnownQueueState: (c as Partial<{ underlyingState: string | null }>).underlyingState ?? null,
          scheduledCountAtLastSync: c.scheduledCount,
        },
        suggestedAction: never
          ? `Aguarde a primeira sincronização da fila de ${who} (ou execute uma sincronização da conexão); até lá a cobertura não pode ser confirmada.`
          : `Verifique a conexão com o Buffer e sincronize ${who}; os números de cobertura vêm da última sincronização bem-sucedida e podem não refletir mudanças recentes.`,
      });
    } else if (!input.isQueuePaused && (c.state === "empty" || c.state === "critical" || c.state === "warning")) {
      const empty = c.state === "empty";
      const coveredDays = c.coveredDays ?? 0;
      out.push({
        ...scope,
        dedupeKey: `queue_coverage:${input.accountId}`,
        type: empty ? "queue_empty" : "queue_coverage",
        severity: c.state === "warning" ? "warning" : "critical",
        title: empty
          ? `Nenhum post agendado em ${who}`
          : `A fila de ${who} cobre apenas ${roundDays(coveredDays)} ${roundDays(coveredDays) === 1 ? "dia" : "dias"}`,
        evidence: {
          accountId: input.accountId,
          state: c.state,
          coveredDays: c.coveredDays,
          coverageRatio: c.coverageRatio,
          expectedSlots: c.expectedSlots,
          coveredSlots: c.coveredSlots,
          scheduledCount: c.scheduledCount,
          postsNeeded: c.postsNeeded,
          firstUncoveredSlot: iso(c.firstUncoveredSlot),
          nextScheduledAt: iso(c.nextScheduledAt),
          lastScheduledAt: iso(c.lastScheduledAt),
          horizonStart: iso(c.horizonStart),
          horizonEnd: iso(c.horizonEnd),
          unresolvedCount: c.unresolvedCount,
          isEstimate: c.isEstimate,
          reasons: c.reasons,
        },
        suggestedAction: coverageAction(input, fmt, tz),
      });
    }
  }

  if (c.unresolvedCount > 0 && c.freshness !== "never_synced" && !input.isDisconnected) {
    out.push({
      ...scope,
      dedupeKey: `unresolved_times:${input.accountId}`,
      type: "unresolved_times",
      severity: "info",
      title: `${plural(c.unresolvedCount, "post pendente", "posts pendentes")} de ${who} sem horário de publicação confirmado`,
      evidence: { accountId: input.accountId, unresolvedCount: c.unresolvedCount },
      suggestedAction: `Aprove ou defina um horário de publicação no Buffer para os rascunhos ou posts aguardando aprovação de ${who}; até lá eles não contam para a cobertura.`,
    });
  }

  const errorIds = new Set<string>();
  for (const err of input.recentErrors) {
    if (errorIds.has(err.postId)) continue;
    errorIds.add(err.postId);
    const recent = err.dueAt === null || input.now.getTime() - err.dueAt.getTime() <= 24 * HOUR_MS;
    out.push({
      ...scope,
      dedupeKey: `publish_failed:${err.postId}`,
      type: "publish_failed",
      severity: recent ? "critical" : "warning",
      title: `Falha ao publicar post em ${who}`,
      evidence: { accountId: input.accountId, postId: err.postId, dueAt: iso(err.dueAt), providerMessage: err.message.slice(0, MAX_PROVIDER_MESSAGE) },
      suggestedAction: err.dueAt
        ? `Revise o erro no Buffer, corrija o post e reagende; o horário de ${fmt(err.dueAt, tz)} ficou vazio.`
        : "Revise o erro no Buffer, corrija o post e reagende.",
    });
  }

  const overdue = input.overdue
    .filter((o) => !errorIds.has(o.postId) && o.dueAt.getTime() <= input.now.getTime())
    .filter((o, i, arr) => arr.findIndex((x) => x.postId === o.postId) === i)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || (a.postId < b.postId ? -1 : 1));
  if (overdue.length > 0) {
    const oldest = overdue[0] as { postId: string; dueAt: Date };
    const likelyCause = input.isDisconnected ? "account_disconnected" : input.isQueuePaused ? "queue_paused" : null;
    out.push({
      ...scope,
      dedupeKey: `post_overdue:${input.accountId}`,
      type: "post_overdue",
      severity: likelyCause ? "info" : "warning",
      title: `${plural(overdue.length, "post agendado", "posts agendados")} ${overdue.length === 1 ? "atrasado" : "atrasados"} em ${who}`,
      evidence: { accountId: input.accountId, count: overdue.length, postIds: overdue.map((o) => o.postId), oldestDueAt: iso(oldest.dueAt), likelyCause },
      suggestedAction: likelyCause
        ? `Estes posts não podem ser publicados enquanto a conta estiver ${likelyCause === "account_disconnected" ? "desconectada" : "pausada"}; resolva isso primeiro e depois verifique no Buffer.`
        : `Verifique ${overdue.length === 1 ? "este post" : "estes posts"} no Buffer: com horário desde ${fmt(oldest.dueAt, tz)} e ainda sem publicação. Reagende ou tente novamente se o Buffer não mostrar progresso.`,
    });
  }

  return out;
}

export interface ConnectionAlertInput {
  connectionId: string;
  /** pending | active | invalid | error | revoked */
  status: string;
  lastSyncSuccessAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  now: Date;
  staleAfterMinutes: number;
  /** Consecutive failures before alerting (default 3); twice this is critical. */
  failureThreshold?: number;
  formatDate?: DateFormatter;
}

const CREDENTIAL_ERRORS = new Set(["unauthorized", "forbidden"]);
const THROTTLE_ERRORS = new Set(["rate_limited", "quota_reserved"]);

export function evaluateConnectionAlerts(input: ConnectionAlertInput): AlertCandidate[] {
  const fmt = input.formatDate ?? defaultDateFormatter;
  const threshold = Math.max(1, input.failureThreshold ?? 3);
  const scope = { brandId: null, socialAccountId: null, connectionId: input.connectionId };
  const evidence = {
    connectionId: input.connectionId,
    status: input.status,
    consecutiveFailures: input.consecutiveFailures,
    lastErrorCode: input.lastErrorCode,
    lastSyncSuccessAt: iso(input.lastSyncSuccessAt),
  };
  const out: AlertCandidate[] = [];
  if (input.status === "pending") return out;

  const credentialProblem = input.status === "invalid" || input.status === "revoked" || CREDENTIAL_ERRORS.has(input.lastErrorCode ?? "");
  if (credentialProblem) {
    out.push({
      ...scope,
      dedupeKey: `connection_failing:${input.connectionId}`,
      type: "connection_failing",
      severity: "critical",
      title: "O Buffer rejeitou a chave de API desta conexão",
      evidence,
      suggestedAction: "Informe novamente uma chave de API válida do Buffer em Configurações → Conexões; nada dos canais dessa conexão será sincronizado até lá.",
    });
  } else if (input.consecutiveFailures >= threshold) {
    const throttled = THROTTLE_ERRORS.has(input.lastErrorCode ?? "");
    out.push({
      ...scope,
      dedupeKey: `connection_failing:${input.connectionId}`,
      type: "connection_failing",
      severity: input.consecutiveFailures >= threshold * 2 && !throttled ? "critical" : "warning",
      title: throttled
        ? `Sincronização do Buffer limitada ${plural(input.consecutiveFailures, "vez", "vezes")} seguidas`
        : `Falha na sincronização do Buffer ${plural(input.consecutiveFailures, "vez", "vezes")} seguidas`,
      evidence,
      suggestedAction: throttled
        ? "A sincronização é repetida automaticamente após a janela de limite. Evite sincronizações manuais e distribua as conexões que compartilham a mesma conta do Buffer."
        : "Verifique o status do Buffer e o último erro desta conexão; as sincronizações são repetidas automaticamente. Se as falhas continuarem, valide novamente a chave de API em Configurações → Conexões.",
    });
  }

  if (out.length === 0) {
    const ageMs = input.lastSyncSuccessAt ? input.now.getTime() - input.lastSyncSuccessAt.getTime() : null;
    const staleMs = input.staleAfterMinutes * 60_000;
    if (ageMs === null || ageMs > staleMs) {
      out.push({
        ...scope,
        dedupeKey: `sync_stale:connection:${input.connectionId}`,
        type: "sync_stale",
        severity: ageMs !== null && ageMs > staleMs * 4 ? "critical" : "warning",
        title: input.lastSyncSuccessAt ? "A conexão com o Buffer não sincroniza há algum tempo" : "A conexão com o Buffer nunca sincronizou com sucesso",
        evidence: { ...evidence, staleAfterMinutes: input.staleAfterMinutes },
        suggestedAction: input.lastSyncSuccessAt
          ? `Última sincronização bem-sucedida em ${fmt(input.lastSyncSuccessAt, "UTC")}. Verifique se o processo de sincronização está ativo; os dados desta conexão podem estar desatualizados.`
          : "Verifique se o processo de sincronização está ativo e execute a primeira sincronização desta conexão.",
      });
    }
  }
  return out;
}

/** Open dedupe keys (for the evaluated scope) that no longer have a candidate → auto-resolve. Order preserved, unique. */
export function resolveMissing(openDedupeKeys: Iterable<string>, candidates: AlertCandidate[]): string[] {
  const active = new Set(candidates.map((c) => c.dedupeKey));
  const out: string[] = [];
  for (const key of openDedupeKeys) if (!active.has(key) && !out.includes(key)) out.push(key);
  return out;
}

/** Data older than this cannot confirm tomorrow is empty (the queue syncs once a day). */
export const NEXT_DAY_GAP_MAX_DATA_AGE_HOURS = 26;

/**
 * The user-facing queue alert: critical when the account posts today and has nothing scheduled for tomorrow.
 * Suppressed when the queue data is too old to confirm it.
 */
export function evaluateNextDayGapAlert(input: {
  accountId: string;
  brandId: string;
  handle: string;
  platform: Platform;
  timezone: string;
  now: Date;
  lastQueueSyncAt: Date | null;
  posts: DayPost[];
}): AlertCandidate[] {
  if (!input.lastQueueSyncAt || input.now.getTime() - input.lastQueueSyncAt.getTime() > NEXT_DAY_GAP_MAX_DATA_AGE_HOURS * HOUR_MS) return [];
  const r = evaluateNextDayGap({ now: input.now, timezone: input.timezone, posts: input.posts });
  if (!r.isGap) return [];
  const who = `@${input.handle.replace(/^@/, "")} (${PLATFORM_LABEL[input.platform]})`;
  const tomorrowLabel = DateTime.fromISO(r.tomorrow, { zone: input.timezone }).setLocale("pt-BR").toFormat("cccc, dd/LL");
  return [
    {
      dedupeKey: `next_day_gap:${input.accountId}`,
      type: "next_day_gap",
      severity: "critical",
      title: `Amanhã (${tomorrowLabel}) não há post agendado em ${who}`,
      evidence: { accountId: input.accountId, today: r.today, tomorrow: r.tomorrow, postsToday: r.postsToday, scheduledTomorrow: r.scheduledTomorrow, lastQueueSyncAt: iso(input.lastQueueSyncAt) },
      suggestedAction: `Agende pelo menos um post em ${who} para ${tomorrowLabel}.`,
      brandId: input.brandId,
      socialAccountId: input.accountId,
      connectionId: null,
    },
  ];
}
