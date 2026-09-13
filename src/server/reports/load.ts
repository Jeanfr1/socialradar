/**
 * Loads everything a weekly report needs for ONE brand. Queries are brand-scoped: accounts come from
 * loadAccountStatuses({ brandIds: [brand.id] }) (mapped, not removed) and every other query is restricted to those
 * account ids. Connection credentials, labels and error messages are never selected into the report input.
 */
import { and, eq, gte, inArray, isNotNull, lt, lte, max, sql } from "drizzle-orm";
import type { WeekPeriod } from "@/domain/periods";
import type { BrandRow } from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { metricObservations, posts, syncRuns } from "@/server/db/schema";
import { loadAccountStatuses } from "@/server/queries/account-status";
import { loadPostPerformance } from "@/server/queries/post-performance";
import { reportWindowStart, type ObservationInput, type ReportInput } from "./facts";

const CHUNK = 500;

export async function loadReportInput(db: Db, brand: Pick<BrandRow, "id" | "name" | "timezone" | "reportLocale" | "contentPillars">, period: WeekPeriod, now: Date): Promise<ReportInput> {
  const statuses = (await loadAccountStatuses(db, { brandIds: [brand.id] }, now)).filter((s) => s.account.brandId === brand.id);
  const accountIds = statuses.map((s) => s.account.id);
  const connectionIds = [...new Set(statuses.map((s) => s.account.connectionId))];

  const [postRows, failedRows, publishedSyncs] = await Promise.all([
    loadPostPerformance(db, { accountIds, publishedFrom: reportWindowStart(period), publishedTo: period.endUtcExclusive }),
    accountIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ postId: posts.id, socialAccountId: posts.socialAccountId, dueAt: posts.dueAt, message: posts.errorMessage, externalUrl: posts.externalUrl })
          .from(posts)
          .where(and(inArray(posts.socialAccountId, accountIds), eq(posts.status, "error"), gte(posts.dueAt, period.startUtc), lt(posts.dueAt, period.endUtcExclusive))),
    connectionIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ connectionId: syncRuns.connectionId, at: max(syncRuns.finishedAt) })
          .from(syncRuns)
          .where(and(inArray(syncRuns.connectionId, connectionIds), eq(syncRuns.kind, "published"), eq(syncRuns.status, "succeeded"), lte(syncRuns.finishedAt, now)))
          .groupBy(syncRuns.connectionId),
  ]);

  const observations: ObservationInput[] = [];
  const postIds = postRows.map((p) => p.postId);
  for (let i = 0; i < postIds.length; i += CHUNK) {
    const chunk = postIds.slice(i, i + CHUNK);
    const rows = await db
      .select({
        postId: metricObservations.postId,
        metricKey: metricObservations.metricKey,
        value: metricObservations.value,
        valueStatus: metricObservations.valueStatus,
        providerUpdatedAt: metricObservations.providerUpdatedAt,
      })
      .from(metricObservations)
      .where(
        and(
          sql`${metricObservations.subject} = 'post'`,
          inArray(metricObservations.postId, chunk),
          isNotNull(metricObservations.providerUpdatedAt),
          lte(metricObservations.providerUpdatedAt, now),
          lte(metricObservations.retrievedAt, now),
        ),
      );
    for (const r of rows) {
      if (r.postId && r.providerUpdatedAt) observations.push({ postId: r.postId, metricKey: r.metricKey, value: r.value, valueStatus: r.valueStatus, providerUpdatedAt: r.providerUpdatedAt });
    }
  }

  const lastPublishedByConnection = new Map(publishedSyncs.map((s) => [s.connectionId, s.at]));
  return {
    brand: { id: brand.id, name: brand.name, timezone: brand.timezone, reportLocale: brand.reportLocale, contentPillars: brand.contentPillars ?? [] },
    period,
    now,
    accounts: statuses.map((s) => ({
      id: s.account.id,
      handle: s.account.handle,
      displayName: s.account.displayName,
      platform: s.account.platform,
      connectionStatus: s.connection.status,
      isDisconnected: s.account.isDisconnected,
      isQueuePaused: s.account.isQueuePaused,
      cadence: s.cadence,
      cadenceIsDefault: s.cadenceIsDefault,
      coverage: s.coverage,
      lastQueueSyncAt: s.lastQueueSyncAt,
      lastPublishedSyncAt: lastPublishedByConnection.get(s.account.connectionId) ?? null,
      overdueCount: s.overdue.length,
    })),
    posts: postRows.map((p) => ({
      postId: p.postId,
      socialAccountId: p.socialAccountId,
      platform: p.platform,
      format: p.format,
      publishedAt: p.publishedAt,
      metricsUpdatedAt: p.metricsUpdatedAt,
      metrics: p.metrics,
      tags: p.tags,
      externalUrl: p.externalUrl,
      text: p.text,
      title: p.title,
    })),
    observations,
    failedPosts: failedRows,
  };
}
