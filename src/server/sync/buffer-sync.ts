/**
 * Buffer synchronization (read-only).
 *
 * syncQueue      — channels + pending/failed/recently-sent posts. ~1 request per organization.
 * syncPublished  — sent posts with lifetime metrics (Buffer refreshes them about daily).
 *
 * Reliability rules
 * - Every write is an idempotent upsert keyed by provider identifiers; re-running a sync never duplicates rows.
 * - Pending posts that vanish are marked `missing` ONLY after a complete, error-free listing. A failed or
 *   partial sync leaves the last known queue untouched and is surfaced as stale data, never as an empty queue.
 * - Quota reserved for existing publishing automations is never spent (see quota.ts).
 */
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import {
  connections,
  metricObservations,
  postMetricsLatest,
  posts,
  providerOrganizations,
  socialAccounts,
  syncRuns,
} from "@/server/db/schema";
import {
  edgesOf,
  mapChannel,
  mapOrganization,
  mapPost,
  type RawChannel,
  type RawConnection,
  type RawOrganization,
  type RawPost,
} from "@/server/providers/buffer/adapter";
import { BufferClient } from "@/server/providers/buffer/client";
import { checkQuota, reservesFromEnv, type QuotaReserves } from "@/server/providers/buffer/quota";
import { ACCOUNT_QUERY, ORG_QUEUE_QUERY, PENDING_PAGE_QUERY, PUBLISHED_PAGE_QUERY } from "@/server/providers/buffer/queries";
import { ProviderError, type ProviderChannel, type ProviderPost, type RateLimitWindow } from "@/server/providers/types";

export interface SyncContext {
  db: Db;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  reserves?: QuotaReserves;
  getSecret?: (db: Db, connectionId: string) => Promise<string>;
}

export interface SyncOutcome {
  runId: string | null;
  status: "succeeded" | "partial" | "failed" | "skipped";
  requestsUsed: number;
  itemsUpserted: number;
  details: Record<string, unknown>;
}

type ConnectionRow = typeof connections.$inferSelect;
type OrgRow = typeof providerOrganizations.$inferSelect;
type WorkResult = { status?: "succeeded" | "partial"; details: Record<string, unknown>; items: number };

const PENDING_STATUSES = ["scheduled", "needs_approval", "sending"] as const;
const MAX_PAGES = 10;
const ORG_REFRESH_MS = 24 * 3600_000;
const FAILURES_BEFORE_ERROR_STATUS = 3;
export const METRICS_SOURCE = "buffer.post.metrics";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function toRateLimitState(windows: RateLimitWindow[]): NonNullable<ConnectionRow["rateLimitState"]> {
  return Object.fromEntries(
    windows.map((w) => [w.name, { limit: w.limit, remaining: w.remaining, resetAt: w.resetAt, windowSeconds: w.windowSeconds }]),
  );
}

function fromRateLimitState(state: ConnectionRow["rateLimitState"]): RateLimitWindow[] {
  return Object.entries(state ?? {}).map(([name, w]) => ({ name, ...w }));
}

async function runWithConnection(
  ctx: SyncContext,
  connectionId: string,
  kind: "queue" | "published",
  work: (client: BufferClient, conn: ConnectionRow, runId: string) => Promise<WorkResult>,
): Promise<SyncOutcome> {
  const { db } = ctx;
  const now = ctx.now ?? (() => new Date());
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.deletedAt)));
  if (!conn) throw new ProviderError("not_found", "Connection not found or removed");
  if (conn.provider !== "buffer" || conn.status === "invalid" || conn.status === "revoked") {
    return { runId: null, status: "skipped", requestsUsed: 0, itemsUpserted: 0, details: { reason: `connection_${conn.status}` } };
  }

  const [run] = await db.insert(syncRuns).values({ connectionId, kind, startedAt: now() }).returning({ id: syncRuns.id });
  const runId = run!.id;
  const reserves = ctx.reserves ?? reservesFromEnv();
  let windows = fromRateLimitState(conn.rateLimitState);
  let client: BufferClient | undefined;

  try {
    const getSecret =
      ctx.getSecret ??
      (async (d: Db, id: string) => (await (await import("@/server/connections/service")).getCredentialForWorker(d, id)).secret);
    const secret = await getSecret(db, connectionId);
    client = new BufferClient({
      token: secret,
      fetchImpl: ctx.fetchImpl,
      sleep: ctx.sleep,
      now,
      beforeRequest: () => {
        const decision = checkQuota(windows, reserves, now());
        if (!decision.allowed) {
          throw new ProviderError(
            "quota_reserved",
            `Paused to protect existing automations: ${decision.remaining} requests left in window ${decision.window}, ${decision.reserve} reserved.`,
            { retryAfterMs: decision.retryAfterMs },
          );
        }
      },
      onRateLimit: async (w) => {
        windows = w;
        await db.update(connections).set({ rateLimitState: toRateLimitState(w) }).where(eq(connections.id, connectionId));
      },
    });

    const result = await work(client, conn, runId);
    const status = result.status ?? "succeeded";
    const finishedAt = now();
    await db
      .update(syncRuns)
      .set({ status, finishedAt, requestsUsed: client.requestsUsed, itemsUpserted: result.items, details: result.details })
      .where(eq(syncRuns.id, runId));
    await db
      .update(connections)
      .set({
        status: "active",
        lastSyncAttemptAt: finishedAt,
        lastSyncSuccessAt: finishedAt,
        consecutiveFailures: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: finishedAt,
      })
      .where(eq(connections.id, connectionId));
    return { runId, status, requestsUsed: client.requestsUsed, itemsUpserted: result.items, details: result.details };
  } catch (err) {
    const providerError = err instanceof ProviderError ? err : null;
    const code = providerError?.code ?? "internal_error";
    const message = providerError?.message ?? "Internal synchronization error";
    const quota = code === "quota_reserved";
    const failures = quota ? conn.consecutiveFailures : conn.consecutiveFailures + 1;
    const finishedAt = now();
    await db
      .update(syncRuns)
      .set({ status: quota ? "skipped" : "failed", finishedAt, requestsUsed: client?.requestsUsed ?? 0, errorCode: code, errorMessage: message })
      .where(eq(syncRuns.id, runId));
    await db
      .update(connections)
      .set({
        status: code === "unauthorized" ? "invalid" : failures >= FAILURES_BEFORE_ERROR_STATUS ? "error" : conn.status === "pending" ? "active" : conn.status,
        lastSyncAttemptAt: finishedAt,
        consecutiveFailures: failures,
        lastErrorCode: code,
        lastErrorMessage: message,
        updatedAt: finishedAt,
      })
      .where(eq(connections.id, connectionId));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Organizations & channels
// ---------------------------------------------------------------------------
async function ensureOrganizations(db: Db, client: BufferClient, conn: ConnectionRow, now: Date): Promise<OrgRow[]> {
  const existing = await db.select().from(providerOrganizations).where(eq(providerOrganizations.connectionId, conn.id));
  if (existing.length > 0 && existing.every((o) => now.getTime() - o.lastSeenAt.getTime() < ORG_REFRESH_MS)) return existing;

  const data = await client.query<{ account: { id: string; name: string | null; organizations: RawOrganization[] } }>(ACCOUNT_QUERY);
  const orgs = data.account.organizations.map(mapOrganization);
  await db
    .update(connections)
    .set({ externalAccountId: data.account.id, externalAccountName: data.account.name ?? conn.externalAccountName, updatedAt: now })
    .where(eq(connections.id, conn.id));
  for (const org of orgs) {
    await db
      .insert(providerOrganizations)
      .values({ connectionId: conn.id, externalId: org.externalId, name: org.name, limits: org.limits, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [providerOrganizations.connectionId, providerOrganizations.externalId],
        set: { name: org.name, limits: org.limits, lastSeenAt: now },
      });
  }
  const seen = orgs.map((o) => o.externalId);
  const vanished = existing.filter((o) => !seen.includes(o.externalId)).map((o) => o.id);
  if (vanished.length > 0) {
    await db
      .update(socialAccounts)
      .set({ removedAt: now, updatedAt: now })
      .where(and(inArray(socialAccounts.providerOrganizationId, vanished), isNull(socialAccounts.removedAt)));
    await db.delete(providerOrganizations).where(inArray(providerOrganizations.id, vanished));
  }
  return db.select().from(providerOrganizations).where(eq(providerOrganizations.connectionId, conn.id));
}

/** Upserts channels and returns externalChannelId → social account id. Channels no longer returned are marked removed. */
export async function upsertChannels(
  db: Db,
  conn: Pick<ConnectionRow, "id">,
  org: Pick<OrgRow, "id">,
  channels: ProviderChannel[],
  now: Date,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const c of channels) {
    const values = {
      connectionId: conn.id,
      providerOrganizationId: org.id,
      provider: "buffer" as const,
      externalChannelId: c.externalChannelId,
      platform: c.platform,
      platformAccountId: c.platformAccountId,
      channelType: c.channelType,
      handle: c.handle,
      displayName: c.displayName,
      avatarUrl: c.avatarUrl,
      externalUrl: c.externalUrl,
      providerTimezone: c.timezone,
      isQueuePaused: c.isQueuePaused,
      isDisconnected: c.isDisconnected,
      isLocked: c.isLocked,
      canViewInsights: c.canViewInsights,
      providerPostingSchedule: c.postingSchedule,
      lastSeenAt: now,
      updatedAt: now,
    };
    const [row] = await db
      .insert(socialAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [socialAccounts.provider, socialAccounts.externalChannelId],
        set: {
          ...values,
          // Keep the original connection while it is still active (several keys may see the same channel).
          connectionId: sql`case when exists (select 1 from connections c where c.id = ${socialAccounts.connectionId} and c.deleted_at is null) then ${socialAccounts.connectionId} else excluded.connection_id end`,
          removedAt: null,
        },
      })
      .returning({ id: socialAccounts.id, externalChannelId: socialAccounts.externalChannelId });
    if (row) ids.set(row.externalChannelId, row.id);
  }
  const seen = channels.map((c) => c.externalChannelId);
  await db
    .update(socialAccounts)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(socialAccounts.connectionId, conn.id),
        eq(socialAccounts.providerOrganizationId, org.id),
        isNull(socialAccounts.removedAt),
        seen.length ? notInArray(socialAccounts.externalChannelId, seen) : sql`true`,
      ),
    );
  return ids;
}

// ---------------------------------------------------------------------------
// Posts & metrics
// ---------------------------------------------------------------------------
const keepExisting = (column: string) => sql.raw(`coalesce(excluded.${column}, "posts"."${column}")`);

/** Idempotent post upsert. Enrichment fields absent from a lighter query never overwrite stored values. */
export async function upsertPosts(
  db: Db,
  accountIdByChannel: Map<string, string>,
  items: ProviderPost[],
  now: Date,
  { authoritativeTags = false }: { authoritativeTags?: boolean } = {},
): Promise<Map<string, { id: string; socialAccountId: string }>> {
  const result = new Map<string, { id: string; socialAccountId: string }>();
  const rows = items
    .map((p) => {
      const socialAccountId = accountIdByChannel.get(p.externalChannelId);
      if (!socialAccountId) return null;
      return {
        socialAccountId,
        provider: "buffer" as const,
        externalPostId: p.externalPostId,
        status: p.status,
        dueAt: p.dueAt,
        sentAt: p.sentAt,
        shareMode: p.shareMode,
        schedulingType: p.schedulingType,
        isCustomScheduled: p.isCustomScheduled,
        via: p.via,
        format: p.format,
        text: p.text,
        title: p.title,
        externalUrl: p.externalUrl,
        thumbnailUrl: p.thumbnailUrl,
        errorMessage: p.errorMessage,
        providerTags: p.providerTags,
        providerCreatedAt: p.providerCreatedAt,
        providerUpdatedAt: p.providerUpdatedAt,
        metricsUpdatedAt: p.metricsUpdatedAt,
        lastSeenAt: now,
        updatedAt: now,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Deduplicate by external id (a post can appear in two lists during a status transition); last one wins.
  const unique = [...new Map(rows.map((r) => [r.externalPostId, r])).values()];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const returned = await db
      .insert(posts)
      .values(chunk)
      .onConflictDoUpdate({
        target: [posts.provider, posts.externalPostId],
        set: {
          socialAccountId: sql.raw("excluded.social_account_id"),
          status: sql.raw("excluded.status"),
          dueAt: sql.raw("excluded.due_at"),
          sentAt: sql.raw("excluded.sent_at"),
          shareMode: sql.raw("excluded.share_mode"),
          schedulingType: sql.raw("excluded.scheduling_type"),
          isCustomScheduled: sql.raw("excluded.is_custom_scheduled"),
          via: sql.raw("excluded.via"),
          errorMessage: sql.raw("excluded.error_message"),
          providerCreatedAt: keepExisting("provider_created_at"),
          providerUpdatedAt: keepExisting("provider_updated_at"),
          format: keepExisting("format"),
          text: keepExisting("text"),
          title: keepExisting("title"),
          externalUrl: keepExisting("external_url"),
          thumbnailUrl: keepExisting("thumbnail_url"),
          metricsUpdatedAt: keepExisting("metrics_updated_at"),
          ...(authoritativeTags ? { providerTags: sql.raw("excluded.provider_tags") } : {}),
          lastSeenAt: sql.raw("excluded.last_seen_at"),
          updatedAt: sql.raw("excluded.updated_at"),
        },
      })
      .returning({ id: posts.id, externalPostId: posts.externalPostId, socialAccountId: posts.socialAccountId });
    for (const r of returned) result.set(r.externalPostId, { id: r.id, socialAccountId: r.socialAccountId });
  }
  return result;
}

/** Pending posts not present in a complete listing are no longer pending in Buffer (published, failed or deleted). */
async function markMissingPending(db: Db, accountIds: string[], listedExternalIds: string[], now: Date): Promise<number> {
  if (accountIds.length === 0) return 0;
  const rows = await db
    .update(posts)
    .set({ status: "missing", updatedAt: now })
    .where(
      and(
        inArray(posts.socialAccountId, accountIds),
        eq(posts.provider, "buffer"),
        inArray(posts.status, [...PENDING_STATUSES]),
        listedExternalIds.length ? notInArray(posts.externalPostId, listedExternalIds) : sql`true`,
      ),
    )
    .returning({ id: posts.id });
  return rows.length;
}

const UNIT_OVERRIDES: Record<string, string> = {
  avg_watch_time_seconds: "seconds",
  total_watch_time_minutes: "minutes",
  provider_engagement_rate: "percentage",
};

/**
 * Stores one observation per (post, metric, Buffer refresh) and maintains the latest-value table.
 * Rows are written in bulk (a few round trips per sync) because the database may be far from the function.
 */
export async function ingestPostMetrics(
  db: Db,
  items: ProviderPost[],
  stored: Map<string, { id: string; socialAccountId: string }>,
  { now, runId }: { now: Date; runId: string | null },
): Promise<number> {
  const rows: (typeof metricObservations.$inferInsert & { postId: string; providerUpdatedAt: Date })[] = [];
  for (const p of items) {
    const ref = stored.get(p.externalPostId);
    // No refresh timestamp → Buffer has not ingested metrics yet: store nothing rather than zeros.
    if (!ref || !p.metricsUpdatedAt || !p.metrics) continue;
    const metricsUpdatedAt = p.metricsUpdatedAt;
    for (const m of p.metrics) {
      if (m.key === null) continue;
      rows.push({
        subject: "post",
        postId: ref.id,
        socialAccountId: ref.socialAccountId,
        metricKey: m.key,
        value: m.value,
        valueStatus: m.value === 0 ? "reported_zero" : "reported",
        unit: UNIT_OVERRIDES[m.key] ?? m.unit,
        semantics: "lifetime_cumulative",
        providerUpdatedAt: metricsUpdatedAt,
        retrievedAt: now,
        source: METRICS_SOURCE,
        syncRunId: runId,
      });
    }
  }
  // One row per (post, metric) per statement: an upsert cannot touch the same row twice.
  const unique = [...new Map(rows.map((r) => [`${r.postId}:${r.metricKey}`, r])).values()];
  let written = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const inserted = await db.insert(metricObservations).values(chunk).onConflictDoNothing().returning({ id: metricObservations.id });
    written += inserted.length;
    await db
      .insert(postMetricsLatest)
      .values(
        chunk.map((r) => ({
          postId: r.postId,
          metricKey: r.metricKey,
          value: r.value ?? null,
          valueStatus: r.valueStatus,
          unit: r.unit,
          providerUpdatedAt: r.providerUpdatedAt,
          retrievedAt: r.retrievedAt,
          source: r.source,
        })),
      )
      .onConflictDoUpdate({
        target: [postMetricsLatest.postId, postMetricsLatest.metricKey],
        set: {
          value: sql.raw("excluded.value"),
          valueStatus: sql.raw("excluded.value_status"),
          unit: sql.raw("excluded.unit"),
          providerUpdatedAt: sql.raw("excluded.provider_updated_at"),
          retrievedAt: sql.raw("excluded.retrieved_at"),
        },
        setWhere: sql`excluded.provider_updated_at >= ${postMetricsLatest.providerUpdatedAt} or ${postMetricsLatest.providerUpdatedAt} is null`,
      });
  }
  return written;
}

async function channelMapForOrg(db: Db, connectionId: string, orgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: socialAccounts.id, externalChannelId: socialAccounts.externalChannelId })
    .from(socialAccounts)
    .where(and(eq(socialAccounts.providerOrganizationId, orgId), eq(socialAccounts.connectionId, connectionId)));
  return new Map(rows.map((r) => [r.externalChannelId, r.id]));
}

// ---------------------------------------------------------------------------
// Public sync entry points
// ---------------------------------------------------------------------------
interface OrgQueueData {
  channels: RawChannel[];
  pending: RawConnection<RawPost>;
  approvals: RawConnection<RawPost>;
  upcoming: RawConnection<RawPost>;
  failed: RawConnection<RawPost>;
  recentSent: RawConnection<RawPost>;
}

export async function syncQueue(ctx: SyncContext, connectionId: string): Promise<SyncOutcome> {
  const now = ctx.now ?? (() => new Date());
  return runWithConnection(ctx, connectionId, "queue", async (client, conn) => {
    const { db } = ctx;
    const orgs = await ensureOrganizations(db, client, conn, now());
    const details = {
      organizations: orgs.length,
      channels: 0,
      pending: 0,
      approvals: 0,
      failed: 0,
      recentlySent: 0,
      markedMissing: 0,
      incompleteListings: 0,
      filterInconsistencies: 0,
    };
    let items = 0;
    for (const org of orgs) {
      const t = now();
      const data = await client.query<OrgQueueData>(ORG_QUEUE_QUERY, {
        org: org.externalId,
        errorsSince: new Date(t.getTime() - 14 * DAY).toISOString(),
        sentSince: new Date(t.getTime() - 48 * HOUR).toISOString(),
        upcomingSince: t.toISOString(),
      });
      const channels = data.channels.map((c) => mapChannel(c, org.externalId));
      const accountIds = await upsertChannels(db, conn, org, channels, t);

      const pendingRaw = edgesOf(data.pending);
      let pageInfo = data.pending.pageInfo;
      for (let page = 1; pageInfo.hasNextPage && pageInfo.endCursor && page < MAX_PAGES; page++) {
        const next = await client.query<{ pending: RawConnection<RawPost> }>(PENDING_PAGE_QUERY, { org: org.externalId, after: pageInfo.endCursor });
        pendingRaw.push(...edgesOf(next.pending));
        pageInfo = next.pending.pageInfo;
      }
      const approvals = edgesOf(data.approvals).map(mapPost);
      const listed = new Set([...pendingRaw.map((p) => p.id), ...approvals.map((p) => p.externalPostId)]);
      // Cross-check: pending posts the status filters failed to return (see provider defect in queries.ts).
      const missedByFilter = edgesOf(data.upcoming)
        .filter((p) => (p.status === "scheduled" || p.status === "sending" || p.status === "needs_approval") && !listed.has(p.id))
        .map(mapPost);
      const listingComplete =
        !pageInfo.hasNextPage && !data.approvals.pageInfo.hasNextPage && !data.upcoming.pageInfo.hasNextPage && missedByFilter.length === 0;

      const pending = [...pendingRaw.map(mapPost), ...approvals, ...missedByFilter];
      const failed = edgesOf(data.failed).map(mapPost);
      const recentlySent = edgesOf(data.recentSent).map(mapPost);
      const stored = await upsertPosts(db, accountIds, [...recentlySent, ...failed, ...pending], t);
      items += channels.length + stored.size;
      details.channels += channels.length;
      details.pending += pending.length;
      details.approvals += approvals.length;
      details.failed += failed.length;
      details.recentlySent += recentlySent.length;
      details.filterInconsistencies += missedByFilter.length;
      if (listingComplete) {
        details.markedMissing += await markMissingPending(db, [...accountIds.values()], pending.map((p) => p.externalPostId), t);
      } else {
        details.incompleteListings += 1;
      }
    }
    return { status: details.incompleteListings > 0 ? "partial" : "succeeded", details, items };
  });
}

export async function syncPublished(
  ctx: SyncContext,
  connectionId: string,
  { lookbackDays }: { lookbackDays?: number } = {},
): Promise<SyncOutcome> {
  const now = ctx.now ?? (() => new Date());
  return runWithConnection(ctx, connectionId, "published", async (client, conn, runId) => {
    const { db } = ctx;
    const orgs = await ensureOrganizations(db, client, conn, now());
    const [previous] = await db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(and(eq(syncRuns.connectionId, conn.id), eq(syncRuns.kind, "published"), eq(syncRuns.status, "succeeded")))
      .limit(1);
    // First run backfills 90 days; later runs refresh 35 days of lifetime metrics (covers 4-week baselines).
    const days = lookbackDays ?? (previous ? 35 : 90);
    const details = { organizations: orgs.length, lookbackDays: days, posts: 0, observationsWritten: 0, pages: 0, truncated: false };
    let items = 0;
    for (const org of orgs) {
      const since = new Date(now().getTime() - days * DAY).toISOString();
      const accountIds = await channelMapForOrg(db, conn.id, org.id);
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data: { published: RawConnection<RawPost> } = await client.query(PUBLISHED_PAGE_QUERY, { org: org.externalId, since, after });
        details.pages += 1;
        const published = edgesOf(data.published).map(mapPost);
        const t = now();
        const stored = await upsertPosts(db, accountIds, published, t, { authoritativeTags: true });
        details.observationsWritten += await ingestPostMetrics(db, published, stored, { now: t, runId });
        details.posts += published.length;
        items += stored.size;
        const info = data.published.pageInfo;
        if (!info.hasNextPage || !info.endCursor) break;
        after = info.endCursor;
        if (page === MAX_PAGES - 1) details.truncated = true;
      }
    }
    return { status: details.truncated ? "partial" : "succeeded", details, items };
  });
}
