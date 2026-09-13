/** Shared fixtures for security-sensitive tests (direct inserts, fast low-cost bcrypt hashes). */
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "@/server/db/client";
import { brands, connections, memberships, socialAccounts, users } from "@/server/db/schema";
import { resetKeyringCache } from "@/server/security/crypto";

export const TEST_PASSWORD = "Correct-Horse-Battery-9";
/** Cost 4 keeps tests fast; production hashes use cost 12 (see password.ts). */
export const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

/** Configures a random in-memory KEK for the current test file. Returns the base64 key. */
export function useTestKek(version = 1): string {
  const key = randomBytes(32).toString("base64");
  delete process.env.BRANDPULSE_KEK_FILE;
  delete process.env.BRANDPULSE_KEK_PREVIOUS;
  process.env.BRANDPULSE_KEK = key;
  process.env.BRANDPULSE_KEK_VERSION = String(version);
  resetKeyringCache();
  return key;
}

export function randomSecret(): string {
  return `bp_live_${randomBytes(24).toString("base64url")}`;
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  isWorkspaceAdmin: boolean;
}

export async function insertUser(
  db: Db,
  opts: { email?: string; name?: string; admin?: boolean; active?: boolean } = {},
): Promise<TestUser> {
  const email = (opts.email ?? `user-${randomUUID()}@example.test`).toLowerCase();
  const [row] = await db
    .insert(users)
    .values({
      email,
      name: opts.name ?? "Test User",
      passwordHash: TEST_PASSWORD_HASH,
      isWorkspaceAdmin: opts.admin ?? false,
      isActive: opts.active ?? true,
    })
    .returning({ id: users.id, email: users.email, name: users.name, isWorkspaceAdmin: users.isWorkspaceAdmin });
  return row!;
}

export async function insertBrand(
  db: Db,
  name: string,
  members: [userId: string, role: "owner" | "manager" | "viewer"][] = [],
): Promise<string> {
  const [brand] = await db
    .insert(brands)
    .values({ name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}` })
    .returning({ id: brands.id });
  for (const [userId, role] of members) await db.insert(memberships).values({ userId, brandId: brand!.id, role });
  return brand!.id;
}

export async function insertConnection(db: Db, label = "Test connection"): Promise<string> {
  const [row] = await db
    .insert(connections)
    .values({ provider: "buffer", label, status: "active", externalAccountId: `acct-${randomUUID()}` })
    .returning({ id: connections.id });
  return row!.id;
}

export async function insertAccount(db: Db, connectionId: string, brandId: string | null, handle = "handle"): Promise<string> {
  const [row] = await db
    .insert(socialAccounts)
    .values({
      connectionId,
      provider: "buffer",
      externalChannelId: `ch-${randomUUID()}`,
      platform: "instagram",
      platformAccountId: `ig-${randomUUID()}`,
      handle,
      brandId,
      mappingStatus: brandId ? "mapped" : "unmapped",
    })
    .returning({ id: socialAccounts.id });
  return row!.id;
}
