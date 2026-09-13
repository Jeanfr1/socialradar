/**
 * Generate every weekly report that is due now (same rules as the worker), without waiting for the worker loop.
 *   npm run reports:run
 * Idempotent: scheduled reports are unique per brand and period; already generated periods are skipped.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { closeDb, getDb } from "@/server/db/client";
import { claimJobs, completeJob, failJob } from "@/server/jobs/queue";
import { JOB_KINDS, scheduleWeeklyReports } from "@/server/jobs/scheduler";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

async function main() {
  const db = getDb();
  const now = new Date();
  const enqueued = await scheduleWeeklyReports(db, now);
  console.log(enqueued.length ? `Due reports: ${enqueued.join(", ")}` : "No newly due reports (already generated or not yet due).");
  const { runScheduledWeeklyReport } = await import("@/server/reports/service");
  const workerId = `reports-cli:${hostname()}:${process.pid}`;
  for (;;) {
    const [job] = await claimJobs(db, { workerId, now: new Date(), kinds: [JOB_KINDS.weeklyReport] });
    if (!job) break;
    const brandId = String(job.payload.brandId);
    const periodStart = String(job.payload.periodStart);
    try {
      const report = await runScheduledWeeklyReport(db, { brandId, periodStart }, new Date());
      await completeJob(db, job);
      console.log(`Brand ${brandId} · week ${periodStart}: v${report.version} ${report.status}${report.isPreliminary ? " (preliminary)" : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(db, job, { message, retryable: true });
      console.log(`Brand ${brandId} · week ${periodStart}: FAILED — ${message}`);
    }
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error("reports:run failed:", err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
