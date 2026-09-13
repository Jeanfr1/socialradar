import { randomBytes, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, looksLikeSecret, redact, redactText, serializeError } from "./redact";

const secret = randomBytes(32).toString("base64url");

describe("redact (objects)", () => {
  it("redacts sensitive keys at any depth, case-insensitively", () => {
    const input = {
      apiKey: "k1",
      api_key: "k2",
      "x-api-key": "k3",
      BUFFER_API_KEY: "k4",
      Authorization: "Bearer abc",
      nested: { password: "p", sessionToken: 42, cookie: ["a", "b"], kek: "base64", credential: { any: "thing" } },
      list: [{ clientSecret: "s" }, { safe: "value" }],
      privateKey: "pem",
    };
    const out = redact(input);
    expect(out).toEqual({
      apiKey: REDACTED,
      api_key: REDACTED,
      "x-api-key": REDACTED,
      BUFFER_API_KEY: REDACTED,
      Authorization: REDACTED,
      nested: { password: REDACTED, sessionToken: REDACTED, cookie: REDACTED, kek: REDACTED, credential: REDACTED },
      list: [{ clientSecret: REDACTED }, { safe: "value" }],
      privateKey: REDACTED,
    });
    expect(input.apiKey).toBe("k1"); // input not mutated
  });

  it("keeps null/boolean flags and token counts", () => {
    expect(redact({ hasCredential: true, token: null, inputTokens: 120, max_tokens: 800, tokensUsed: 3 })).toEqual({
      hasCredential: true,
      token: null,
      inputTokens: 120,
      max_tokens: 800,
      tokensUsed: 3,
    });
    expect(isSensitiveKey("accessToken")).toBe(true);
    expect(isSensitiveKey("brandId")).toBe(false);
  });

  it("handles circular structures, Maps, Headers, Dates, bigint and Errors", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const date = new Date("2026-09-13T12:00:00.000Z");
    const headers = new Headers({ authorization: `Bearer ${secret}`, "content-type": "application/json" });
    const out = redact({ a, m: new Map([["token", "t"]]), headers, date, big: 10n, err: new Error(`failed with ${secret}`) });
    expect(out.a).toEqual({ name: "a", self: "[Circular]" });
    expect(out.m).toEqual({ token: REDACTED });
    expect(out.headers).toEqual({ authorization: REDACTED, "content-type": "application/json" });
    expect(out.date).toBe(date);
    expect(out.big).toBe("10");
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});

describe("redactText", () => {
  it("masks Bearer tokens, key=value pairs, JSON fragments, JWTs, bcrypt hashes, PEM keys and ciphertexts", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const cases = [
      `Authorization: Bearer ${secret}`,
      `calling with bearer ${secret}`,
      `https://api.example.com/v1?access_token=${secret}&x=1`,
      `{"apiKey":"${secret}","ok":true}`,
      `api_key=${secret}`,
      `password: hunter2hunter2`,
      `jwt ${jwt}`,
      "$2b$12$jA838TFR3PGRPyf6lvcCeOLh6H8.c68HFnIHfGd2EwrJ2rlgy/TZ2",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
      "v1:1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBB:CCCCCCCCCCCCCCCCCCCCCC:DDDDDDDDDDDDDDDD:EEEE:FFFFFFFFFFFFFFFFFFFFFF",
    ];
    for (const text of cases) {
      const out = redactText(text);
      expect(out, text).toContain(REDACTED);
      expect(out).not.toContain(secret);
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("eyJzdWIi");
      expect(out).not.toContain("MIIEvQ");
    }
  });

  it("masks random high-entropy tokens (base64url, hex digests)", () => {
    const hex = createHash("sha256").update("x").digest("hex");
    expect(redactText(`key ${secret} used`)).toBe(`key ${REDACTED} used`);
    expect(redactText(`digest ${hex}`)).toBe(`digest ${REDACTED}`);
    expect(looksLikeSecret(randomBytes(18).toString("hex"))).toBe(true);
  });

  it("preserves UUIDs, ISO timestamps, identifiers, paths, URLs and prose", () => {
    const safe = [
      "brand 3f1b8c9e-6d2a-4c1e-9b7a-2f4d6e8a0b1c not found",
      "ids 3f1b8c9e-6d2a-4c1e-9b7a-2f4d6e8a0b1c/5a6b7c8d-1e2f-4a3b-8c9d-0e1f2a3b4c5d",
      "queue_coverage:3f1b8c9e-6d2a-4c1e-9b7a-2f4d6e8a0b1c",
      "synced at 2026-09-13T15:23:00.000Z (window 2026-09-07/2026-09-13)",
      "unique index social_accounts_platform_identity_idx violated",
      "column credentialKeyVersion2026 and reportScheduleDayOfWeek",
      "/Users/someone/Desktop/SocialRadar/src/server/security/redact.ts:42:7",
      "https://buffer.com/app/profile/instagram/queue",
      "Password must be at least 12 characters.",
      "Invalid API key provided — check your settings",
      "epoch 1726243200000 and version 20260913152300_add_index",
      "request 42 took 1234ms; 1.2.3.4 responded",
    ];
    for (const text of safe) expect(redactText(text), text).toBe(text);
  });

  it("is idempotent", () => {
    const once = redactText(`token=${secret} Authorization: Bearer ${secret} password: "abc"`);
    expect(redactText(once)).toBe(once);
    expect(redact(redact({ note: once }))).toEqual({ note: once });
  });
});

describe("serializeError", () => {
  it("never exposes query parameters from database errors", () => {
    const err = Object.assign(new Error(`Failed query: insert into connections\nparams: ${secret}`), {
      query: "insert into connections",
      params: [secret],
      cause: Object.assign(new Error("duplicate key value"), { code: "23505" }),
    });
    const out = serializeError(err);
    expect(out.message).toBe("Database query failed");
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.cause).toMatchObject({ message: "duplicate key value", code: "23505" });
  });
});
