/**
 * Periodic scheduler: decides which durable jobs are due. Runs inside the worker every minute.
 * Enqueueing is idempotent (dedupe keys), so several workers or restarts never duplicate work.
 */
import { and, count, eq, inArray, isNull, max } from "drizzle-orm";
import { isValidTimezone, nextReportRunAt, previousCompleteWeek } from "@/domain/periods";
import type { Db } from "@/server/db/client";
import { brands, connections, providerOrganizations, reportVersions, syncRuns } from "@/server/db/schema";
import { recommendedIntervalMinutes, reservesFromEnv } from "@/server/providers/buffer/quota";
import type { RateLimitWindow } from "@/server/providers/types";
import { enqueueJob } from "./queue";

export const JOB_KINDS = {
  syncQueue: "sync.queue",
  syncPublished: "sync.published",
  evaluateAlerts: "alerts.evaluate",
  weeklyReport: "report.weekly",
  generateRecommendations: "recommendations.generate",
} as const;

export interface SchedulerOptions {
  queueBaseMinutes: number;
  publishedHours: number;
  alertsEveryMinutes: number;
}

export function schedulerOptionsFromEnv(env: Record<string, string | undefined> = process.env): SchedulerOptions {
  const num = (key: string, fallback: number) => (Number(env[key]) > 0 ? Number(env[key]) : fallback);
  return {
    queueBaseMinutes: num("BUFFER_QUEUE_SYNC_MINUTES", 120),
    publishedHours: num("BUFFER_METRICS_SYNC_HOURS", 24),
    alertsEveryMinutes: num("ALERTS_EVALUATE_MINUTES", 15),
  };
}

async function lastRunAt(db: Db, connectionId: string, kind: "queue" | "published", statuses?: ("succeeded" | "partial")[]) {
  const conditions = [eq(syncRuns.connectionId, connectionId), eq(syncRuns.kind, kind)];
  if (statuses) conditions.push(inArray(syncRuns.status, statuses));
  const [row] = await db.select({ at: max(syncRuns.startedAt) }).from(syncRuns).where(and(...conditions));
  return row?.at ?? null;
}

export async function scheduleSyncJobs(db: Db, now: Date, opts: SchedulerOptions): Promise<string[]> {
  const enqueued: string[] = [];
  const reserves = reservesFromEnv();
  const active = await db
    .select({ id: connections.id, rateLimitState: connections.rateLimitState })
    .from(connections)
    .where(and(isNull(connections.deletedAt), eq(connections.provider, "buffer"), inArray(connections.status, ["active", "error", "pending"])));

  for (const conn of active) {
    const [orgs] = await db.select({ n: count() }).from(providerOrganizations).where(eq(providerOrganizations.connectionId, conn.id));
    const windows: RateLimitWindow[] = Object.entries(conn.rateLimitState ?? {}).map(([name, w]) => ({ name, ...w }));
    const interval = recommendedIntervalMinutes(windows, reserves, now, {
      baseMinutes: opts.queueBaseMinutes,
      requestsPerRun: Math.max(1, orgs?.n ?? 1) + 1,
    });

    const lastQueue = await lastRunAt(db, conn.id, "queue");
    if (!lastQueue || now.getTime() - lastQueue.getTime() >= interval * 60_000) {
      const r = await enqueueJob(db, { kind: JOB_KINDS.syncQueue, payload: { connectionId: conn.id }, dedupeKey: `${JOB_KINDS.syncQueue}:${conn.id}`, runAt: now });
      if (r.enqueued) enqueued.push(`${JOB_KINDS.syncQueue}:${conn.id}`);
    }

    const lastPublishedOk = await lastRunAt(db, conn.id, "published", ["succeeded", "partial"]);
    const lastPublishedAttempt = await lastRunAt(db, conn.id, "published");
    const dueByAge = !lastPublishedOk || now.getTime() - lastPublishedOk.getTime() >= opts.publishedHours * 3600_000;
    // After a failed attempt wait at least the queue interval before trying again.
    const recentlyAttempted = lastPublishedAttempt && now.getTime() - lastPublishedAttempt.getTime() < interval * 60_000;
    if (dueByAge && !recentlyAttempted) {
      const r = await enqueueJob(db, {
        kind: JOB_KINDS.syncPublished,
        payload: { connectionId: conn.id },
        dedupeKey: `${JOB_KINDS.syncPublished}:${conn.id}`,
        runAt: now,
      });
      if (r.enqueued) enqueued.push(`${JOB_KINDS.syncPublished}:${conn.id}`);
    }
  }
  return enqueued;
}

/**
 * Weekly reports are generated whether or not anyone opens the app. For each brand, the previous complete
 * Monday–Sunday week (brand timezone) becomes due at the first configured run time after the week ends
 * (default Monday 08:00). A worker that was offline catches up. The partial unique index on
 * report_versions (brand, period, trigger = scheduled) plus the job dedupe key prevent duplicates.
 */
export async function scheduleWeeklyReports(db: Db, now: Date): Promise<string[]> {
  const enqueued: string[] = [];
  const rows = await db
    .select({ id: brands.id, timezone: brands.timezone, schedule: brands.reportSchedule })
    .from(brands)
    .where(isNull(brands.archivedAt));
  for (const brand of rows) {
    if (!brand.schedule.enabled || !isValidTimezone(brand.timezone)) continue;
    const period = previousCompleteWeek(now, brand.timezone);
    const runAt = nextReportRunAt(new Date(period.endUtcExclusive.getTime() - 1), brand.timezone, brand.schedule);
    if (now.getTime() < runAt.getTime()) continue;
    const [existing] = await db
      .select({ id: reportVersions.id })
      .from(reportVersions)
      .where(and(eq(reportVersions.brandId, brand.id), eq(reportVersions.periodStart, period.start), eq(reportVersions.trigger, "scheduled")))
      .limit(1);
    if (existing) continue;
    const dedupeKey = `${JOB_KINDS.weeklyReport}:${brand.id}:${period.start}`;
    const r = await enqueueJob(db, { kind: JOB_KINDS.weeklyReport, payload: { brandId: brand.id, periodStart: period.start }, dedupeKey, runAt: now });
    if (r.enqueued) enqueued.push(dedupeKey);
  }
  return enqueued;
}
