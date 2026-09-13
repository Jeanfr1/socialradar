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
  const na = (v: string | null, empty = "None") => (u ? u : (v ?? empty));
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
            {s.isEstimate ? <Pill tone="warning">Estimates</Pill> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Freshness vm={vm.freshness} />
          {detailHref ? (
            <Link href={detailHref} className="link text-sm">
              Account detail
            </Link>
          ) : null}
        </div>
      </div>

      {u ? (
        <p className="mb-3 rounded-md border border-disconnected/30 bg-disconnected/5 p-2 text-sm text-ink">
          This account is disconnected from Buffer. We can&apos;t retrieve current queue or performance data. Reconnect it directly in
          Buffer, then it will sync here again.
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
          {vm.freshness.label} — figures below may not reflect the very latest changes in Buffer.
        </p>
      ) : null}

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Field term="Scheduled posts" value={u ? u : s.scheduledCount} sub={u ? null : s.nextScheduled ? `Next: ${s.nextScheduled}` : "Next: none scheduled"} />
        <Field term="Last scheduled date" definition={DEFINITIONS.lastScheduled} value={na(s.lastScheduled)} />
        <Field
          term="Cadence coverage"
          definition={DEFINITIONS.coverage}
          emphasize
          value={u ? u : (s.coveragePct ?? "No expected slots")}
          sub={u ? null : `${s.coveredSlots} of ${s.expectedSlots} expected slots covered · ${s.horizonLabel}`}
        />
        <Field
          term="First uncovered slot"
          definition={DEFINITIONS.firstUncovered}
          emphasize
          value={u ? u : (s.firstUncoveredSlot ?? (s.expectedSlots > 0 ? "All slots covered in horizon" : "None"))}
          sub={u || !s.firstUncoveredRelative ? null : `${s.firstUncoveredRelative}${s.coveredDays ? ` · continuous coverage ${s.coveredDays}` : ""}`}
        />
        <Field
          term="Estimated runway"
          definition={DEFINITIONS.runway}
          value={
            u ? (
              u
            ) : (
              <span className="inline-flex items-center gap-2">
                {s.runway ?? "N/A"} <Pill tone="neutral">Estimate</Pill>
              </span>
            )
          }
        />
        <Field
          term="Posts needed"
          definition={DEFINITIONS.postsNeeded}
          value={u ? u : s.postsNeeded === 0 ? "None" : `Schedule ${s.postsNeeded} more`}
          sub={u ? null : `to stay covered through ${s.horizonEnd}`}
        />
        <Field term="Deadline to fill first gap" definition={DEFINITIONS.fillDeadline} value={na(s.fillDeadline, "No gap in horizon")} />
        <Field
          term="Unresolved items"
          value={u ? u : s.unresolvedCount}
          sub={u ? null : "Drafts / awaiting approval / no confirmed time — never counted as coverage"}
        />
        <Field
          term="Publishing problems"
          value={
            u ? (
              u
            ) : (
              <span className={s.overdueCount + s.failedCount > 0 ? "text-critical" : ""}>
                {s.overdueCount} overdue · {s.failedCount} failed
              </span>
            )
          }
          sub={u ? null : "Failed posts from the last 14 days"}
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
          <summary className="link cursor-pointer">How these figures were calculated ({s.notes.length})</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
            <li>
              Cadence: {s.cadenceLabel}. Times shown in {vm.cadenceTimezone} ({vm.cadenceZoneLabel}).
            </li>
            {s.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="mt-3 text-xs text-ink-2">
          Cadence: {s.cadenceLabel}. Times shown in {vm.cadenceTimezone} ({vm.cadenceZoneLabel}).
        </p>
      )}
    </section>
  );
}
