/**
 * Local development PostgreSQL using the `embedded-postgres` binaries (no Docker or system install).
 * Data lives in ./data/pg (gitignored). Writes DATABASE_URL to .env.local on first run.
 * Production must use a managed PostgreSQL instance instead (see docs/DEPLOYMENT.md).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const DATA_DIR = path.resolve("data/pg");
const CONFIG_FILE = path.resolve("data/pg-local.json");
const PORT = Number(process.env.LOCAL_PG_PORT ?? 54329);

function loadOrCreateConfig(): { user: string; password: string } {
  if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const config = { user: "brandpulse", password: randomBytes(18).toString("base64url") };
  writeFileSync(CONFIG_FILE, JSON.stringify(config), { mode: 0o600 });
  return config;
}

async function main() {
  const { user, password } = loadOrCreateConfig();
  const pg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user, password, port: PORT, persistent: true });
  if (!existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
    console.log("Initialising local PostgreSQL cluster in data/pg …");
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase("brandpulse");
  } catch {
    // Database already exists.
  }
  const url = `postgres://${user}:${password}@127.0.0.1:${PORT}/brandpulse`;
  const envFile = path.resolve(".env.local");
  const envContent = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  if (!/^DATABASE_URL=/m.test(envContent)) {
    appendFileSync(envFile, `${envContent && !envContent.endsWith("\n") ? "\n" : ""}DATABASE_URL=${url}\n`, { mode: 0o600 });
    console.log("DATABASE_URL written to .env.local");
  }
  console.log(`Local PostgreSQL running on 127.0.0.1:${PORT} (database "brandpulse"). Press Ctrl+C to stop.`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => undefined, 1 << 30);
}

main().catch((err) => {
  console.error("Failed to start local PostgreSQL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
