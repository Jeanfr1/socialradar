/**
 * Copies BrandPulse data between two PostgreSQL databases (e.g. local → Supabase), in dependency order.
 * Only tables of the public schema created by the migrations are copied; the target must already be migrated.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run db:copy [-- --truncate]
 *
 * Safe to re-run with --truncate (clears target tables first). Identity columns keep their ids and the
 * sequences are re-synced afterwards.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "pg";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/** Parent tables first so foreign keys are always satisfied. */
const TABLE_ORDER = [
  "users",
  "brands",
  "memberships",
  "connections",
  "provider_organizations",
  "social_accounts",
  "posting_schedules",
  "posts",
  "post_tags",
  "metric_observations",
  "post_metrics_latest",
  "audience_snapshots",
  "sync_runs",
  "jobs",
  "alerts",
  "recommendations",
  "experiments",
  "report_versions",
  "audit_events",
  "worker_heartbeats",
  "sessions",
] as const;

const BATCH = 500;

async function main() {
  const { values } = parseArgs({ options: { truncate: { type: "boolean" } } });
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl) throw new Error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required");

  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  await source.connect();
  await target.connect();

  if (values.truncate) {
    const list = [...TABLE_ORDER].reverse().map((t) => `"${t}"`).join(", ");
    await target.query(`truncate table ${list} restart identity cascade`);
    console.log("tabelas de destino limpas");
  }

  for (const table of TABLE_ORDER) {
    const cols = (
      await target.query<{ column_name: string; is_identity: string }>(
        "select column_name, is_identity from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position",
        [table],
      )
    ).rows;
    if (cols.length === 0) {
      console.log(`- ${table}: não existe no destino, ignorado`);
      continue;
    }
    const names = cols.map((c) => c.column_name);
    const hasIdentity = cols.some((c) => c.is_identity === "YES");
    const rows = (await source.query(`select ${names.map((n) => `"${n}"`).join(", ")} from "${table}"`)).rows;
    if (rows.length === 0) {
      console.log(`- ${table}: 0`);
      continue;
    }
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = chunk.map((row) => {
        const placeholders = names.map((n) => {
          const value = (row as Record<string, unknown>)[n];
          params.push(value && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value);
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await target.query(
        `insert into "${table}" (${names.map((n) => `"${n}"`).join(", ")}) ${hasIdentity ? "overriding system value " : ""}values ${tuples.join(", ")} on conflict do nothing`,
        params,
      );
    }
    // Keep identity sequences ahead of the copied ids.
    for (const col of cols.filter((c) => c.is_identity === "YES")) {
      await target.query(
        `select setval(pg_get_serial_sequence('"${table}"', '${col.column_name}'), coalesce((select max("${col.column_name}") from "${table}"), 1))`,
      );
    }
    const after = (await target.query<{ n: string }>(`select count(*)::text n from "${table}"`)).rows[0]?.n;
    console.log(`- ${table}: ${rows.length} origem → ${after} destino`);
  }

  await source.end();
  await target.end();
  console.log("cópia concluída");
}

main().catch((err) => {
  console.error("db:copy falhou:", err instanceof Error ? err.message : err);
  process.exit(1);
});
