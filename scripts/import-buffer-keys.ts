/**
 * Imports Buffer API keys from a local file (one key per line; blank lines and lines starting with # are ignored).
 *
 *   npm run connections:import -- --file /path/outside/repo/keys.txt [--actor admin@agency.com]
 *
 * Each key is validated with Buffer, then stored encrypted as "Buffer – <account name>". Keys are never printed:
 * output shows only the label, status and the fingerprint suffix. Duplicates are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { ConflictError, isAppError } from "@/server/auth/authz";
import { findFirstWorkspaceAdmin } from "@/server/brands/service";
import { CredentialRejectedError, createConnection } from "@/server/connections/service";
import { closeDb, getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { validateBufferCredential } from "@/server/providers/buffer/validate";
import { assertKekConfigured, fingerprintSecret } from "@/server/security/crypto";
import { redactText } from "@/server/security/redact";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { file: { type: "string" }, actor: { type: "string" } },
    strict: true,
  });
  if (!values.file) {
    console.error("Usage: npm run connections:import -- --file <path> [--actor admin@email]");
    return 2;
  }
  const file = path.resolve(values.file);
  assertKekConfigured();

  const stat = fs.statSync(file);
  if ((stat.mode & 0o077) !== 0) console.warn(`Warning: ${file} is readable by other users (chmod 600 recommended).`);
  if (file.startsWith(process.cwd() + path.sep)) {
    console.warn("Warning: the key file is inside the project directory. Keep key files outside the repository.");
  }
  const keys = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (keys.length === 0) {
    console.error("No keys found in the file.");
    return 1;
  }

  const db = getDb();
  let actor: { id: string; email: string; isWorkspaceAdmin: boolean } | null;
  if (values.actor) {
    const [row] = await db
      .select({ id: users.id, email: users.email, isWorkspaceAdmin: users.isWorkspaceAdmin, isActive: users.isActive })
      .from(users)
      .where(eq(users.email, values.actor.trim().toLowerCase()))
      .limit(1);
    actor = row?.isActive && row.isWorkspaceAdmin ? row : null;
  } else {
    actor = await findFirstWorkspaceAdmin(db);
  }
  if (!actor) {
    console.error("No active workspace admin found. Run `npm run setup:owner` first (or pass --actor).");
    return 1;
  }
  console.log(`Importing ${keys.length} key(s) as ${actor.email}…`);

  const counts = { created: 0, skipped: 0, rejected: 0, failed: 0 };
  for (const [index, secret] of keys.entries()) {
    const prefix = `[${index + 1}/${keys.length}]`;
    const hint = `key ••••${fingerprintSecret(secret).slice(-4)}`;
    try {
      const connection = await createConnection(
        db,
        actor,
        {
          provider: "buffer",
          secret,
          label: (account) => `Buffer – ${account.externalAccountName || account.externalAccountId}`.slice(0, 80),
        },
        validateBufferCredential,
      );
      counts.created++;
      console.log(`${prefix} ${connection.label}: created (${connection.status}, ${hint})`);
    } catch (err) {
      if (err instanceof ConflictError) {
        counts.skipped++;
        console.log(`${prefix} skipped: ${err.message} (${hint})`);
      } else if (err instanceof CredentialRejectedError) {
        counts.rejected++;
        console.log(`${prefix} rejected: ${err.providerCode} (${hint})`);
      } else {
        counts.failed++;
        const message = isAppError(err) ? err.message : "unexpected error";
        console.log(`${prefix} failed: ${redactText(message)} (${hint})`);
      }
    }
  }

  console.log(
    `Done: ${counts.created} created, ${counts.skipped} skipped, ${counts.rejected} rejected, ${counts.failed} failed.`,
  );
  console.log(
    [
      "",
      "Now destroy the key file — the keys are stored encrypted in the database:",
      `  macOS:  rm -P "${file}"`,
      `  Linux:  shred -u "${file}"`,
      "On SSDs/APFS or synced folders secure deletion is not guaranteed: if the file was ever backed up or synced,",
      "rotate the keys in Buffer and use Settings → Connections → Rotate key.",
    ].join("\n"),
  );
  return counts.failed > 0 ? 1 : 0;
}

main()
  .then((code) => (process.exitCode = code))
  .catch((err: unknown) => {
    console.error(isAppError(err) ? err.message : `Import failed: ${redactText(String((err as Error)?.message ?? err))}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
