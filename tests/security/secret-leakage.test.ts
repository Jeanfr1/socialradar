/**
 * Credentials must never reach browser responses (DTOs), logs, audit metadata or UI modules.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditEvents, connections } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import { recordAudit } from "@/server/audit";
import { createLogger, logger, setLogSink } from "@/server/logger";
import { createConnection, getConnection, listConnections, rotateCredential } from "@/server/connections/service";
import type { CredentialValidationResult } from "@/server/providers/types";
import { insertUser, randomSecret, useTestKek, type TestUser } from "./fixtures";

let db: Db;
let close: () => Promise<void>;
let admin: TestUser;
const secret = randomSecret();
const ok = async (): Promise<CredentialValidationResult> => ({
  ok: true,
  externalAccountId: "leak-test-account",
  externalAccountName: "Leak Test",
  organizations: [],
});

beforeAll(async () => {
  useTestKek();
  ({ db, close } = await createTestDb());
  admin = await insertUser(db, { admin: true });
});
afterAll(async () => {
  setLogSink(undefined);
  await close();
});

describe("PublicConnection DTO", () => {
  it("never contains the secret, ciphertext or full fingerprint", async () => {
    const created = await createConnection(db, admin, { provider: "buffer", label: "Leak", secret }, ok);
    const [row] = await db.select().from(connections).where(eq(connections.id, created.id));
    const next = randomSecret();
    const rotated = await rotateCredential(db, admin, created.id, next, ok);
    const [rotatedRow] = await db.select().from(connections).where(eq(connections.id, created.id));
    const payload = JSON.stringify([created, rotated, await getConnection(db, admin, created.id), await listConnections(db, admin)]);
    for (const needle of [secret, next, row!.credentialCiphertext!, rotatedRow!.credentialCiphertext!, row!.credentialFingerprint!, rotatedRow!.credentialFingerprint!]) {
      expect(payload).not.toContain(needle);
    }
    expect(payload).not.toMatch(/ciphertext|fingerprint"/i);
  });
});

describe("logger", () => {
  it("never writes a secret, whatever the shape", () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const log = createLogger({ requestId: "r1", apiKey: secret }).child({ connection: { credential: secret } });
    log.info(`starting sync with key ${secret}`, { headers: { Authorization: `Bearer ${secret}` } });
    log.warn("provider failed", { err: new Error(`401 for token=${secret}`), url: `https://api.buffer.com/?access_token=${secret}` });
    log.error("db failed", { err: Object.assign(new Error(`Failed query\nparams: ${secret}`), { query: "q", params: [secret] }) });
    logger.info("nested", { payload: [{ deep: { password: secret } }], note: `pasted ${secret}` });
    const output = lines.join("\n");
    expect(lines).toHaveLength(4);
    expect(output).not.toContain(secret);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", requestId: "r1" });
  });

  it("respects LOG_LEVEL", () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    logger.info("hidden");
    logger.debug("hidden");
    logger.warn("shown");
    process.env.LOG_LEVEL = previous;
    expect(lines).toHaveLength(1);
  });
});

describe("audit metadata", () => {
  it("is redacted before storage", async () => {
    await recordAudit(db, {
      actorUserId: admin.id,
      action: "settings_updated",
      targetType: "test",
      targetId: "redaction",
      metadata: { apiKey: secret, note: `Authorization: Bearer ${secret}`, nested: [{ token: secret }], ok: true },
    });
    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.targetId, "redaction"));
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(event!.metadata).toMatchObject({ apiKey: "[REDACTED]", ok: true });
  });

  it("rejects unknown actions", async () => {
    await expect(recordAudit(db, { actorUserId: null, action: "made_up" as never })).rejects.toThrow(/Unknown audit action/);
  });
});

describe("module boundaries", () => {
  const root = path.resolve(__dirname, "../..");
  const uiDirs = ["src/app", "src/components", "src/domain", "src/lib/client"].map((d) => path.join(root, d));

  function files(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return files(full);
      return /\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
  }

  it("UI and domain modules never access decrypted credentials", () => {
    const offenders = uiDirs
      .flatMap(files)
      .filter((f) => /getCredentialForWorker|decryptSecret|credentialCiphertext|security\/crypto/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it("client components never import server modules", () => {
    const offenders = uiDirs.flatMap(files).filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /^\s*["']use client["']/.test(src) && /from\s+["']@\/server\//.test(src);
    });
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
