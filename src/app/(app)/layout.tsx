import { SidebarNav } from "@/components/layout/SidebarNav";
import { logoutAction } from "@/server/actions/auth";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadShell } from "@/server/queries/pages/shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("page");
  const shell = await loadShell(getDb(), user);
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only z-50 rounded bg-accent px-3 py-2 text-white focus:not-sr-only focus:fixed focus:left-2 focus:top-2">
        Skip to content
      </a>
      <SidebarNav
        brands={shell.brands.map((b) => ({ id: b.id, name: b.name, isDemo: b.isDemo }))}
        canSeeSettings={shell.canSeeSettings}
        isWorkspaceAdmin={shell.user.isWorkspaceAdmin}
        userName={shell.user.name}
        logoutAction={logoutAction}
      />
      <div className="lg:pl-60">
        <main id="main" className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
