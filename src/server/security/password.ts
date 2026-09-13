/** Password hashing (bcrypt, cost 12) and password policy. Server-only. */
import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;
export const PASSWORD_MIN_LENGTH = 12;
/** bcrypt silently ignores bytes beyond 72, so longer passwords are rejected instead of truncated. */
export const PASSWORD_MAX_BYTES = 72;

/** Valid cost-12 hash of an unused random string; compared against when the user does not exist (timing parity). */
const DUMMY_HASH = "$2b$12$jA838TFR3PGRPyf6lvcCeOLh6H8.c68HFnIHfGd2EwrJ2rlgy/TZ2";

const COMMON_PASSWORDS = new Set([
  "password1234",
  "password12345",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "qwertyuiopas",
  "changeme1234",
  "letmein12345",
  "welcome12345",
  "adminadmin12",
  "administrator",
  "brandpulse123",
  "iloveyou1234",
]);

export class PasswordPolicyError extends Error {
  override name = "PasswordPolicyError";
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
  }
}

/** Returns human-readable policy violations (empty when the password is acceptable). */
export function checkPasswordPolicy(password: string, context: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (typeof password !== "string") return ["Password is required."];
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    problems.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    problems.push(`Password must be at most ${PASSWORD_MAX_BYTES} bytes.`);
  }
  const lower = password.toLowerCase();
  if (/^(.)\1*$/su.test(password)) problems.push("Password cannot be a single repeated character.");
  else if (COMMON_PASSWORDS.has(lower)) problems.push("Password is too common.");
  const localPart = context.email?.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    problems.push("Password must not contain your email address.");
  }
  return problems;
}

export function assertPasswordPolicy(password: string, context?: { email?: string; name?: string }): void {
  const problems = checkPasswordPolicy(password, context);
  if (problems.length) throw new PasswordPolicyError(problems);
}

/** Hashes a password after enforcing the policy. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Constant-time verification (bcrypt compare). Always performs a full bcrypt comparison, even when the hash is
 * missing or the input is invalid, so response time does not reveal whether an account exists.
 */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const usable =
    typeof password === "string" && password.length > 0 && Buffer.byteLength(password, "utf8") <= PASSWORD_MAX_BYTES;
  const target = typeof hash === "string" && hash.startsWith("$2") ? hash : DUMMY_HASH;
  try {
    const match = await bcrypt.compare(usable ? password : "invalid-password-input", target);
    return usable && target === hash && match;
  } catch {
    return false;
  }
}

/** True when the stored hash was produced with a lower cost than the current policy. */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST;
  } catch {
    return true;
  }
}
