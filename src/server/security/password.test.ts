import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  BCRYPT_COST,
  PasswordPolicyError,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "./password";

describe("password policy", () => {
  it("requires at least 12 characters and at most 72 bytes", () => {
    expect(checkPasswordPolicy("short-pass1")).toEqual(["Password must be at least 12 characters."]);
    expect(checkPasswordPolicy("a-very-good-passphrase")).toEqual([]);
    expect(checkPasswordPolicy("é".repeat(37))).toContain("Password must be at most 72 bytes.");
    expect(checkPasswordPolicy("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂")).toContain("Password must be at least 12 characters.");
  });

  it("rejects repeated characters, common passwords and the email local part", () => {
    expect(checkPasswordPolicy("aaaaaaaaaaaaaa")).toContain("Password cannot be a single repeated character.");
    expect(checkPasswordPolicy("Password1234")).toContain("Password is too common.");
    expect(checkPasswordPolicy("jeanne-rocks-2026", { email: "jeanne@example.com" })).toContain(
      "Password must not contain your email address.",
    );
  });

  it("hashPassword enforces the policy and uses cost 12", async () => {
    await expect(hashPassword("short")).rejects.toBeInstanceOf(PasswordPolicyError);
    const hash = await hashPassword("a-very-good-passphrase");
    expect(bcrypt.getRounds(hash)).toBe(BCRYPT_COST);
    expect(BCRYPT_COST).toBe(12);
    expect(await verifyPassword("a-very-good-passphrase", hash)).toBe(true);
    expect(await verifyPassword("a-very-good-passphrasE", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });
});

describe("verifyPassword", () => {
  const hash = bcrypt.hashSync("x".repeat(72), 4);

  it("rejects inputs beyond 72 bytes instead of truncating", async () => {
    expect(await verifyPassword("x".repeat(72), hash)).toBe(true);
    expect(await verifyPassword(`${"x".repeat(72)}extra`, hash)).toBe(false);
  });

  it("returns false for missing/invalid hashes and empty passwords", async () => {
    expect(await verifyPassword("anything-at-all", null)).toBe(false);
    expect(await verifyPassword("anything-at-all", "not-a-hash")).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(true);
  });
});
