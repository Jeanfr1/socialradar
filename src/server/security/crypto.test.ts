import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CryptoConfigError,
  DecryptionError,
  assertKekConfigured,
  ciphertextKeyVersion,
  decryptSecret,
  encryptSecret,
  ensureLocalKek,
  fingerprintSecret,
  reencryptIfOld,
  resetKeyringCache,
} from "./crypto";

const ENV_KEYS = ["BRANDPULSE_KEK", "BRANDPULSE_KEK_FILE", "BRANDPULSE_KEK_VERSION", "BRANDPULSE_KEK_PREVIOUS"] as const;
const saved: Partial<Record<string, string | undefined>> = {};
const newKey = () => randomBytes(32).toString("base64");

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  resetKeyringCache();
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetKeyringCache();
});

describe("envelope encryption", () => {
  it("round-trips and uses a fresh data key and IV per call", () => {
    setEnv({ BRANDPULSE_KEK: newKey() });
    const secret = "buffer-key-ünïcode-1234567890";
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a.keyVersion).toBe(1);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.ciphertext.split(":")).toHaveLength(8);
    expect(a.ciphertext.startsWith("v1:1:")).toBe(true);
    expect(a.ciphertext).not.toContain(secret);
    expect(decryptSecret(a.ciphertext)).toBe(secret);
    expect(decryptSecret(b.ciphertext)).toBe(secret);
  });

  it("detects tampering in every field", () => {
    setEnv({ BRANDPULSE_KEK: newKey() });
    const { ciphertext } = encryptSecret("super-secret-value-123");
    const parts = ciphertext.split(":");
    for (const i of [2, 3, 4, 5, 6, 7]) {
      const copy = [...parts];
      const buf = Buffer.from(copy[i]!, "base64url");
      buf[0] = buf[0]! ^ 0xff;
      copy[i] = buf.toString("base64url");
      expect(() => decryptSecret(copy.join(":"))).toThrow(DecryptionError);
    }
    expect(() => decryptSecret("garbage")).toThrow(DecryptionError);
    expect(() => decryptSecret(`v2:${parts.slice(1).join(":")}`)).toThrow(DecryptionError);
  });

  it("rejects truncated auth tags", () => {
    setEnv({ BRANDPULSE_KEK: newKey() });
    const parts = encryptSecret("super-secret-value-123").ciphertext.split(":");
    parts[7] = Buffer.from(parts[7]!, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow(DecryptionError);
  });

  it("binds the key version (AAD) so the header cannot be swapped", () => {
    const key = newKey();
    setEnv({ BRANDPULSE_KEK: key, BRANDPULSE_KEK_VERSION: "2", BRANDPULSE_KEK_PREVIOUS: `1:${key}` });
    const { ciphertext } = encryptSecret("value-with-version-2");
    const swapped = ciphertext.replace(/^v1:2:/, "v1:1:");
    expect(() => decryptSecret(swapped)).toThrow(DecryptionError);
  });

  it("fails with the wrong key without leaking plaintext", () => {
    setEnv({ BRANDPULSE_KEK: newKey() });
    const { ciphertext } = encryptSecret("plaintext-should-not-leak");
    setEnv({ BRANDPULSE_KEK: newKey() });
    try {
      decryptSecret(ciphertext);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      expect(String((err as Error).message)).not.toContain("plaintext-should-not-leak");
    }
  });

  it("fails closed when the KEK is missing or invalid", () => {
    setEnv({});
    expect(() => encryptSecret("x-secret-value")).toThrow(CryptoConfigError);
    expect(() => assertKekConfigured()).toThrow(/not configured/);
    setEnv({ BRANDPULSE_KEK: Buffer.alloc(16).toString("base64") });
    expect(() => encryptSecret("x-secret-value")).toThrow(/32-byte/);
    setEnv({ BRANDPULSE_KEK: "not base64 !!" });
    expect(() => encryptSecret("x-secret-value")).toThrow(CryptoConfigError);
    setEnv({ BRANDPULSE_KEK: newKey(), BRANDPULSE_KEK_VERSION: "zero" });
    expect(() => encryptSecret("x-secret-value")).toThrow(CryptoConfigError);
    setEnv({ BRANDPULSE_KEK_FILE: path.join(os.tmpdir(), "does-not-exist-brandpulse-kek") });
    expect(() => encryptSecret("x-secret-value")).toThrow(CryptoConfigError);
  });

  it("prefers BRANDPULSE_KEK_FILE over BRANDPULSE_KEK", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-kek-"));
    const fileKey = newKey();
    const file = path.join(dir, "kek");
    fs.writeFileSync(file, `${fileKey}\n`, { mode: 0o600 });
    setEnv({ BRANDPULSE_KEK_FILE: file, BRANDPULSE_KEK: newKey() });
    const { ciphertext } = encryptSecret("file-key-secret");
    setEnv({ BRANDPULSE_KEK: fileKey });
    expect(decryptSecret(ciphertext)).toBe("file-key-secret");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("supports rotation with BRANDPULSE_KEK_PREVIOUS and re-encryption", () => {
    const oldKey = newKey();
    const nextKey = newKey();
    setEnv({ BRANDPULSE_KEK: oldKey });
    const old = encryptSecret("rotating-secret-1");
    expect(reencryptIfOld(old.ciphertext)).toBeNull();

    setEnv({ BRANDPULSE_KEK: nextKey, BRANDPULSE_KEK_VERSION: "2" });
    expect(() => decryptSecret(old.ciphertext)).toThrow(/version 1 is not available/);

    setEnv({ BRANDPULSE_KEK: nextKey, BRANDPULSE_KEK_VERSION: "2", BRANDPULSE_KEK_PREVIOUS: `1:${oldKey}` });
    expect(decryptSecret(old.ciphertext)).toBe("rotating-secret-1");
    const upgraded = reencryptIfOld(old.ciphertext);
    expect(upgraded?.keyVersion).toBe(2);
    expect(ciphertextKeyVersion(upgraded!.ciphertext)).toBe(2);

    setEnv({ BRANDPULSE_KEK: nextKey, BRANDPULSE_KEK_VERSION: "2" });
    expect(decryptSecret(upgraded!.ciphertext)).toBe("rotating-secret-1");
    expect(reencryptIfOld(upgraded!.ciphertext)).toBeNull();
  });

  it("rejects a previous key with the same version", () => {
    const key = newKey();
    setEnv({ BRANDPULSE_KEK: key, BRANDPULSE_KEK_PREVIOUS: `1:${newKey()}` });
    expect(() => encryptSecret("x-secret-value")).toThrow(CryptoConfigError);
  });
});

describe("fingerprintSecret", () => {
  it("is 12 lowercase hex chars, deterministic and key-specific", () => {
    const fp = fingerprintSecret("abc");
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).toBe("ba7816bf8f01");
    expect(fingerprintSecret("abd")).not.toBe(fp);
  });
});

describe("ensureLocalKek", () => {
  it("creates a 600 key file once and validates it afterwards", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-local-"));
    const file = path.join(dir, "nested", "kek");
    const first = ensureLocalKek(file);
    expect(first).toEqual({ path: file, created: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(file, "utf8").trim();
    expect(Buffer.from(content, "base64")).toHaveLength(32);
    expect(ensureLocalKek(file)).toEqual({ path: file, created: false });
    expect(fs.readFileSync(file, "utf8").trim()).toBe(content);

    setEnv({ BRANDPULSE_KEK_FILE: file });
    expect(decryptSecret(encryptSecret("local-kek-secret").ciphertext)).toBe("local-kek-secret");

    fs.writeFileSync(file, "short");
    expect(() => ensureLocalKek(file)).toThrow(CryptoConfigError);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
