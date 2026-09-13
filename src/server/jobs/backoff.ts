/**
 * Exponential backoff with "equal jitter": half of the exponential delay is fixed, half is random.
 * attempt is zero-based (0 = first retry).
 */
export function backoffDelayMs(
  attempt: number,
  { baseMs, capMs, random = Math.random }: { baseMs: number; capMs: number; random?: () => number },
): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}
