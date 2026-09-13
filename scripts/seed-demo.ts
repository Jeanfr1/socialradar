/**
 * Seeds an isolated DEMO brand with clearly labeled fixture data (never live analytics).
 * Every row is flagged is_demo and uses provider "demo"; the scheduler never syncs demo connections.
 * Re-running replaces the previous demo data. Usage: npm run seed:demo [-- --member <email>]
 *
 * Scenarios covered: a healthy account, an account with an imminent gap hidden behind one distant post,
 * an empty queue, a failed publication, ambiguous zeros, unsupported metrics and a 6-week metric history.
 */
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import {
  brands,
  connections,
  memberships,
  metricObservations,
  postingSchedules,
  postMetricsLatest,
  posts,
  providerOrganizations,
  socialAccounts,
  syncRuns,
  users,
} from "@/server/db/schema";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const DEMO_SLUG = "demo-brand";
const DAY = 86_400_000;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Deterministic PRNG so the demo is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260913);

/** Instant for local São Paulo wall time (UTC−3, no DST since 2019). */
function spTime(dayOffset: number, hour: number, base: Date): Date {
  const d = new Date(base);
  d.setUTCHours(hour + 3, 0, 0, 0);
  return new Date(d.getTime() + dayOffset * DAY);
}

type MetricPlan = Record<string, number | null>;

const PLATFORM_METRICS: Record<string, { key: string; unit: string }[]> = {
  instagram: [
    { key: "reactions", unit: "count" },
    { key: "comments", unit: "count" },
    { key: "shares", unit: "count" },
    { key: "saves", unit: "count" },
    { key: "views", unit: "count" },
    { key: "reach", unit: "count" },
    { key: "follows", unit: "count" },
    { key: "provider_engagement_rate", unit: "percentage" },
  ],
  tiktok: [
    { key: "reactions", unit: "count" },
    { key: "comments", unit: "count" },
    { key: "shares", unit: "count" },
    { key: "views", unit: "count" },
    { key: "reach", unit: "count" },
    { key: "avg_watch_time_seconds", unit: "seconds" },
    { key: "total_watch_time_minutes", unit: "minutes" },
    { key: "provider_engagement_rate", unit: "percentage" },
  ],
  youtube: [
    { key: "reactions", unit: "count" },
    { key: "comments", unit: "count" },
    { key: "views", unit: "count" },
    { key: "provider_engagement_rate", unit: "percentage" },
  ],
};

function finalMetrics(platform: string, format: string, strength: number): MetricPlan {
  const views = Math.round((platform === "youtube" ? 900 : 2400) * strength * (0.6 + rand()));
  const reach = Math.round(views * (0.55 + rand() * 0.2));
  const reactions = Math.round(views * (0.03 + rand() * 0.04));
  const comments = rand() < 0.4 ? 0 : Math.round(reactions * 0.08);
  const shares = rand() < 0.3 ? 0 : Math.round(reactions * 0.12);
  const saves = format === "carousel" ? Math.round(reactions * 0.3) : Math.round(reactions * 0.05);
  return {
    views,
    reach,
    reactions,
    comments,
    shares,
    saves,
    follows: 0, // mirrors the real Buffer behavior: always 0 on Instagram (likely not reported)
    avg_watch_time_seconds: Math.round(6 + rand() * 10),
    total_watch_time_minutes: Math.round((views * (6 + rand() * 10)) / 60),
    provider_engagement_rate: Math.round(((reactions + comments + shares) / Math.max(1, reach)) * 1000) / 10,
  };
}

async function main() {
  const db = getDb();
  const now = new Date();
  const memberEmail = process.argv.includes("--member") ? process.argv[process.argv.indexOf("--member") + 1] : undefined;

  // Replace previous demo data (cascades remove accounts, posts, metrics, alerts, reports).
  await db.delete(brands).where(and(eq(brands.slug, DEMO_SLUG), eq(brands.isDemo, true)));
  await db.delete(connections).where(and(eq(connections.provider, "demo"), eq(connections.isDemo, true)));

  const [brand] = await db
    .insert(brands)
    .values({
      name: "Demo Brand (fixtures)",
      slug: DEMO_SLUG,
      timezone: "America/Sao_Paulo",
      reportLocale: "pt-BR",
      businessGoals: "Demonstration only — synthetic data.",
      contentPillars: ["Educação", "Bastidores", "Produto"],
      isDemo: true,
    })
    .returning();
  const [conn] = await db
    .insert(connections)
    .values({
      provider: "demo",
      label: "Demo connection (fixtures)",
      status: "active",
      isDemo: true,
      externalAccountName: "demo",
      lastValidatedAt: now,
      lastSyncAttemptAt: now,
      lastSyncSuccessAt: now,
    })
    .returning();
  const [org] = await db.insert(providerOrganizations).values({ connectionId: conn!.id, externalId: "demo-org", name: "Demo organization", limits: { scheduledPosts: 10 } }).returning();

  const schedule = WEEKDAYS.map((day) => ({ day, paused: false, times: ["12:00", "19:00"] }));
  const accountsSpec = [
    { platform: "instagram" as const, handle: "demo.brand", scenario: "healthy", formats: ["reel", "carousel", "post"] },
    { platform: "tiktok" as const, handle: "demobrand", scenario: "distant_post_gap", formats: ["post"] },
    { platform: "youtube" as const, handle: "Demo Brand Channel", scenario: "empty_with_failure", formats: ["short"] },
  ];

  let postCounter = 0;
  for (const spec of accountsSpec) {
    const [account] = await db
      .insert(socialAccounts)
      .values({
        connectionId: conn!.id,
        providerOrganizationId: org!.id,
        provider: "demo",
        externalChannelId: `demo-${spec.platform}`,
        platform: spec.platform,
        platformAccountId: `demo-${spec.platform}-id`,
        channelType: spec.platform === "youtube" ? "channel" : spec.platform === "tiktok" ? "account" : "business",
        handle: spec.handle,
        providerTimezone: "America/Sao_Paulo",
        canViewInsights: true,
        providerPostingSchedule: schedule,
        brandId: brand!.id,
        mappingStatus: "mapped",
        isDemo: true,
      })
      .returning();
    await db.insert(postingSchedules).values({
      socialAccountId: account!.id,
      mode: "custom",
      slots: WEEKDAYS.map((day) => ({ day, paused: false, times: ["19:00"] })),
      timezone: "America/Sao_Paulo",
    });

    // Pending queue per scenario.
    const pendingDays =
      spec.scenario === "healthy" ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : spec.scenario === "distant_post_gap" ? [0, 1, 12] : [];
    for (const d of pendingDays) {
      const dueAt = spTime(d, 19, now);
      if (dueAt <= now) continue;
      await db.insert(posts).values({
        socialAccountId: account!.id,
        provider: "demo",
        externalPostId: `demo-pending-${++postCounter}`,
        status: "scheduled",
        dueAt,
        shareMode: "customScheduled",
        schedulingType: "automatic",
        isCustomScheduled: true,
        via: "buffer",
        format: spec.formats[0],
        text: `[DEMO] Scheduled post ${postCounter}`,
        isDemo: true,
      });
    }
    if (spec.scenario === "empty_with_failure") {
      await db.insert(posts).values({
        socialAccountId: account!.id,
        provider: "demo",
        externalPostId: `demo-failed-${++postCounter}`,
        status: "error",
        dueAt: new Date(now.getTime() - 2 * DAY),
        errorMessage: "[DEMO] It looks like the provider lost authorization to post on your behalf. Refresh the channel to resume.",
        format: "short",
        text: "[DEMO] Failed post",
        isDemo: true,
      });
    }

    // 6 weeks of published posts with daily lifetime metric observations for the first 10 days.
    for (let d = 42; d >= 1; d--) {
      if (rand() < 0.25) continue;
      const publishedAt = spTime(-d, 19, now);
      const format = spec.formats[Math.floor(rand() * spec.formats.length)]!;
      const [post] = await db
        .insert(posts)
        .values({
          socialAccountId: account!.id,
          provider: "demo",
          externalPostId: `demo-sent-${++postCounter}`,
          status: "sent",
          dueAt: publishedAt,
          sentAt: publishedAt,
          via: rand() < 0.1 ? "network" : "buffer",
          format,
          text: `[DEMO] ${format} sobre ${["educação", "bastidores", "produto"][postCounter % 3]}`,
          externalUrl: `https://example.com/demo/${spec.platform}/${postCounter}`,
          isDemo: true,
        })
        .returning();
      const strength = format === "carousel" ? 1.4 : format === "reel" ? 1.2 : 1;
      const final = finalMetrics(spec.platform, format, strength);
      const observationDays = Math.min(10, d - 1);
      if (observationDays < 1) continue; // metrics still pending (published < 1 day ago)
      let lastObserved: Date | null = null;
      for (let age = 1; age <= observationDays; age++) {
        const observedAt = new Date(publishedAt.getTime() + age * DAY);
        const fraction = 1 - Math.exp(-age / 2.2);
        const rows = PLATFORM_METRICS[spec.platform]!.map(({ key, unit }) => {
          const target = final[key] ?? 0;
          const value = unit === "percentage" || key === "avg_watch_time_seconds" ? target : Math.round(target * fraction);
          return {
            subject: "post" as const,
            postId: post!.id,
            socialAccountId: account!.id,
            metricKey: key,
            value,
            valueStatus: value === 0 ? ("reported_zero" as const) : ("reported" as const),
            unit,
            semantics: "lifetime_cumulative" as const,
            providerUpdatedAt: observedAt,
            retrievedAt: observedAt,
            source: "demo.fixtures",
          };
        });
        await db.insert(metricObservations).values(rows);
        if (age === observationDays) {
          await db.insert(postMetricsLatest).values(
            rows.map((r) => ({
              postId: r.postId,
              metricKey: r.metricKey,
              value: r.value,
              valueStatus: r.valueStatus,
              unit: r.unit,
              providerUpdatedAt: r.providerUpdatedAt,
              retrievedAt: r.retrievedAt,
              source: r.source,
            })),
          );
        }
        lastObserved = observedAt;
      }
      await db.update(posts).set({ metricsUpdatedAt: lastObserved }).where(eq(posts.id, post!.id));
    }
  }

  await db.insert(syncRuns).values([
    { connectionId: conn!.id, kind: "queue", status: "succeeded", startedAt: now, finishedAt: now, details: { demo: true } },
    { connectionId: conn!.id, kind: "published", status: "succeeded", startedAt: now, finishedAt: now, details: { demo: true } },
  ]);

  // Grant access: every workspace admin (and an optional member) becomes owner of the demo brand.
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.isWorkspaceAdmin, true));
  const extra = memberEmail ? await db.select({ id: users.id }).from(users).where(eq(users.email, memberEmail.toLowerCase())) : [];
  for (const u of [...admins, ...extra]) {
    await db.insert(memberships).values({ userId: u.id, brandId: brand!.id, role: "owner" }).onConflictDoNothing();
  }
  console.log(`Demo brand seeded (${postCounter} posts). Access granted to ${admins.length + extra.length} user(s). All rows are flagged demo.`);
  await closeDb();
}

main().catch(async (err) => {
  console.error("Demo seed failed:", err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
