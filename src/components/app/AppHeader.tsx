import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { BrandSwitcher } from "./BrandSwitcher";
import { MainTabs } from "./MainTabs";

export function AppHeader({
  brands,
  canSeeSettings,
  logoutAction,
}: {
  brands: { id: string; name: string }[];
  canSeeSettings: boolean;
  logoutAction: () => Promise<void>;
}) {
  const fallback = brands[0]?.id ?? null;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/portfolio" className="shrink-0 text-[15px] font-semibold tracking-tight text-ink">
          Social<span className="text-accent">Radar</span>
        </Link>
        <BrandSwitcher brands={brands} />
        <div className="hidden h-full md:block">
          <MainTabs fallbackBrandId={fallback} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {canSeeSettings ? (
            <Link href="/settings" className="rounded-lg p-2 text-ink-2 hover:bg-canvas hover:text-ink" title="Configurações">
              <Icon name="settings" className="h-5 w-5" />
              <span className="sr-only">Configurações</span>
            </Link>
          ) : null}
          <form action={logoutAction}>
            <button type="submit" className="rounded-lg p-2 text-ink-2 hover:bg-canvas hover:text-ink" title="Sair">
              <Icon name="logout" className="h-5 w-5" />
              <span className="sr-only">Sair</span>
            </button>
          </form>
        </div>
      </div>
      <div className="h-11 overflow-x-auto border-t border-line px-2 md:hidden">
        <MainTabs fallbackBrandId={fallback} />
      </div>
    </header>
  );
}
