import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Driver-agnostic database handle (node-postgres in runtime, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

type GlobalDb = { __brandpulseDb?: Db; __brandpulsePool?: Pool };
const g = globalThis as unknown as GlobalDb;

export function getDb(): Db {
  if (g.__brandpulseDb) return g.__brandpulseDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // Serverless: connections start cold behind a pooler, so fail fast and recycle idle sockets.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 15_000),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 10_000),
    keepAlive: true,
  });
  g.__brandpulsePool = pool;
  g.__brandpulseDb = drizzle(pool, { schema }) as unknown as Db;
  return g.__brandpulseDb;
}

/** Test hook: inject a database (e.g. PGlite). */
export function setDb(db: Db | undefined): void {
  g.__brandpulseDb = db;
}

export async function closeDb(): Promise<void> {
  await g.__brandpulsePool?.end();
  g.__brandpulsePool = undefined;
  g.__brandpulseDb = undefined;
}

export { schema };
