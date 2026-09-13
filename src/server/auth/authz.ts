/**
 * Authorization primitives. Every brand-scoped read/write/export must go through one of the `require*` helpers.
 *
 * Rules
 * - Brand data requires a membership. Workspace admins manage connections/users/brand creation, but do NOT see a
 *   brand's data without a membership (creating a brand grants the creator an owner membership).
 * - Missing membership, unknown ids and malformed UUIDs all raise NotFoundError, so other brands' existence is
 *   never revealed. An insufficient role on a brand the user CAN see raises ForbiddenError.
 * Server-only.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "@/server/db/client";
import { alerts, brands, membershipRole, memberships, reportVersions, socialAccounts } from "@/server/db/schema";
import { getCurrentUser, type SessionUser } from "@/server/auth/session";

// ---------------------------------------------------------------------------
// Errors (safe, user-facing messages; never include secrets or other tenants' data)
// ---------------------------------------------------------------------------
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class AuthError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super("unauthenticated", 401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super("forbidden", 403, message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super("not_found", 404, message);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("conflict", 409, message);
  }
}
export class ValidationError extends AppError {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super("invalid_input", 422, message);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Validates input with zod; throws ValidationError carrying only paths and messages (never the input values). */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  throw new ValidationError(issues[0]?.message ?? "Invalid input.", issues);
}

/** PostgreSQL unique_violation (23505), also when wrapped by drizzle's DrizzleQueryError. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Identity & roles
// ---------------------------------------------------------------------------
export type BrandRole = (typeof membershipRole.enumValues)[number];
/** Minimal identity needed for authorization decisions (SessionUser satisfies it). */
export type Actor = Pick<SessionUser, "id" | "isWorkspaceAdmin">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const ROLE_RANK: Record<BrandRole, number> = { viewer: 1, manager: 2, owner: 3 };
export function roleAtLeast(role: BrandRole | null | undefined, min: BrandRole): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Current user or failure. `mode: "page"` redirects to /login (Server Components);
 * `mode: "action"` (default) throws AuthError (Server Actions, Route Handlers).
 */
export async function requireUser(mode: "page" | "action" = "action"): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (user) return user;
  if (mode === "page") {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  throw new AuthError();
}

export function requireWorkspaceAdmin(user: Actor | null | undefined): asserts user is Actor {
  if (!user) throw new AuthError();
  if (!user.isWorkspaceAdmin) throw new ForbiddenError("Only workspace administrators can do this.");
}

// ---------------------------------------------------------------------------
// Brand scope
// ---------------------------------------------------------------------------
export async function getBrandRole(db: Db, userId: string, brandId: string): Promise<BrandRole | null> {
  if (!isUuid(userId) || !isUuid(brandId)) return null;
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.brandId, brandId)))
    .limit(1);
  return row?.role ?? null;
}

export type BrandRow = typeof brands.$inferSelect;

/** Brand + caller's role. NotFoundError without membership (or bad UUID); ForbiddenError when the role is too low. */
export async function requireBrandRole(
  db: Db,
  user: Actor | null | undefined,
  brandId: string,
  min: BrandRole,
): Promise<{ brand: BrandRow; role: BrandRole }> {
  if (!user) throw new AuthError();
  if (!isUuid(brandId) || !isUuid(user.id)) throw new NotFoundError();
  const [row] = await db
    .select({ brand: brands, role: memberships.role })
    .from(brands)
    .innerJoin(memberships, and(eq(memberships.brandId, brands.id), eq(memberships.userId, user.id)))
    .where(eq(brands.id, brandId))
    .limit(1);
  if (!row) throw new NotFoundError();
  if (!roleAtLeast(row.role, min)) throw new ForbiddenError();
  return row;
}

export async function listAccessibleBrands(
  db: Db,
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<(BrandRow & { role: BrandRole })[]> {
  if (!isUuid(userId)) return [];
  const rows = await db
    .select({ brand: brands, role: memberships.role })
    .from(brands)
    .innerJoin(memberships, and(eq(memberships.brandId, brands.id), eq(memberships.userId, userId)))
    .where(opts.includeArchived ? undefined : isNull(brands.archivedAt))
    .orderBy(asc(brands.name));
  return rows.map((r) => ({ ...r.brand, role: r.role }));
}

export type SocialAccountRow = typeof socialAccounts.$inferSelect;

/**
 * Resolves an account only when it is mapped to a brand the user can access with at least `min`.
 * Pass `opts.brandId` (from the URL) to also require that the account belongs to that exact brand.
 */
export async function requireAccountInBrand(
  db: Db,
  user: Actor | null | undefined,
  accountId: string,
  min: BrandRole,
  opts: { brandId?: string } = {},
): Promise<{ account: SocialAccountRow; brandId: string; role: BrandRole }> {
  if (!user) throw new AuthError();
  if (!isUuid(accountId) || !isUuid(user.id)) throw new NotFoundError();
  const [row] = await db
    .select({ account: socialAccounts, role: memberships.role })
    .from(socialAccounts)
    .innerJoin(memberships, and(eq(memberships.brandId, socialAccounts.brandId), eq(memberships.userId, user.id)))
    .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.mappingStatus, "mapped")))
    .limit(1);
  const brandId = row?.account.brandId;
  if (!row || !brandId || (opts.brandId !== undefined && opts.brandId !== brandId)) throw new NotFoundError();
  if (!roleAtLeast(row.role, min)) throw new ForbiddenError();
  return { account: row.account, brandId, role: row.role };
}

export type ReportVersionRow = typeof reportVersions.$inferSelect;

/** Report version (in-app view, PDF/CSV export, regenerate) scoped to the caller's brand role. */
export async function requireReportAccess(
  db: Db,
  user: Actor | null | undefined,
  reportId: string,
  min: BrandRole = "viewer",
): Promise<{ report: ReportVersionRow; brandId: string; role: BrandRole }> {
  if (!user) throw new AuthError();
  if (!isUuid(reportId)) throw new NotFoundError();
  const [report] = await db.select().from(reportVersions).where(eq(reportVersions.id, reportId)).limit(1);
  if (!report) throw new NotFoundError();
  const { role } = await requireBrandRole(db, user, report.brandId, min);
  return { report, brandId: report.brandId, role };
}

export type AlertRow = typeof alerts.$inferSelect;

/** Alert scoped to the caller's brand role. Connection-level alerts (brandId null) require a workspace admin. */
export async function requireAlertAccess(
  db: Db,
  user: Actor | null | undefined,
  alertId: string,
  min: BrandRole,
): Promise<{ alert: AlertRow; brandId: string | null; role: BrandRole | null }> {
  if (!user) throw new AuthError();
  if (!isUuid(alertId)) throw new NotFoundError();
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) throw new NotFoundError();
  if (alert.brandId === null) {
    if (!user.isWorkspaceAdmin) throw new NotFoundError();
    return { alert, brandId: null, role: null };
  }
  const { role } = await requireBrandRole(db, user, alert.brandId, min);
  return { alert, brandId: alert.brandId, role };
}
