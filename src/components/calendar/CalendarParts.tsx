import type { CalendarCellVM, CalendarItemVM } from "@/server/queries/pages/calendar";
import { Icon } from "@/components/ui/Icon";

const KIND_STYLE: Record<CalendarItemVM["kind"], string> = {
  published: "border-healthy/50 bg-healthy/5",
  scheduled: "border-accent/50 bg-accent-soft",
  failed: "border-critical/60 bg-critical/5",
  unconfirmed: "border-dashed border-ink-2 bg-surface",
  other: "border-line-strong bg-canvas",
};

export function CalendarItem({ item, showHandle }: { item: CalendarItemVM; showHandle: boolean }) {
  return (
    <details className={`rounded border px-1.5 py-1 text-[11px] leading-tight ${KIND_STYLE[item.kind]}`}>
      <summary className="cursor-pointer list-none">
        <span className="font-semibold tabular-nums">{item.time ?? "—"}</span> <span>{item.statusLabel}</span>
        {showHandle ? <span className="block truncate text-ink-2">@{item.handle.replace(/^@/, "")}</span> : null}
        {item.kind === "unconfirmed" ? <span className="mt-0.5 block font-semibold text-ink">Horário não confirmado</span> : null}
      </summary>
      <div className="mt-1 space-y-0.5 border-t border-line pt-1 text-xs">
        <p>
          @{item.handle.replace(/^@/, "")} · {item.platformLabel}
        </p>
        <p>
          {item.statusLabel}
          {item.when ? ` · ${item.when}` : ""}
        </p>
        {item.format ? <p>Formato: {item.format}</p> : null}
        {item.preview ? <p className="break-words text-ink-2">{item.preview}</p> : null}
        {item.tags.length ? <p className="text-ink-2">Tags: {item.tags.join(", ")}</p> : null}
        {item.externalUrl ? (
          <a href={item.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
            Post original <Icon name="external" className="h-3 w-3" />
            <span className="sr-only">(abre em uma nova aba)</span>
          </a>
        ) : null}
      </div>
    </details>
  );
}

export function CellContent({ cell, showHandles, maxItems = 6 }: { cell: CalendarCellVM; showHandles: boolean; maxItems?: number }) {
  const visible = cell.items.slice(0, maxItems);
  const hidden = cell.items.slice(maxItems);
  const uncoveredSlots = cell.slots.filter((s) => !s.covered);
  return (
    <div className={`h-full min-h-24 ${cell.gap ? "hatch-gap" : ""}`}>
      <div className={`h-full space-y-1 p-1 ${cell.gap ? "bg-surface/80" : ""}`}>
        {cell.gap ? (
          <p className="text-[11px] font-semibold text-critical">
            Lacuna: {uncoveredSlots.length} {uncoveredSlots.length === 1 ? "horário descoberto" : "horários descobertos"}
          </p>
        ) : null}
        {visible.map((i) => (
          <CalendarItem key={i.id} item={i} showHandle={showHandles} />
        ))}
        {hidden.length ? (
          <details className="text-[11px]">
            <summary className="link cursor-pointer">+{hidden.length} a mais</summary>
            <div className="mt-1 space-y-1">
              {hidden.map((i) => (
                <CalendarItem key={i.id} item={i} showHandle={showHandles} />
              ))}
            </div>
          </details>
        ) : null}
        {cell.slots.length ? (
          <ul className="space-y-0.5 text-[11px] text-ink-2" aria-label="Horários esperados">
            {cell.slots.map((s, idx) => (
              <li key={`${s.accountId}-${s.time}-${idx}`} className="flex items-center gap-1 tabular-nums">
                <span aria-hidden className={s.covered ? "text-healthy" : "text-critical"}>
                  {s.covered ? "●" : "○"}
                </span>
                {s.time} {showHandles ? `@${s.handle.replace(/^@/, "")}` : ""}{" "}
                <span className={s.covered ? "" : "font-semibold text-critical"}>{s.covered ? "coberto" : "descoberto"}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function CalendarLegend() {
  return (
    <ul className="mb-3 flex flex-wrap gap-3 text-xs text-ink-2" aria-label="Legenda do calendário">
      <li className="flex items-center gap-1">
        <span className="inline-block h-3 w-5 rounded border border-healthy/50 bg-healthy/5" /> Publicado
      </li>
      <li className="flex items-center gap-1">
        <span className="inline-block h-3 w-5 rounded border border-accent/50 bg-accent-soft" /> Agendado
      </li>
      <li className="flex items-center gap-1">
        <span className="inline-block h-3 w-5 rounded border border-critical/60 bg-critical/5" /> Com falha
      </li>
      <li className="flex items-center gap-1">
        <span className="inline-block h-3 w-5 rounded border border-dashed border-ink-2" /> Horário não confirmado (não conta como cobertura)
      </li>
      <li className="flex items-center gap-1">
        <span className="hatch-gap inline-block h-3 w-5 rounded border border-critical/40" /> Lacuna: dia com horários esperados descobertos
      </li>
      <li className="flex items-center gap-1">
        <span className="hatch-unavailable inline-block h-3 w-5 rounded border border-locked/40" /> Indisponível (não é possível confirmar)
      </li>
      <li className="flex items-center gap-1">
        <span className="text-healthy">●</span>/<span className="text-critical">○</span> Horário esperado coberto / descoberto
      </li>
    </ul>
  );
}
