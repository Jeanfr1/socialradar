/**
 * Buffer quota handling.
 *
 * Buffer returns IETF-style headers on every authenticated response (verified 2026-09-13):
 *   RateLimit:        "100-in-15min"; r=99; t=900, "250-in-1day"; r=241; t=32871, "3000-in-30days"; r=2938; t=2145606
 *   RateLimit-Policy: "100-in-15min"; q=100; w=900; pk=:...:, ...
 * The same API key is used by the brands' existing publishing automations, so BrandPulse keeps a
 * configurable fraction of every window in reserve and never spends it.
 */
import type { RateLimitWindow } from "@/server/providers/types";

type ParsedItem = { name: string; params: Record<string, string> };

function parseStructuredList(header: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const chunk of header.split(/,\s*(?=")/)) {
    const match = chunk.match(/^\s*"([^"]+)"\s*(.*)$/);
    if (!match?.[1]) continue;
    const params: Record<string, string> = {};
    for (const part of (match[2] ?? "").split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key) params[key] = rest.join("=");
    }
    items.push({ name: match[1], params });
  }
  return items;
}

function inferWindowSeconds(name: string): number {
  const m = name.match(/-in-(\d+)(min|hour|day|days)$/);
  if (!m?.[1] || !m[2]) return NaN;
  const n = Number(m[1]);
  return m[2] === "min" ? n * 60 : m[2] === "hour" ? n * 3600 : n * 86400;
}

export function parseRateLimitHeaders(rateLimit: string | null, policy: string | null, now: Date): RateLimitWindow[] {
  if (!rateLimit) return [];
  const policies = parseStructuredList(policy ?? "");
  const windows: RateLimitWindow[] = [];
  for (const { name, params } of parseStructuredList(rateLimit)) {
    const remaining = Number(params.r);
    const resetSeconds = Number(params.t);
    const pol = policies.find((p) => p.name === name);
    const limit = Number(pol?.params.q ?? name.split("-in-")[0]);
    const windowSeconds = Number(pol?.params.w ?? inferWindowSeconds(name));
    if (![remaining, resetSeconds, limit].every(Number.isFinite)) continue;
    windows.push({
      name,
      limit,
      remaining,
      resetAt: new Date(now.getTime() + resetSeconds * 1000).toISOString(),
      windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : 0,
    });
  }
  return windows;
}

export interface QuotaReserves {
  /** Fraction of each window's limit that BrandPulse must leave untouched. */
  shortWindow: number; // windows <= 15 minutes
  daily: number; // windows <= 1 day
  long: number; // longer windows (30 days)
}

export function reservesFromEnv(env: Record<string, string | undefined> = process.env): QuotaReserves {
  const read = (key: string, fallback: number) => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v >= 0 && v < 1 ? v : fallback;
  };
  return {
    shortWindow: read("BUFFER_RESERVE_FRACTION_15MIN", 0.4),
    daily: read("BUFFER_RESERVE_FRACTION_DAILY", 0.5),
    long: read("BUFFER_RESERVE_FRACTION_30DAY", 0.4),
  };
}

export function reserveFor(window: RateLimitWindow, reserves: QuotaReserves): number {
  const fraction =
    window.windowSeconds <= 900 ? reserves.shortWindow : window.windowSeconds <= 86400 ? reserves.daily : reserves.long;
  return Math.ceil(window.limit * fraction);
}

export type QuotaDecision = { allowed: true } | { allowed: false; window: string; remaining: number; reserve: number; retryAfterMs: number };

/**
 * Decide whether BrandPulse may spend `cost` requests now.
 * `interactive` (a user validating a new key) only keeps a quarter of the reserve.
 * Windows whose reset time has passed are ignored (their counters have refilled).
 */
export function checkQuota(
  windows: RateLimitWindow[] | null | undefined,
  reserves: QuotaReserves,
  now: Date,
  { cost = 1, interactive = false }: { cost?: number; interactive?: boolean } = {},
): QuotaDecision {
  for (const w of windows ?? []) {
    const resetAt = Date.parse(w.resetAt);
    if (!Number.isFinite(resetAt) || resetAt <= now.getTime()) continue;
    const reserve = Math.ceil(reserveFor(w, reserves) * (interactive ? 0.25 : 1));
    if (w.remaining - cost < reserve) {
      // Re-check long windows periodically instead of sleeping until the 30-day reset.
      const retryAfterMs = Math.min(resetAt - now.getTime(), 6 * 3600_000);
      return { allowed: false, window: w.name, remaining: w.remaining, reserve, retryAfterMs };
    }
  }
  return { allowed: true };
}

/**
 * Adaptive polling: widen the base interval so that, at the current burn rate, BrandPulse never
 * exhausts its spendable share of the daily or 30-day window before it resets.
 */
export function recommendedIntervalMinutes(
  windows: RateLimitWindow[] | null | undefined,
  reserves: QuotaReserves,
  now: Date,
  { baseMinutes, requestsPerRun }: { baseMinutes: number; requestsPerRun: number },
): number {
  let interval = baseMinutes;
  for (const w of windows ?? []) {
    if (w.windowSeconds <= 900) continue;
    const resetAt = Date.parse(w.resetAt);
    if (!Number.isFinite(resetAt) || resetAt <= now.getTime()) continue;
    const minutesLeft = Math.max(1, (resetAt - now.getTime()) / 60_000);
    const spendable = w.remaining - reserveFor(w, reserves);
    if (spendable <= 0) return Math.min(24 * 60, Math.ceil(minutesLeft));
    const runsAffordable = spendable / Math.max(1, requestsPerRun);
    interval = Math.max(interval, minutesLeft / runsAffordable);
  }
  return Math.min(24 * 60, Math.ceil(interval));
}
