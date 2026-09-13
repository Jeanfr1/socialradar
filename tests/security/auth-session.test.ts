import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditEvents, sessions, users } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import {
  LOCKOUT_MS,
  LOGIN_ERROR_MESSAGE,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
  authenticate,
  createSession,
  getSessionUser,
  hashSessionToken,
  pruneExpiredSessions,
  revokeAllUserSessions,
  revokeSession,
  sessionCookieOptions,
} from "@/server/auth/session";
import { TEST_PASSWORD, insertUser } from "./fixtures";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("authenticate", () => {
  it("succeeds with the right password and stores only the token hash", async () => {
    const user = await insertUser(db, { email: "Login.Ok@Example.test" });
    const result = await authenticate(db, "  LOGIN.OK@example.TEST ", TEST_PASSWORD, { userAgent: "vitest" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.user).toEqual({ id: user.id, email: user.email, name: user.name, isWorkspaceAdmin: false });
    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashSessionToken(result.token));
    expect(JSON.stringify(rows)).not.toContain(result.token);
    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$12\$/); // upgraded from the cost-4 fixture hash
    expect(stored!.lastLoginAt).toBeInstanceOf(Date);
  });

  it("returns the same generic error for unknown users, wrong passwords and inactive users", async () => {
    const user = await insertUser(db);
    const inactive = await insertUser(db, { active: false });
    const results = [
      await authenticate(db, "nobody@example.test", TEST_PASSWORD),
      await authenticate(db, user.email, "wrong-password-123"),
      await authenticate(db, inactive.email, TEST_PASSWORD),
      await authenticate(db, "", ""),
    ];
    for (const r of results) expect(r).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE });
    const failures = await db.select().from(auditEvents).where(eq(auditEvents.action, "login_failed"));
    expect(JSON.stringify(failures)).not.toContain("wrong-password-123");
    expect(JSON.stringify(failures)).not.toContain("nobody@example.test");
  });

  it("locks the account for 15 minutes after 5 failures, then allows login again", async () => {
    const user = await insertUser(db);
    const t0 = new Date("2026-09-13T10:00:00Z");
    for (let i = 0; i < 5; i++) await authenticate(db, user.email, `wrong-password-${i}`, { now: t0 });
    const [locked] = await db.select().from(users).where(eq(users.id, user.id));
    expect(locked!.lockedUntil?.getTime()).toBe(t0.getTime() + LOCKOUT_MS);

    const during = await authenticate(db, user.email, TEST_PASSWORD, { now: new Date(t0.getTime() + LOCKOUT_MS - 1000) });
    expect(during).toEqual({ ok: false, error: LOGIN_ERROR_MESSAGE });

    const after = await authenticate(db, user.email, TEST_PASSWORD, { now: new Date(t0.getTime() + LOCKOUT_MS + 1000) });
    expect(after.ok).toBe(true);
    const [reset] = await db.select().from(users).where(eq(users.id, user.id));
    expect(reset).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });
});

describe("sessions", () => {
  it("resolves valid tokens with sliding expiry touched at most every 10 minutes", async () => {
    const user = await insertUser(db, { admin: true });
    const t0 = new Date("2026-09-13T08:00:00Z");
    const { token, expiresAt } = await createSession(db, user.id, "ua", t0);
    expect(expiresAt.getTime()).toBe(t0.getTime() + SESSION_TTL_MS);

    expect(await getSessionUser(db, token, new Date(t0.getTime() + 60_000))).toMatchObject({ id: user.id, isWorkspaceAdmin: true });
    let [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(row!.lastSeenAt.getTime()).toBe(t0.getTime());

    const t1 = new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS + 1);
    await getSessionUser(db, token, t1);
    [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(row!.lastSeenAt.getTime()).toBe(t1.getTime());
    expect(row!.expiresAt.getTime()).toBe(t1.getTime() + SESSION_TTL_MS);

    expect(await getSessionUser(db, token, new Date(t1.getTime() + SESSION_TTL_MS + 1))).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)))).toHaveLength(0);
  });

  it("rejects malformed tokens, revoked sessions and deactivated users", async () => {
    const user = await insertUser(db);
    expect(await getSessionUser(db, "short")).toBeNull();
    expect(await getSessionUser(db, undefined)).toBeNull();
    expect(await getSessionUser(db, "A".repeat(43))).toBeNull();

    const a = await createSession(db, user.id);
    const b = await createSession(db, user.id);
    await revokeSession(db, a.token);
    expect(await getSessionUser(db, a.token)).toBeNull();
    expect(await getSessionUser(db, b.token)).not.toBeNull();

    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    expect(await getSessionUser(db, b.token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);

    await db.update(users).set({ isActive: true }).where(eq(users.id, user.id));
    const c = await createSession(db, user.id);
    await revokeAllUserSessions(db, user.id);
    expect(await getSessionUser(db, c.token)).toBeNull();
  });

  it("prunes expired sessions", async () => {
    const user = await insertUser(db);
    await createSession(db, user.id, null, new Date("2020-01-01T00:00:00Z"));
    await pruneExpiredSessions(db);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  it("uses hardened cookie options", () => {
    const previous = process.env.SECURE_COOKIES;
    process.env.SECURE_COOKIES = "true";
    const expires = new Date();
    expect(sessionCookieOptions(expires)).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", expires });
    process.env.SECURE_COOKIES = "false";
    expect(sessionCookieOptions(expires).secure).toBe(false);
    process.env.SECURE_COOKIES = previous;
  });
});
