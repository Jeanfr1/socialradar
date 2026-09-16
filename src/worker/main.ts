/**
 * BrandPulse background worker: scheduler + durable job runner.
 * Run with `npm run worker` (one or more instances; job claiming is safe under concurrency).
 * On serverless hosts without a long-running process, use the equivalent /api/cron/tick endpoint instead.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { workerHeartbeats } from "@/server/db/schema";
import { claimJobs, purgeFinishedJobs } from "@/server/jobs/queue";
import { runJob, scheduleDueWork } from "@/server/jobs/handlers";
import { schedulerOptionsFromEnv } from "@/server/jobs/scheduler";
import { logger } from "@/server/logger";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = getDb();
  const log = logger.child({ component: "worker" });
  const workerId = `${hostname()}:${process.pid}`;
  const pollMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
  const opts = schedulerOptionsFromEnv();
  const startedAt = new Date();
  let stopping = false;
  let processed = 0;
  let lastSchedule = 0;
  let lastPurge = 0;

  const stop = () => {
    stopping = true;
    log.info("shutdown requested");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log.info("worker started", { workerId, pollMs });

  while (!stopping) {
    const now = new Date();
    try {
      if (now.getTime() - lastSchedule >= 60_000) {
        lastSchedule = now.getTime();
        await db
          .insert(workerHeartbeats)
          .values({ workerId, startedAt, lastSeenAt: now, jobsProcessed: processed })
          .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: now, jobsProcessed: processed } });
        const { recovered, enqueued } = await scheduleDueWork(db, now, opts);
        if (recovered) log.warn("recovered jobs with expired locks", { recovered });
        if (enqueued.length) log.info("jobs scheduled", { enqueued });
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
      const outcome = await runJob(db, job);
      processed += 1;
      if (outcome.status === "succeeded") log.info("job succeeded", { ...outcome });
      else log.error("job failed", { ...outcome });
      await db
        .update(workerHeartbeats)
        .set({ lastSeenAt: new Date(), jobsProcessed: processed, lastJobKind: job.kind, lastError: outcome.error ?? null })
        .where(eq(workerHeartbeats.workerId, workerId));
    } catch (err) {
      log.error("worker loop error", { error: err instanceof Error ? err.message : String(err) });
      await sleep(pollMs);
    }
  }
  await closeDb();
  log.info("worker stopped");
}

main().catch((err) => {
  logger.error("worker crashed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
