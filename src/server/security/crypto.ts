/**
 * Envelope encryption for provider credentials (AES-256-GCM). Server-only.
 *
 * Serialized ciphertext (binary parts are base64url, fields separated by ":"):
 *
 *   v1:<keyVersion>:<wrapIv>:<wrappedDek>:<wrapTag>:<iv>:<ciphertext>:<tag>
 *
 * - A fresh random 32-byte data-encryption key (DEK) is generated per secret and encrypted ("wrapped") with the
 *   key-encryption key (KEK) identified by <keyVersion>; the secret itself is encrypted with the DEK.
 * - Both GCM operations authenticate the header `v1:<keyVersion>` as AAD, so the version cannot be swapped,
 *   and 16-byte tags are enforced on decryption (no truncated-tag forgeries).
 * - Only the KEK lives outside the database: BRANDPULSE_KEK_FILE (preferred; a file outside the repo containing
 *   the base64 key) or BRANDPULSE_KEK (base64). BRANDPULSE_KEK_VERSION (default 1) names the current key.
 *
 * Rotation: generate a new key, set BRANDPULSE_KEK_VERSION=<n+1>, expose the old one as
 * BRANDPULSE_KEK_PREVIOUS="<n>:<base64 key>" (or just the base64 key, implying version n), then re-encrypt rows
 * with `reencryptIfOld` (see reencryptAllCredentials in connections/service.ts) and finally drop the previous key.
 *
 * Fails closed: any missing/invalid key configuration throws CryptoConfigError; nothing is ever stored in plaintext.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FORMAT = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export class CryptoConfigError extends Error {
  override name = "CryptoConfigError";
}

/** Thrown for malformed, tampered or undecryptable ciphertext. Never includes key or plaintext material. */
export class DecryptionError extends Error {
  override name = "DecryptionError";
}

interface Keyring {
  version: number;
  key: Buffer;
  byVersion: Map<number, Buffer>;
}

let cache: { sig: string; ring: Keyring } | undefined;
let warnedPermissions = false;

function decodeKey(text: string, source: string): Buffer {
  const trimmed = text.trim();
  const key = B64_RE.test(trimmed) ? Buffer.from(trimmed, "base64") : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(`${source} must be a base64-encoded 32-byte key`);
  }
  return key;
}

function parseVersion(raw: string | undefined, source: string): number {
  const v = raw === undefined || raw.trim() === "" ? 1 : Number(raw.trim());
  if (!Number.isInteger(v) || v < 1 || v > 1_000_000) throw new CryptoConfigError(`${source} must be a positive integer`);
  return v;
}

function loadKeyring(): Keyring {
  const env = process.env;
  const file = env.BRANDPULSE_KEK_FILE?.trim() ?? "";
  const inline = env.BRANDPULSE_KEK?.trim() ?? "";
  const previous = env.BRANDPULSE_KEK_PREVIOUS?.trim() ?? "";
  const sig = [file, inline, env.BRANDPULSE_KEK_VERSION ?? "", previous].join("\0");
  if (cache?.sig === sig) return cache.ring;

  const version = parseVersion(env.BRANDPULSE_KEK_VERSION, "BRANDPULSE_KEK_VERSION");
  let key: Buffer;
  if (file) {
    let text: string;
    try {
      // The KEK path is a runtime secret mount, not a build dependency.
      const stat = fs.statSync(/* turbopackIgnore: true */ file);
      if (!warnedPermissions && (stat.mode & 0o077) !== 0) {
        warnedPermissions = true;
        process.emitWarning(`BRANDPULSE_KEK_FILE (${file}) is readable by other users; run chmod 600 on it`);
      }
      text = fs.readFileSync(/* turbopackIgnore: true */ file, "utf8");
    } catch {
      throw new CryptoConfigError(`BRANDPULSE_KEK_FILE could not be read: ${file}`);
    }
    key = decodeKey(text, "BRANDPULSE_KEK_FILE");
  } else if (inline) {
    key = decodeKey(inline, "BRANDPULSE_KEK");
  } else {
    throw new CryptoConfigError(
      "Credential encryption key is not configured: set BRANDPULSE_KEK_FILE (preferred) or BRANDPULSE_KEK",
    );
  }

  const byVersion = new Map<number, Buffer>([[version, key]]);
  if (previous) {
    const sep = previous.indexOf(":");
    const prevVersion = sep > 0 ? parseVersion(previous.slice(0, sep), "BRANDPULSE_KEK_PREVIOUS version") : version - 1;
    const prevKey = decodeKey(sep > 0 ? previous.slice(sep + 1) : previous, "BRANDPULSE_KEK_PREVIOUS");
    if (prevVersion < 1 || prevVersion === version) {
      throw new CryptoConfigError("BRANDPULSE_KEK_PREVIOUS must use a version different from BRANDPULSE_KEK_VERSION");
    }
    byVersion.set(prevVersion, prevKey);
  }
  const ring = { version, key, byVersion };
  cache = { sig, ring };
  return ring;
}

/** Throws CryptoConfigError when the KEK is missing or invalid. Call at process start to fail fast. */
export function assertKekConfigured(): { keyVersion: number } {
  return { keyVersion: loadKeyring().version };
}

/** Test hook: forget cached keys (e.g. after changing env vars). */
export function resetKeyringCache(): void {
  cache = undefined;
}

const b64 = (buf: Buffer) => buf.toString("base64url");

function seal(key: Buffer, plain: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [b64(iv), b64(data), b64(cipher.getAuthTag())];
}

function open(key: Buffer, ivB64: string, dataB64: string, tagB64: string, aad: Buffer): Buffer {
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]);
}

/** Encrypts a secret with a fresh data key wrapped by the current KEK. */
export function encryptSecret(plain: string): { ciphertext: string; keyVersion: number } {
  if (typeof plain !== "string" || plain.length === 0) throw new TypeError("Secret must be a non-empty string");
  const { version, key } = loadKeyring();
  const aad = Buffer.from(`${FORMAT}:${version}`);
  const dek = randomBytes(KEY_BYTES);
  try {
    const wrapped = seal(key, dek, aad);
    const sealed = seal(dek, Buffer.from(plain, "utf8"), aad);
    return { ciphertext: [FORMAT, String(version), ...wrapped, ...sealed].join(":"), keyVersion: version };
  } finally {
    dek.fill(0);
  }
}

/** Returns the key version recorded in a ciphertext, or throws DecryptionError when malformed. */
export function ciphertextKeyVersion(ciphertext: string): number {
  const parts = typeof ciphertext === "string" ? ciphertext.split(":") : [];
  const version = Number(parts[1]);
  if (parts.length !== 8 || parts[0] !== FORMAT || !Number.isInteger(version) || version < 1) {
    throw new DecryptionError("Unsupported credential ciphertext format");
  }
  return version;
}

/** Decrypts a value produced by encryptSecret. Throws DecryptionError (tampering/wrong key) or CryptoConfigError. */
export function decryptSecret(ciphertext: string): string {
  const version = ciphertextKeyVersion(ciphertext);
  const key = loadKeyring().byVersion.get(version);
  if (!key) {
    throw new CryptoConfigError(`Encryption key version ${version} is not available (configure BRANDPULSE_KEK_PREVIOUS)`);
  }
  const [, , wIv = "", wData = "", wTag = "", iv = "", data = "", tag = ""] = ciphertext.split(":");
  const aad = Buffer.from(`${FORMAT}:${version}`);
  let dek: Buffer | undefined;
  try {
    dek = open(key, wIv, wData, wTag, aad);
    if (dek.length !== KEY_BYTES) throw new DecryptionError("Malformed data key");
    return open(dek, iv, data, tag, aad).toString("utf8");
  } catch {
    throw new DecryptionError("Credential could not be decrypted (wrong key or tampered data)");
  } finally {
    dek?.fill(0);
  }
}

/** Re-encrypts with the current KEK when the ciphertext uses an older key version; returns null when current. */
export function reencryptIfOld(ciphertext: string): { ciphertext: string; keyVersion: number } | null {
  if (ciphertextKeyVersion(ciphertext) === loadKeyring().version) return null;
  return encryptSecret(decryptSecret(ciphertext));
}

/** First 12 hex chars of SHA-256(secret): duplicate detection and masked display without storing the secret. */
export function fingerprintSecret(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex").slice(0, 12);
}

/**
 * Development helper (explicit use by scripts only): creates a random KEK at ~/.brandpulse/kek with mode 600,
 * or validates the existing one. Returns the path so the caller can print `BRANDPULSE_KEK_FILE=<path>`.
 */
export function ensureLocalKek(filePath = path.join(os.homedir(), ".brandpulse", "kek")): {
  path: string;
  created: boolean;
} {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filePath, `${randomBytes(KEY_BYTES).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    return { path: filePath, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    decodeKey(fs.readFileSync(filePath, "utf8"), filePath);
    fs.chmodSync(filePath, 0o600);
    return { path: filePath, created: false };
  }
}
