"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

export interface SidebarBrand {
  id: string;
  name: string;
  isDemo: boolean;
}

interface NavLinkProps {
  href: string;
  label: string;
  icon?: IconName;
  active: boolean;
  nested?: boolean;
  badge?: React.ReactNode;
}

function NavLink({ href, label, icon, active, nested, badge }: NavLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-10 items-center gap-2 rounded-md px-2.5 text-sm ${nested ? "pl-8" : ""} ${
        active ? "bg-accent-soft font-semibold text-accent" : "text-ink hover:bg-canvas"
      }`}
    >
      {icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </Link>
  );
}

const BRAND_SECTIONS: { suffix: string; label: string }[] = [
  { suffix: "", label: "Dashboard" },
  { suffix: "/calendar", label: "Calendário" },
  { suffix: "/content", label: "Conteúdo" },
  { suffix: "/recommendations", label: "Recomendações" },
  { suffix: "/reports", label: "Relatórios" },
];

export function SidebarNav({
  brands,
  canSeeSettings,
  isWorkspaceAdmin,
  userName,
  logoutAction,
}: {
  brands: SidebarBrand[];
  canSeeSettings: boolean;
  isWorkspaceAdmin: boolean;
  userName: string;
  logoutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const activeBrandId = /^\/brands\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const is = (href: string) => pathname === href;
  const starts = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav aria-label="Principal" className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div className="px-2.5 pt-1">
        <Link href="/portfolio" className="text-lg font-semibold tracking-tight text-ink">
          BrandPulse
        </Link>
        <p className="text-xs text-ink-2">Monitoramento somente leitura</p>
      </div>
      <ul className="space-y-0.5">
        <li>
          <NavLink href="/portfolio" label="Portfólio" icon="grid" active={is("/portfolio")} />
        </li>
        <li>
          <NavLink href="/alerts" label="Alertas" icon="bell" active={starts("/alerts")} />
        </li>
      </ul>
      <div>
        <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-2" id="nav-brands">
          Marcas
        </p>
        {brands.length === 0 ? (
          <p className="px-2.5 text-xs text-ink-2">Nenhuma marca atribuída.</p>
        ) : (
          <ul aria-labelledby="nav-brands" className="space-y-0.5">
            {brands.map((b) => {
              const base = `/brands/${b.id}`;
              const expanded = activeBrandId === b.id;
              return (
                <li key={b.id}>
                  <NavLink
                    href={base}
                    label={b.name}
                    active={is(base)}
                    badge={
                      b.isDemo ? (
                        <span className="rounded-full border border-demo/50 bg-demo-soft px-1.5 text-[10px] font-semibold text-demo">Demo</span>
                      ) : null
                    }
                  />
                  {expanded ? (
                    <ul className="mt-0.5 space-y-0.5" aria-label={`Seções de ${b.name}`}>
                      {BRAND_SECTIONS.slice(1).map((s) => (
                        <li key={s.suffix}>
                          <NavLink href={`${base}${s.suffix}`} label={s.label} nested active={starts(`${base}${s.suffix}`)} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {canSeeSettings ? (
        <div>
          <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-2" id="nav-settings">
            Configurações
          </p>
          <ul aria-labelledby="nav-settings" className="space-y-0.5">
            <li>
              <NavLink href="/settings/brands" label="Marcas e cadência" icon="settings" active={starts("/settings/brands")} />
            </li>
            {isWorkspaceAdmin ? (
              <>
                <li>
                  <NavLink href="/settings/connections" label="Conexões" icon="unlink" active={starts("/settings/connections")} />
                </li>
                <li>
                  <NavLink href="/settings/users" label="Usuários e perfis" icon="user" active={starts("/settings/users")} />
                </li>
                <li>
                  <NavLink href="/settings/system" label="Saúde do sistema" icon="database" active={starts("/settings/system")} />
                </li>
              </>
            ) : null}
          </ul>
        </div>
      ) : null}
      <div className="mt-auto border-t border-line pt-3">
        <p className="truncate px-2.5 text-sm font-medium text-ink" title={userName}>
          {userName}
        </p>
        <form action={logoutAction}>
          <button type="submit" className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-sm text-ink hover:bg-canvas">
            <Icon name="logout" />
            Sair
          </button>
        </form>
      </div>
    </nav>
  );

  return (
    <>
      <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface px-3 lg:hidden">
        <button
          type="button"
          className="btn btn-secondary px-2.5"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "close" : "menu"} className="h-5 w-5" />
          <span className="sr-only">{open ? "Fechar navegação" : "Abrir navegação"}</span>
        </button>
        <Link href="/portfolio" className="font-semibold">
          BrandPulse
        </Link>
      </div>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Fechar navegação" className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div id="mobile-nav" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-xl">
            {nav}
          </div>
        </div>
      ) : null}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 border-r border-line bg-surface lg:block">{nav}</aside>
    </>
  );
}
