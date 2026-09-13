/**
 * Deep redaction for anything that may reach logs, audit metadata, error reports or AI prompts.
 *
 * - Object keys that look sensitive (token, secret, password, authorization, api key, credential, cookie, kek, ...)
 *   have their value replaced by "[REDACTED]" (null/undefined/booleans are kept: they cannot carry secrets).
 *   Token *counts* such as `inputTokens` are not treated as secrets.
 * - Free text: `key=value` / `key: value` pairs with sensitive keys, Bearer tokens, JWTs, bcrypt hashes, PEM private
 *   keys, BrandPulse ciphertexts and long high-entropy strings are masked. UUIDs, ISO timestamps, file paths and
 *   snake/camel-case identifiers are preserved.
 * Redaction is idempotent, so values may safely pass through it more than once.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|credential|cookie|kek|private[_-]?key/i;
const SAFE_KEY = /(?:input|output|max|total|prompt|completion)_?tokens$|tokens?_?(?:count|used)$/i;
const MAX_DEPTH = 12;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key);
}

const KV_IN_TEXT =
  /\b([\w.-]*(?:token|secret|password|passwd|authorization|api[_-]?key|credential|cookie|kek)[\w.-]*)("?\s*[:=]\s*"?|'?\s*[:=]\s*'?)(?!\[REDACTED\])(?:(?:Bearer|Basic)\s+)?[^\s"'&,;}\]]+/gi;
const BEARER = /\bBearer\s+(?:(?=[\w.~+/=-]*\d)[\w.~+/=-]{8,}|[\w.~+/=-]{20,})/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const BCRYPT = /\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const ENVELOPE = /\bv1:\d+(?::[\w-]+){6}/g;
const CANDIDATE = /[A-Za-z0-9_+/=-]{20,}/g;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Dictionary-like segments: lowercase, camelCase/PascalCase or ALLCAPS words (optionally digit-suffixed), or digits. */
const WORDISH = /^(?:(?:[a-z]+(?:[A-Z][a-z]+)*|(?:[A-Z][a-z]+)+|[A-Z]+)\d*|\d+)?$/;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Heuristic for random-looking tokens (API keys, hashes, session tokens) embedded in free text. */
export function looksLikeSecret(candidate: string): boolean {
  const s = candidate.replace(UUID_G, "");
  if (s.length < 20 || !/\d/.test(s) || !/[A-Za-z]/.test(s)) return false;
  const suspicious = s
    .split(/[/_+=-]/)
    .filter((seg) => !WORDISH.test(seg))
    .join("");
  return suspicious.length >= 16 && shannonEntropy(suspicious) >= 3;
}

/** Redacts secrets embedded in free text. */
export function redactText(text: string): string {
  if (!text) return text;
  return text
    .replace(PEM, REDACTED)
    .replace(ENVELOPE, REDACTED)
    .replace(KV_IN_TEXT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(BCRYPT, REDACTED)
    .replace(CANDIDATE, (m) => (looksLikeSecret(m) ? REDACTED : m));
}

/**
 * Serializes an Error without leaking data: the message is redacted, the stack loses its first line (which repeats
 * the message) and database query errors never expose their SQL parameters.
 */
export function serializeError(err: Error, depth = 0): Record<string, unknown> {
  const isQueryError = "query" in err && "params" in err;
  const out: Record<string, unknown> = {
    name: err.name,
    message: isQueryError ? "Database query failed" : redactText(err.message),
  };
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  if (err.stack) out.stack = redactText(err.stack.split("\n").slice(1).join("\n"));
  if (err.cause !== undefined && depth < 3) {
    out.cause = err.cause instanceof Error ? serializeError(err.cause, depth + 1) : walk(err.cause, new WeakSet(), depth);
  }
  return out;
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[Binary]";
  if (value instanceof Error) return serializeError(value);
  if (value instanceof URL) return redactText(value.toString());
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, seen, depth + 1));
    const entries: [string, unknown][] =
      value instanceof Map
        ? [...value.entries()].map(([k, v]) => [String(k), v])
        : typeof Headers !== "undefined" && value instanceof Headers
          ? [...value.entries()]
          : value instanceof Set
            ? [...value.values()].map((v, i) => [String(i), v])
            : Object.entries(value);
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) {
      if (isSensitiveKey(key) && v !== null && v !== undefined && typeof v !== "boolean") out[key] = REDACTED;
      else {
        const next = walk(v, seen, depth + 1);
        if (next !== undefined) out[key] = next;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Returns a deep, redacted copy of `value` (plain objects/arrays; Errors, Maps, Sets and Headers are normalized). */
export function redact<T>(value: T): T {
  return walk(value, new WeakSet(), 0) as T;
}
