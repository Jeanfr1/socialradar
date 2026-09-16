import Link from "next/link";
import type { AccountHealthVM } from "@/server/queries/pages/account-health";
import { DEFINITIONS } from "@/components/ui/copy";
import { Freshness } from "@/components/ui/Freshness";
import { Icon } from "@/components/ui/Icon";
import { Term } from "@/components/ui/InfoTip";
import { Pill, StatusBadge } from "@/components/ui/StatusBadge";

function Field({ term, definition, value, sub, emphasize }: { term: string; definition?: string; value: React.ReactNode; sub?: React.ReactNode; emphasize?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-line p-3">
      <dt className="flex items-center text-xs font-medium text-ink-2">{definition ? <Term term={term} definition={definition} /> : term}</dt>
      <dd className={`mt-1 tabular-nums ${emphasize ? "text-base font-semibold" : "font-medium"} text-ink`}>{value}</dd>
      {sub ? <dd className="mt-0.5 text-xs text-ink-2">{sub}</dd> : null}
    </div>
  );
}

/**
 * Scheduling math card: never collapses the coverage figures into one number, labels the runway as an estimate
 * and shows every figure as "Unavailable" when the channel is disconnected.
 */
export function SchedulingCard({ vm, headingId, detailHref }: { vm: AccountHealthVM; headingId: string; detailHref?: string }) {
  const s = vm.scheduling;
  const u = s.unavailable;
  const na = (v: string | null, empty = "Nenhum") => (u ? u : (v ?? empty));
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <span className="truncate">@{vm.handle.replace(/^@/, "")}</span>
            <span className="text-sm font-normal text-ink-2">{vm.platformLabel}</span>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusBadge status={vm.status} stale={!!vm.stale} staleLabel={vm.stale?.label} note={vm.statusNote} />
            {vm.connectionIssue ? <Pill tone="critical">{vm.connectionIssue}</Pill> : null}
            {s.isEstimate ? <Pill tone="warning">Estimativas</Pill> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Freshness vm={vm.freshness} />
          {detailHref ? (
            <Link href={detailHref} className="link text-sm">
              Detalhe da conta
            </Link>
          ) : null}
        </div>
      </div>

      {u ? (
        <p className="mb-3 rounded-md border border-disconnected/30 bg-disconnected/5 p-2 text-sm text-ink">
          Esta conta está desconectada do Buffer. Não conseguimos obter os dados atuais de fila nem de desempenho. Reconecte-a
          diretamente no Buffer para que ela volte a sincronizar aqui.
        </p>
      ) : null}
      {!u && s.emptyCopy ? (
        <p role="note" className="mb-3 flex items-center gap-2 rounded-md border border-critical/40 bg-critical/5 p-2 text-sm font-medium text-critical">
          <Icon name="circle-slash" /> {s.emptyCopy}
        </p>
      ) : null}
      {!u && s.pausedCopy ? <p className="mb-3 rounded-md border border-paused/30 bg-paused/5 p-2 text-sm text-ink">{s.pausedCopy}</p> : null}
      {!u && vm.stale ? (
        <p className="mb-3 rounded-md border border-stale/40 bg-[#fdf6e3] p-2 text-sm text-ink">
          {vm.freshness.label} — os números abaixo podem não refletir as mudanças mais recentes no Buffer.
        </p>
      ) : null}

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Field term="Posts agendados" value={u ? u : s.scheduledCount} sub={u ? null : s.nextScheduled ? `Próximo: ${s.nextScheduled}` : "Próximo: nenhum agendado"} />
        <Field term="Último post agendado" definition={DEFINITIONS.lastScheduled} value={na(s.lastScheduled)} />
        <Field
          term="Cobertura da cadência"
          definition={DEFINITIONS.coverage}
          emphasize
          value={u ? u : (s.coveragePct ?? "Sem horários esperados")}
          sub={u ? null : `${s.coveredSlots} de ${s.expectedSlots} horários esperados cobertos · ${s.horizonLabel}`}
        />
        <Field
          term="Primeiro horário descoberto"
          definition={DEFINITIONS.firstUncovered}
          emphasize
          value={u ? u : (s.firstUncoveredSlot ?? (s.expectedSlots > 0 ? "Todos os horários cobertos no horizonte" : "Nenhum"))}
          sub={u || !s.firstUncoveredRelative ? null : `${s.firstUncoveredRelative}${s.coveredDays ? ` · cobertura contínua ${s.coveredDays}` : ""}`}
        />
        <Field
          term="Autonomia estimada da fila"
          definition={DEFINITIONS.runway}
          value={
            u ? (
              u
            ) : (
              <span className="inline-flex items-center gap-2">
                {s.runway ?? "Indisponível"} <Pill tone="neutral">Estimativa</Pill>
              </span>
            )
          }
        />
        <Field
          term="Posts necessários"
          definition={DEFINITIONS.postsNeeded}
          value={u ? u : s.postsNeeded === 0 ? "Nenhum" : `Agende mais ${s.postsNeeded}`}
          sub={u ? null : `para seguir coberto até ${s.horizonEnd}`}
        />
        <Field term="Prazo para preencher a primeira lacuna" definition={DEFINITIONS.fillDeadline} value={na(s.fillDeadline, "Sem lacunas no horizonte")} />
        <Field
          term="Itens pendentes"
          value={u ? u : s.unresolvedCount}
          sub={u ? null : "Rascunhos / aguardando aprovação / sem horário confirmado — nunca contam como cobertura"}
        />
        <Field
          term="Problemas de publicação"
          value={
            u ? (
              u
            ) : (
              <span className={s.overdueCount + s.failedCount > 0 ? "text-critical" : ""}>
                {s.overdueCount} atrasados · {s.failedCount} com falha
              </span>
            )
          }
          sub={u ? null : "Posts com falha nos últimos 14 dias"}
        />
      </dl>

      {s.capNote ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-sm text-ink">
          <Icon name="alert-triangle" className="mt-0.5 h-4 w-4 text-warning" />
          {s.capNote}
        </p>
      ) : null}
      {s.notes.length > 0 ? (
        <details className="mt-3 text-sm">
          <summary className="link cursor-pointer">Como estes números foram calculados ({s.notes.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
            <li>
              Cadência: {s.cadenceLabel}. Horários exibidos em {vm.cadenceTimezone} ({vm.cadenceZoneLabel}).
            </li>
            {s.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="mt-3 text-xs text-ink-2">
          Cadência: {s.cadenceLabel}. Horários exibidos em {vm.cadenceTimezone} ({vm.cadenceZoneLabel}).
        </p>
      )}
    </section>
  );
}
