/**
 * Alert rules: pure evaluation of alert candidates from already-computed facts.
 *
 * Dedupe keys identify the underlying CONDITION, not its severity, so a changing severity updates the same
 * alert in place:
 *   queue_coverage:<accountId>        queue_empty AND queue_coverage (warning/critical) share this key —
 *                                     depletion is one condition; the persistence layer must update `type` too.
 *   sync_stale:<accountId>            account queue data stale / never synced
 *   sync_stale:connection:<id>        connection has not synced successfully within its staleness window
 *   queue_paused:<accountId>
 *   account_disconnected:<accountId>
 *   publish_failed:<postId>           one per failed post
 *   post_overdue:<accountId>          one per account listing every overdue post id
 *   unresolved_times:<accountId>
 *   connection_failing:<connectionId>
 *
 * Suppression rules (avoid contradictory or misleading alerts)
 * - Coverage is stale or never synced → emit sync_stale, NEVER queue_empty/queue_coverage
 *   (stale data must not be presented as confirmed depletion).
 * - Account disconnected → emit account_disconnected only; no queue_* and no sync_stale (the disconnection explains both).
 * - Queue paused → emit queue_paused; no queue_* (coverage cannot deplete while nothing publishes).
 * - A post in recentErrors is not also reported as overdue.
 * - connection_failing suppresses the connection-level sync_stale.
 *
 * `resolveMissing` must receive the open keys of exactly the scope that was evaluated (one account or one connection);
 * otherwise alerts of other scopes would be auto-resolved.
 */
import { DateTime } from "luxon";
import type { CoverageResult, Platform } from "./types";

export type AlertType =
  | "queue_empty"
  | "queue_coverage"
  | "sync_stale"
  | "queue_paused"
  | "account_disconnected"
  | "publish_failed"
  | "post_overdue"
  | "unresolved_times"
  | "connection_failing";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertCandidate {
  dedupeKey: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  /** Observed facts only: numbers, ISO dates, post ids. */
  evidence: Record<string, unknown>;
  suggestedAction: string;
  brandId: string | null;
  socialAccountId: string | null;
  connectionId: string | null;
}

/** Formats an instant for alert copy. Default: "Tue 16 Sep 20:00 (America/Sao_Paulo)". */
export type DateFormatter = (at: Date, timezone: string) => string;

export const defaultDateFormatter: DateFormatter = (at, timezone) =>
  `${DateTime.fromJSDate(at, { zone: timezone }).setLocale("en-US").toFormat("ccc d LLL HH:mm")} (${timezone})`;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_PROVIDER_MESSAGE = 500;

const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", other: "Other" };

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function roundDays(days: number): number {
  return Math.round(days * 10) / 10;
}

export interface AccountAlertInput {
  accountId: string;
  brandId: string;
  handle: string;
  platform: Platform;
  coverage: CoverageResult;
  recentErrors: { postId: string; dueAt: Date | null; message: string }[];
  /** Scheduled posts with dueAt < now − grace that are still not sent. */
  overdue: { postId: string; dueAt: Date }[];
  isDisconnected: boolean;
  isQueuePaused: boolean;
  now: Date;
  /** Cadence timezone for human-readable dates (default UTC). */
  timezone?: string;
  lastQueueSyncAt?: Date | null;
  /** Provider cap on pending scheduled posts for this account (see coverage.ts). */
  inventoryCap?: number | null;
  formatDate?: DateFormatter;
}

function coverageAction(input: AccountAlertInput, fmt: DateFormatter, tz: string): string {
  const c = input.coverage;
  const horizonDays = Math.round((c.horizonEnd.getTime() - c.horizonStart.getTime()) / DAY_MS);
  if (c.postsNeeded === 0) {
    return `Every expected slot in the next ${plural(horizonDays, "day")} is covered, but the coverage horizon is shorter than the warning threshold. Extend the horizon in this account's cadence settings so healthy coverage can be confirmed.`;
  }
  const deadline = c.fillDeadline ? fmt(c.fillDeadline, tz) : null;
  const cap = input.inventoryCap ?? (c as Partial<{ inventoryCap: number | null }>).inventoryCap ?? null;
  const remaining = cap === null ? null : Math.max(0, cap - c.scheduledCount);
  if (remaining !== null && remaining < c.postsNeeded) {
    if (remaining === 0) {
      return `The provider's scheduled-post limit (${cap}) is reached, so the next ${horizonDays} days cannot be fully covered. Top up the queue as posts publish${deadline ? `, before ${deadline} at the latest` : ""}.`;
    }
    return `Schedule ${plural(remaining, "post")}${deadline ? ` before ${deadline}` : ""} (the provider limit of ${cap} scheduled posts prevents covering all ${horizonDays} days), then top up the queue as posts publish.`;
  }
  return `Schedule ${plural(c.postsNeeded, "post")}${deadline ? ` before ${deadline}` : ""} to cover the next ${plural(horizonDays, "day")}.`;
}

export function evaluateAccountAlerts(input: AccountAlertInput): AlertCandidate[] {
  const fmt = input.formatDate ?? defaultDateFormatter;
  const tz = input.timezone ?? "UTC";
  const c = input.coverage;
  const who = `@${input.handle.replace(/^@/, "")} (${PLATFORM_LABEL[input.platform]})`;
  const scope = { brandId: input.brandId, socialAccountId: input.accountId, connectionId: null };
  const out: AlertCandidate[] = [];

  if (input.isDisconnected) {
    out.push({
      ...scope,
      dedupeKey: `account_disconnected:${input.accountId}`,
      type: "account_disconnected",
      severity: "critical",
      title: `${who} is disconnected from Buffer`,
      evidence: { accountId: input.accountId, platform: input.platform, handle: input.handle, lastQueueSyncAt: iso(input.lastQueueSyncAt), scheduledCountAtLastSync: c.scheduledCount },
      suggestedAction: `Reconnect ${who} directly in Buffer. BrandPulse cannot reconnect channels; scheduled posts will not publish and coverage cannot be confirmed until it is reconnected.`,
    });
  }

  if (input.isQueuePaused && !input.isDisconnected) {
    out.push({
      ...scope,
      dedupeKey: `queue_paused:${input.accountId}`,
      type: "queue_paused",
      severity: "warning",
      title: `Queue paused for ${who}`,
      evidence: { accountId: input.accountId, scheduledCount: c.scheduledCount, nextScheduledAt: iso(c.nextScheduledAt) },
      suggestedAction: `Resume the queue for ${who} in Buffer if the pause is not intentional; ${plural(c.scheduledCount, "scheduled post")} will not publish while it is paused.`,
    });
  }

  if (!input.isDisconnected) {
    if (c.freshness !== "fresh") {
      const never = c.freshness === "never_synced";
      out.push({
        ...scope,
        dedupeKey: `sync_stale:${input.accountId}`,
        type: "sync_stale",
        severity: never ? "info" : "warning",
        title: never ? `No queue data yet for ${who}` : `Queue data for ${who} is out of date`,
        evidence: {
          accountId: input.accountId,
          freshness: c.freshness,
          lastQueueSyncAt: iso(input.lastQueueSyncAt),
          lastKnownQueueState: (c as Partial<{ underlyingState: string | null }>).underlyingState ?? null,
          scheduledCountAtLastSync: c.scheduledCount,
        },
        suggestedAction: never
          ? `Wait for the first queue sync of ${who} (or run a sync for its connection); coverage cannot be confirmed until then.`
          : `Check the Buffer connection and run a sync for ${who}; coverage figures come from the last successful sync and may not reflect recent changes.`,
      });
    } else if (!input.isQueuePaused && (c.state === "empty" || c.state === "critical" || c.state === "warning")) {
      const empty = c.state === "empty";
      const coveredDays = c.coveredDays ?? 0;
      out.push({
        ...scope,
        dedupeKey: `queue_coverage:${input.accountId}`,
        type: empty ? "queue_empty" : "queue_coverage",
        severity: c.state === "warning" ? "warning" : "critical",
        title: empty
          ? `No posts scheduled for ${who}`
          : `Queue for ${who} covers only ${roundDays(coveredDays)} ${roundDays(coveredDays) === 1 ? "day" : "days"}`,
        evidence: {
          accountId: input.accountId,
          state: c.state,
          coveredDays: c.coveredDays,
          coverageRatio: c.coverageRatio,
          expectedSlots: c.expectedSlots,
          coveredSlots: c.coveredSlots,
          scheduledCount: c.scheduledCount,
          postsNeeded: c.postsNeeded,
          firstUncoveredSlot: iso(c.firstUncoveredSlot),
          nextScheduledAt: iso(c.nextScheduledAt),
          lastScheduledAt: iso(c.lastScheduledAt),
          horizonStart: iso(c.horizonStart),
          horizonEnd: iso(c.horizonEnd),
          unresolvedCount: c.unresolvedCount,
          isEstimate: c.isEstimate,
          reasons: c.reasons,
        },
        suggestedAction: coverageAction(input, fmt, tz),
      });
    }
  }

  if (c.unresolvedCount > 0 && c.freshness !== "never_synced" && !input.isDisconnected) {
    out.push({
      ...scope,
      dedupeKey: `unresolved_times:${input.accountId}`,
      type: "unresolved_times",
      severity: "info",
      title: `${plural(c.unresolvedCount, "pending post")} for ${who} ${c.unresolvedCount === 1 ? "has" : "have"} no confirmed publish time`,
      evidence: { accountId: input.accountId, unresolvedCount: c.unresolvedCount },
      suggestedAction: `Approve or set a publish time in Buffer for the draft or awaiting-approval posts of ${who}; they do not count toward coverage until then.`,
    });
  }

  const errorIds = new Set<string>();
  for (const err of input.recentErrors) {
    if (errorIds.has(err.postId)) continue;
    errorIds.add(err.postId);
    const recent = err.dueAt === null || input.now.getTime() - err.dueAt.getTime() <= 24 * HOUR_MS;
    out.push({
      ...scope,
      dedupeKey: `publish_failed:${err.postId}`,
      type: "publish_failed",
      severity: recent ? "critical" : "warning",
      title: `Post failed to publish on ${who}`,
      evidence: { accountId: input.accountId, postId: err.postId, dueAt: iso(err.dueAt), providerMessage: err.message.slice(0, MAX_PROVIDER_MESSAGE) },
      suggestedAction: err.dueAt
        ? `Review the error in Buffer, fix the post and reschedule it; its slot at ${fmt(err.dueAt, tz)} was not filled.`
        : "Review the error in Buffer, fix the post and reschedule it.",
    });
  }

  const overdue = input.overdue
    .filter((o) => !errorIds.has(o.postId) && o.dueAt.getTime() <= input.now.getTime())
    .filter((o, i, arr) => arr.findIndex((x) => x.postId === o.postId) === i)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || (a.postId < b.postId ? -1 : 1));
  if (overdue.length > 0) {
    const oldest = overdue[0] as { postId: string; dueAt: Date };
    const likelyCause = input.isDisconnected ? "account_disconnected" : input.isQueuePaused ? "queue_paused" : null;
    out.push({
      ...scope,
      dedupeKey: `post_overdue:${input.accountId}`,
      type: "post_overdue",
      severity: likelyCause ? "info" : "warning",
      title: `${plural(overdue.length, "scheduled post")} overdue on ${who}`,
      evidence: { accountId: input.accountId, count: overdue.length, postIds: overdue.map((o) => o.postId), oldestDueAt: iso(oldest.dueAt), likelyCause },
      suggestedAction: likelyCause
        ? `These posts cannot publish while the account is ${likelyCause === "account_disconnected" ? "disconnected" : "paused"}; resolve that first, then check them in Buffer.`
        : `Check ${overdue.length === 1 ? "this post" : "these posts"} in Buffer: due since ${fmt(oldest.dueAt, tz)} and still not sent. Reschedule or retry if Buffer shows no progress.`,
    });
  }

  return out;
}

export interface ConnectionAlertInput {
  connectionId: string;
  /** pending | active | invalid | error | revoked */
  status: string;
  lastSyncSuccessAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  now: Date;
  staleAfterMinutes: number;
  /** Consecutive failures before alerting (default 3); twice this is critical. */
  failureThreshold?: number;
  formatDate?: DateFormatter;
}

const CREDENTIAL_ERRORS = new Set(["unauthorized", "forbidden"]);
const THROTTLE_ERRORS = new Set(["rate_limited", "quota_reserved"]);

export function evaluateConnectionAlerts(input: ConnectionAlertInput): AlertCandidate[] {
  const fmt = input.formatDate ?? defaultDateFormatter;
  const threshold = Math.max(1, input.failureThreshold ?? 3);
  const scope = { brandId: null, socialAccountId: null, connectionId: input.connectionId };
  const evidence = {
    connectionId: input.connectionId,
    status: input.status,
    consecutiveFailures: input.consecutiveFailures,
    lastErrorCode: input.lastErrorCode,
    lastSyncSuccessAt: iso(input.lastSyncSuccessAt),
  };
  const out: AlertCandidate[] = [];
  if (input.status === "pending") return out;

  const credentialProblem = input.status === "invalid" || input.status === "revoked" || CREDENTIAL_ERRORS.has(input.lastErrorCode ?? "");
  if (credentialProblem) {
    out.push({
      ...scope,
      dedupeKey: `connection_failing:${input.connectionId}`,
      type: "connection_failing",
      severity: "critical",
      title: "Buffer rejected this connection's API key",
      evidence,
      suggestedAction: "Re-enter a valid Buffer API key for this connection in Settings → Connections; nothing from its channels will sync until then.",
    });
  } else if (input.consecutiveFailures >= threshold) {
    const throttled = THROTTLE_ERRORS.has(input.lastErrorCode ?? "");
    out.push({
      ...scope,
      dedupeKey: `connection_failing:${input.connectionId}`,
      type: "connection_failing",
      severity: input.consecutiveFailures >= threshold * 2 && !throttled ? "critical" : "warning",
      title: throttled
        ? `Buffer sync throttled ${plural(input.consecutiveFailures, "time")} in a row`
        : `Buffer sync failed ${plural(input.consecutiveFailures, "time")} in a row`,
      evidence,
      suggestedAction: throttled
        ? "Sync retries automatically after the rate-limit window. Avoid manual syncs and stagger connections that share a Buffer account."
        : "Check Buffer's status and this connection's last error; syncs retry automatically. If failures continue, re-validate the API key in Settings → Connections.",
    });
  }

  if (out.length === 0) {
    const ageMs = input.lastSyncSuccessAt ? input.now.getTime() - input.lastSyncSuccessAt.getTime() : null;
    const staleMs = input.staleAfterMinutes * 60_000;
    if (ageMs === null || ageMs > staleMs) {
      out.push({
        ...scope,
        dedupeKey: `sync_stale:connection:${input.connectionId}`,
        type: "sync_stale",
        severity: ageMs !== null && ageMs > staleMs * 4 ? "critical" : "warning",
        title: input.lastSyncSuccessAt ? "Buffer connection has not synced recently" : "Buffer connection has never synced successfully",
        evidence: { ...evidence, staleAfterMinutes: input.staleAfterMinutes },
        suggestedAction: input.lastSyncSuccessAt
          ? `Last successful sync ${fmt(input.lastSyncSuccessAt, "UTC")}. Check that the sync worker is running; data from this connection may be out of date.`
          : "Check that the sync worker is running and run a first sync for this connection.",
      });
    }
  }
  return out;
}

/** Open dedupe keys (for the evaluated scope) that no longer have a candidate → auto-resolve. Order preserved, unique. */
export function resolveMissing(openDedupeKeys: Iterable<string>, candidates: AlertCandidate[]): string[] {
  const active = new Set(candidates.map((c) => c.dedupeKey));
  const out: string[] = [];
  for (const key of openDedupeKeys) if (!active.has(key) && !out.includes(key)) out.push(key);
  return out;
}
