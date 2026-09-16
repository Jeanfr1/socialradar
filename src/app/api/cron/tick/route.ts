/**
 * Serverless scheduler tick for deployments without a long-running worker (e.g. Vercel Cron).
 * Protected by CRON_SECRET: Vercel sends it as `Authorization: Bearer <CRON_SECRET>`.
 * Idempotent — running it more often than needed only re-checks what is due.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/client";
import { processJobs, scheduleDueWork } from "@/server/jobs/handlers";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");
  // Without a configured secret the endpoint stays closed, and a wrong secret looks like a missing route.
  if (!secret || provided !== `Bearer ${secret}`) return new Response("Not found", { status: 404 });

  const db = getDb();
  const now = new Date();
  const workerId = `cron:${randomUUID().slice(0, 8)}`;
  const { recovered, enqueued } = await scheduleDueWork(db, now);
  const outcomes = await processJobs(db, { workerId, budgetMs: Number(process.env.CRON_BUDGET_MS ?? 45_000) });
  const failed = outcomes.filter((o) => o.status !== "succeeded");
  logger.info("cron tick", { workerId, recovered, enqueued: enqueued.length, processed: outcomes.length, failed: failed.length });
  return Response.json(
    {
      ok: true,
      at: now.toISOString(),
      recovered,
      enqueued,
      processed: outcomes.map(({ kind, status, code, ms }) => ({ kind, status, code, ms })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
