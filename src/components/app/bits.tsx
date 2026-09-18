/** Small presentational building blocks shared by the four main tabs. */
import Link from "next/link";
import type { Platform } from "@/domain/types";

const PLATFORM_STYLE: Record<Platform, { code: string; name: string; className: string }> = {
  instagram: { code: "IG", name: "Instagram", className: "bg-[#fbe7f0] text-[#b0185a]" },
  tiktok: { code: "TT", name: "TikTok", className: "bg-[#e9ebef] text-[#111827]" },
  youtube: { code: "YT", name: "YouTube", className: "bg-[#fde8e8] text-[#b91c1c]" },
  other: { code: "•", name: "Outra", className: "bg-canvas text-ink-2" },
};

export function PlatformTag({ platform, className = "" }: { platform: Platform; className?: string }) {
  const s = PLATFORM_STYLE[platform];
  return (
    <span title={s.name} className={`inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded px-1 text-[10px] font-bold tracking-wide ${s.className} ${className}`}>
      {s.code}
      <span className="sr-only"> {s.name}</span>
    </span>
  );
}

export const nf = new Intl.NumberFormat("pt-BR");
const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function fmtCount(n: number | null): string {
  return n === null ? "—" : nf.format(Math.round(n));
}

export function fmtRate(n: number | null): string {
  return n === null ? "—" : `${nf1.format(n)}%`;
}

/** Change badge: ▲/▼ with sign; neutral when not comparable. */
export function Delta({ value, unit = "pct" }: { value: number | null; unit?: "pct" | "pp" }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-xs text-ink-2" title="Sem base de comparação">sem comparação</span>;
  }
  const flat = Math.abs(value) < 0.05;
  const up = value > 0;
  const text = `${up ? "+" : flat ? "" : "−"}${nf1.format(Math.abs(value))}${unit === "pp" ? " p.p." : "%"}`;
  const tone = flat ? "text-ink-2" : up ? "text-healthy" : "text-critical";
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${tone}`}>
      <span aria-hidden="true">{flat ? "•" : up ? "▲" : "▼"}</span>
      {text}
      <span className="sr-only">{flat ? " estável" : up ? " de aumento" : " de queda"}</span>
    </span>
  );
}

/** Two-option switch rendered as links (keeps state in the URL). */
export function Segmented({ options, active }: { options: { href: string; label: string; key: string }[]; active: string }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
      {options.map((o) => (
        <Link
          key={o.key}
          href={o.href}
          role="tab"
          aria-selected={o.key === active}
          className={`rounded-md px-3 py-1.5 text-sm ${o.key === active ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export function PeriodNav({ label, prevHref, nextHref, badge }: { label: string; prevHref: string; nextHref: string | null; badge?: string | null }) {
  const btn = "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink";
  return (
    <div className="flex items-center gap-2">
      <Link href={prevHref} className={btn} aria-label="Período anterior">
        ‹
      </Link>
      <span className="min-w-[9rem] text-center text-sm font-semibold text-ink">{label}</span>
      {nextHref ? (
        <Link href={nextHref} className={btn} aria-label="Próximo período">
          ›
        </Link>
      ) : (
        <span className={`${btn} cursor-not-allowed opacity-40`} aria-hidden="true">
          ›
        </span>
      )}
      {badge ? <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">{badge}</span> : null}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
