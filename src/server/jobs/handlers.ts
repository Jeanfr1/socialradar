/**
 * Job handlers shared by the long-running worker (`npm run worker`) and the serverless cron endpoint
 * (`/api/cron/tick`). Both claim from the same durable queue, so either deployment model works and
 * running both at once is safe (dedupe keys + SKIP LOCKED).
 */
import { and, eq, lt } from "drizzle-orm";
import { evaluateAlerts } from "@/server/alerts/engine";
import type { Db } from "@/server/db/client";
import { syncRuns } from "@/server/db/schema";
import { claimJobs, completeJob, enqueueJob, failJob, purgeFinishedJobs, recoverExpiredLocks, type JobRow } from "@/server/jobs/queue";
import { JOB_KINDS, scheduleSyncJobs, scheduleWeeklyReports, schedulerOptionsFromEnv, type SchedulerOptions } from "@/server/jobs/scheduler";
import { ProviderError } from "@/server/providers/types";
import { syncPublished, syncQueue } from "@/server/sync/buffer-sync";

export type JobHandler = (job: JobRow, db: Db) => Promise<void>;

function payloadString(job: JobRow, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Job ${job.kind} is missing payload.${key}`);
  return value;
}

export const jobHandlers: Record<string, JobHandler> = {
  [JOB_KINDS.syncQueue]: async (job, db) => {
    const connectionId = payloadString(job, "connectionId");
    try {
      await syncQueue({ db }, connectionId);
    } finally {
      // Evaluate alerts after success AND failure (connection failures are alerts too).
      await enqueueJob(db, { kind: JOB_KINDS.evaluateAlerts, payload: { connectionId }, dedupeKey: `${JOB_KINDS.evaluateAlerts}:${connectionId}` });
    }
  },
  [JOB_KINDS.syncPublished]: async (job, db) => {
    const connectionId = payloadString(job, "connectionId");
    await syncPublished({ db }, connectionId);
    await enqueueJob(db, {
      kind: JOB_KINDS.generateRecommendations,
      payload: { connectionId },
      dedupeKey: `${JOB_KINDS.generateRecommendations}:${connectionId}`,
    });
  },
  [JOB_KINDS.evaluateAlerts]: async (job, db) => {
    const connectionId = typeof job.payload.connectionId === "string" ? job.payload.connectionId : undefined;
    await evaluateAlerts(db, new Date(), { connectionId });
  },
  [JOB_KINDS.weeklyReport]: async (job, db) => {
    const { runScheduledWeeklyReport } = await import("@/server/reports/service");
    await runScheduledWeeklyReport(
      db,
      { brandId: payloadString(job, "brandId"), periodStart: payloadString(job, "periodStart"), kind: job.payload.kind === "month" ? "month" : "week" },
      new Date(),
    );
  },
  [JOB_KINDS.generateRecommendations]: async (job, db) => {
    const { generateRecommendationsForConnection } = await import("@/server/insights/service");
    await generateRecommendationsForConnection(db, payloadString(job, "connectionId"), new Date());
  },
};

export interface JobOutcome {
  jobId: number;
  kind: string;
  attempt: number;
  ms: number;
  status: "succeeded" | "retry_scheduled" | "failed" | "dead";
  code?: string;
  error?: string;
}

/** Runs one claimed job, recording success or failure (never throws). */
export async function runJob(db: Db, job: JobRow): Promise<JobOutcome> {
  const started = Date.now();
  const base = { jobId: job.id, kind: job.kind, attempt: job.attempts };
  const handler = jobHandlers[job.kind];
  if (!handler) {
    await failJob(db, job, { message: `No handler for job kind ${job.kind}`, retryable: false });
    return { ...base, ms: Date.now() - started, status: "failed", code: "unknown_kind" };
  }
  try {
    await handler(job, db);
    await completeJob(db, job);
    return { ...base, ms: Date.now() - started, status: "succeeded" };
  } catch (err) {
    const provider = err instanceof ProviderError ? err : null;
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = await failJob(db, job, {
      message: provider ? `${provider.code}: ${message}` : message,
      retryable: provider ? provider.retryable : true,
      retryAfterMs: provider?.retryAfterMs,
    });
    return { ...base, ms: Date.now() - started, status, code: provider?.code ?? "internal_error", error: message };
  }
}

/** Recovers crashed jobs and enqueues everything that is due (sync, alerts, weekly reports). */
export async function scheduleDueWork(
  db: Db,
  now: Date,
  opts: SchedulerOptions = schedulerOptionsFromEnv(),
): Promise<{ recovered: number; enqueued: string[] }> {
  const recovered = await recoverExpiredLocks(db, now);
  // Sync runs left "running" by a stopped process (e.g. a serverless timeout) are closed as interrupted.
  await db
    .update(syncRuns)
    .set({ status: "failed", finishedAt: now, errorCode: "interrupted", errorMessage: "Run did not finish (process stopped)" })
    .where(and(eq(syncRuns.status, "running"), lt(syncRuns.startedAt, new Date(now.getTime() - 15 * 60_000))));
  const enqueued = [...(await scheduleSyncJobs(db, now, opts)), ...(await scheduleWeeklyReports(db, now))];
  const alerts = await enqueueJob(db, { kind: JOB_KINDS.evaluateAlerts, payload: {}, dedupeKey: `${JOB_KINDS.evaluateAlerts}:all` });
  if (alerts.enqueued) enqueued.push(`${JOB_KINDS.evaluateAlerts}:all`);
  return { recovered, enqueued };
}

/** Claims and runs queued jobs until the time budget or the job limit is reached (used by the cron endpoint). */
export async function processJobs(
  db: Db,
  { workerId, budgetMs = 45_000, maxJobs = 25 }: { workerId: string; budgetMs?: number; maxJobs?: number },
): Promise<JobOutcome[]> {
  const deadline = Date.now() + budgetMs;
  const outcomes: JobOutcome[] = [];
  while (outcomes.length < maxJobs && Date.now() < deadline) {
    const [job] = await claimJobs(db, { workerId, now: new Date(), lockMs: Math.max(60_000, budgetMs * 2) });
    if (!job) break;
    outcomes.push(await runJob(db, job));
  }
  return outcomes;
}

export { purgeFinishedJobs };
