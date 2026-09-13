import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { alerts, brands, reportVersions } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import { insertAccount, insertBrand, insertConnection, insertUser, type TestUser } from "../../../tests/security/fixtures";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  getBrandRole,
  isUniqueViolation,
  isUuid,
  listAccessibleBrands,
  parseInput,
  requireAccountInBrand,
  requireAlertAccess,
  requireBrandRole,
  requireReportAccess,
  requireWorkspaceAdmin,
  roleAtLeast,
} from "./authz";
import { z } from "zod";
import { eq } from "drizzle-orm";

let db: Db;
let close: () => Promise<void>;
let owner: TestUser, viewer: TestUser, outsider: TestUser, admin: TestUser;
let brandA: string, brandB: string, archived: string;
let accountA: string, accountB: string, unmapped: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  owner = await insertUser(db);
  viewer = await insertUser(db);
  outsider = await insertUser(db);
  admin = await insertUser(db, { admin: true });
  brandA = await insertBrand(db, "Alpha", [
    [owner.id, "owner"],
    [viewer.id, "viewer"],
  ]);
  brandB = await insertBrand(db, "Beta", [[outsider.id, "owner"]]);
  archived = await insertBrand(db, "Zulu Archived", [[owner.id, "owner"]]);
  await db.update(brands).set({ archivedAt: new Date() }).where(eq(brands.id, archived));
  const conn = await insertConnection(db);
  accountA = await insertAccount(db, conn, brandA, "alpha");
  accountB = await insertAccount(db, conn, brandB, "beta");
  unmapped = await insertAccount(db, conn, null, "loose");
});
afterAll(async () => close());

describe("roles", () => {
  it("orders viewer < manager < owner", () => {
    expect(roleAtLeast("owner", "manager")).toBe(true);
    expect(roleAtLeast("manager", "manager")).toBe(true);
    expect(roleAtLeast("viewer", "manager")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
  });

  it("validates UUIDs strictly", () => {
    expect(isUuid(randomUUID())).toBe(true);
    for (const bad of ["", "1", "../etc", "' OR 1=1 --", `${randomUUID()} `, null, 42]) expect(isUuid(bad)).toBe(false);
  });
});

describe("brand access", () => {
  it("returns the membership role", async () => {
    expect(await getBrandRole(db, owner.id, brandA)).toBe("owner");
    expect(await getBrandRole(db, viewer.id, brandA)).toBe("viewer");
    expect(await getBrandRole(db, outsider.id, brandA)).toBeNull();
    expect(await getBrandRole(db, owner.id, "not-a-uuid")).toBeNull();
  });

  it("requireBrandRole: NotFound without membership, Forbidden when role too low", async () => {
    await expect(requireBrandRole(db, owner, brandA, "owner")).resolves.toMatchObject({ role: "owner" });
    await expect(requireBrandRole(db, viewer, brandA, "viewer")).resolves.toMatchObject({ brand: { id: brandA } });
    await expect(requireBrandRole(db, viewer, brandA, "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireBrandRole(db, owner, brandB, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireBrandRole(db, owner, randomUUID(), "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireBrandRole(db, owner, "abc", "viewer")).rejects.toBeInstanceOf(NotFoundError);
    // Workspace admins do not implicitly see brand data.
    await expect(requireBrandRole(db, admin, brandA, "viewer")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists only member brands, hiding archived ones by default", async () => {
    expect((await listAccessibleBrands(db, owner.id)).map((b) => b.id)).toEqual([brandA]);
    expect((await listAccessibleBrands(db, owner.id, { includeArchived: true })).map((b) => b.id)).toEqual([brandA, archived]);
    expect(await listAccessibleBrands(db, admin.id)).toEqual([]);
    expect(await listAccessibleBrands(db, "nope")).toEqual([]);
  });

  it("requireAccountInBrand only resolves mapped accounts of accessible brands", async () => {
    const ok = await requireAccountInBrand(db, viewer, accountA, "viewer");
    expect(ok).toMatchObject({ brandId: brandA, role: "viewer", account: { id: accountA } });
    await expect(requireAccountInBrand(db, viewer, accountA, "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireAccountInBrand(db, owner, accountB, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, owner, unmapped, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, owner, accountA, "viewer", { brandId: brandB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAccountInBrand(db, owner, "x", "viewer")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requireWorkspaceAdmin", () => {
    expect(() => requireWorkspaceAdmin(admin)).not.toThrow();
    expect(() => requireWorkspaceAdmin(owner)).toThrow(ForbiddenError);
  });
});

describe("reports and alerts", () => {
  it("scopes reports by brand membership", async () => {
    const [report] = await db
      .insert(reportVersions)
      .values({ brandId: brandB, periodStart: "2026-09-07", periodEnd: "2026-09-13", version: 1, trigger: "manual", locale: "pt-BR", timezone: "UTC" })
      .returning({ id: reportVersions.id });
    await expect(requireReportAccess(db, outsider, report!.id)).resolves.toMatchObject({ brandId: brandB });
    await expect(requireReportAccess(db, owner, report!.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireReportAccess(db, owner, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("scopes brand alerts by role and connection alerts to workspace admins", async () => {
    const [brandAlert] = await db
      .insert(alerts)
      .values({ brandId: brandA, type: "queue", severity: "warning", dedupeKey: `q:${randomUUID()}`, title: "t", suggestedAction: "a" })
      .returning({ id: alerts.id });
    const [connAlert] = await db
      .insert(alerts)
      .values({ brandId: null, type: "auth", severity: "critical", dedupeKey: `c:${randomUUID()}`, title: "t", suggestedAction: "a" })
      .returning({ id: alerts.id });
    await expect(requireAlertAccess(db, owner, brandAlert!.id, "manager")).resolves.toMatchObject({ brandId: brandA });
    await expect(requireAlertAccess(db, viewer, brandAlert!.id, "manager")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireAlertAccess(db, outsider, brandAlert!.id, "viewer")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireAlertAccess(db, admin, connAlert!.id, "manager")).resolves.toMatchObject({ brandId: null });
    await expect(requireAlertAccess(db, owner, connAlert!.id, "viewer")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("helpers", () => {
  it("parseInput throws ValidationError with paths only", () => {
    expect(() => parseInput(z.object({ a: z.number() }), { a: "secret-value" })).toThrow(ValidationError);
    try {
      parseInput(z.object({ a: z.number() }), { a: "secret-value" });
    } catch (err) {
      expect(JSON.stringify((err as ValidationError).issues)).not.toContain("secret-value");
    }
  });

  it("detects wrapped unique violations", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new ConflictError("x"))).toBe(false);
  });
});
