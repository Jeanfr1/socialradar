/**
 * Creates the brands discovered on the connected Buffer accounts and maps each channel to its brand.
 * Idempotent: existing brands (by slug) are reused, and channels already mapped are left untouched
 * unless --remap is passed. Mapping can always be changed later in Settings → Connections.
 *
 *   npm run setup:brands            # apply
 *   npm run setup:brands -- --dry   # show what would happen
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { brands, memberships, postingSchedules, socialAccounts, users } from "@/server/db/schema";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** handle (as reported by Buffer) + platform → brand. */
const BRAND_MAP: { name: string; slug: string; channels: { platform: "instagram" | "tiktok" | "youtube"; handle: string }[] }[] = [
  {
    name: "Nordestinos In The World",
    slug: "nordestinos-in-the-world",
    channels: [
      { platform: "instagram", handle: "nordestinointheworld" },
      { platform: "tiktok", handle: "nordestinointheworld" },
      { platform: "youtube", handle: "Nordestinos In The World" },
    ],
  },
  {
    name: "Fora do Diagrama",
    slug: "fora-do-diagrama",
    channels: [
      { platform: "instagram", handle: "foradodiagrama" },
      { platform: "tiktok", handle: "foradodiagrama" },
      { platform: "youtube", handle: "Fora do Diagrama" },
    ],
  },
  {
    name: "Wins Engenharia",
    slug: "wins-engenharia",
    channels: [
      { platform: "tiktok", handle: "winsengenharia" },
      { platform: "youtube", handle: "Wins Engenharia" },
    ],
  },
  {
    name: "Hidden Revelations",
    slug: "hidden-revelations",
    channels: [
      { platform: "tiktok", handle: "hiddenrevelations6" },
      { platform: "youtube", handle: "Hidden Revelations" },
    ],
  },
  { name: "Scarllet Aurora", slug: "scarllet-aurora", channels: [{ platform: "instagram", handle: "scarlletaurora" }] },
  { name: "MF Catarino", slug: "mf-catarino", channels: [{ platform: "instagram", handle: "mfcatarino.pt" }] },
];

async function main() {
  const { values } = parseArgs({ options: { dry: { type: "boolean" }, remap: { type: "boolean" } } });
  const db = getDb();
  const accounts = await db
    .select({
      id: socialAccounts.id,
      platform: socialAccounts.platform,
      handle: socialAccounts.handle,
      brandId: socialAccounts.brandId,
      providerTimezone: socialAccounts.providerTimezone,
      isDemo: socialAccounts.isDemo,
    })
    .from(socialAccounts)
    .where(isNull(socialAccounts.removedAt));
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.isWorkspaceAdmin, true));

  for (const spec of BRAND_MAP) {
    const matched = spec.channels
      .map((c) => accounts.find((a) => !a.isDemo && a.platform === c.platform && a.handle.toLowerCase() === c.handle.toLowerCase()))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    if (matched.length === 0) {
      console.log(`- ${spec.name}: nenhum canal correspondente encontrado, ignorado`);
      continue;
    }
    // Brand timezone: the timezone the channels actually publish in (falls back to the app default).
    const zones = matched.map((a) => a.providerTimezone).filter((z): z is string => Boolean(z));
    const timezone = zones.sort((a, b) => zones.filter((z) => z === b).length - zones.filter((z) => z === a).length)[0] ?? "America/Sao_Paulo";

    if (values.dry) {
      console.log(`- ${spec.name} (${timezone}): ${matched.map((m) => `${m.platform}/@${m.handle}`).join(", ")}`);
      continue;
    }
    const [brand] = await db
      .insert(brands)
      .values({ name: spec.name, slug: spec.slug, timezone, reportLocale: "pt-BR" })
      .onConflictDoUpdate({ target: brands.slug, set: { name: spec.name } })
      .returning();
    for (const admin of admins) {
      await db.insert(memberships).values({ userId: admin.id, brandId: brand!.id, role: "owner" }).onConflictDoNothing();
    }
    let mapped = 0;
    for (const account of matched) {
      if (account.brandId && !values.remap) continue;
      await db
        .update(socialAccounts)
        .set({ brandId: brand!.id, mappingStatus: "mapped", updatedAt: new Date() })
        .where(and(eq(socialAccounts.id, account.id), isNull(socialAccounts.removedAt)));
      await db.insert(postingSchedules).values({ socialAccountId: account.id }).onConflictDoNothing();
      mapped += 1;
    }
    console.log(`- ${spec.name} (${timezone}): ${matched.length} canal(is), ${mapped} mapeado(s) agora`);
  }
  if (values.dry) console.log("\n(dry run: nada foi gravado)");
  await closeDb();
}

main().catch(async (err) => {
  console.error("setup:brands falhou:", err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
