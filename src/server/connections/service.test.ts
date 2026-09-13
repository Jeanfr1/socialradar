import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditEvents, connections, socialAccounts } from "@/server/db/schema";
import { ProviderError, type CredentialValidationResult } from "@/server/providers/types";
import { createTestDb } from "@/test/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/auth/authz";
import { encryptSecret, fingerprintSecret, resetKeyringCache } from "@/server/security/crypto";
import { setLogSink } from "@/server/logger";
import { insertAccount, insertBrand, insertUser, randomSecret, useTestKek, type TestUser } from "../../../tests/security/fixtures";
import {
  CredentialRejectedError,
  createConnection,
  getConnection,
  getCredentialForWorker,
  listConnections,
  markValidation,
  reencryptAllCredentials,
  removeConnection,
  revalidateConnection,
  rotateCredential,
  type CredentialValidator,
} from "./service";

let db: Db;
let close: () => Promise<void>;
let admin: TestUser;
let member: TestUser;
let logs: string[] = [];
let accountSeq = 0;

const okFor = (externalAccountId: string, externalAccountName = "Agency Buffer"): CredentialValidator =>
  vi.fn(async (): Promise<CredentialValidationResult> => ({ ok: true, externalAccountId, externalAccountName, organizations: [] }));
const newAccountId = () => `buffer-account-${++accountSeq}`;

beforeAll(async () => {
  useTestKek();
  ({ db, close } = await createTestDb());
  admin = await insertUser(db, { admin: true });
  member = await insertUser(db);
  setLogSink((line) => logs.push(line));
});
afterAll(async () => {
  setLogSink(undefined);
  await close();
});
beforeEach(() => {
  logs = [];
});

describe("createConnection", () => {
  it("requires a workspace admin and never calls the validator otherwise", async () => {
    const validate = okFor(newAccountId());
    await expect(createConnection(db, member, { provider: "buffer", label: "x", secret: randomSecret() }, validate)).rejects.toBeInstanceOf(ForbiddenError);
    expect(validate).not.toHaveBeenCalled();
  });

  it("validates before storing and stores only an encrypted envelope", async () => {
    const secret = randomSecret();
    const validate = okFor(newAccountId(), "Main Buffer");
    const dto = await createConnection(db, admin, { provider: "buffer", label: (a) => `Buffer – ${a.externalAccountName}`, secret }, validate);
    expect(validate).toHaveBeenCalledWith(secret);
    expect(dto).toMatchObject({ label: "Buffer – Main Buffer", status: "active", keyHint: `••••${fingerprintSecret(secret).slice(-4)}` });
    expect(Object.keys(dto)).not.toContain("credentialCiphertext");
    const [row] = await db.select().from(connections).where(eq(connections.id, dto.id));
    expect(row!.credentialCiphertext).toMatch(/^v1:1:/);
    expect(row!.credentialCiphertext).not.toContain(secret);
    expect(row!.credentialFingerprint).toBe(fingerprintSecret(secret));
    const json = JSON.stringify(dto);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(row!.credentialCiphertext!);
    expect(json).not.toContain(row!.credentialFingerprint!);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.targetId, dto.id));
    expect(events.map((e) => e.action)).toEqual(["connection_created"]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("rejects invalid keys without storing them or echoing the secret", async () => {
    const secret = randomSecret();
    const before = (await db.select().from(connections)).length;
    const validate: CredentialValidator = async (s) => ({ ok: false, code: "unauthorized", message: `bad key ${s}` });
    const err = await createConnection(db, admin, { provider: "buffer", label: "Bad", secret }, validate).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialRejectedError);
    expect((err as CredentialRejectedError).providerCode).toBe("unauthorized");
    expect(String((err as Error).message)).not.toContain(secret);
    expect((await db.select().from(connections)).length).toBe(before);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("treats validator exceptions as rejections and scrubs their messages", async () => {
    const secret = randomSecret();
    const validate: CredentialValidator = async (s) => {
      throw new ProviderError("network", `socket hang up while sending ${s}`);
    };
    const err = await createConnection(db, admin, { provider: "buffer", label: "Net", secret }, validate).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialRejectedError);
    expect((err as CredentialRejectedError).providerCode).toBe("network");
    expect(JSON.stringify(err) + String((err as Error).stack)).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("rejects malformed keys and labels with validation errors", async () => {
    const validate = okFor(newAccountId());
    await expect(createConnection(db, admin, { provider: "buffer", label: "x", secret: "short" }, validate)).rejects.toBeInstanceOf(ValidationError);
    await expect(createConnection(db, admin, { provider: "buffer", label: "", secret: randomSecret() }, validate)).rejects.toBeInstanceOf(ValidationError);
    await expect(createConnection(db, admin, { provider: "buffer", label: "x", secret: "has spaces in the key 123" }, validate)).rejects.toBeInstanceOf(ValidationError);
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects duplicate keys (without spending a validation call) and duplicate accounts", async () => {
    const secret = randomSecret();
    const accountId = newAccountId();
    await createConnection(db, admin, { provider: "buffer", label: "Dup", secret }, okFor(accountId));
    const again = okFor(accountId);
    await expect(createConnection(db, admin, { provider: "buffer", label: "Dup2", secret: `  ${secret}  ` }, again)).rejects.toBeInstanceOf(ConflictError);
    expect(again).not.toHaveBeenCalled();
    await expect(createConnection(db, admin, { provider: "buffer", label: "Dup3", secret: randomSecret() }, okFor(accountId))).rejects.toThrow(
      /already connected as "Dup"/,
    );
  });
});

describe("rotation, removal and worker access", () => {
  it("rotates only to a key for the same provider account", async () => {
    const accountId = newAccountId();
    const original = randomSecret();
    const conn = await createConnection(db, admin, { provider: "buffer", label: "Rotate", secret: original }, okFor(accountId));
    const next = randomSecret();

    await expect(rotateCredential(db, member, conn.id, next, okFor(accountId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rotateCredential(db, admin, conn.id, original, okFor(accountId))).rejects.toThrow(/identical/);
    await expect(rotateCredential(db, admin, conn.id, next, okFor("someone-else"))).rejects.toThrow(/different Buffer account/);
    expect((await getCredentialForWorker(db, conn.id)).secret).toBe(original);

    const rotated = await rotateCredential(db, admin, conn.id, next, okFor(accountId));
    expect(rotated.rotatedAt).toBeInstanceOf(Date);
    expect(rotated.keyHint).toBe(`••••${fingerprintSecret(next).slice(-4)}`);
    expect((await getCredentialForWorker(db, conn.id)).secret).toBe(next);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.targetId, conn.id));
    expect(audit.map((a) => a.action)).toContain("connection_rotated");
    expect(JSON.stringify(audit)).not.toContain(next);
  });

  it("removes softly: wipes ciphertext, keeps account brand mapping, blocks worker access", async () => {
    const conn = await createConnection(db, admin, { provider: "buffer", label: "Remove", secret: randomSecret() }, okFor(newAccountId()));
    const owner = await insertUser(db);
    const brandId = await insertBrand(db, "Kept", [[owner.id, "owner"]]);
    const accountId = await insertAccount(db, conn.id, brandId);

    await expect(removeConnection(db, member, conn.id)).rejects.toBeInstanceOf(ForbiddenError);
    await removeConnection(db, admin, conn.id);

    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row).toMatchObject({ status: "revoked", credentialCiphertext: null, credentialFingerprint: null });
    expect(row!.deletedAt).toBeInstanceOf(Date);
    const [account] = await db.select().from(socialAccounts).where(eq(socialAccounts.id, accountId));
    expect(account!.brandId).toBe(brandId);
    expect(account!.removedAt).toBeInstanceOf(Date);
    expect((await listConnections(db, admin)).map((c) => c.id)).not.toContain(conn.id);
    await expect(getConnection(db, admin, conn.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCredentialForWorker(db, conn.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeConnection(db, admin, conn.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("worker credentials hide the secret from serialization", async () => {
    const secret = randomSecret();
    const conn = await createConnection(db, admin, { provider: "buffer", label: "Worker", secret }, okFor(newAccountId()));
    const credential = await getCredentialForWorker(db, conn.id);
    expect(credential.secret).toBe(secret);
    expect(JSON.stringify(credential)).not.toContain(secret);
    expect(JSON.stringify({ ...credential })).not.toContain(secret);
    await expect(getCredentialForWorker(db, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records validation outcomes with redacted provider messages", async () => {
    const secret = randomSecret();
    const conn = await createConnection(db, admin, { provider: "buffer", label: "Validate", secret }, okFor(newAccountId()));
    await markValidation(db, conn.id, { ok: false, code: "unauthorized", message: `Invalid token=${secret}` });
    const invalid = await getConnection(db, admin, conn.id);
    expect(invalid).toMatchObject({ status: "invalid", consecutiveFailures: 1, lastErrorCode: "unauthorized" });
    expect(invalid.lastErrorMessage).not.toContain(secret);
    await markValidation(db, conn.id, { ok: false, code: "upstream", message: "503" });
    expect(await getConnection(db, admin, conn.id)).toMatchObject({ status: "error", consecutiveFailures: 2 });

    const revalidated = await revalidateConnection(db, admin, conn.id, okFor("ignored", "Renamed"));
    expect(revalidated).toMatchObject({ status: "active", consecutiveFailures: 0, lastErrorMessage: null, externalAccountName: "Renamed" });
    await expect(revalidateConnection(db, member, conn.id, okFor("x"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("re-encrypts credentials that use a previous KEK version", async () => {
    const secret = randomSecret();
    const conn = await createConnection(db, admin, { provider: "buffer", label: "KEK", secret }, okFor(newAccountId()));
    const oldKey = process.env.BRANDPULSE_KEK!;
    const oldCipher = encryptSecret(secret).ciphertext;
    useTestKek(2);
    process.env.BRANDPULSE_KEK_PREVIOUS = `1:${oldKey}`;
    resetKeyringCache();
    await db.update(connections).set({ credentialCiphertext: oldCipher, credentialKeyVersion: 1 }).where(eq(connections.id, conn.id));

    expect((await getCredentialForWorker(db, conn.id)).secret).toBe(secret);
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id));
    expect(row!.credentialKeyVersion).toBe(2);
    const result = await reencryptAllCredentials(db);
    expect(result.updated).toBeGreaterThan(0);
    const rows = await db.select().from(connections);
    for (const r of rows) if (r.credentialCiphertext) expect(r.credentialCiphertext.startsWith("v1:2:")).toBe(true);
  });
});
