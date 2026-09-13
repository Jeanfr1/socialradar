import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/test/db";
import type { Db } from "@/server/db/client";
import { jobs } from "@/server/db/schema";
import { backoffDelayMs } from "./backoff";
import { claimJobs, completeJob, enqueueJob, failJob, recoverExpiredLocks } from "./queue";

let db: Db;
let close: () => Promise<void>;
const T0 = new Date("2026-09-13T12:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(jobs);
});

describe("job queue", () => {
  it("deduplicates active jobs with the same key but allows a new one after completion", async () => {
    expect((await enqueueJob(db, { kind: "sync.queue", dedupeKey: "sync.queue:c1", runAt: T0 })).enqueued).toBe(true);
    expect((await enqueueJob(db, { kind: "sync.queue", dedupeKey: "sync.queue:c1", runAt: T0 })).enqueued).toBe(false);
    const [job] = await claimJobs(db, { workerId: "w1", now: T0 });
    expect(job).toBeDefined();
    // Still deduplicated while running.
    expect((await enqueueJob(db, { kind: "sync.queue", dedupeKey: "sync.queue:c1", runAt: T0 })).enqueued).toBe(false);
    await completeJob(db, job!, T0);
    expect((await enqueueJob(db, { kind: "sync.queue", dedupeKey: "sync.queue:c1", runAt: T0 })).enqueued).toBe(true);
  });

  it("does not claim future jobs and claims each job only once", async () => {
    await enqueueJob(db, { kind: "a", runAt: new Date(T0.getTime() + 60_000) });
    await enqueueJob(db, { kind: "a", runAt: T0 });
    const first = await claimJobs(db, { workerId: "w1", now: T0, limit: 5 });
    const second = await claimJobs(db, { workerId: "w2", now: T0, limit: 5 });
    expect(first).toHaveLength(1);
    expect(first[0]!.attempts).toBe(1);
    expect(second).toHaveLength(0);
  });

  it("reschedules retryable failures with backoff and marks exhausted jobs dead", async () => {
    await enqueueJob(db, { kind: "a", runAt: T0, maxAttempts: 2 });
    const [job] = await claimJobs(db, { workerId: "w1", now: T0 });
    expect(await failJob(db, job!, { message: "upstream", retryable: true }, { now: T0, random: () => 0 })).toBe("retry_scheduled");
    expect(await claimJobs(db, { workerId: "w1", now: T0 })).toHaveLength(0);
    const later = new Date(T0.getTime() + 60_000);
    const [retry] = await claimJobs(db, { workerId: "w1", now: later });
    expect(retry?.attempts).toBe(2);
    expect(await failJob(db, retry!, { message: "upstream", retryable: true }, { now: later })).toBe("dead");
  });

  it("honours provider retry-after and fails non-retryable errors immediately", async () => {
    await enqueueJob(db, { kind: "a", runAt: T0 });
    const [job] = await claimJobs(db, { workerId: "w1", now: T0 });
    await failJob(db, job!, { message: "rate limited", retryable: true, retryAfterMs: 3600_000 }, { now: T0, random: () => 0 });
    expect(await claimJobs(db, { workerId: "w1", now: new Date(T0.getTime() + 3599_000) })).toHaveLength(0);
    const [again] = await claimJobs(db, { workerId: "w1", now: new Date(T0.getTime() + 3600_000) });
    expect(await failJob(db, again!, { message: "unauthorized", retryable: false })).toBe("failed");
  });

  it("recovers jobs from crashed workers", async () => {
    await enqueueJob(db, { kind: "a", runAt: T0 });
    await claimJobs(db, { workerId: "w1", now: T0, lockMs: 1000 });
    expect(await recoverExpiredLocks(db, new Date(T0.getTime() + 5000))).toBe(1);
    expect(await claimJobs(db, { workerId: "w2", now: new Date(T0.getTime() + 5000) })).toHaveLength(1);
  });

  it("computes bounded exponential backoff with jitter", () => {
    expect(backoffDelayMs(0, { baseMs: 1000, capMs: 10_000, random: () => 0 })).toBe(500);
    expect(backoffDelayMs(3, { baseMs: 1000, capMs: 10_000, random: () => 1 })).toBe(8000);
    expect(backoffDelayMs(10, { baseMs: 1000, capMs: 10_000, random: () => 1 })).toBe(10_000);
  });
});
