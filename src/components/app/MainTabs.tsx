"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { slug: "calendar", label: "Calendário" },
  { slug: "metrics", label: "Métricas" },
  { slug: "reports", label: "Relatórios" },
  { slug: "recommendations", label: "Recomendações" },
] as const;

export function MainTabs({ fallbackBrandId }: { fallbackBrandId: string | null }) {
  const pathname = usePathname();
  const match = pathname.match(/^\/brands\/([^/]+)(?:\/([^/]+))?/);
  const brandId = match?.[1] ?? fallbackBrandId;
  if (!brandId) return null;
  const active = match?.[2] ?? null;
  return (
    <nav aria-label="Seções" className="flex h-full items-stretch gap-1">
      {TABS.map((t) => {
        const isActive = active === t.slug;
        return (
          <Link
            key={t.slug}
            href={`/brands/${brandId}/${t.slug}`}
            aria-current={isActive ? "page" : undefined}
            className={`flex items-center whitespace-nowrap border-b-2 px-3 text-sm transition-colors ${
              isActive ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
