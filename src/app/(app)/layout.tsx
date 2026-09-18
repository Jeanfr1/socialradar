import { AppHeader } from "@/components/app/AppHeader";
import { logoutAction } from "@/server/actions/auth";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadShell } from "@/server/queries/pages/shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("page");
  const shell = await loadShell(getDb(), user);
  // Demo brands stay out of the way unless they are all the user has.
  const real = shell.brands.filter((b) => !b.isDemo);
  const brands = (real.length > 0 ? real : shell.brands).map((b) => ({ id: b.id, name: b.name }));
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only z-50 rounded bg-accent px-3 py-2 text-white focus:not-sr-only focus:fixed focus:left-2 focus:top-2">
        Pular para o conteúdo
      </a>
      <AppHeader brands={brands} canSeeSettings={shell.canSeeSettings} logoutAction={logoutAction} />
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
