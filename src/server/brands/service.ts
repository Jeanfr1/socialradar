/**
 * Brands, memberships, account mapping, posting schedules and users. Server-only.
 * Every function authorizes the actor first (see src/server/auth/authz.ts) and audits every mutation.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import {
  type Actor,
  type BrandRole,
  type BrandRow,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
  isUuid,
  parseInput,
  requireBrandRole,
  requireAccountInBrand,
  requireWorkspaceAdmin,
} from "@/server/auth/authz";
import { normalizeEmail, revokeAllUserSessions } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import {
  alerts,
  brands,
  cadenceMode,
  membershipRole,
  memberships,
  postingSchedules,
  slotMatchMode,
  socialAccounts,
  users,
} from "@/server/db/schema";
import { checkPasswordPolicy, hashPassword } from "@/server/security/password";

export const REPORT_LOCALES = ["pt-BR", "en-US", "es-ES"] as const;
type Tx = Db;
const asDb = (tx: unknown) => tx as Tx;

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z.string().trim().max(64).refine(isValidTimeZone, "Unknown time zone. Use an IANA name such as America/Sao_Paulo.");
const brandFields = {
  name: z.string().trim().min(1, "Brand name is required.").max(80, "Brand name is too long."),
  logoUrl: z
    .url({ protocol: /^https?$/, error: "Logo URL must be an http(s) URL." })
    .max(2048)
    .nullable(),
  timezone: timezoneSchema,
  reportLocale: z.enum(REPORT_LOCALES, { error: "Report language must be pt-BR, en-US or es-ES." }),
  businessGoals: z.string().trim().max(2000).nullable(),
  contentPillars: z
    .array(z.string().trim().min(1).max(60))
    .max(20, "At most 20 content pillars.")
    .transform((list) => [...new Set(list)]),
  reportSchedule: z
    .object({
      enabled: z.boolean(),
      dayOfWeek: z.number().int().min(1).max(7),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
};
const createBrandSchema = z.object(brandFields).partial().required({ name: true }).strict();
const updateBrandSchema = z.object(brandFields).partial().strict();
export type CreateBrandInput = z.input<typeof createBrandSchema>;
export type UpdateBrandInput = z.input<typeof updateBrandSchema>;

const roleSchema = z.enum(membershipRole.enumValues, { error: "Role must be owner, manager or viewer." });
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const postingScheduleObject = z
  .object({
    mode: z.enum(cadenceMode.enumValues),
    slots: z
      .array(
        z
          .object({
            day: weekdaySchema,
            paused: z.boolean(),
            times: z
              .array(z.string().regex(HHMM, "Times must use HH:MM (24-hour)."))
              .max(24, "At most 24 times per day.")
              .transform((t) => [...new Set(t)].sort()),
          })
          .strict(),
      )
      .max(7)
      .refine((days) => new Set(days.map((d) => d.day)).size === days.length, "Each weekday can appear only once."),
    postsPerWeek: z.number().int().min(1).max(100).nullable(),
    timezone: timezoneSchema.nullable(),
    matchMode: z.enum(slotMatchMode.enumValues),
    matchToleranceMinutes: z.number().int().min(5).max(720),
    horizonDays: z.number().int().min(1, "Horizon must be 1–60 days.").max(60, "Horizon must be 1–60 days."),
    warningDays: z.number().int().min(1).max(60),
    criticalDays: z.number().int().min(1, "Critical threshold must be at least 1 day.").max(60),
    staleAfterMinutes: z.number().int().min(15).max(10_080),
  })
  .strict();

export const postingScheduleSchema = postingScheduleObject.superRefine((v, ctx) => {
  if (v.warningDays <= v.criticalDays) {
    ctx.addIssue({ code: "custom", path: ["warningDays"], message: "Warning threshold must be greater than the critical threshold." });
  }
  if (v.warningDays > v.horizonDays) {
    ctx.addIssue({ code: "custom", path: ["warningDays"], message: "Warning threshold cannot exceed the horizon." });
  }
  if (v.mode === "irregular" && v.postsPerWeek === null) {
    ctx.addIssue({ code: "custom", path: ["postsPerWeek"], message: "Posts per week is required for irregular cadence." });
  }
  if (v.mode === "custom" && !v.slots.some((d) => !d.paused && d.times.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["slots"], message: "Add at least one posting time for a custom cadence." });
  }
});
export type PostingScheduleInput = z.input<typeof postingScheduleObject>;

export const DEFAULT_POSTING_SCHEDULE: z.output<typeof postingScheduleObject> = {
  mode: "provider_schedule",
  slots: [],
  postsPerWeek: null,
  timezone: null,
  matchMode: "same_day",
  matchToleranceMinutes: 90,
  horizonDays: 14,
  warningDays: 7,
  criticalDays: 3,
  staleAfterMinutes: 360,
};

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------
function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "brand";
}

/** Workspace admin only. The creator becomes the brand owner. */
export async function createBrand(db: Db, actor: Actor, input: CreateBrandInput): Promise<BrandRow> {
  requireWorkspaceAdmin(actor);
  const data = parseInput(createBrandSchema, input);
  const base = slugify(data.name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      return await db.transaction(async (tx) => {
        const [brand] = await tx
          .insert(brands)
          .values({ ...data, slug })
          .returning();
        if (!brand) throw new Error("insert returned no row");
        await tx.insert(memberships).values({ userId: actor.id, brandId: brand.id, role: "owner" });
        await recordAudit(asDb(tx), {
          actorUserId: actor.id,
          action: "brand_created",
          brandId: brand.id,
          targetType: "brand",
          targetId: brand.id,
          metadata: { name: brand.name, slug },
        });
        return brand;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new ConflictError("Could not generate a unique brand slug. Try a different name.");
}

/** Owner or manager. Updates brand profile, report locale/schedule, goals and pillars. */
export async function updateBrand(db: Db, actor: Actor, brandId: string, patch: UpdateBrandInput): Promise<BrandRow> {
  await requireBrandRole(db, actor, brandId, "manager");
  const data = parseInput(updateBrandSchema, patch);
  if (Object.keys(data).length === 0) throw new ValidationError("Nothing to update.");
  return db.transaction(async (tx) => {
    const [brand] = await tx
      .update(brands)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(brands.id, brandId))
      .returning();
    if (!brand) throw new NotFoundError();
    await recordAudit(asDb(tx), {
      actorUserId: actor.id,
      action: "brand_updated",
      brandId,
      targetType: "brand",
      targetId: brandId,
      metadata: { fields: Object.keys(data) },
    });
    return brand;
  });
}

/** Owner only. Archived brands disappear from default listings; data is kept. */
export async function setBrandArchived(db: Db, actor: Actor, brandId: string, archived: boolean): Promise<void> {
  await requireBrandRole(db, actor, brandId, "owner");
  await db.transaction(async (tx) => {
    await tx
      .update(brands)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(brands.id, brandId));
    await recordAudit(asDb(tx), {
      actorUserId: actor.id,
      action: "brand_updated",
      brandId,
      targetType: "brand",
      targetId: brandId,
      metadata: { archived },
    });
  });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
export interface BrandMember {
  userId: string;
  name: string;
  email: string;
  role: BrandRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  addedAt: Date;
}

/** Owner only. */
export async function listMembers(db: Db, actor: Actor, brandId: string): Promise<BrandMember[]> {
  await requireBrandRole(db, actor, brandId, "owner");
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      addedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.brandId, brandId))
    .orderBy(asc(users.name));
}

const addMemberSchema = z
  .object({
    userId: z.string().optional(),
    email: z.string().optional(),
    role: roleSchema,
  })
  .strict()
  .refine((v) => !!v.userId !== !!v.email, "Provide either a user id or an email.");

/** Owner only. Adds an existing active user to the brand. */
export async function addMember(
  db: Db,
  actor: Actor,
  brandId: string,
  input: { userId?: string; email?: string; role: BrandRole },
): Promise<BrandMember> {
  await requireBrandRole(db, actor, brandId, "owner");
  const data = parseInput(addMemberSchema, input);
  if (data.userId !== undefined && !isUuid(data.userId)) throw new NotFoundError("No active user found.");
  const [user] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(data.userId ? eq(users.id, data.userId) : eq(users.email, normalizeEmail(data.email ?? "")))
    .limit(1);
  if (!user?.isActive) throw new NotFoundError("No active user found.");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ userId: user.id, brandId, role: data.role });
      await recordAudit(asDb(tx), {
        actorUserId: actor.id,
        action: "member_added",
        brandId,
        targetType: "user",
        targetId: user.id,
        metadata: { role: data.role },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("This user is already a member of the brand.");
    throw err;
  }
  const members = await listMembers(db, actor, brandId);
  const added = members.find((m) => m.userId === user.id);
  if (!added) throw new NotFoundError();
  return added;
}

async function lockBrandMemberships(tx: Tx, brandId: string) {
  return tx
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.brandId, brandId))
    .for("update");
}

/** Owner only. A brand always keeps at least one owner. */
export async function changeRole(db: Db, actor: Actor, brandId: string, userId: string, role: BrandRole): Promise<void> {
  const nextRole = parseInput(roleSchema, role);
  await db.transaction(async (txRaw) => {
    const tx = asDb(txRaw);
    await requireBrandRole(tx, actor, brandId, "owner");
    const rows = await lockBrandMemberships(tx, brandId);
    const target = rows.find((r) => r.userId === userId);
    if (!target) throw new NotFoundError("Member not found.");
    if (target.role === nextRole) return;
    if (target.role === "owner" && rows.filter((r) => r.role === "owner").length <= 1) {
      throw new ValidationError("A brand must keep at least one owner.");
    }
    await tx
      .update(memberships)
      .set({ role: nextRole })
      .where(and(eq(memberships.brandId, brandId), eq(memberships.userId, userId)));
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: "member_role_changed",
      brandId,
      targetType: "user",
      targetId: userId,
      metadata: { from: target.role, to: nextRole },
    });
  });
}

/** Owner only. The last owner cannot be removed. */
export async function removeMember(db: Db, actor: Actor, brandId: string, userId: string): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = asDb(txRaw);
    await requireBrandRole(tx, actor, brandId, "owner");
    const rows = await lockBrandMemberships(tx, brandId);
    const target = rows.find((r) => r.userId === userId);
    if (!target) throw new NotFoundError("Member not found.");
    if (target.role === "owner" && rows.filter((r) => r.role === "owner").length <= 1) {
      throw new ValidationError("A brand must keep at least one owner.");
    }
    await tx.delete(memberships).where(and(eq(memberships.brandId, brandId), eq(memberships.userId, userId)));
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: "member_removed",
      brandId,
      targetType: "user",
      targetId: userId,
      metadata: { role: target.role },
    });
  });
}

// ---------------------------------------------------------------------------
// Account mapping & posting schedules
// ---------------------------------------------------------------------------
async function loadAccountForAdmin(db: Db, accountId: string) {
  if (!isUuid(accountId)) throw new NotFoundError("Account not found.");
  const [account] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)).limit(1);
  if (!account) throw new NotFoundError("Account not found.");
  return account;
}

/**
 * Maps (brandId) or unmaps (null) an account. Requires workspace admin AND manager/owner on the target brand, and
 * also on the brand the account currently belongs to (an admin cannot pull accounts out of brands they cannot manage).
 * Unresolved alerts of the account follow it to the new brand so old-brand members stop seeing them.
 */
export async function mapAccountToBrand(db: Db, actor: Actor, accountId: string, brandId: string | null): Promise<void> {
  requireWorkspaceAdmin(actor);
  const account = await loadAccountForAdmin(db, accountId);
  if (brandId !== null) await requireBrandRole(db, actor, brandId, "manager");
  if (account.brandId && account.brandId !== brandId) await requireBrandRole(db, actor, account.brandId, "manager");
  if (brandId !== null && account.removedAt) {
    throw new ValidationError("This channel is no longer returned by the provider and cannot be mapped.");
  }
  if (account.brandId === brandId && account.mappingStatus === (brandId ? "mapped" : "unmapped")) return;

  const now = new Date();
  await db.transaction(async (txRaw) => {
    const tx = asDb(txRaw);
    await tx
      .update(socialAccounts)
      .set({ brandId, mappingStatus: brandId ? "mapped" : "unmapped", updatedAt: now })
      .where(eq(socialAccounts.id, account.id));
    await tx
      .update(alerts)
      .set({ brandId, updatedAt: now })
      .where(and(eq(alerts.socialAccountId, account.id), ne(alerts.state, "resolved")));
    if (brandId) {
      await tx.insert(postingSchedules).values({ socialAccountId: account.id, updatedBy: actor.id }).onConflictDoNothing();
    }
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: brandId ? "account_mapped" : "account_unmapped",
      brandId: brandId ?? account.brandId,
      targetType: "social_account",
      targetId: account.id,
      metadata: { handle: account.handle, platform: account.platform, fromBrandId: account.brandId, toBrandId: brandId },
    });
  });
}

/** Workspace admin (plus manager on the current brand, if mapped). Ignored accounts are excluded from mapping lists. */
export async function setAccountIgnored(db: Db, actor: Actor, accountId: string, ignored: boolean): Promise<void> {
  requireWorkspaceAdmin(actor);
  const account = await loadAccountForAdmin(db, accountId);
  if (account.brandId) await requireBrandRole(db, actor, account.brandId, "manager");
  const now = new Date();
  await db.transaction(async (txRaw) => {
    const tx = asDb(txRaw);
    await tx
      .update(socialAccounts)
      .set({ brandId: ignored ? null : account.brandId, mappingStatus: ignored ? "ignored" : account.brandId ? "mapped" : "unmapped", updatedAt: now })
      .where(eq(socialAccounts.id, account.id));
    if (ignored && account.brandId) {
      await tx
        .update(alerts)
        .set({ brandId: null, updatedAt: now })
        .where(and(eq(alerts.socialAccountId, account.id), ne(alerts.state, "resolved")));
    }
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: "account_ignored",
      brandId: account.brandId,
      targetType: "social_account",
      targetId: account.id,
      metadata: { ignored, handle: account.handle },
    });
  });
}

/** Owner/manager of the account's brand. Partial input is merged over the stored (or default) schedule. */
export async function updatePostingSchedule(
  db: Db,
  actor: Actor,
  accountId: string,
  input: Partial<PostingScheduleInput>,
) {
  const { brandId } = await requireAccountInBrand(db, actor, accountId, "manager");
  const patch = parseInput(postingScheduleObject.partial(), input);
  const [current] = await db
    .select()
    .from(postingSchedules)
    .where(eq(postingSchedules.socialAccountId, accountId))
    .limit(1);
  const base = current
    ? Object.fromEntries(Object.keys(DEFAULT_POSTING_SCHEDULE).map((k) => [k, current[k as keyof typeof current]]))
    : DEFAULT_POSTING_SCHEDULE;
  const next = parseInput(postingScheduleSchema, { ...base, ...patch });
  const now = new Date();
  return db.transaction(async (txRaw) => {
    const tx = asDb(txRaw);
    const [row] = await tx
      .insert(postingSchedules)
      .values({ socialAccountId: accountId, ...next, updatedBy: actor.id, updatedAt: now })
      .onConflictDoUpdate({
        target: postingSchedules.socialAccountId,
        set: { ...next, updatedBy: actor.id, updatedAt: now },
      })
      .returning();
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: "settings_updated",
      brandId,
      targetType: "posting_schedule",
      targetId: accountId,
      metadata: { fields: Object.keys(patch), mode: next.mode },
    });
    return row!;
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  isWorkspaceAdmin: boolean;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const publicUserColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  isWorkspaceAdmin: users.isWorkspaceAdmin,
  isActive: users.isActive,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(320)),
    name: z.string().trim().min(1, "Name is required.").max(120),
    password: z.string({ error: "Password is required." }),
    isWorkspaceAdmin: z.boolean().default(false),
  })
  .strict();
export type CreateUserInput = z.input<typeof createUserSchema>;

async function insertUser(db: Db, actorUserId: string | null, input: CreateUserInput): Promise<PublicUser> {
  const data = parseInput(createUserSchema, input);
  const problems = checkPasswordPolicy(data.password, { email: data.email, name: data.name });
  if (problems.length) {
    throw new ValidationError(problems[0]!, problems.map((message) => ({ path: "password", message })));
  }
  const passwordHash = await hashPassword(data.password);
  try {
    return await db.transaction(async (txRaw) => {
      const tx = asDb(txRaw);
      const [user] = await tx
        .insert(users)
        .values({ email: data.email, name: data.name, passwordHash, isWorkspaceAdmin: data.isWorkspaceAdmin })
        .returning(publicUserColumns);
      if (!user) throw new Error("insert returned no row");
      await recordAudit(tx, {
        actorUserId: actorUserId ?? user.id,
        action: "user_created",
        targetType: "user",
        targetId: user.id,
        metadata: { isWorkspaceAdmin: user.isWorkspaceAdmin, via: actorUserId ? "settings" : "cli" },
      });
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("A user with this email already exists.");
    throw err;
  }
}

/** Workspace admin only. */
export async function createUser(db: Db, actor: Actor, input: CreateUserInput): Promise<PublicUser> {
  requireWorkspaceAdmin(actor);
  return insertUser(db, actor.id, input);
}

/** CLI/bootstrap only (scripts/create-owner.ts): no actor exists yet. Never call from request handlers. */
export async function createUserAsSystem(db: Db, input: CreateUserInput): Promise<PublicUser> {
  return insertUser(db, null, input);
}

/** Workspace admin only. */
export async function listUsers(db: Db, actor: Actor): Promise<PublicUser[]> {
  requireWorkspaceAdmin(actor);
  return db.select(publicUserColumns).from(users).orderBy(asc(users.name));
}

/** Workspace admin only. Deactivation revokes all sessions immediately; admins cannot deactivate themselves. */
export async function setUserActive(db: Db, actor: Actor, userId: string, active: boolean): Promise<void> {
  requireWorkspaceAdmin(actor);
  if (!isUuid(userId)) throw new NotFoundError("User not found.");
  if (userId === actor.id && !active) throw new ForbiddenError("You cannot deactivate your own account.");
  await db.transaction(async (txRaw) => {
    const tx = asDb(txRaw);
    const [row] = await tx
      .update(users)
      .set({ isActive: active, updatedAt: new Date(), ...(active ? { failedLoginCount: 0, lockedUntil: null } : {}) })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!row) throw new NotFoundError("User not found.");
    if (!active) await revokeAllUserSessions(tx, userId);
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: "user_updated",
      targetType: "user",
      targetId: userId,
      metadata: { isActive: active },
    });
  });
}

/** Oldest active workspace admin (used by scripts to pick a default actor). */
export async function findFirstWorkspaceAdmin(db: Db): Promise<{ id: string; email: string; isWorkspaceAdmin: boolean } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, isWorkspaceAdmin: users.isWorkspaceAdmin })
    .from(users)
    .where(and(eq(users.isWorkspaceAdmin, true), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row ?? null;
}
