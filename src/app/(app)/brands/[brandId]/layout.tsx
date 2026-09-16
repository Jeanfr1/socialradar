import { BrandTabs } from "@/components/layout/BrandTabs";
import { DemoBadge, DemoBanner } from "@/components/ui/Demo";
import { Pill } from "@/components/ui/StatusBadge";
import { requireBrandRole, requireUser, roleAtLeast } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { zoneLabel } from "@/server/queries/pages/format";
import { orNotFound } from "@/server/queries/pages/guard";

const ROLE_LABEL: Record<string, string> = { owner: "Proprietário", manager: "Gerente", viewer: "Visualizador" };

export default async function BrandLayout({ children, params }: { children: React.ReactNode; params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const user = await requireUser("page");
  const { brand, role } = await orNotFound(requireBrandRole(getDb(), user, brandId, "viewer"));
  return (
    <div>
      {brand.isDemo ? <DemoBanner scope={`${brand.name} é uma marca de demonstração com dados fictícios. Nenhuma conta real está conectada nesta visualização.`} /> : null}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <span className="text-base font-semibold text-ink">{brand.name}</span>
        {brand.isDemo ? <DemoBadge /> : null}
        {brand.archivedAt ? <Pill tone="warning">Arquivada</Pill> : null}
        <Pill>{ROLE_LABEL[role] ?? role}</Pill>
        <span>
          Horários em {brand.timezone} ({zoneLabel(new Date(), brand.timezone)})
        </span>
      </div>
      <BrandTabs brandId={brand.id} canManage={roleAtLeast(role, "manager")} />
      {children}
    </div>
  );
}
