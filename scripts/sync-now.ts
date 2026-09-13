/**
 * Run a synchronization immediately (outside the worker schedule), then evaluate alerts.
 *   npm run sync:now                       → queue + published for every active Buffer connection
 *   npm run sync:now -- --connection <id>  → one connection
 *   npm run sync:now -- --queue-only
 * Quota reserves still apply: a sync that would spend reserved quota is skipped and reported.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { evaluateAlerts } from "@/server/alerts/engine";
import { closeDb, getDb } from "@/server/db/client";
import { connections } from "@/server/db/schema";
import { ProviderError } from "@/server/providers/types";
import { syncPublished, syncQueue } from "@/server/sync/buffer-sync";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

async function main() {
  const { values } = parseArgs({ options: { connection: { type: "string" }, "queue-only": { type: "boolean" } } });
  const db = getDb();
  const rows = await db
    .select({ id: connections.id, label: connections.label })
    .from(connections)
    .where(
      and(
        isNull(connections.deletedAt),
        eq(connections.provider, "buffer"),
        inArray(connections.status, ["active", "error", "pending"]),
        values.connection ? eq(connections.id, values.connection) : undefined,
      ),
    );
  if (rows.length === 0) console.log("No active Buffer connections.");
  for (const conn of rows) {
    for (const kind of values["queue-only"] ? (["queue"] as const) : (["queue", "published"] as const)) {
      try {
        const out = kind === "queue" ? await syncQueue({ db }, conn.id) : await syncPublished({ db }, conn.id);
        console.log(`${conn.label} · ${kind}: ${out.status} · ${out.requestsUsed} request(s) · ${out.itemsUpserted} item(s) · ${JSON.stringify(out.details)}`);
      } catch (err) {
        const code = err instanceof ProviderError ? err.code : "internal_error";
        console.log(`${conn.label} · ${kind}: FAILED (${code}) ${err instanceof Error ? err.message : ""}`);
      }
    }
  }
  const summary = await evaluateAlerts(db, new Date());
  console.log(`Alerts evaluated: ${JSON.stringify(summary)}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error("sync:now failed:", err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
