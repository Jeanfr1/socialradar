/**
 * Provider connections (Buffer API keys). Server-only.
 *
 * Invariants
 * - Keys are validated with the provider BEFORE anything is stored, then stored only as an AES-256-GCM envelope.
 * - Duplicate keys are detected through a 12-hex SHA-256 fingerprint; the same Buffer account cannot be connected
 *   twice (rotate the existing connection instead).
 * - Nothing returned from this module to UI code contains ciphertext, fingerprints or secrets: `PublicConnection`
 *   is an explicit allowlist and exposes only `keyHint` (last 4 chars of the fingerprint, not of the key).
 * - Error messages never contain the secret; provider messages are scrubbed before storage/logging.
 * - Removal is a soft delete: ciphertext and fingerprint are wiped, `status = revoked`, and the connection's social
 *   accounts get `removedAt` while keeping their brand mapping, so historical posts/metrics/reports stay intact.
 * - `getCredentialForWorker` is for the background worker / provider sync only. Never import it from UI modules.
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import {
  type Actor,
  AppError,
  ConflictError,
  NotFoundError,
  isUniqueViolation,
  isUuid,
  parseInput,
  requireWorkspaceAdmin,
} from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { connections, socialAccounts } from "@/server/db/schema";
import { logger } from "@/server/logger";
import type { CredentialValidationResult, ProviderErrorCode } from "@/server/providers/types";
import { ProviderError } from "@/server/providers/types";
import { decryptSecret, encryptSecret, fingerprintSecret, reencryptIfOld } from "@/server/security/crypto";
import { REDACTED, redactText } from "@/server/security/redact";

export type CredentialValidator = (secret: string) => Promise<CredentialValidationResult>;
export type ValidCredential = Extract<CredentialValidationResult, { ok: true }>;
type ConnectionRow = typeof connections.$inferSelect;

export interface PublicConnection {
  id: string;
  provider: ConnectionRow["provider"];
  label: string;
  status: ConnectionRow["status"];
  /** Masked hint such as "••••3f9c" (derived from the fingerprint, never from the key). */
  keyHint: string | null;
  externalAccountId: string | null;
  externalAccountName: string | null;
  isDemo: boolean;
  lastValidatedAt: Date | null;
  lastSyncAttemptAt: Date | null;
  lastSyncSuccessAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  createdAt: Date;
  rotatedAt: Date | null;
  accountCount: number;
  mappedAccountCount: number;
}

/** Rejected credential. Message is user-facing and provider-neutral; `providerCode` is safe to show/log. */
export class CredentialRejectedError extends AppError {
  constructor(readonly providerCode: ProviderErrorCode) {
    super("credential_rejected", 422, rejectionMessage(providerCode));
  }
}

function rejectionMessage(code: ProviderErrorCode): string {
  switch (code) {
    case "unauthorized":
      return "Buffer rejected this API key. Check that it was copied correctly and has not been revoked.";
    case "forbidden":
      return "This API key doesn't have permission to read the Buffer account.";
    case "rate_limited":
    case "quota_reserved":
      return "Buffer is rate limiting requests right now. Try again in a few minutes.";
    case "network":
    case "upstream":
      return "We couldn't reach Buffer to validate this key. Try again shortly.";
    default:
      return "We couldn't validate this API key. Check the key and try again.";
  }
}

const secretSchema = z
  .string({ error: "API key is required." })
  .trim()
  .min(16, "This doesn't look like a valid API key.")
  .max(1024, "This doesn't look like a valid API key.")
  .regex(/^[\x21-\x7e]+$/, "This doesn't look like a valid API key.");
const labelSchema = z.string({ error: "Label is required." }).trim().min(1, "Label is required.").max(80, "Label is too long.");

const keyHint = (fingerprint: string | null) => (fingerprint ? `••••${fingerprint.slice(-4)}` : null);

/** Removes the literal secret and anything secret-looking from provider-supplied text. */
function scrub(text: unknown, secret: string): string {
  const raw = typeof text === "string" ? text : "";
  return redactText(secret ? raw.split(secret).join(REDACTED) : raw).slice(0, 500);
}

async function runValidation(validate: CredentialValidator, secret: string): Promise<CredentialValidationResult> {
  try {
    const result = await validate(secret);
    if (result?.ok === true) {
      if (!result.externalAccountId) return { ok: false, code: "invalid_response", message: "Missing account id" };
      return { ...result, externalAccountName: scrub(result.externalAccountName, secret) };
    }
    return {
      ok: false,
      code: result?.code ?? "invalid_response",
      message: scrub(result?.message, secret),
    };
  } catch (err) {
    return {
      ok: false,
      code: err instanceof ProviderError ? err.code : "network",
      message: scrub(err instanceof Error ? err.message : String(err), secret),
    };
  }
}

const accountCount = sql<number>`(select count(*)::int from ${socialAccounts} sa where sa.connection_id = ${connections.id} and sa.removed_at is null)`;
const mappedCount = sql<number>`(select count(*)::int from ${socialAccounts} sa where sa.connection_id = ${connections.id} and sa.removed_at is null and sa.mapping_status = 'mapped')`;

/** Explicit column allowlist: ciphertext and full fingerprint never leave the database through this module. */
const publicColumns = {
  id: connections.id,
  provider: connections.provider,
  label: connections.label,
  status: connections.status,
  fingerprintSuffix: sql<string | null>`right(${connections.credentialFingerprint}, 4)`,
  externalAccountId: connections.externalAccountId,
  externalAccountName: connections.externalAccountName,
  isDemo: connections.isDemo,
  lastValidatedAt: connections.lastValidatedAt,
  lastSyncAttemptAt: connections.lastSyncAttemptAt,
  lastSyncSuccessAt: connections.lastSyncSuccessAt,
  lastErrorCode: connections.lastErrorCode,
  lastErrorMessage: connections.lastErrorMessage,
  consecutiveFailures: connections.consecutiveFailures,
  createdAt: connections.createdAt,
  rotatedAt: connections.rotatedAt,
  accountCount,
  mappedAccountCount: mappedCount,
};

const selectPublic = (db: Db) => db.select(publicColumns).from(connections);
type PublicRow = Awaited<ReturnType<typeof selectPublic>>[number];

function toPublic(r: PublicRow): PublicConnection {
  return {
    id: r.id,
    provider: r.provider,
    label: r.label,
    status: r.status,
    keyHint: keyHint(r.fingerprintSuffix),
    externalAccountId: r.externalAccountId,
    externalAccountName: r.externalAccountName,
    isDemo: r.isDemo,
    lastValidatedAt: r.lastValidatedAt,
    lastSyncAttemptAt: r.lastSyncAttemptAt,
    lastSyncSuccessAt: r.lastSyncSuccessAt,
    lastErrorCode: r.lastErrorCode,
    lastErrorMessage: r.lastErrorMessage ? redactText(r.lastErrorMessage) : null,
    consecutiveFailures: r.consecutiveFailures,
    createdAt: r.createdAt,
    rotatedAt: r.rotatedAt,
    accountCount: Number(r.accountCount ?? 0),
    mappedAccountCount: Number(r.mappedAccountCount ?? 0),
  };
}

async function loadPublic(db: Db, id: string): Promise<PublicConnection> {
  const [row] = await selectPublic(db)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError("Connection not found.");
  return toPublic(row);
}

async function loadActive(db: Db, id: string) {
  if (!isUuid(id)) throw new NotFoundError("Connection not found.");
  const [row] = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      label: connections.label,
      status: connections.status,
      fingerprint: connections.credentialFingerprint,
      externalAccountId: connections.externalAccountId,
    })
    .from(connections)
    .where(and(eq(connections.id, id), isNull(connections.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError("Connection not found.");
  return row;
}

async function assertKeyNotConnected(db: Db, provider: ConnectionRow["provider"], fingerprint: string, exceptId?: string) {
  const [dup] = await db
    .select({ label: connections.label })
    .from(connections)
    .where(
      and(
        eq(connections.provider, provider),
        eq(connections.credentialFingerprint, fingerprint),
        isNull(connections.deletedAt),
        exceptId ? ne(connections.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (dup) throw new ConflictError(`This API key is already connected as "${dup.label}".`);
}

/** Wraps unexpected persistence errors so SQL parameters (ciphertext, fingerprint) never propagate. */
function persistenceError(err: unknown, action: string): Error {
  if (err instanceof AppError) return err;
  if (isUniqueViolation(err)) return new ConflictError("This API key is already connected.");
  logger.error(`connection ${action} failed`, { err });
  return new Error(`We couldn't ${action} this connection. Try again.`);
}

export interface CreateConnectionInput {
  /** Fixed label, or a function deriving it from the validated account (e.g. "Buffer – <account name>"). */
  label: string | ((account: ValidCredential) => string);
  secret: string;
  provider: "buffer";
}

/** Workspace admin only. Validates the key with the provider first, then stores it encrypted. */
export async function createConnection(
  db: Db,
  actor: Actor,
  input: CreateConnectionInput,
  validate: CredentialValidator,
): Promise<PublicConnection> {
  requireWorkspaceAdmin(actor);
  if (input?.provider !== "buffer") throw new ConflictError("Unsupported provider.");
  const secret = parseInput(secretSchema, input.secret);
  if (typeof input.label === "string") parseInput(labelSchema, input.label);
  const fingerprint = fingerprintSecret(secret);
  await assertKeyNotConnected(db, "buffer", fingerprint);

  const result = await runValidation(validate, secret);
  if (!result.ok) {
    logger.warn("connection validation rejected", { providerCode: result.code, providerMessage: result.message });
    throw new CredentialRejectedError(result.code);
  }
  const [sameAccount] = await db
    .select({ label: connections.label })
    .from(connections)
    .where(
      and(
        eq(connections.provider, "buffer"),
        eq(connections.externalAccountId, result.externalAccountId),
        isNull(connections.deletedAt),
      ),
    )
    .limit(1);
  if (sameAccount) {
    throw new ConflictError(
      `This Buffer account is already connected as "${sameAccount.label}". Rotate that connection's key instead.`,
    );
  }

  const label = parseInput(labelSchema, typeof input.label === "function" ? input.label(result) : input.label);
  const { ciphertext, keyVersion } = encryptSecret(secret);
  const now = new Date();
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(connections)
        .values({
          provider: "buffer",
          label,
          status: "active",
          credentialCiphertext: ciphertext,
          credentialKeyVersion: keyVersion,
          credentialFingerprint: fingerprint,
          externalAccountId: result.externalAccountId,
          externalAccountName: result.externalAccountName,
          lastValidatedAt: now,
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: connections.id });
      if (!row) throw new Error("insert returned no row");
      await recordAudit(tx as unknown as Db, {
        actorUserId: actor.id,
        action: "connection_created",
        targetType: "connection",
        targetId: row.id,
        metadata: {
          label,
          provider: "buffer",
          keyHint: keyHint(fingerprint),
          externalAccountName: result.externalAccountName,
          organizations: result.organizations.length,
        },
      });
      return row.id;
    });
  } catch (err) {
    throw persistenceError(err, "save");
  }
  return loadPublic(db, id);
}

/**
 * Workspace admin only. Replaces the stored key after validating that the new key belongs to the SAME provider
 * account (externalAccountId); otherwise rejects so channels/history cannot silently switch accounts.
 */
export async function rotateCredential(
  db: Db,
  actor: Actor,
  connectionId: string,
  newSecret: string,
  validate: CredentialValidator,
): Promise<PublicConnection> {
  requireWorkspaceAdmin(actor);
  const conn = await loadActive(db, connectionId);
  const secret = parseInput(secretSchema, newSecret);
  const fingerprint = fingerprintSecret(secret);
  if (conn.fingerprint === fingerprint) {
    throw new ConflictError("The new API key is identical to the current one.");
  }
  await assertKeyNotConnected(db, conn.provider, fingerprint, conn.id);

  const result = await runValidation(validate, secret);
  if (!result.ok) {
    logger.warn("credential rotation rejected", { connectionId: conn.id, providerCode: result.code });
    throw new CredentialRejectedError(result.code);
  }
  if (conn.externalAccountId && result.externalAccountId !== conn.externalAccountId) {
    throw new ConflictError(
      "This API key belongs to a different Buffer account. Add it as a new connection instead of rotating.",
    );
  }

  const { ciphertext, keyVersion } = encryptSecret(secret);
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(connections)
        .set({
          credentialCiphertext: ciphertext,
          credentialKeyVersion: keyVersion,
          credentialFingerprint: fingerprint,
          externalAccountId: result.externalAccountId,
          externalAccountName: result.externalAccountName,
          status: "active",
          lastValidatedAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          consecutiveFailures: 0,
          rotatedAt: now,
          updatedAt: now,
        })
        .where(eq(connections.id, conn.id));
      await recordAudit(tx as unknown as Db, {
        actorUserId: actor.id,
        action: "connection_rotated",
        targetType: "connection",
        targetId: conn.id,
        metadata: { label: conn.label, previousKeyHint: keyHint(conn.fingerprint), keyHint: keyHint(fingerprint) },
      });
    });
  } catch (err) {
    throw persistenceError(err, "update");
  }
  return loadPublic(db, conn.id);
}

/** Workspace admin only. Soft delete; wipes the encrypted key and marks the connection's accounts as removed. */
export async function removeConnection(db: Db, actor: Actor, connectionId: string): Promise<void> {
  requireWorkspaceAdmin(actor);
  const conn = await loadActive(db, connectionId);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        status: "revoked",
        credentialCiphertext: null,
        credentialKeyVersion: null,
        credentialFingerprint: null,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(connections.id, conn.id));
    await tx
      .update(socialAccounts)
      .set({ removedAt: now, updatedAt: now })
      .where(and(eq(socialAccounts.connectionId, conn.id), isNull(socialAccounts.removedAt)));
    await recordAudit(tx as unknown as Db, {
      actorUserId: actor.id,
      action: "connection_removed",
      targetType: "connection",
      targetId: conn.id,
      metadata: { label: conn.label, keyHint: keyHint(conn.fingerprint) },
    });
  });
}

/** Workspace admin only. Active (non-deleted) connections as safe DTOs. */
export async function listConnections(db: Db, actor: Actor): Promise<PublicConnection[]> {
  requireWorkspaceAdmin(actor);
  const rows = await selectPublic(db).where(isNull(connections.deletedAt)).orderBy(asc(connections.createdAt));
  return rows.map(toPublic);
}

/** Workspace admin only. Single connection as a safe DTO. */
export async function getConnection(db: Db, actor: Actor, connectionId: string): Promise<PublicConnection> {
  requireWorkspaceAdmin(actor);
  if (!isUuid(connectionId)) throw new NotFoundError("Connection not found.");
  return loadPublic(db, connectionId);
}

/**
 * Records a validation outcome (worker or admin re-check). No authorization: callers are trusted server code.
 * unauthorized/forbidden → `invalid`; transient failures → `error`. Audited when the status changes or an actor acted.
 */
export async function markValidation(
  db: Db,
  connectionId: string,
  result: CredentialValidationResult,
  opts: { actorUserId?: string | null; now?: Date } = {},
): Promise<void> {
  const conn = await loadActive(db, connectionId);
  const now = opts.now ?? new Date();
  const nextStatus = result.ok
    ? "active"
    : result.code === "unauthorized" || result.code === "forbidden"
      ? "invalid"
      : "error";
  await db
    .update(connections)
    .set(
      result.ok
        ? {
            status: nextStatus,
            lastValidatedAt: now,
            consecutiveFailures: 0,
            lastErrorCode: null,
            lastErrorMessage: null,
            externalAccountName: result.externalAccountName,
            updatedAt: now,
          }
        : {
            status: nextStatus,
            consecutiveFailures: sql`${connections.consecutiveFailures} + 1`,
            lastErrorCode: result.code,
            lastErrorMessage: redactText(result.message ?? "").slice(0, 500),
            updatedAt: now,
          },
    )
    .where(eq(connections.id, conn.id));
  if (opts.actorUserId || conn.status !== nextStatus) {
    await recordAudit(db, {
      actorUserId: opts.actorUserId ?? null,
      action: "connection_validated",
      targetType: "connection",
      targetId: conn.id,
      metadata: { ok: result.ok, from: conn.status, to: nextStatus, ...(result.ok ? {} : { code: result.code }) },
    });
  }
}

/** Workspace admin only. Re-validates the stored key with the provider and records the outcome. */
export async function revalidateConnection(
  db: Db,
  actor: Actor,
  connectionId: string,
  validate: CredentialValidator,
): Promise<PublicConnection> {
  requireWorkspaceAdmin(actor);
  const { secret } = await getCredentialForWorker(db, connectionId);
  const result = await runValidation(validate, secret);
  await markValidation(db, connectionId, result, { actorUserId: actor.id });
  return loadPublic(db, connectionId);
}

export interface WorkerCredential {
  connectionId: string;
  provider: ConnectionRow["provider"];
  status: ConnectionRow["status"];
  /** Non-enumerable: excluded from JSON.stringify / spreads / console inspection of the object. */
  readonly secret: string;
}

/**
 * SERVER/WORKER ONLY. Decrypts a connection's credential for provider calls. Never pass the result to UI code,
 * logs, reports or AI prompts. Opportunistically re-encrypts ciphertext that still uses a previous KEK version.
 */
export async function getCredentialForWorker(db: Db, connectionId: string): Promise<WorkerCredential> {
  if (typeof window !== "undefined") throw new Error("getCredentialForWorker is server-only");
  if (!isUuid(connectionId)) throw new NotFoundError("Connection credential not available.");
  const [row] = await db
    .select({
      provider: connections.provider,
      status: connections.status,
      ciphertext: connections.credentialCiphertext,
    })
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)))
    .limit(1);
  if (!row?.ciphertext || row.status === "revoked") throw new NotFoundError("Connection credential not available.");
  const secret = decryptSecret(row.ciphertext);
  const upgraded = reencryptIfOld(row.ciphertext);
  if (upgraded) {
    await db
      .update(connections)
      .set({ credentialCiphertext: upgraded.ciphertext, credentialKeyVersion: upgraded.keyVersion })
      .where(and(eq(connections.id, connectionId), eq(connections.credentialCiphertext, row.ciphertext)));
  }
  const credential = { connectionId, provider: row.provider, status: row.status } as WorkerCredential;
  Object.defineProperty(credential, "secret", { value: secret, enumerable: false });
  return credential;
}

/** Key rotation helper for scripts: re-encrypts every stored credential still using an old KEK version. */
export async function reencryptAllCredentials(db: Db): Promise<{ updated: number }> {
  const rows = await db
    .select({ id: connections.id, ciphertext: connections.credentialCiphertext })
    .from(connections)
    .where(and(isNull(connections.deletedAt), sql`${connections.credentialCiphertext} is not null`));
  let updated = 0;
  for (const row of rows) {
    const next = row.ciphertext ? reencryptIfOld(row.ciphertext) : null;
    if (!next) continue;
    await db
      .update(connections)
      .set({ credentialCiphertext: next.ciphertext, credentialKeyVersion: next.keyVersion })
      .where(and(eq(connections.id, row.id), eq(connections.credentialCiphertext, row.ciphertext!)));
    updated++;
  }
  return { updated };
}
