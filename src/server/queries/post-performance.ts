/**
 * Published-post performance read model shared by dashboards, content analysis, insights and reports.
 * Values come from `post_metrics_latest` (lifetime cumulative, as of the provider refresh time).
 * Every canonical metric key is present on every post with an explicit status — never a silent 0:
 *   unsupported   → the platform/provider combination does not offer the metric (capability table)
 *   pending       → Buffer has not ingested metrics for this post yet
 *   not_reported  → supported, but absent from the provider response
 *   reported / reported_zero → value as returned (zero may be a provider default; see METRIC_DICTIONARY.md)
 * Callers must pass only account ids the actor is authorized to read.
 */
import { and, asc, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { METRIC_KEYS, PLATFORM_METRIC_CAPABILITIES } from "@/domain/metrics";
import type { MetricKey, MetricValue, PostPerformance, ValueStatus } from "@/domain/types";
import type { Db } from "@/server/db/client";
import { postMetricsLatest, posts, postTags, socialAccounts } from "@/server/db/schema";

export interface PostPerformanceView extends PostPerformance {
  handle: string;
  via: string | null;
  text: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  providerTags: string[];
  isDemo: boolean;
  /** Provenance of the metric values shown. */
  provenance: { source: string | null; providerUpdatedAt: Date | null; retrievedAt: Date | null };
}

const publishedAtSql = sql<Date>`coalesce(${posts.sentAt}, ${posts.dueAt})`;

export async function loadPostPerformance(
  db: Db,
  { accountIds, publishedFrom, publishedTo }: { accountIds: string[]; publishedFrom?: Date; publishedTo?: Date },
): Promise<PostPerformanceView[]> {
  if (accountIds.length === 0) return [];
  const conditions: SQL[] = [inArray(posts.socialAccountId, accountIds), sql`${posts.status} = 'sent'`];
  if (publishedFrom) conditions.push(gte(publishedAtSql, publishedFrom));
  if (publishedTo) conditions.push(lt(publishedAtSql, publishedTo));

  const rows = await db
    .select({ post: posts, platform: socialAccounts.platform, handle: socialAccounts.handle })
    .from(posts)
    .innerJoin(socialAccounts, sql`${socialAccounts.id} = ${posts.socialAccountId}`)
    .where(and(...conditions))
    .orderBy(asc(publishedAtSql));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.post.id);
  const metricRows: (typeof postMetricsLatest.$inferSelect)[] = [];
  const tagRows: (typeof postTags.$inferSelect)[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    metricRows.push(...(await db.select().from(postMetricsLatest).where(inArray(postMetricsLatest.postId, chunk))));
    tagRows.push(...(await db.select().from(postTags).where(inArray(postTags.postId, chunk))));
  }
  const metricsByPost = new Map<string, Map<string, (typeof metricRows)[number]>>();
  for (const m of metricRows) {
    if (!metricsByPost.has(m.postId)) metricsByPost.set(m.postId, new Map());
    metricsByPost.get(m.postId)!.set(m.metricKey, m);
  }

  return rows.map(({ post, platform, handle }) => {
    const stored = metricsByPost.get(post.id) ?? new Map();
    const metrics: Partial<Record<MetricKey, MetricValue>> = {};
    let provenance: PostPerformanceView["provenance"] = { source: null, providerUpdatedAt: post.metricsUpdatedAt, retrievedAt: null };
    for (const key of METRIC_KEYS) {
      const row = stored.get(key);
      let status: ValueStatus;
      let value: number | null = null;
      if (PLATFORM_METRIC_CAPABILITIES[platform][key] === "unsupported") status = "unsupported";
      else if (row) {
        status = row.valueStatus === "reported_zero" ? "reported_zero" : row.valueStatus === "reported" ? "reported" : row.valueStatus;
        value = status === "reported" || status === "reported_zero" ? row.value : null;
        provenance = { source: row.source, providerUpdatedAt: row.providerUpdatedAt, retrievedAt: row.retrievedAt };
      } else if (!post.metricsUpdatedAt) status = "pending";
      else status = "not_reported";
      metrics[key] = { key, value, status };
    }
    return {
      postId: post.id,
      socialAccountId: post.socialAccountId,
      platform,
      format: post.format,
      publishedAt: post.sentAt ?? post.dueAt ?? post.createdAt,
      metricsUpdatedAt: post.metricsUpdatedAt,
      metrics,
      tags: tagRows.filter((t) => t.postId === post.id).map((t) => ({ kind: t.kind, value: t.value })),
      externalUrl: post.externalUrl,
      handle,
      via: post.via,
      text: post.text,
      title: post.title,
      thumbnailUrl: post.thumbnailUrl,
      providerTags: post.providerTags,
      isDemo: post.isDemo,
      provenance,
    };
  });
}
