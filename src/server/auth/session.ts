/**
 * Session authentication.
 * - Opaque 32-byte random tokens (base64url) live only in the httpOnly `bp_session` cookie; the database stores
 *   SHA-256(token), so a database leak does not yield usable sessions.
 * - 7-day sliding expiry; `lastSeenAt`/`expiresAt` are refreshed at most every 10 minutes.
 * - Login uses a generic error, bcrypt timing parity for unknown users, and a 15-minute lockout after 5 failures.
 * Server-only.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { cache } from "react";
import { recordAudit } from "@/server/audit";
import { getDb, type Db } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { fingerprintSecret } from "@/server/security/crypto";
import { BCRYPT_COST, needsRehash, verifyPassword } from "@/server/security/password";
import bcrypt from "bcryptjs";

export const SESSION_COOKIE = "bp_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const LOGIN_ERROR_MESSAGE = "We couldn't sign you in. Check your email and password and try again.";

/** Safe identity DTO: never includes password hash, lockout state or session tokens. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isWorkspaceAdmin: boolean;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeEmail(email: string): string {
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 320) : "";
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.SECURE_COOKIES === "true",
    path: "/",
    expires,
  };
}

export async function createSession(
  db: Db,
  userId: string,
  userAgent?: string | null,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt,
    createdAt: now,
    lastSeenAt: now,
    userAgent: userAgent ? userAgent.slice(0, 256) : null,
  });
  return { token, expiresAt };
}

/** Resolves a raw session token to its active user, extending the sliding expiry. Returns null otherwise. */
export async function getSessionUser(
  db: Db,
  token: string | null | undefined,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const tokenHash = hashSessionToken(token);
  const [row] = await db
    .select({
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      email: users.email,
      name: users.name,
      isWorkspaceAdmin: users.isWorkspaceAdmin,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  if (!row.isActive) {
    await revokeAllUserSessions(db, row.id);
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.tokenHash, tokenHash));
  }
  return { id: row.id, email: row.email, name: row.name, isWorkspaceAdmin: row.isWorkspaceAdmin };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

export async function revokeAllUserSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Housekeeping for the worker: deletes expired sessions. */
export async function pruneExpiredSessions(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}

export type LoginResult =
  | { ok: true; user: SessionUser; token: string; expiresAt: Date }
  | { ok: false; error: string };

/** Framework-free login core (testable). Creates a session on success; audits every attempt. */
export async function authenticate(
  db: Db,
  emailInput: string,
  password: string,
  opts: { userAgent?: string | null; now?: Date } = {},
): Promise<LoginResult> {
  const now = opts.now ?? new Date();
  const email = normalizeEmail(emailInput);
  const failure = { ok: false as const, error: LOGIN_ERROR_MESSAGE };
  const [user] = email ? await db.select().from(users).where(eq(users.email, email)).limit(1) : [];

  if (!user || !user.isActive || (user.lockedUntil && user.lockedUntil.getTime() > now.getTime())) {
    await verifyPassword(password, null); // timing parity with a real comparison
    const reason = !user ? "unknown_user" : !user.isActive ? "inactive" : "locked_out";
    await recordAudit(db, {
      actorUserId: user?.id ?? null,
      action: "login_failed",
      targetType: "user",
      targetId: user?.id ?? null,
      metadata: { reason, ...(user ? {} : { emailFingerprint: fingerprintSecret(email) }) },
    });
    return failure;
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const lockUntil = new Date(now.getTime() + LOCKOUT_MS).toISOString();
    const [updated] = await db
      .update(users)
      .set({
        failedLoginCount: sql`case when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} then 0 else ${users.failedLoginCount} + 1 end`,
        lockedUntil: sql`case when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} then ${lockUntil}::timestamptz else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, user.id))
      .returning({ lockedUntil: users.lockedUntil });
    const locked = !!updated?.lockedUntil && updated.lockedUntil.getTime() > now.getTime();
    await recordAudit(db, {
      actorUserId: user.id,
      action: "login_failed",
      targetType: "user",
      targetId: user.id,
      metadata: { reason: "bad_password", lockedOut: locked },
    });
    return failure;
  }

  const rehash = needsRehash(user.passwordHash) ? await bcrypt.hash(password, BCRYPT_COST) : undefined;
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, ...(rehash ? { passwordHash: rehash } : {}) })
    .where(and(eq(users.id, user.id), eq(users.isActive, true)));
  const { token, expiresAt } = await createSession(db, user.id, opts.userAgent, now);
  await recordAudit(db, { actorUserId: user.id, action: "login_succeeded", targetType: "user", targetId: user.id });
  return {
    ok: true,
    token,
    expiresAt,
    user: { id: user.id, email: user.email, name: user.name, isWorkspaceAdmin: user.isWorkspaceAdmin },
  };
}

/** Current request's user (deduplicated per request). Null when not signed in. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? getSessionUser(getDb(), token) : null;
});

/** Server Action login: sets the session cookie on success. The error message is always generic. */
export async function login(
  email: string,
  password: string,
): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
  const { cookies, headers } = await import("next/headers");
  const userAgent = (await headers()).get("user-agent");
  const result = await authenticate(getDb(), email, password, { userAgent });
  if (!result.ok) return result;
  (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  return { ok: true, user: result.user };
}

/** Server Action logout: revokes the session server-side and clears the cookie. */
export async function logout(): Promise<void> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = getDb();
    const user = await getSessionUser(db, token);
    await revokeSession(db, token);
    if (user) await recordAudit(db, { actorUserId: user.id, action: "logout", targetType: "user", targetId: user.id });
  }
  store.delete(SESSION_COOKIE);
}
