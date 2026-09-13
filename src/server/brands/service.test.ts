import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { alerts, auditEvents, memberships, postingSchedules, sessions, socialAccounts, users } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/auth/authz";
import { createSession } from "@/server/auth/session";
import { insertAccount, insertBrand, insertConnection, insertUser, type TestUser } from "../../../tests/security/fixtures";
import {
  addMember,
  changeRole,
  createBrand,
  createUser,
  createUserAsSystem,
  isValidTimeZone,
  listMembers,
  listUsers,
  mapAccountToBrand,
  removeMember,
  setAccountIgnored,
  setBrandArchived,
  setUserActive,
  updateBrand,
  updatePostingSchedule,
} from "./service";

let db: Db;
let close: () => Promise<void>;
let admin: TestUser, manager: TestUser, viewer: TestUser, other: TestUser;
let brandId: string;
let connectionId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await insertUser(db, { admin: true });
  manager = await insertUser(db);
  viewer = await insertUser(db);
  other = await insertUser(db);
  connectionId = await insertConnection(db);
  const brand = await createBrand(db, admin, { name: "Café Norte" });
  brandId = brand.id;
  await addMember(db, admin, brandId, { userId: manager.id, role: "manager" });
  await addMember(db, admin, brandId, { email: viewer.email.toUpperCase(), role: "viewer" });
});
afterAll(async () => close());

describe("brands", () => {
  it("createBrand: admin only, creator becomes owner, unique slugs, audited", async () => {
    await expect(createBrand(db, manager, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
    const a = await createBrand(db, admin, { name: "Café Norte" });
    const [base] = await db.select().from(memberships).where(and(eq(memberships.brandId, a.id), eq(memberships.userId, admin.id)));
    expect(base!.role).toBe("owner");
    expect(a.slug).toBe("cafe-norte-2");
    const events = await db.select().from(auditEvents).where(eq(auditEvents.brandId, a.id));
    expect(events.map((e) => e.action)).toContain("brand_created");
  });

  it("updateBrand: manager allowed, viewer forbidden, outsiders not found, input validated", async () => {
    const updated = await updateBrand(db, manager, brandId, {
      timezone: "Europe/Paris",
      reportLocale: "en-US",
      contentPillars: ["Education", "Education", "Behind the scenes"],
      reportSchedule: { enabled: true, dayOfWeek: 1, hour: 9, minute: 30 },
      logoUrl: "https://cdn.example.com/logo.png",
    });
    expect(updated).toMatchObject({ timezone: "Europe/Paris", reportLocale: "en-US", contentPillars: ["Education", "Behind the scenes"] });
    await expect(updateBrand(db, viewer, brandId, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateBrand(db, other, brandId, { name: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateBrand(db, manager, brandId, { timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateBrand(db, manager, brandId, { reportLocale: "fr-FR" as "en-US" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateBrand(db, manager, brandId, { logoUrl: "javascript:alert(1)" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateBrand(db, manager, brandId, { reportSchedule: { enabled: true, dayOfWeek: 8, hour: 0, minute: 0 } })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateBrand(db, manager, brandId, { slug: "hijack" } as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(setBrandArchived(db, manager, brandId, true)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("validates IANA time zones", () => {
    expect(isValidTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("+01:00")).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});

describe("members", () => {
  it("owner-only membership management with last-owner protection", async () => {
    await expect(listMembers(db, manager, brandId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addMember(db, manager, brandId, { userId: other.id, role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
    const members = await listMembers(db, admin, brandId);
    expect(members.map((m) => m.role).sort()).toEqual(["manager", "owner", "viewer"]);
    expect(JSON.stringify(members)).not.toContain("passwordHash");

    await expect(addMember(db, admin, brandId, { userId: viewer.id, role: "viewer" })).rejects.toBeInstanceOf(ConflictError);
    await expect(addMember(db, admin, brandId, { email: "ghost@example.test", role: "viewer" })).rejects.toBeInstanceOf(NotFoundError);

    await expect(changeRole(db, admin, brandId, admin.id, "manager")).rejects.toThrow(/at least one owner/);
    await expect(removeMember(db, admin, brandId, admin.id)).rejects.toThrow(/at least one owner/);
    await changeRole(db, admin, brandId, manager.id, "owner");
    await changeRole(db, manager, brandId, admin.id, "manager");
    await expect(removeMember(db, manager, brandId, manager.id)).rejects.toThrow(/at least one owner/);
    await changeRole(db, manager, brandId, admin.id, "owner");
    await changeRole(db, admin, brandId, manager.id, "manager");

    const temp = await insertUser(db);
    await addMember(db, admin, brandId, { userId: temp.id, role: "viewer" });
    await removeMember(db, admin, brandId, temp.id);
    await expect(removeMember(db, admin, brandId, temp.id)).rejects.toBeInstanceOf(NotFoundError);
    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.brandId, brandId))).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member_added", "member_role_changed", "member_removed"]));
  });
});

describe("account mapping and posting schedules", () => {
  it("mapAccountToBrand requires admin + manager on target and source brands", async () => {
    const accountId = await insertAccount(db, connectionId, null, "map-me");
    await expect(mapAccountToBrand(db, manager, accountId, brandId)).rejects.toBeInstanceOf(ForbiddenError);

    const foreign = await insertBrand(db, "Foreign", [[other.id, "owner"]]);
    await expect(mapAccountToBrand(db, admin, accountId, foreign)).rejects.toBeInstanceOf(NotFoundError);

    await mapAccountToBrand(db, admin, accountId, brandId);
    const [account] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId));
    expect(account).toMatchObject({ brandId, mappingStatus: "mapped" });
    const [schedule] = await db.select().from(postingSchedules).where(eq(postingSchedules.socialAccountId, accountId));
    expect(schedule).toMatchObject({ mode: "provider_schedule", horizonDays: 14, warningDays: 7, criticalDays: 3 });

    const foreignAccount = await insertAccount(db, connectionId, foreign, "foreign");
    await expect(mapAccountToBrand(db, admin, foreignAccount, brandId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(mapAccountToBrand(db, admin, "nope", brandId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("unresolved alerts follow the account; unmapping and ignoring are audited", async () => {
    const accountId = await insertAccount(db, connectionId, brandId, "alerts");
    const second = await createBrand(db, admin, { name: "Second" });
    const [open] = await db
      .insert(alerts)
      .values({ brandId, socialAccountId: accountId, type: "queue", severity: "warning", dedupeKey: `q:${accountId}`, title: "t", suggestedAction: "a" })
      .returning({ id: alerts.id });
    await mapAccountToBrand(db, admin, accountId, second.id);
    const [moved] = await db.select().from(alerts).where(eq(alerts.id, open!.id));
    expect(moved!.brandId).toBe(second.id);

    await mapAccountToBrand(db, admin, accountId, null);
    const [unmapped] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId));
    expect(unmapped).toMatchObject({ brandId: null, mappingStatus: "unmapped" });

    await setAccountIgnored(db, admin, accountId, true);
    expect((await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0]!.mappingStatus).toBe("ignored");
    await setAccountIgnored(db, admin, accountId, false);
    expect((await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId)))[0]!.mappingStatus).toBe("unmapped");
    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.targetId, accountId))).map((e) => e.action);
    expect(actions).toEqual(["account_mapped", "account_unmapped", "account_ignored", "account_ignored"]);
  });

  it("updatePostingSchedule validates thresholds, times and modes; viewers cannot edit", async () => {
    const accountId = await insertAccount(db, connectionId, brandId, "schedule");
    await expect(updatePostingSchedule(db, viewer, accountId, { horizonDays: 20 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePostingSchedule(db, other, accountId, { horizonDays: 20 })).rejects.toBeInstanceOf(NotFoundError);
    for (const bad of [
      { horizonDays: 0 },
      { horizonDays: 61 },
      { warningDays: 3, criticalDays: 3 },
      { criticalDays: 0 },
      { warningDays: 20 },
      { mode: "custom" as const },
      { mode: "irregular" as const },
      { mode: "custom" as const, slots: [{ day: "mon" as const, paused: false, times: ["25:00"] }] },
      { slots: [{ day: "mon" as const, paused: false, times: ["09:00"] }, { day: "mon" as const, paused: false, times: ["10:00"] }] },
      { timezone: "Nowhere/City" },
      { unknownField: 1 } as never,
    ]) {
      await expect(updatePostingSchedule(db, manager, accountId, bad), JSON.stringify(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    const saved = await updatePostingSchedule(db, manager, accountId, {
      mode: "custom",
      slots: [{ day: "tue", paused: false, times: ["18:00", "09:30", "18:00"] }],
      timezone: "America/Sao_Paulo",
      horizonDays: 21,
      warningDays: 10,
      criticalDays: 4,
    });
    expect(saved).toMatchObject({ mode: "custom", horizonDays: 21, warningDays: 10, criticalDays: 4, updatedBy: manager.id });
    expect(saved.slots).toEqual([{ day: "tue", paused: false, times: ["09:30", "18:00"] }]);
    const merged = await updatePostingSchedule(db, manager, accountId, { matchMode: "time_window", matchToleranceMinutes: 60 });
    expect(merged).toMatchObject({ mode: "custom", horizonDays: 21, matchMode: "time_window" });
  });
});

describe("users", () => {
  it("createUser: admin only, password policy, normalized unique email, safe DTO", async () => {
    const input = { email: "  New.Person@Example.TEST ", name: "New Person", password: "a-long-enough-passphrase" };
    await expect(createUser(db, manager, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createUser(db, admin, { ...input, password: "short" })).rejects.toThrow(/at least 12/);
    const user = await createUser(db, admin, input);
    expect(user.email).toBe("new.person@example.test");
    expect(JSON.stringify(user)).not.toMatch(/password/i);
    await expect(createUserAsSystem(db, { ...input, email: "new.person@example.test" })).rejects.toBeInstanceOf(ConflictError);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect((await listUsers(db, admin)).some((u) => u.id === user.id)).toBe(true);
    await expect(listUsers(db, manager)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deactivation revokes sessions; admins cannot deactivate themselves", async () => {
    const user = await insertUser(db);
    await createSession(db, user.id, "test");
    await expect(setUserActive(db, admin, admin.id, false)).rejects.toBeInstanceOf(ForbiddenError);
    await setUserActive(db, admin, user.id, false);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    await expect(setUserActive(db, manager, user.id, true)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
