"use client";

import { usePathname, useRouter } from "next/navigation";

const TABS = ["calendar", "metrics", "reports", "recommendations"] as const;

/** Brand selector: keeps the current tab when switching brands. */
export function BrandSwitcher({ brands }: { brands: { id: string; name: string }[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const match = pathname.match(/^\/brands\/([^/]+)(?:\/([^/]+))?/);
  const current = match?.[1] ?? "";
  const tab = TABS.find((t) => t === match?.[2]) ?? "calendar";
  if (brands.length === 0) return null;
  return (
    <label className="relative flex items-center">
      <span className="sr-only">Marca</span>
      <select
        value={brands.some((b) => b.id === current) ? current : ""}
        onChange={(e) => e.target.value && router.push(`/brands/${e.target.value}/${tab}`)}
        className="h-9 max-w-[14rem] cursor-pointer appearance-none truncate rounded-lg border border-line bg-surface py-0 pl-3 pr-8 text-sm font-medium text-ink hover:border-line-strong"
      >
        {!brands.some((b) => b.id === current) ? (
          <option value="" disabled>
            Escolher marca
          </option>
        ) : null}
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-2">
        <path fill="currentColor" d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fillOpacity="0" />
      </svg>
    </label>
  );
}
