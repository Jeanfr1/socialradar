import type { ErCellVM, MetricCellVM } from "@/server/queries/pages/metric-cells";
import { DEFINITIONS } from "@/components/ui/copy";
import { InfoTip } from "@/components/ui/InfoTip";

export function MetricCell({ cell }: { cell: MetricCellVM }) {
  const muted = cell.status !== "reported" && cell.status !== "reported_zero";
  return (
    <span className="inline-flex items-center whitespace-nowrap">
      <span className={`tabular-nums ${muted ? "text-xs italic text-ink-2" : ""}`}>{cell.display}</span>
      {cell.tip ? (
        <InfoTip label={`Sobre este valor de ${cell.label}`} align="right">
          {cell.tip}
        </InfoTip>
      ) : null}
    </span>
  );
}

export function ErCell({ cell }: { cell: ErCellVM }) {
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center whitespace-nowrap">
        <span className={`tabular-nums ${cell.value === null ? "text-xs italic text-ink-2" : "font-medium"}`}>{cell.display}</span>
        <InfoTip label="Sobre esta taxa de engajamento" align="right">
          {cell.definition}
          {cell.naReason ? ` Indisponível porque: ${cell.naReason}` : ""}
          {cell.zeroUncertainty ? ` * ${DEFINITIONS.ambiguousZero}` : ""}
        </InfoTip>
      </span>
      {cell.denominator ? <span className="text-[11px] text-ink-2">por {cell.denominator}</span> : null}
    </span>
  );
}
