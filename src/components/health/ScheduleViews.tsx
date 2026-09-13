import type { AccountDetailVM } from "@/server/queries/pages/account-detail";

/** Weekly posting schedule grid (Mon–Sun) with paused days. */
export function PostingScheduleGrid({ days, caption }: { days: AccountDetailVM["providerSchedule"]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {days.map((d) => (
              <th key={d.day} scope="col">
                {d.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {days.map((d) => (
              <td key={d.day} className={d.paused ? "hatch-unavailable" : ""}>
                {d.paused ? <span className="rounded bg-surface px-1 text-xs font-medium text-paused">Paused</span> : null}
                {d.times.length === 0 && !d.paused ? <span className="text-xs text-ink-2">No slots</span> : null}
                <ul className="space-y-0.5 tabular-nums">
                  {d.times.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Expected slots in the coverage horizon, grouped by local day, marked covered / uncovered (icon + text). */
export function CoverageSlotsTimeline({ days }: { days: AccountDetailVM["slotDays"] }) {
  if (days.length === 0) return <p className="text-sm text-ink-2">No expected slots in the horizon.</p>;
  return (
    <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
      {days.map((d) => {
        const gap = d.slots.some((s) => !s.covered);
        return (
          <li key={d.key} className={`rounded-md border p-2 ${gap ? "hatch-gap border-critical/40" : "border-line bg-surface"}`}>
            <div className={gap ? "rounded bg-surface/95 p-1" : ""}>
              <p className="text-xs font-semibold">{d.label}</p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {d.slots.map((s) => (
                  <li key={s.at} className="flex items-center gap-1 tabular-nums">
                    <span aria-hidden className={s.covered ? "text-healthy" : "text-critical"}>
                      {s.covered ? "●" : "○"}
                    </span>
                    {s.time} <span className={s.covered ? "text-healthy" : "font-semibold text-critical"}>{s.covered ? "Covered" : "Uncovered"}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
