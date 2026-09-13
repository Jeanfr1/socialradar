/**
 * Durable PostgreSQL job queue.
 * - Deduplication: a partial unique index on dedupe_key covers queued + running jobs.
 * - Claiming uses SELECT ... FOR UPDATE SKIP LOCKED, so several workers can run safely.
 * - Expired locks (crashed worker) are recovered; retries use exponential backoff with jitter.
 */
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { backoffDelayMs } from "./backoff";

export type JobRow = typeof jobs.$inferSelect;

export async function enqueueJob(
  db: Db,
  input: { kind: string; payload?: Record<string, unknown>; dedupeKey?: string | null; runAt?: Date; maxAttempts?: number },
): Promise<{ enqueued: boolean; id: number | null }> {
  const rows = await db
    .insert(jobs)
    .values({
      kind: input.kind,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return { enqueued: rows.length > 0, id: rows[0]?.id ?? null };
}

export async function claimJobs(
  db: Db,
  { workerId, now = new Date(), limit = 1, lockMs = 10 * 60_000, kinds }: {
    workerId: string;
    now?: Date;
    limit?: number;
    lockMs?: number;
    kinds?: string[];
  },
): Promise<JobRow[]> {
  return db.transaction(async (tx) => {
    const conditions = [eq(jobs.status, "queued"), lte(jobs.runAt, now)];
    if (kinds?.length) conditions.push(inArray(jobs.kind, kinds));
    const candidates = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(...conditions))
      .orderBy(asc(jobs.runAt), asc(jobs.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    return tx
      .update(jobs)
      .set({
        status: "running",
        lockedBy: workerId,
        lockedUntil: new Date(now.getTime() + lockMs),
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(jobs.id, candidates.map((c) => c.id)))
      .returning();
  });
}

export async function completeJob(db: Db, job: JobRow, now = new Date()): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", lockedBy: null, lockedUntil: null, finishedAt: now, updatedAt: now, lastError: null })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
}

export async function failJob(
  db: Db,
  job: JobRow,
  error: { message: string; retryable: boolean; retryAfterMs?: number },
  { now = new Date(), random = Math.random }: { now?: Date; random?: () => number } = {},
): Promise<"retry_scheduled" | "failed" | "dead"> {
  const lastError = error.message.slice(0, 1000);
  if (error.retryable && job.attempts < job.maxAttempts) {
    const delay = Math.max(
      error.retryAfterMs ?? 0,
      backoffDelayMs(job.attempts - 1, { baseMs: 30_000, capMs: 6 * 3600_000, random }),
    );
    await db
      .update(jobs)
      .set({ status: "queued", runAt: new Date(now.getTime() + delay), lockedBy: null, lockedUntil: null, lastError, updatedAt: now })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
    return "retry_scheduled";
  }
  const status = error.retryable ? "dead" : "failed";
  await db
    .update(jobs)
    .set({ status, lockedBy: null, lockedUntil: null, lastError, finishedAt: now, updatedAt: now })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
  return status;
}

/** Return jobs whose worker died (lock expired) to the queue. */
export async function recoverExpiredLocks(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedUntil: null, updatedAt: now })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedUntil, now)))
    .returning({ id: jobs.id });
  return rows.length;
}

export async function purgeFinishedJobs(db: Db, olderThan: Date): Promise<void> {
  await db.delete(jobs).where(and(inArray(jobs.status, ["succeeded", "failed", "dead"]), lt(jobs.finishedAt, olderThan)));
}
