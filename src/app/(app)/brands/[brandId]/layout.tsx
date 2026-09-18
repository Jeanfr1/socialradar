import { DemoBanner } from "@/components/ui/Demo";
import { requireBrandRole, requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { orNotFound } from "@/server/queries/pages/guard";

export default async function BrandLayout({ children, params }: { children: React.ReactNode; params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const user = await requireUser("page");
  const { brand } = await orNotFound(requireBrandRole(getDb(), user, brandId, "viewer"));
  return (
    <>
      {brand.isDemo ? <DemoBanner scope={`${brand.name} é uma marca de demonstração com dados fictícios.`} /> : null}
      {children}
    </>
  );
}
