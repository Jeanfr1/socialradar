"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function BrandTabs({ brandId, canManage }: { brandId: string; canManage: boolean }) {
  const pathname = usePathname();
  const base = `/brands/${brandId}`;
  const tabs = [
    { href: base, label: "Dashboard", match: (p: string) => p === base || p.startsWith(`${base}/accounts`) },
    { href: `${base}/calendar`, label: "Calendar" },
    { href: `${base}/content`, label: "Content" },
    { href: `${base}/recommendations`, label: "Recommendations" },
    { href: `${base}/reports`, label: "Reports" },
    ...(canManage ? [{ href: `/settings/brands/${brandId}`, label: "Settings" }] : []),
  ];
  return (
    <nav aria-label="Brand sections" className="-mx-1 mb-5 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1 px-1">
        {tabs.map((t) => {
          const active = "match" in t && t.match ? t.match(pathname) : pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-10 items-center border-b-2 px-3 text-sm ${
                  active ? "border-accent font-semibold text-accent" : "border-transparent text-ink-2 hover:text-ink"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
