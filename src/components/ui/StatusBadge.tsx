import { useId } from "react";
import { Icon, type IconName } from "./Icon";
import { STATUS_COPY } from "./copy";

export type StatusKind = "healthy" | "warning" | "critical" | "empty" | "paused" | "disconnected" | "locked" | "unknown";

const STYLE: Record<StatusKind, { icon: IconName; cls: string }> = {
  healthy: { icon: "check-circle", cls: "text-healthy border-healthy/40 bg-healthy/5" },
  warning: { icon: "alert-triangle", cls: "text-warning border-warning/40 bg-warning/5" },
  critical: { icon: "alert-octagon", cls: "text-critical border-critical/40 bg-critical/5" },
  empty: { icon: "circle-slash", cls: "text-critical border-empty/50 bg-empty/5" },
  paused: { icon: "pause-circle", cls: "text-paused border-paused/40 bg-paused/5" },
  disconnected: { icon: "unlink", cls: "text-disconnected border-disconnected/40 bg-disconnected/5" },
  locked: { icon: "lock", cls: "text-locked border-locked/40 bg-locked/5" },
  unknown: { icon: "help", cls: "text-ink-2 border-line-strong bg-canvas" },
};

function Chip({ icon, label, tip, cls }: { icon: IconName; label: string; tip: string; cls: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        aria-describedby={id}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`}
      >
        <Icon name={icon} className={`h-3.5 w-3.5 ${icon === "circle-slash" ? "text-empty" : ""}`} />
        {label}
      </span>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none invisible absolute left-0 top-full z-40 mt-1 w-64 max-w-[80vw] rounded-md bg-ink px-3 py-2 text-xs font-normal leading-snug text-white opacity-0 shadow-lg group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}

/** Status chip (icon + text + color) with an optional Stale overlay badge. Never color-only. */
export function StatusBadge({
  status,
  stale,
  staleLabel,
  note,
}: {
  status: StatusKind;
  stale?: boolean;
  /** e.g. "Stale" or "Never synced". */
  staleLabel?: string;
  /** Extra tooltip context appended to the definition. */
  note?: string | null;
}) {
  const s = STYLE[status];
  const copy = STATUS_COPY[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Chip icon={s.icon} label={copy.label} tip={note ? `${copy.tip} ${note}` : copy.tip} cls={s.cls} />
      {stale ? (
        <Chip
          icon="clock-alert"
          label={staleLabel ?? STATUS_COPY.stale.label}
          tip={STATUS_COPY.stale.tip}
          cls="text-stale border-stale/40 bg-stale/5"
        />
      ) : null}
    </span>
  );
}

/** Small neutral pill. */
export function Pill({ children, tone = "neutral", title }: { children: React.ReactNode; tone?: "neutral" | "accent" | "demo" | "critical" | "warning" | "healthy" | "stale"; title?: string }) {
  const cls = {
    neutral: "border-line-strong bg-canvas text-ink-2",
    accent: "border-accent/30 bg-accent-soft text-accent",
    demo: "border-demo/40 bg-demo-soft text-demo",
    critical: "border-critical/40 bg-critical/5 text-critical",
    warning: "border-warning/40 bg-warning/5 text-warning",
    healthy: "border-healthy/40 bg-healthy/5 text-healthy",
    stale: "border-stale/40 bg-stale/5 text-stale",
  }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: "info" | "warning" | "critical" }) {
  if (severity === "critical") return <Chip icon="alert-octagon" label="Critical" tip={STATUS_COPY.critical.tip} cls={STYLE.critical.cls} />;
  if (severity === "warning") return <Chip icon="alert-triangle" label="Warning" tip="Warning: needs attention soon, but not yet urgent." cls={STYLE.warning.cls} />;
  return <Chip icon="info" label="Info" tip="Info: worth knowing; no immediate action required." cls="text-accent border-accent/30 bg-accent-soft" />;
}
