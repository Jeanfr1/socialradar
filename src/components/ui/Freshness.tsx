import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";
import { DEFINITIONS } from "./copy";

export interface FreshnessVM {
  /** "Synced 42 min ago" / "Never synced". */
  label: string;
  /** Absolute time in the display zone, e.g. "Tue 16 Sep 2026, 20:00 GMT-3". */
  absolute: string | null;
  /** soft = older than 24h, hard = older than 48h or never synced. */
  level: "fresh" | "soft" | "hard";
}

export function Freshness({ vm, prefix }: { vm: FreshnessVM; prefix?: string }) {
  const tone = vm.level === "fresh" ? "text-ink-2" : "text-stale font-medium";
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tone}`}>
      {vm.level !== "fresh" ? <Icon name="clock-alert" className="h-3.5 w-3.5" /> : null}
      <span title={vm.absolute ?? undefined}>
        {prefix ? `${prefix} ` : ""}
        {vm.label}
        {vm.level === "hard" ? " · desatualizado" : ""}
      </span>
      <InfoTip label="Sobre a Última sincronização">
        {DEFINITIONS.lastSynced}
        {vm.absolute ? ` Última sincronização bem-sucedida: ${vm.absolute}.` : ""}
      </InfoTip>
    </span>
  );
}
