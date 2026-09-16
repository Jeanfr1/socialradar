/**
 * Generates recommendations for every brand now (the worker does this after each published sync).
 *   npm run insights:run [-- --brand <brandId>]
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { eq, isNull } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { brands } from "@/server/db/schema";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

async function main() {
  const { values } = parseArgs({ options: { brand: { type: "string" } } });
  const db = getDb();
  const { generateRecommendationsForBrand } = await import("@/server/insights/service");
  const rows = await db
    .select({ id: brands.id, name: brands.name })
    .from(brands)
    .where(values.brand ? eq(brands.id, values.brand) : isNull(brands.archivedAt));
  for (const brand of rows) {
    try {
      const result = await generateRecommendationsForBrand(db, brand.id, new Date());
      console.log(`${brand.name}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`${brand.name}: FALHOU — ${err instanceof Error ? err.message : err}`);
    }
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error("insights:run falhou:", err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
