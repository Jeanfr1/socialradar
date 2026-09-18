/**
 * Operational status per social account: cadence, queue coverage, publishing failures and sync freshness.
 * Shared by the alerts engine, dashboards and reports. Callers are responsible for authorization
 * (pass only account/brand ids the actor may access).
 */
import { and, eq, gte, inArray, isNull, max, or, type SQL } from "drizzle-orm";
import { computeCoverage, type CoverageResultDetailed } from "@/domain/coverage";
import type { CadenceConfig, QueueItem } from "@/domain/types";
import type { Db } from "@/server/db/client";
import { brands, connections, postingSchedules, posts, providerOrganizations, socialAccounts, syncRuns } from "@/server/db/schema";

export const OVERDUE_GRACE_MINUTES = 30;
const RECENT_ERROR_DAYS = 14;

export const DEFAULT_POSTING_SCHEDULE = {
  mode: "provider_schedule",
  slots: [],
  postsPerWeek: null,
  timezone: null,
  matchMode: "same_day",
  matchToleranceMinutes: 90,
  horizonDays: 14,
  warningDays: 7,
  criticalDays: 3,
  staleAfterMinutes: 1560,
} as const satisfies Omit<typeof postingSchedules.$inferInsert, "socialAccountId" | "updatedBy" | "updatedAt">;

type AccountRow = typeof socialAccounts.$inferSelect;
type ScheduleRow = typeof postingSchedules.$inferSelect;

export interface AccountStatus {
  account: Pick<
    AccountRow,
    | "id"
    | "brandId"
    | "connectionId"
    | "platform"
    | "handle"
    | "displayName"
    | "avatarUrl"
    | "externalUrl"
    | "isQueuePaused"
    | "isDisconnected"
    | "isLocked"
    | "isDemo"
    | "providerTimezone"
    | "mappingStatus"
  >;
  brandTimezone: string;
  cadence: CadenceConfig;
  /** True when the account uses defaults because no BrandPulse schedule has been saved yet. */
  cadenceIsDefault: boolean;
  coverage: CoverageResultDetailed;
  lastQueueSyncAt: Date | null;
  connection: {
    id: string;
    label: string;
    status: string;
    lastSyncSuccessAt: Date | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    consecutiveFailures: number;
  };
  recentErrors: { postId: string; dueAt: Date | null; message: string; externalUrl: string | null }[];
  overdue: { postId: string; dueAt: Date }[];
  /** Provider cap on pending scheduled posts (Buffer `limits.scheduledPosts`; per-channel enforcement unverified). */
  inventoryCap: number | null;
}

export function buildCadence(
  account: Pick<AccountRow, "providerPostingSchedule" | "providerTimezone">,
  schedule: ScheduleRow | null,
  brandTimezone: string,
): CadenceConfig {
  const s = schedule ?? DEFAULT_POSTING_SCHEDULE;
  // Buffer slot times are expressed in the channel timezone; custom slots in the configured or brand timezone.
  const timezone =
    s.timezone ?? (s.mode === "provider_schedule" ? account.providerTimezone ?? brandTimezone : brandTimezone);
  return {
    mode: s.mode,
    timezone,
    days: s.mode === "custom" ? [...s.slots] : [...(account.providerPostingSchedule ?? [])],
    postsPerWeek: s.postsPerWeek,
    matchMode: s.matchMode,
    matchToleranceMinutes: s.matchToleranceMinutes,
    horizonDays: s.horizonDays,
    warningDays: s.warningDays,
    criticalDays: s.criticalDays,
    staleAfterMinutes: s.staleAfterMinutes,
  };
}

export async function loadAccountStatuses(
  db: Db,
  filter: { accountIds?: string[]; brandIds?: string[]; connectionId?: string; includeUnmapped?: boolean },
  now: Date,
): Promise<AccountStatus[]> {
  const conditions: SQL[] = [isNull(socialAccounts.removedAt), isNull(connections.deletedAt)];
  if (filter.accountIds) conditions.push(inArray(socialAccounts.id, filter.accountIds.length ? filter.accountIds : ["00000000-0000-0000-0000-000000000000"]));
  if (filter.brandIds) conditions.push(inArray(socialAccounts.brandId, filter.brandIds.length ? filter.brandIds : ["00000000-0000-0000-0000-000000000000"]));
  if (filter.connectionId) conditions.push(eq(socialAccounts.connectionId, filter.connectionId));
  if (!filter.includeUnmapped) conditions.push(eq(socialAccounts.mappingStatus, "mapped"));

  const rows = await db
    .select({ account: socialAccounts, schedule: postingSchedules, brandTimezone: brands.timezone, connection: connections, orgLimits: providerOrganizations.limits })
    .from(socialAccounts)
    .innerJoin(connections, eq(connections.id, socialAccounts.connectionId))
    .leftJoin(brands, eq(brands.id, socialAccounts.brandId))
    .leftJoin(postingSchedules, eq(postingSchedules.socialAccountId, socialAccounts.id))
    .leftJoin(providerOrganizations, eq(providerOrganizations.id, socialAccounts.providerOrganizationId))
    .where(and(...conditions));
  if (rows.length === 0) return [];

  const accountIds = rows.map((r) => r.account.id);
  const connectionIds = [...new Set(rows.map((r) => r.connection.id))];

  const [syncs, pending, errors] = await Promise.all([
    db
      .select({ connectionId: syncRuns.connectionId, at: max(syncRuns.finishedAt) })
      .from(syncRuns)
      .where(and(inArray(syncRuns.connectionId, connectionIds), eq(syncRuns.kind, "queue"), inArray(syncRuns.status, ["succeeded", "partial"])))
      .groupBy(syncRuns.connectionId),
    db
      .select({ id: posts.id, socialAccountId: posts.socialAccountId, status: posts.status, dueAt: posts.dueAt })
      .from(posts)
      .where(and(inArray(posts.socialAccountId, accountIds), inArray(posts.status, ["scheduled", "needs_approval", "draft", "sending"]))),
    db
      .select({ id: posts.id, socialAccountId: posts.socialAccountId, dueAt: posts.dueAt, message: posts.errorMessage, externalUrl: posts.externalUrl })
      .from(posts)
      .where(
        and(
          inArray(posts.socialAccountId, accountIds),
          eq(posts.status, "error"),
          or(isNull(posts.dueAt), gte(posts.dueAt, new Date(now.getTime() - RECENT_ERROR_DAYS * 86_400_000))),
        ),
      ),
  ]);
  const lastSyncByConnection = new Map(syncs.map((s) => [s.connectionId, s.at]));

  return rows.map(({ account, schedule, brandTimezone, connection, orgLimits }) => {
    const tz = brandTimezone ?? "America/Sao_Paulo";
    const cadence = buildCadence(account, schedule, tz);
    const items: QueueItem[] = pending
      .filter((p) => p.socialAccountId === account.id)
      .map((p) => ({ id: p.id, dueAt: p.dueAt, status: p.status as QueueItem["status"] }));
    const inventoryCap = typeof orgLimits?.scheduledPosts === "number" ? orgLimits.scheduledPosts : null;
    const lastQueueSyncAt = lastSyncByConnection.get(connection.id) ?? null;
    const coverage = computeCoverage(
      { now, cadence, items, lastQueueSyncAt, queuePaused: account.isQueuePaused, accountDisconnected: account.isDisconnected },
      { inventoryCap },
    );
    const overdueBefore = now.getTime() - OVERDUE_GRACE_MINUTES * 60_000;
    return {
      account: {
        id: account.id,
        brandId: account.brandId,
        connectionId: account.connectionId,
        platform: account.platform,
        handle: account.handle,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        externalUrl: account.externalUrl,
        isQueuePaused: account.isQueuePaused,
        isDisconnected: account.isDisconnected,
        isLocked: account.isLocked,
        isDemo: account.isDemo,
        providerTimezone: account.providerTimezone,
        mappingStatus: account.mappingStatus,
      },
      brandTimezone: tz,
      cadence,
      cadenceIsDefault: schedule === null,
      coverage,
      lastQueueSyncAt,
      connection: {
        id: connection.id,
        label: connection.label,
        status: connection.status,
        lastSyncSuccessAt: connection.lastSyncSuccessAt,
        lastErrorCode: connection.lastErrorCode,
        lastErrorMessage: connection.lastErrorMessage,
        consecutiveFailures: connection.consecutiveFailures,
      },
      recentErrors: errors
        .filter((e) => e.socialAccountId === account.id)
        .map((e) => ({ postId: e.id, dueAt: e.dueAt, message: e.message ?? "Publishing failed (no message from provider)", externalUrl: e.externalUrl })),
      overdue: items
        .filter((i): i is QueueItem & { dueAt: Date } => i.status === "scheduled" && i.dueAt !== null && i.dueAt.getTime() < overdueBefore)
        .map((i) => ({ postId: i.id, dueAt: i.dueAt })),
      inventoryCap,
    };
  });
}
