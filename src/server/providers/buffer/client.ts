/**
 * Read-only Buffer GraphQL transport.
 * - Refuses mutation/subscription documents: BrandPulse never changes content in Buffer.
 * - Maps HTTP and GraphQL errors to ProviderError codes. Any GraphQL error fails the whole request, so a
 *   partial response can never be mistaken for an empty queue.
 * - Retries transient failures (5xx, network, short rate limits) with exponential backoff + jitter.
 * - Never includes the API key in errors or return values.
 */
import { backoffDelayMs } from "@/server/jobs/backoff";
import { ProviderError, type RateLimitWindow } from "@/server/providers/types";
import { parseRateLimitHeaders } from "./quota";

export const BUFFER_GRAPHQL_ENDPOINT = "https://api.buffer.com";

export interface BufferClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Runs before every HTTP attempt. Throw ProviderError("quota_reserved") to stop spending quota. */
  beforeRequest?: () => void | Promise<void>;
  onRateLimit?: (windows: RateLimitWindow[]) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

type GraphQLErrorShape = { message?: string; extensions?: { code?: string } };

const MAX_INLINE_RETRY_WAIT_MS = 60_000;

export function assertReadOnlyDocument(document: string): void {
  const withoutStrings = document.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#[^\n]*/g, "");
  if (/(^|[\s}])(mutation|subscription)\b/.test(withoutStrings)) {
    throw new ProviderError("invalid_response", "BrandPulse only performs read-only Buffer queries");
  }
}

function sanitizeProviderMessage(message: string | undefined): string {
  if (!message) return "";
  if (/<html|<body|<\/?h1/i.test(message)) return "upstream gateway error";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 300);
}

export function mapGraphQLErrors(errors: GraphQLErrorShape[], httpStatus: number): ProviderError {
  const first = errors.find((e) => e.extensions?.code) ?? errors[0];
  const code = first?.extensions?.code ?? "";
  const msg = sanitizeProviderMessage(first?.message);
  switch (code) {
    case "UNAUTHORIZED":
    case "UNAUTHENTICATED":
      return new ProviderError("unauthorized", "Buffer rejected the API key. Generate a new key in Buffer and rotate this connection.");
    case "FORBIDDEN":
      return new ProviderError("forbidden", `Buffer denied access: ${msg}`);
    case "NOT_FOUND":
      return new ProviderError("not_found", `Buffer resource not found: ${msg}`);
    case "RATE_LIMIT_EXCEEDED":
      return new ProviderError("rate_limited", "Buffer rate limit exceeded");
    case "UPSTREAM_SERVER_ERROR":
    case "UNEXPECTED":
    case "INTERNAL_SERVER_ERROR":
      return new ProviderError("upstream", `Buffer upstream error (HTTP ${httpStatus}): ${msg}`);
    default:
      if (httpStatus >= 500) return new ProviderError("upstream", `Buffer upstream error (HTTP ${httpStatus}): ${msg}`);
      return new ProviderError("invalid_response", `Buffer rejected the query (${code || "unknown"}): ${msg}`);
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export class BufferClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly opts: BufferClientOptions;
  /** HTTP attempts made by this client (includes retries). */
  requestsUsed = 0;
  lastRateLimit: RateLimitWindow[] = [];

  constructor(opts: BufferClientOptions) {
    if (!opts.token) throw new ProviderError("unauthorized", "Missing Buffer API key");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.opts = opts;
  }

  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    assertReadOnlyDocument(document);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(document, variables);
      } catch (err) {
        const error = err instanceof ProviderError ? err : new ProviderError("network", "Buffer request failed");
        const wait = error.retryAfterMs ?? backoffDelayMs(attempt, { baseMs: 1000, capMs: 30_000, random: this.opts.random });
        const retry =
          error.retryable && error.code !== "quota_reserved" && attempt < this.maxRetries && wait <= MAX_INLINE_RETRY_WAIT_MS;
        if (!retry) throw error;
        await sleep(wait);
      }
    }
  }

  private async attempt<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    await this.opts.beforeRequest?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    this.requestsUsed++;
    try {
      res = await this.fetchImpl(BUFFER_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new ProviderError("network", timedOut ? "Buffer request timed out" : "Buffer network error");
    } finally {
      clearTimeout(timer);
    }

    const now = this.opts.now?.() ?? new Date();
    const windows = parseRateLimitHeaders(res.headers.get("ratelimit"), res.headers.get("ratelimit-policy"), now);
    if (windows.length) {
      this.lastRateLimit = windows;
      await this.opts.onRateLimit?.(windows);
    }

    if (res.status === 429) {
      throw new ProviderError("rate_limited", "Buffer rate limit exceeded", {
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
      });
    }

    let body: { data?: T | null; errors?: GraphQLErrorShape[] } | undefined;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }

    if (body?.errors?.length) throw mapGraphQLErrors(body.errors, res.status);
    if (res.status === 401) throw mapGraphQLErrors([{ extensions: { code: "UNAUTHORIZED" } }], 401);
    if (res.status === 403) throw mapGraphQLErrors([{ extensions: { code: "FORBIDDEN" } }], 403);
    if (res.status >= 500) throw new ProviderError("upstream", `Buffer upstream error (HTTP ${res.status})`);
    if (!res.ok) throw new ProviderError("invalid_response", `Unexpected Buffer response (HTTP ${res.status})`);
    if (body?.data == null) throw new ProviderError("invalid_response", "Buffer returned an empty response");
    return body.data;
  }
}
