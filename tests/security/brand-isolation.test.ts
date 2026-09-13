/**
 * Cross-cutting brand isolation checks: a user with membership on brand A must not be able to read or mutate
 * brand B through any authorization helper or service, including with guessed or malformed identifiers.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { alerts, reportVersions } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import {
  ForbiddenError,
  NotFoundError,
  listAccessibleBrands,
  requireAccountInBrand,
  requireAlertAccess,
  requireBrandRole,
  requireReportAccess,
} from "@/server/auth/authz";
import {
  addMember,
  changeRole,
  listMembers,
  mapAccountToBrand,
  removeMember,
  setAccountIgnored,
  updateBrand,
  updatePostingSchedule,
} from "@/server/brands/service";
import { listConnections } from "@/server/connections/service";
import { insertAccount, insertBrand, insertConnection, insertUser, type TestUser } from "./fixtures";

let db: Db;
let close: () => Promise<void>;
let ownerA: TestUser, viewerA: TestUser, managerB: TestUser, admin: TestUser;
let brandA: string, brandB: string;
let accountA: string, accountB: string;
let reportB: string, alertB: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ownerA = await insertUser(db);
  viewerA = await insertUser(db);
  managerB = await insertUser(db);
  admin = await insertUser(db, { admin: true });
  brandA = await insertBrand(db, "Brand A", [
    [ownerA.id, "owner"],
    [viewerA.id, "viewer"],
  ]);
  brandB = await insertBrand(db, "Brand B", [[managerB.id, "manager"]]);
  const conn = await insertConnection(db);
  accountA = await insertAccount(db, conn, brandA, "a");
  accountB = await insertAccount(db, conn, brandB, "b");
  const [r] = await db
    .insert(reportVersions)
    .values({ brandId: brandB, periodStart: "2026-09-07", periodEnd: "2026-09-13", version: 1, trigger: "manual", locale: "pt-BR", timezone: "UTC" })
    .returning({ id: reportVersions.id });
  reportB = r!.id;
  const [al] = await db
    .insert(alerts)
    .values({ brandId: brandB, socialAccountId: accountB, type: "queue", severity: "critical", dedupeKey: `b:${randomUUID()}`, title: "t", suggestedAction: "a" })
    .returning({ id: alerts.id });
  alertB = al!.id;
});
afterAll(async () => close());

const GUESSES = () => [randomUUID(), "00000000-0000-0000-0000-000000000000", "1", "../brandB", "' OR '1'='1", "%", ""];

describe("reads across brands", () => {
  it("owner of A sees only A", async () => {
    expect((await listAccessibleBrands(db, ownerA.id)).map((b) => b.id)).toEqual([brandA]);
    await expect(requireBrandRole(db, ownerA, brandB, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, ownerA, accountB, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, ownerA, accountB, "viewer", { brandId: brandA })).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, ownerA, accountA, "viewer", { brandId: brandB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireReportAccess(db, ownerA, reportB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAlertAccess(db, ownerA, alertB, "viewer")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("guessed or malformed ids are indistinguishable from other brands' ids", async () => {
    for (const id of GUESSES()) {
      await expect(requireBrandRole(db, ownerA, id, "viewer")).rejects.toBeInstanceOf(NotFoundError);
      await expect(requireAccountInBrand(db, ownerA, id, "viewer")).rejects.toBeInstanceOf(NotFoundError);
      await expect(requireReportAccess(db, ownerA, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(requireAlertAccess(db, ownerA, id, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("workspace admins without membership cannot read brand data", async () => {
    await expect(requireBrandRole(db, admin, brandA, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, admin, accountA, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireReportAccess(db, admin, reportB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAlertAccess(db, admin, alertB, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    expect(await listAccessibleBrands(db, admin.id)).toEqual([]);
  });
});

describe("mutations", () => {
  it("viewers cannot mutate their own brand", async () => {
    await expect(updateBrand(db, viewerA, brandA, { name: "Hacked" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePostingSchedule(db, viewerA, accountA, { horizonDays: 30 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addMember(db, viewerA, brandA, { userId: managerB.id, role: "owner" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeRole(db, viewerA, brandA, viewerA.id, "owner")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(db, viewerA, brandA, ownerA.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireAlertAccess(db, viewerA, (await seedAlert(brandA)).id, "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listConnections(db, viewerA)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("members of A cannot mutate B, and managers cannot manage members", async () => {
    await expect(updateBrand(db, ownerA, brandB, { name: "Hacked" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updatePostingSchedule(db, ownerA, accountB, { horizonDays: 30 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addMember(db, ownerA, brandB, { userId: ownerA.id, role: "owner" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listMembers(db, ownerA, brandB)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listMembers(db, managerB, brandB)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addMember(db, managerB, brandB, { userId: ownerA.id, role: "viewer" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("mapping cannot move accounts across brands the actor cannot manage", async () => {
    await expect(mapAccountToBrand(db, ownerA, accountB, brandA)).rejects.toBeInstanceOf(ForbiddenError);
    const adminOwnsA = await insertBrand(db, "Admin brand", [[admin.id, "owner"]]);
    await expect(mapAccountToBrand(db, admin, accountB, adminOwnsA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(mapAccountToBrand(db, admin, accountB, null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setAccountIgnored(db, admin, accountB, true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, managerB, accountB, "manager")).resolves.toMatchObject({ brandId: brandB });
  });
});

async function seedAlert(brandId: string) {
  const [row] = await db
    .insert(alerts)
    .values({ brandId, type: "queue", severity: "info", dedupeKey: `x:${randomUUID()}`, title: "t", suggestedAction: "a" })
    .returning({ id: alerts.id });
  return row!;
}
