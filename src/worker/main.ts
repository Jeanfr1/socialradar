/**
 * BrandPulse background worker: scheduler + durable job runner.
 * Run with `npm run worker` (one or more instances; job claiming is safe under concurrency).
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { evaluateAlerts } from "@/server/alerts/engine";
import { closeDb, getDb, type Db } from "@/server/db/client";
import { workerHeartbeats } from "@/server/db/schema";
import { claimJobs, completeJob, enqueueJob, failJob, purgeFinishedJobs, recoverExpiredLocks, type JobRow } from "@/server/jobs/queue";
import { JOB_KINDS, scheduleSyncJobs, scheduleWeeklyReports, schedulerOptionsFromEnv } from "@/server/jobs/scheduler";
import { ProviderError } from "@/server/providers/types";
import { syncPublished, syncQueue } from "@/server/sync/buffer-sync";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

type Handler = (job: JobRow, db: Db) => Promise<void>;

function payloadString(job: JobRow, key: string): string {
  const value = job.payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Job ${job.kind} is missing payload.${key}`);
  return value;
}

const handlers: Record<string, Handler> = {
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
    await runScheduledWeeklyReport(db, { brandId: payloadString(job, "brandId"), periodStart: payloadString(job, "periodStart") }, new Date());
  },
  [JOB_KINDS.generateRecommendations]: async (job, db) => {
    const { generateRecommendationsForConnection } = await import("@/server/insights/service");
    await generateRecommendationsForConnection(db, payloadString(job, "connectionId"), new Date());
  },
};

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component: "worker", message, ...fields });
  (level === "error" ? console.error : console.log)(line);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(db: Db, job: JobRow): Promise<void> {
  const handler = handlers[job.kind];
  const started = Date.now();
  if (!handler) {
    await failJob(db, job, { message: `No handler for job kind ${job.kind}`, retryable: false });
    log("error", "unknown job kind", { jobId: job.id, kind: job.kind });
    return;
  }
  try {
    await handler(job, db);
    await completeJob(db, job);
    log("info", "job succeeded", { jobId: job.id, kind: job.kind, attempt: job.attempts, ms: Date.now() - started });
  } catch (err) {
    const provider = err instanceof ProviderError ? err : null;
    const message = err instanceof Error ? err.message : "Unknown error";
    const outcome = await failJob(db, job, {
      message: provider ? `${provider.code}: ${message}` : message,
      retryable: provider ? provider.retryable : true,
      retryAfterMs: provider?.retryAfterMs,
    });
    log(provider?.code === "quota_reserved" ? "warn" : "error", "job failed", {
      jobId: job.id,
      kind: job.kind,
      attempt: job.attempts,
      code: provider?.code ?? "internal_error",
      error: message,
      outcome,
    });
  }
}

async function main() {
  const db = getDb();
  const workerId = `${hostname()}:${process.pid}`;
  const pollMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
  const opts = schedulerOptionsFromEnv();
  const startedAt = new Date();
  let stopping = false;
  let processed = 0;
  let lastSchedule = 0;
  let lastAlerts = 0;
  let lastPurge = 0;
  const stop = () => {
    stopping = true;
    log("info", "shutdown requested");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log("info", "worker started", { workerId, pollMs });

  while (!stopping) {
    const now = new Date();
    try {
      if (now.getTime() - lastSchedule >= 60_000) {
        lastSchedule = now.getTime();
        await db
          .insert(workerHeartbeats)
          .values({ workerId, startedAt, lastSeenAt: now, jobsProcessed: processed })
          .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: now, jobsProcessed: processed } });
        const recovered = await recoverExpiredLocks(db, now);
        if (recovered) log("warn", "recovered jobs with expired locks", { recovered });
        const enqueued = [...(await scheduleSyncJobs(db, now, opts)), ...(await scheduleWeeklyReports(db, now))];
        if (enqueued.length) log("info", "jobs scheduled", { enqueued });
      }
      if (now.getTime() - lastAlerts >= opts.alertsEveryMinutes * 60_000) {
        lastAlerts = now.getTime();
        await enqueueJob(db, { kind: JOB_KINDS.evaluateAlerts, payload: {}, dedupeKey: `${JOB_KINDS.evaluateAlerts}:all` });
      }
      if (now.getTime() - lastPurge >= 6 * 3600_000) {
        lastPurge = now.getTime();
        await purgeFinishedJobs(db, new Date(now.getTime() - 14 * 86_400_000));
      }

      const [job] = await claimJobs(db, { workerId, now });
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      await runJob(db, job);
      processed += 1;
      await db
        .update(workerHeartbeats)
        .set({ lastSeenAt: new Date(), jobsProcessed: processed, lastJobKind: job.kind })
        .where(sql`${workerHeartbeats.workerId} = ${workerId}`);
    } catch (err) {
      log("error", "worker loop error", { error: err instanceof Error ? err.message : String(err) });
      await sleep(pollMs);
    }
  }
  await closeDb();
  log("info", "worker stopped");
}

main().catch((err) => {
  log("error", "worker crashed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
