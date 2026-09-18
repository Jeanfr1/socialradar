/**
 * Alert persistence: turns pure alert candidates (src/domain/alert-rules.ts) into deduplicated alerts.
 *
 * - One unresolved alert per dedupe key (enforced by a partial unique index).
 * - Re-detection updates evidence/severity in place; severity escalation reopens acknowledged or snoozed alerts.
 * - Conditions that disappear are auto-resolved, scoped to the account/connection that was evaluated.
 * - Alerts for accounts that were unmapped or removed are resolved.
 */
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { evaluateAccountAlerts, evaluateConnectionAlerts, evaluateNextDayGapAlert, resolveMissing, type AlertCandidate } from "@/domain/alert-rules";
import type { DayPost } from "@/domain/next-day-gap";
import type { Db } from "@/server/db/client";
import { alerts, connections, posts } from "@/server/db/schema";
import { loadAccountStatuses } from "@/server/queries/account-status";

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

export interface EvaluationSummary {
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
}

async function persistCandidates(db: Db, candidates: AlertCandidate[], now: Date, isDemo: boolean, summary: EvaluationSummary) {
  for (const c of candidates) {
    const [existing] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.dedupeKey, c.dedupeKey), ne(alerts.state, "resolved")));
    if (!existing) {
      const inserted = await db
        .insert(alerts)
        .values({
          brandId: c.brandId,
          socialAccountId: c.socialAccountId,
          connectionId: c.connectionId,
          type: c.type,
          severity: c.severity,
          dedupeKey: c.dedupeKey,
          title: c.title,
          evidence: c.evidence,
          suggestedAction: c.suggestedAction,
          firstDetectedAt: now,
          lastDetectedAt: now,
          isDemo,
        })
        .onConflictDoNothing()
        .returning({ id: alerts.id });
      summary.created += inserted.length;
      continue;
    }
    const escalated = SEVERITY_RANK[c.severity] > SEVERITY_RANK[existing.severity];
    const changed = escalated || c.severity !== existing.severity || c.type !== existing.type;
    const reopen = escalated && (existing.state === "acknowledged" || existing.state === "snoozed");
    await db
      .update(alerts)
      .set({
        type: c.type,
        severity: c.severity,
        title: c.title,
        evidence: c.evidence,
        suggestedAction: c.suggestedAction,
        lastDetectedAt: now,
        updatedAt: now,
        ...(changed ? { occurrenceCount: existing.occurrenceCount + 1 } : {}),
        ...(reopen ? { state: "open" as const, acknowledgedAt: null, acknowledgedBy: null, snoozedUntil: null } : {}),
      })
      .where(eq(alerts.id, existing.id));
    summary.updated += 1;
    if (reopen) summary.reopened += 1;
  }
}

async function resolveKeys(db: Db, keys: string[], now: Date, reason: string): Promise<number> {
  if (keys.length === 0) return 0;
  const rows = await db
    .update(alerts)
    .set({ state: "resolved", resolvedAt: now, resolutionReason: reason, updatedAt: now })
    .where(and(inArray(alerts.dedupeKey, keys), ne(alerts.state, "resolved")))
    .returning({ id: alerts.id });
  return rows.length;
}

export async function evaluateAlerts(
  db: Db,
  now: Date,
  scope: { connectionId?: string } = {},
  opts: { connectionStaleMinutes?: number } = {},
): Promise<EvaluationSummary> {
  const summary: EvaluationSummary = { created: 0, updated: 0, reopened: 0, resolved: 0 };

  // Snoozes that expired become open again.
  await db
    .update(alerts)
    .set({ state: "open", snoozedUntil: null, updatedAt: now })
    .where(and(eq(alerts.state, "snoozed"), lt(alerts.snoozedUntil, now)));

  // Accounts that are no longer mapped (or were removed) cannot carry brand alerts.
  const orphaned = await db
    .update(alerts)
    .set({ state: "resolved", resolvedAt: now, resolutionReason: "account_unmapped_or_removed", updatedAt: now })
    .where(
      and(
        ne(alerts.state, "resolved"),
        isNotNull(alerts.socialAccountId),
        sql`${alerts.socialAccountId} in (select id from social_accounts where brand_id is null or mapping_status <> 'mapped' or removed_at is not null ${
          scope.connectionId ? sql`and connection_id = ${scope.connectionId}` : sql``
        })`,
      ),
    )
    .returning({ id: alerts.id });
  summary.resolved += orphaned.length;

  const statuses = await loadAccountStatuses(db, { connectionId: scope.connectionId }, now);
  // Posts around today (any timezone) for the next-day rule, grouped by account.
  const dayPosts = new Map<string, DayPost[]>();
  if (statuses.length > 0) {
    const rows = await db
      .select({ socialAccountId: posts.socialAccountId, status: posts.status, sentAt: posts.sentAt, dueAt: posts.dueAt, via: posts.via })
      .from(posts)
      .where(
        and(
          inArray(posts.socialAccountId, statuses.map((s) => s.account.id)),
          inArray(posts.status, ["scheduled", "sending", "sent"]),
          sql`coalesce(${posts.sentAt}, ${posts.dueAt}) between ${new Date(now.getTime() - 2 * 86_400_000)} and ${new Date(now.getTime() + 3 * 86_400_000)}`,
        ),
      );
    for (const r of rows) {
      const list = dayPosts.get(r.socialAccountId) ?? [];
      list.push({ status: r.status, at: r.status === "sent" ? r.sentAt ?? r.dueAt : r.dueAt, via: r.via });
      dayPosts.set(r.socialAccountId, list);
    }
  }

  for (const status of statuses) {
    const { account } = status;
    if (!account.brandId) continue;
    // User-facing alerts are deliberately minimal: "tomorrow has no post" and publishing failures.
    const failures = evaluateAccountAlerts({
      accountId: account.id,
      brandId: account.brandId,
      handle: account.handle,
      platform: account.platform,
      coverage: status.coverage,
      recentErrors: status.recentErrors.map(({ postId, dueAt, message }) => ({ postId, dueAt, message })),
      overdue: status.overdue,
      isDisconnected: account.isDisconnected,
      isQueuePaused: account.isQueuePaused,
      now,
      timezone: status.cadence.timezone,
      lastQueueSyncAt: status.lastQueueSyncAt,
      inventoryCap: status.inventoryCap,
    }).filter((c) => c.type === "publish_failed");
    const candidates = [
      ...failures,
      ...evaluateNextDayGapAlert({
        accountId: account.id,
        brandId: account.brandId,
        handle: account.handle,
        platform: account.platform,
        timezone: status.brandTimezone,
        now,
        lastQueueSyncAt: status.lastQueueSyncAt,
        posts: dayPosts.get(account.id) ?? [],
      }),
    ];
    const open = await db
      .select({ dedupeKey: alerts.dedupeKey })
      .from(alerts)
      .where(and(eq(alerts.socialAccountId, account.id), ne(alerts.state, "resolved")));
    await persistCandidates(db, candidates, now, account.isDemo, summary);
    summary.resolved += await resolveKeys(db, resolveMissing(open.map((o) => o.dedupeKey), candidates), now, "condition_cleared");
  }

  const connRows = await db
    .select()
    .from(connections)
    .where(and(isNull(connections.deletedAt), eq(connections.provider, "buffer"), scope.connectionId ? eq(connections.id, scope.connectionId) : sql`true`));
  for (const conn of connRows) {
    const candidates = evaluateConnectionAlerts({
      connectionId: conn.id,
      status: conn.status,
      lastSyncSuccessAt: conn.lastSyncSuccessAt,
      consecutiveFailures: conn.consecutiveFailures,
      lastErrorCode: conn.lastErrorCode,
      now,
      staleAfterMinutes: opts.connectionStaleMinutes ?? Number(process.env.CONNECTION_STALE_MINUTES ?? 360),
    });
    const open = await db
      .select({ dedupeKey: alerts.dedupeKey })
      .from(alerts)
      .where(and(eq(alerts.connectionId, conn.id), isNull(alerts.socialAccountId), ne(alerts.state, "resolved")));
    await persistCandidates(db, candidates, now, conn.isDemo, summary);
    summary.resolved += await resolveKeys(db, resolveMissing(open.map((o) => o.dedupeKey), candidates), now, "condition_cleared");
  }

  // Alerts of removed connections.
  const removed = await db
    .update(alerts)
    .set({ state: "resolved", resolvedAt: now, resolutionReason: "connection_removed", updatedAt: now })
    .where(
      and(
        ne(alerts.state, "resolved"),
        isNotNull(alerts.connectionId),
        sql`${alerts.connectionId} in (select id from connections where deleted_at is not null)`,
      ),
    )
    .returning({ id: alerts.id });
  summary.resolved += removed.length;
  return summary;
}
