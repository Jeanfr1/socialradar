import { listAccessibleBrands, roleAtLeast, type BrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";

export interface ShellBrandVM {
  id: string;
  name: string;
  isDemo: boolean;
  role: BrandRole;
}

export interface ShellVM {
  user: { name: string; email: string; isWorkspaceAdmin: boolean };
  brands: ShellBrandVM[];
  /** Settings are hidden from users who are only viewers everywhere (and not workspace admins). */
  canSeeSettings: boolean;
}

export async function loadShell(db: Db, user: SessionUser): Promise<ShellVM> {
  const brands = await listAccessibleBrands(db, user.id);
  return {
    user: { name: user.name, email: user.email, isWorkspaceAdmin: user.isWorkspaceAdmin },
    brands: brands.map((b) => ({ id: b.id, name: b.name, isDemo: b.isDemo, role: b.role })),
    canSeeSettings: user.isWorkspaceAdmin || brands.some((b) => roleAtLeast(b.role, "manager")),
  };
}
