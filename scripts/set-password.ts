/**
 * Creates a user or resets an existing user's password (there is no self-service signup: access is invite-only).
 *
 *   npm run user:password -- --email you@example.com --name "You" [--admin] [--grant-all-brands]
 *
 * The password comes from BRANDPULSE_USER_PASSWORD, or one is generated and printed once.
 * Existing sessions of that user are revoked.
 */
import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { brands, memberships, sessions, users } from "@/server/db/schema";
import { assertPasswordPolicy, hashPassword } from "@/server/security/password";
import { normalizeEmail } from "@/server/auth/session";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const WORDS = ["radar", "pulse", "brand", "signal", "queue", "metric", "report", "insight", "north", "atlas"];

function generatePassword(): string {
  const pick = () => WORDS[randomInt(WORDS.length)]!;
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  return `${cap(pick())}-${pick()}-${randomInt(1000, 9999)}-${cap(pick())}`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      admin: { type: "boolean" },
      "grant-all-brands": { type: "boolean" },
    },
    strict: true,
  });
  if (!values.email) {
    console.error('Usage: npm run user:password -- --email you@example.com [--name "You"] [--admin] [--grant-all-brands]');
    return 2;
  }
  const db = getDb();
  const email = normalizeEmail(values.email);
  const password = process.env.BRANDPULSE_USER_PASSWORD || generatePassword();
  assertPasswordPolicy(password, { email, name: values.name });
  const passwordHash = await hashPassword(password);

  const [existing] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email));
  let userId: string;
  if (existing) {
    userId = existing.id;
    await db
      .update(users)
      .set({
        passwordHash,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
        ...(values.admin ? { isWorkspaceAdmin: true } : {}),
        ...(values.name ? { name: values.name } : {}),
      })
      .where(eq(users.id, userId));
    await db.delete(sessions).where(eq(sessions.userId, userId));
    console.log(`Senha redefinida para ${email} (sessões anteriores encerradas).`);
  } else {
    const [created] = await db
      .insert(users)
      .values({ email, name: values.name ?? email.split("@")[0]!, passwordHash, isWorkspaceAdmin: Boolean(values.admin) })
      .returning({ id: users.id });
    userId = created!.id;
    console.log(`Usuário criado: ${email}${values.admin ? " (workspace admin)" : ""}.`);
  }

  if (values["grant-all-brands"]) {
    const all = await db.select({ id: brands.id, name: brands.name }).from(brands);
    for (const brand of all) {
      await db
        .insert(memberships)
        .values({ userId, brandId: brand.id, role: "owner" })
        .onConflictDoUpdate({ target: [memberships.userId, memberships.brandId], set: { role: "owner" } });
    }
    console.log(`Acesso de owner concedido em ${all.length} marca(s).`);
  }

  if (!process.env.BRANDPULSE_USER_PASSWORD) {
    console.log(`\n  E-mail: ${email}\n  Senha:  ${password}\n\nGuarde-a agora: ela não será exibida de novo.`);
  }
  await closeDb();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (err) => {
    console.error("user:password falhou:", err instanceof Error ? err.message : err);
    await closeDb();
    process.exit(1);
  });
