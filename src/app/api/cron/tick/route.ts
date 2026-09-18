/**
 * Serverless scheduler tick for deployments without a long-running worker (e.g. Vercel Cron).
 * Protected by CRON_SECRET: Vercel sends it as `Authorization: Bearer <CRON_SECRET>`.
 *
 * The response is returned immediately (202) and the work runs in `after()`. When due jobs remain after the
 * time budget, the tick re-invokes itself (up to MAX_HOPS) so a single daily cron still drains the whole queue.
 * Add `?wait=1` to run synchronously and get the result (manual checks).
 */
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { getDb } from "@/server/db/client";
import { processJobs, scheduleDueWork } from "@/server/jobs/handlers";
import { countDueJobs, recoverExpiredLocks } from "@/server/jobs/queue";
import { logger } from "@/server/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_HOPS = 10;

async function triggerNextHop(origin: string, secret: string, hop: number): Promise<void> {
  try {
    await fetch(`${origin}/api/cron/tick?hop=${hop}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err) {
    logger.warn("cron next hop failed", { hop, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");
  // Without a configured secret the endpoint stays closed, and a wrong secret looks like a missing route.
  if (!secret || provided !== `Bearer ${secret}`) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const hop = Math.min(MAX_HOPS, Math.max(0, Number(url.searchParams.get("hop")) || 0));
  const wait = url.searchParams.get("wait") === "1";

  const run = async () => {
    const db = getDb();
    const now = new Date();
    const workerId = `cron:${hop}:${randomUUID().slice(0, 8)}`;
    // The first hop schedules everything that is due; later hops only continue draining the queue.
    const scheduled = hop === 0 ? await scheduleDueWork(db, now) : { recovered: await recoverExpiredLocks(db, now), enqueued: [] };
    const outcomes = await processJobs(db, { workerId, budgetMs: Number(process.env.CRON_BUDGET_MS ?? 45_000) });
    const remaining = await countDueJobs(db, new Date());
    const failed = outcomes.filter((o) => o.status !== "succeeded").length;
    logger.info("cron tick", { workerId, hop, recovered: scheduled.recovered, enqueued: scheduled.enqueued.length, processed: outcomes.length, failed, remaining });
    // Only continue when this hop made progress, so failing jobs (rescheduled with backoff) cannot loop.
    if (remaining > 0 && outcomes.length > 0 && hop + 1 < MAX_HOPS) await triggerNextHop(url.origin, secret, hop + 1);
    return {
      ok: true,
      hop,
      at: now.toISOString(),
      recovered: scheduled.recovered,
      enqueued: scheduled.enqueued,
      processed: outcomes.map(({ kind, status, code, ms }) => ({ kind, status, code, ms })),
      remaining,
    };
  };

  if (wait) return Response.json(await run(), { headers: { "cache-control": "no-store" } });
  after(run);
  return Response.json({ ok: true, accepted: true, hop }, { status: 202, headers: { "cache-control": "no-store" } });
}
