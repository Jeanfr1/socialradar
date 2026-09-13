import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { connections, metricObservations, postMetricsLatest, posts, providerOrganizations, socialAccounts, syncRuns } from "@/server/db/schema";
import type { RawPost } from "@/server/providers/buffer/adapter";
import { ProviderError } from "@/server/providers/types";
import { createTestDb } from "@/test/db";
import { syncPublished, syncQueue, type SyncContext } from "./buffer-sync";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-09-13T12:00:00Z");
const HEALTHY_RATE = '"100-in-15min"; r=90; t=900, "250-in-1day"; r=240; t=40000, "3000-in-30days"; r=2900; t=2000000';

beforeAll(async () => ({ db, close } = await createTestDb()));
afterAll(async () => close());

let connectionId: string;
beforeEach(async () => {
  await db.delete(connections);
  const [conn] = await db
    .insert(connections)
    .values({ provider: "buffer", label: "Test", status: "active", credentialCiphertext: "x", credentialKeyVersion: 1 })
    .returning();
  connectionId = conn!.id;
});

const channel = (id: string, service: string) => ({
  id,
  name: `handle_${id}`,
  displayName: null,
  service,
  serviceId: `svc_${id}`,
  type: "business",
  timezone: "America/Sao_Paulo",
  avatar: "",
  externalLink: null,
  isQueuePaused: false,
  isDisconnected: false,
  isLocked: false,
  allowedActions: ["viewInsights"],
  postingSchedule: [{ day: "mon", paused: false, times: ["20:00"] }],
});

const post = (id: string, channelId: string, status: string, dueAt: string | null, extra: Partial<RawPost> = {}): RawPost => ({
  id,
  channelId,
  status,
  dueAt,
  sentAt: status === "sent" ? dueAt : null,
  shareMode: "customScheduled",
  isCustomScheduled: true,
  schedulingType: "automatic",
  via: "buffer",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  metadata: { type: "reel" },
  ...extra,
});

const conn = (nodes: RawPost[], hasNextPage = false) => ({
  edges: nodes.map((node) => ({ node })),
  pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : null },
});

type Scenario = {
  pending: RawPost[];
  failed?: RawPost[];
  recentSent?: RawPost[];
  published?: RawPost[];
  queueStatus?: number;
  pendingHasNext?: boolean;
  pageFails?: boolean;
  /** Ids the provider's status filter wrongly omits (they still appear in the status-agnostic upcoming listing). */
  hiddenByFilter?: string[];
};

function fakeBuffer(s: Scenario) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const headers = { "content-type": "application/json", ratelimit: HEALTHY_RATE };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (query.includes("BrandPulseAccount")) {
      return json({ data: { account: { id: "acc1", name: "owner", organizations: [{ id: "org1", name: "Org", channelCount: 2, limits: { scheduledPosts: 10 } }] } } });
    }
    if (query.includes("BrandPulseQueue")) {
      if (s.queueStatus) return json({ errors: [{ message: "Bad Gateway", extensions: { code: "UPSTREAM_SERVER_ERROR" } }] }, s.queueStatus);
      const visible = s.pending.filter((p) => !(s.hiddenByFilter ?? []).includes(p.id));
      return json({
        data: {
          channels: [channel("ch1", "instagram"), channel("ch2", "youtube")],
          pending: conn(visible.filter((p) => p.status !== "needs_approval"), s.pendingHasNext),
          approvals: conn(visible.filter((p) => p.status === "needs_approval")),
          upcoming: conn(s.pending.filter((p) => p.dueAt !== null && Date.parse(p.dueAt) >= NOW.getTime())),
          failed: conn(s.failed ?? []),
          recentSent: conn(s.recentSent ?? []),
        },
      });
    }
    if (query.includes("BrandPulsePendingPage")) {
      if (s.pageFails) return json({ errors: [{ message: "boom", extensions: { code: "UNEXPECTED" } }] });
      return json({ data: { pending: conn([]) } });
    }
    if (query.includes("BrandPulsePublished")) return json({ data: { published: conn(s.published ?? []) } });
    throw new Error("unexpected query");
  });
}

const ctx = (fetchImpl: ReturnType<typeof fakeBuffer>): SyncContext => ({
  db,
  now: () => NOW,
  fetchImpl: fetchImpl as unknown as typeof fetch,
  sleep: () => Promise.resolve(),
  getSecret: async () => "fake-key",
});

const PENDING = [
  post("p1", "ch1", "scheduled", "2026-09-13T23:00:00Z", { text: "caption 1" }),
  post("p2", "ch1", "scheduled", "2026-09-14T23:00:00Z"),
  post("p3", "ch2", "needs_approval", null),
];

async function countPosts(status?: string) {
  const rows = await db.select().from(posts);
  return status ? rows.filter((r) => r.status === status).length : rows.length;
}

describe("syncQueue", () => {
  it("upserts channels and pending posts idempotently", async () => {
    const f = fakeBuffer({ pending: PENDING, failed: [post("e1", "ch2", "error", "2026-09-10T10:00:00Z", { error: { message: "Lost authorization" } })] });
    const first = await syncQueue(ctx(f), connectionId);
    expect(first.status).toBe("succeeded");
    expect(first.requestsUsed).toBe(2); // account + one org document
    await syncQueue(ctx(f), connectionId);

    expect(await db.select().from(socialAccounts)).toHaveLength(2);
    expect(await db.select().from(providerOrganizations)).toHaveLength(1);
    expect(await countPosts()).toBe(4);
    expect(await countPosts("scheduled")).toBe(2);
    const [failed] = await db.select().from(posts).where(eq(posts.externalPostId, "e1"));
    expect(failed?.errorMessage).toBe("Lost authorization");
    const [c] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(c?.lastSyncSuccessAt?.toISOString()).toBe(NOW.toISOString());
    expect(c?.rateLimitState?.["250-in-1day"]?.remaining).toBe(240);
    // Organizations are cached for 24h: the second run only spends one request.
    const runs = await db.select().from(syncRuns).where(eq(syncRuns.connectionId, connectionId));
    expect(runs.map((r) => r.requestsUsed).sort()).toEqual([1, 2]);
  });

  it("marks posts missing only after a complete listing and keeps enrichment fields", async () => {
    await syncQueue(ctx(fakeBuffer({ pending: PENDING })), connectionId);
    // p1 was published: it now appears in recentSent without text; p2 disappeared.
    await syncQueue(
      ctx(fakeBuffer({ pending: [PENDING[2]!], recentSent: [post("p1", "ch1", "sent", "2026-09-13T23:00:00Z")] })),
      connectionId,
    );
    const rows = await db.select().from(posts);
    const byId = Object.fromEntries(rows.map((r) => [r.externalPostId, r]));
    expect(byId.p1?.status).toBe("sent");
    expect(byId.p1?.text).toBe("caption 1");
    expect(byId.p2?.status).toBe("missing");
    expect(byId.p3?.status).toBe("needs_approval");
  });

  it("detects provider status-filter inconsistencies and never marks those posts missing", async () => {
    await syncQueue(ctx(fakeBuffer({ pending: PENDING })), connectionId);
    const out = await syncQueue(ctx(fakeBuffer({ pending: PENDING, hiddenByFilter: ["p2"] })), connectionId);
    expect(out.status).toBe("partial");
    expect(out.details.filterInconsistencies).toBe(1);
    expect(await countPosts("missing")).toBe(0);
    expect(await countPosts("scheduled")).toBe(2);
  });

  it("keeps the last known queue when the provider fails (never an empty queue)", async () => {
    await syncQueue(ctx(fakeBuffer({ pending: PENDING })), connectionId);
    await expect(syncQueue(ctx(fakeBuffer({ pending: [], queueStatus: 502 })), connectionId)).rejects.toMatchObject({ code: "upstream" });
    expect(await countPosts("scheduled")).toBe(2);
    const [c] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(c?.consecutiveFailures).toBe(1);
    expect(c?.lastErrorCode).toBe("upstream");
    expect(c?.lastSyncSuccessAt?.toISOString()).toBe(NOW.toISOString());
    const failedRuns = await db.select().from(syncRuns).where(and(eq(syncRuns.connectionId, connectionId), eq(syncRuns.status, "failed")));
    expect(failedRuns).toHaveLength(1);
  });

  it("does not mark anything missing when pagination fails mid-listing", async () => {
    await syncQueue(ctx(fakeBuffer({ pending: PENDING })), connectionId);
    await expect(syncQueue(ctx(fakeBuffer({ pending: [], pendingHasNext: true, pageFails: true })), connectionId)).rejects.toBeInstanceOf(ProviderError);
    expect(await countPosts("missing")).toBe(0);
  });

  it("skips syncing when only reserved quota is left, without counting a failure", async () => {
    await db
      .update(connections)
      .set({ rateLimitState: { "250-in-1day": { limit: 250, remaining: 100, resetAt: new Date(NOW.getTime() + 3600_000).toISOString(), windowSeconds: 86400 } } })
      .where(eq(connections.id, connectionId));
    const f = fakeBuffer({ pending: PENDING });
    await expect(syncQueue(ctx(f), connectionId)).rejects.toMatchObject({ code: "quota_reserved" });
    expect(f).not.toHaveBeenCalled();
    const [c] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(c?.consecutiveFailures).toBe(0);
    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.connectionId, connectionId));
    expect(run?.status).toBe("skipped");
  });

  it("marks the connection invalid on rejected credentials and skips later syncs", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "Not authorized", extensions: { code: "UNAUTHORIZED" } }] }), { status: 200 }));
    await expect(syncQueue(ctx(f as never), connectionId)).rejects.toMatchObject({ code: "unauthorized" });
    const [c] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(c?.status).toBe("invalid");
    expect((await syncQueue(ctx(f as never), connectionId)).status).toBe("skipped");
  });
});

describe("syncPublished", () => {
  const published = (metricsUpdatedAt: string | null, views: number) => [
    post("s1", "ch1", "sent", "2026-09-10T23:00:00Z", {
      text: "published caption",
      externalLink: "https://instagram.com/p/1",
      metricsUpdatedAt,
      metrics: [
        { type: "views", unit: "count", value: views },
        { type: "follows", unit: "count", value: 0 },
        { type: "quotes", unit: "count", value: 3 },
      ],
      tags: [{ name: "Launch" }],
    }),
  ];

  it("stores one observation per provider refresh and never duplicates on retry", async () => {
    await syncQueue(ctx(fakeBuffer({ pending: [] })), connectionId);
    await syncPublished(ctx(fakeBuffer({ pending: [], published: published("2026-09-12T03:00:00Z", 100) })), connectionId);
    await syncPublished(ctx(fakeBuffer({ pending: [], published: published("2026-09-12T03:00:00Z", 100) })), connectionId);
    let obs = await db.select().from(metricObservations);
    expect(obs).toHaveLength(2); // views + follows; unmapped "quotes" ignored
    expect(obs.find((o) => o.metricKey === "follows")?.valueStatus).toBe("reported_zero");

    await syncPublished(ctx(fakeBuffer({ pending: [], published: published("2026-09-13T03:00:00Z", 150) })), connectionId);
    obs = await db.select().from(metricObservations);
    expect(obs).toHaveLength(4);
    const latest = await db.select().from(postMetricsLatest).where(eq(postMetricsLatest.metricKey, "views"));
    expect(latest).toHaveLength(1);
    expect(latest[0]?.value).toBe(150);
    const [p] = await db.select().from(posts).where(eq(posts.externalPostId, "s1"));
    expect(p?.providerTags).toEqual(["Launch"]);
    expect(p?.externalUrl).toBe("https://instagram.com/p/1");
  });

  it("stores no metric values before Buffer has ingested metrics", async () => {
    await syncQueue(ctx(fakeBuffer({ pending: [] })), connectionId);
    await syncPublished(ctx(fakeBuffer({ pending: [], published: published(null, 0) })), connectionId);
    expect(await db.select().from(metricObservations)).toHaveLength(0);
    expect(await countPosts("sent")).toBe(1);
  });
});
