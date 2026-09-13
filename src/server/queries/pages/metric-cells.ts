/** Metric cell view models: value or explicit status label, never a silent 0. */
import { DEFINITIONS } from "@/components/ui/copy";
import { METRIC_DEFINITIONS, primaryEngagementRate } from "@/domain/metrics";
import type { MetricKey, MetricValue, Platform } from "@/domain/types";
import { fmtNum, PLATFORM_LABEL } from "./format";

export interface MetricCellVM {
  key: MetricKey;
  label: string;
  display: string;
  status: MetricValue["status"] | "missing";
  tip: string | null;
  value: number | null;
}

export function metricCell(key: MetricKey, mv: MetricValue | undefined, platform: Platform, opts: { likelyNotReported?: boolean } = {}): MetricCellVM {
  const label = METRIC_DEFINITIONS[key].label;
  const base = { key, label };
  if (!mv) return { ...base, display: "N/A", status: "missing", tip: DEFINITIONS.na, value: null };
  switch (mv.status) {
    case "reported":
      return { ...base, display: fmtNum(mv.value), status: "reported", tip: null, value: mv.value };
    case "reported_zero":
      return {
        ...base,
        display: "0*",
        status: "reported_zero",
        tip: `${DEFINITIONS.ambiguousZero}${opts.likelyNotReported ? ` ${label} was 0 on every recent post of this account, so it is most likely not reported.` : ""}`,
        value: 0,
      };
    case "not_reported":
      return { ...base, display: "Not reported", status: "not_reported", tip: `${DEFINITIONS.notReported} ${DEFINITIONS.na}`, value: null };
    case "pending":
      return { ...base, display: "Pending", status: "pending", tip: DEFINITIONS.pending, value: null };
    case "unsupported":
      return { ...base, display: "Unsupported", status: "unsupported", tip: `${label} is not available on ${PLATFORM_LABEL[platform]} via Buffer.`, value: null };
  }
}

export interface ErCellVM {
  display: string;
  value: number | null;
  definitionId: string;
  denominator: "reach" | "views" | null;
  definition: string;
  naReason: string | null;
  zeroUncertainty: boolean;
}

export function erCell(metrics: Partial<Record<MetricKey, MetricValue>>, platform: Platform): ErCellVM {
  const r = primaryEngagementRate(metrics, platform);
  const denominator = platform === "instagram" ? "reach" : platform === "tiktok" || platform === "youtube" ? "views" : null;
  const canonical = denominator === "reach" ? DEFINITIONS.erReach : denominator === "views" ? DEFINITIONS.erViews : "No engagement rate definition exists for this platform.";
  const formula =
    denominator && r.components.length
      ? ` For ${PLATFORM_LABEL[platform]} via Buffer: (${r.components.join(" + ")}) ÷ ${denominator} × 100.`
      : "";
  return {
    display: r.result.value === null ? "N/A" : `${r.result.value.toFixed(2)}%${r.containsZeroUncertainty ? "*" : ""}`,
    value: r.result.value,
    definitionId: r.definitionId,
    denominator,
    definition: `${canonical}${formula} Definition id: ${r.definitionId}.`,
    naReason: r.result.na?.message ?? null,
    zeroUncertainty: r.containsZeroUncertainty,
  };
}

export const TABLE_METRICS: MetricKey[] = ["views", "reach", "reactions", "comments", "shares", "saves"];
