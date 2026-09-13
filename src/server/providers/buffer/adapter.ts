/** Maps raw Buffer GraphQL payloads to provider-neutral contracts. */
import type { Platform, Weekday } from "@/domain/types";
import {
  ProviderError,
  type CanonicalPostStatus,
  type ProviderChannel,
  type ProviderMetric,
  type ProviderOrganization,
  type ProviderPost,
} from "@/server/providers/types";

export interface RawOrganization {
  id: string;
  name: string;
  channelCount: number;
  limits: Record<string, number> | null;
}

export interface RawChannel {
  id: string;
  name: string;
  displayName: string | null;
  service: string;
  serviceId: string;
  type: string;
  timezone: string;
  avatar: string | null;
  externalLink: string | null;
  isQueuePaused: boolean;
  isDisconnected: boolean;
  isLocked: boolean;
  allowedActions: string[];
  postingSchedule: { day: string; paused: boolean; times: string[] }[];
}

export interface RawPost {
  id: string;
  channelId: string;
  status: string;
  dueAt: string | null;
  sentAt: string | null;
  shareMode: string | null;
  isCustomScheduled: boolean | null;
  schedulingType: string | null;
  via: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  text?: string | null;
  externalLink?: string | null;
  metricsUpdatedAt?: string | null;
  metrics?: { type: string; unit: string; value: number }[] | null;
  metadata?: { __typename?: string; type?: string | null; title?: string | null } | null;
  error?: { message: string } | null;
  assets?: { thumbnail?: string | null }[] | null;
  tags?: { name: string }[] | null;
}

export interface RawConnection<T> {
  edges: { node: T }[] | null;
  pageInfo: { hasNextPage: boolean | null; endCursor: string | null };
}

/** Buffer PostMetricType → canonical BrandPulse metric key (see docs/METRIC_DICTIONARY.md). */
export const BUFFER_METRIC_KEY_MAP: Record<string, string> = {
  reactions: "reactions",
  comments: "comments",
  shares: "shares",
  saves: "saves",
  views: "views",
  reach: "reach",
  impressions: "impressions",
  clicks: "clicks",
  follows: "follows",
  engagementRate: "provider_engagement_rate",
  averageTimeWatched: "avg_watch_time_seconds",
  totalTimeWatched: "total_watch_time_minutes",
};

const STATUSES = new Set<CanonicalPostStatus>(["draft", "needs_approval", "scheduled", "sending", "sent", "error"]);
const WEEKDAYS = new Set<Weekday>(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export function mapPlatform(service: string): Platform {
  return service === "instagram" || service === "tiktok" || service === "youtube" ? service : "other";
}

function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ProviderError("invalid_response", `Invalid ${field} from Buffer`);
  return d;
}

export function mapOrganization(raw: RawOrganization): ProviderOrganization {
  return { externalId: raw.id, name: raw.name, channelCount: raw.channelCount, limits: raw.limits ?? {} };
}

export function mapChannel(raw: RawChannel, organizationExternalId: string): ProviderChannel {
  return {
    externalChannelId: raw.id,
    organizationExternalId,
    platform: mapPlatform(raw.service),
    service: raw.service,
    platformAccountId: raw.serviceId,
    channelType: raw.type,
    handle: raw.name,
    displayName: raw.displayName,
    avatarUrl: raw.avatar || null,
    externalUrl: raw.externalLink,
    timezone: raw.timezone,
    isQueuePaused: raw.isQueuePaused,
    isDisconnected: raw.isDisconnected,
    isLocked: raw.isLocked,
    canViewInsights: raw.allowedActions.includes("viewInsights"),
    postingSchedule: raw.postingSchedule
      .filter((d): d is { day: Weekday; paused: boolean; times: string[] } => WEEKDAYS.has(d.day as Weekday))
      .map((d) => ({ day: d.day, paused: d.paused, times: d.times.filter((t) => /^\d{2}:\d{2}$/.test(t)) })),
  };
}

export function mapMetrics(raw: RawPost["metrics"]): ProviderMetric[] | null {
  if (raw == null) return null;
  return raw
    .filter((m) => Number.isFinite(m.value))
    .map((m) => ({ key: BUFFER_METRIC_KEY_MAP[m.type] ?? null, providerType: m.type, unit: m.unit, value: m.value }));
}

export function mapPost(raw: RawPost): ProviderPost {
  if (!STATUSES.has(raw.status as CanonicalPostStatus)) {
    throw new ProviderError("invalid_response", `Unknown Buffer post status "${raw.status}"`);
  }
  return {
    externalPostId: raw.id,
    externalChannelId: raw.channelId,
    status: raw.status as CanonicalPostStatus,
    dueAt: parseDate(raw.dueAt, "dueAt"),
    sentAt: parseDate(raw.sentAt, "sentAt"),
    shareMode: raw.shareMode,
    schedulingType: raw.schedulingType,
    isCustomScheduled: raw.isCustomScheduled,
    via: raw.via,
    format: raw.metadata?.type ?? null,
    text: raw.text ?? null,
    title: raw.metadata?.title ?? null,
    externalUrl: raw.externalLink ?? null,
    thumbnailUrl: raw.assets?.find((a) => a.thumbnail)?.thumbnail ?? null,
    errorMessage: raw.error?.message ?? null,
    providerTags: (raw.tags ?? []).map((t) => t.name),
    providerCreatedAt: parseDate(raw.createdAt, "createdAt"),
    providerUpdatedAt: parseDate(raw.updatedAt, "updatedAt"),
    metricsUpdatedAt: parseDate(raw.metricsUpdatedAt, "metricsUpdatedAt"),
    metrics: raw.metrics === undefined ? null : mapMetrics(raw.metrics),
  };
}

export function edgesOf<T>(conn: RawConnection<T> | null | undefined): T[] {
  return (conn?.edges ?? []).map((e) => e.node);
}
