/** Account detail: health, cadence, coverage slots, failures, recent posts with metrics and the metric availability matrix. */
import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { detectAlwaysZeroSeries, METRIC_DEFINITIONS, METRIC_KEYS, median, medianMetric, PLATFORM_METRIC_CAPABILITIES } from "@/domain/metrics";
import { rankContent } from "@/domain/ranking";
import type { MetricKey } from "@/domain/types";
import { requireAccountInBrand, requireBrandRole, roleAtLeast, type BrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { posts } from "@/server/db/schema";
import { loadAccountStatuses } from "@/server/queries/account-status";
import { loadPostPerformance } from "@/server/queries/post-performance";
import { buildAccountHealth, freshnessVM, type AccountHealthVM } from "./account-health";
import { dayKey, fmtDate, fmtDateTimeShort, fmtNum, fmtTime, PLATFORM_LABEL, WEEKDAY_LABEL } from "./format";
import { erCell, metricCell, TABLE_METRICS, type ErCellVM, type MetricCellVM } from "./metric-cells";
import type { FreshnessVM } from "@/components/ui/Freshness";

export const POST_STATUS_FILTERS = ["all", "sent", "scheduled", "error", "draft"] as const;
export type PostStatusFilter = (typeof POST_STATUS_FILTERS)[number];

export interface RecentPostVM {
  id: string;
  status: string;
  statusLabel: string;
  due: string | null;
  sent: string | null;
  preview: string;
  format: string | null;
  errorMessage: string | null;
  externalUrl: string | null;
  metrics: MetricCellVM[] | null;
  er: ErCellVM | null;
  metricsAsOf: string | null;
}

export interface AvailabilityRowVM {
  key: MetricKey;
  label: string;
  description: string;
  capability: "supported" | "unsupported" | "requires_direct_connection";
  semantics: string;
  observed: string;
  note: string | null;
}

export interface AccountDetailVM {
  brand: { id: string; name: string; timezone: string };
  role: BrandRole;
  canManage: boolean;
  account: {
    id: string;
    handle: string;
    displayName: string | null;
    platformLabel: string;
    avatarUrl: string | null;
    externalUrl: string | null;
    providerTimezone: string | null;
    connectionLabel: string;
    removed: boolean;
    isDemo: boolean;
  };
  connectionState: "Active" | "Queue paused" | "Disconnected" | "Locked";
  health: AccountHealthVM | null;
  freshness: FreshnessVM;
  cadenceSummary: { label: string; value: string }[];
  providerSchedule: { day: string; label: string; paused: boolean; times: string[] }[];
  cadenceSchedule: { day: string; label: string; paused: boolean; times: string[] }[] | null;
  slotDays: { key: string; label: string; slots: { at: string; time: string; covered: boolean }[] }[];
  statusFilter: PostStatusFilter;
  recentPosts: RecentPostVM[];
  performance: { posts: number; medianViews: string; medianReach: string; medianEr: string; erDefinitionId: string; topPost: { title: string; explanation: string; externalUrl: string | null } | null; topPostNote: string };
  availability: AvailabilityRowVM[];
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  error: "Error",
  missing: "No longer in Buffer",
};

function weekGrid(schedule: { day: string; paused: boolean; times: string[] }[] | null | undefined) {
  return DAYS.map((day) => {
    const entries = (schedule ?? []).filter((d) => d.day === day);
    return {
      day,
      label: WEEKDAY_LABEL[day] ?? day,
      paused: entries.some((e) => e.paused),
      times: [...new Set(entries.flatMap((e) => e.times))].sort(),
    };
  });
}

export async function loadAccountDetail(
  db: Db,
  user: SessionUser,
  brandId: string,
  accountId: string,
  now: Date,
  opts: { status: PostStatusFilter },
): Promise<AccountDetailVM> {
  const { account } = await requireAccountInBrand(db, user, accountId, "viewer", { brandId });
  const { brand, role } = await requireBrandRole(db, user, brandId, "viewer");
  const tz = brand.timezone;
  const [status] = await loadAccountStatuses(db, { accountIds: [account.id] }, now);
  const health = status ? buildAccountHealth(status, now) : null;
  const cadence = status?.cadence;

  const since = new Date(now.getTime() - 28 * 86_400_000);
  const perf = await loadPostPerformance(db, { accountIds: [account.id], publishedFrom: new Date(since.getTime() - 28 * 86_400_000), publishedTo: now });
  const perf28 = perf.filter((p) => p.publishedAt.getTime() >= since.getTime());
  const perfById = new Map(perf.map((p) => [p.postId, p]));

  const statusCond: SQL | undefined =
    opts.status === "all"
      ? undefined
      : opts.status === "draft"
        ? inArray(posts.status, ["draft", "needs_approval"])
        : eq(posts.status, opts.status);
  const orderAt = sql`coalesce(${posts.sentAt}, ${posts.dueAt}, ${posts.providerCreatedAt}, ${posts.createdAt})`;
  const rows = await db
    .select({
      id: posts.id,
      status: posts.status,
      dueAt: posts.dueAt,
      sentAt: posts.sentAt,
      text: posts.text,
      title: posts.title,
      format: posts.format,
      errorMessage: posts.errorMessage,
      externalUrl: posts.externalUrl,
      metricsUpdatedAt: posts.metricsUpdatedAt,
    })
    .from(posts)
    .where(and(eq(posts.socialAccountId, account.id), statusCond, or(isNull(posts.dueAt), gte(orderAt, since), gte(posts.dueAt, now))))
    .orderBy(desc(orderAt))
    .limit(60);

  const alwaysZero = new Map<MetricKey, boolean>();
  for (const key of TABLE_METRICS) alwaysZero.set(key, detectAlwaysZeroSeries(perf28, key, 10).likelyNotReported);

  const recentPosts: RecentPostVM[] = rows.map((r) => {
    const p = perfById.get(r.id);
    return {
      id: r.id,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      due: fmtDateTimeShort(r.dueAt, tz, now),
      sent: fmtDateTimeShort(r.sentAt, tz, now),
      preview: (r.title || r.text || "").replace(/\s+/g, " ").slice(0, 140),
      format: r.format,
      errorMessage: r.errorMessage,
      externalUrl: r.externalUrl,
      metrics: p ? TABLE_METRICS.map((k) => metricCell(k, p.metrics[k], p.platform, { likelyNotReported: alwaysZero.get(k) })) : null,
      er: p ? erCell(p.metrics, p.platform) : null,
      metricsAsOf: p ? fmtDateTimeShort(p.metricsUpdatedAt, tz, now) : null,
    };
  });

  const views = medianMetric(perf28, "views");
  const reach = medianMetric(perf28, "reach");
  const ers = perf28.map((p) => erCell(p.metrics, p.platform).value).filter((v): v is number => v !== null);
  const erMed = median(ers);
  const ranking = rankContent(perf, { period: { startUtc: since, endUtcExclusive: now }, limit: 1 });
  const top = ranking.best[0] ? perfById.get(ranking.best[0].postId) : undefined;
  const caps = PLATFORM_METRIC_CAPABILITIES[account.platform];

  const availability: AvailabilityRowVM[] = METRIC_KEYS.map((key) => {
    const def = METRIC_DEFINITIONS[key];
    if (key === "followers") {
      return { key, label: def.label, description: def.description, capability: "requires_direct_connection", semantics: def.semantics, observed: "—", note: def.sourceNotes };
    }
    const counts = { reported: 0, reported_zero: 0, not_reported: 0, pending: 0, unsupported: 0 };
    for (const p of perf28) {
      const s = p.metrics[key]?.status;
      if (s) counts[s]++;
    }
    const z = detectAlwaysZeroSeries(perf28, key, 10);
    const observed =
      perf28.length === 0
        ? "No published posts in 28 days"
        : caps[key] === "unsupported"
          ? "—"
          : `${counts.reported} reported · ${counts.reported_zero} zero · ${counts.not_reported} not reported · ${counts.pending} pending`;
    return {
      key,
      label: def.label,
      description: def.description,
      capability: caps[key],
      semantics: def.semantics.replace(/_/g, " "),
      observed,
      note: z.likelyNotReported ? z.message : def.summableAcrossPosts ? null : def.summabilityNote,
    };
  });

  const slotDays: AccountDetailVM["slotDays"] = [];
  if (health && cadence && status) {
    for (const s of status.coverage.slots) {
      const key = dayKey(s.at, cadence.timezone);
      let d = slotDays.find((x) => x.key === key);
      if (!d) {
        d = { key, label: fmtDate(s.at, cadence.timezone) ?? key, slots: [] };
        slotDays.push(d);
      }
      d.slots.push({ at: s.at.toISOString(), time: fmtTime(s.at, cadence.timezone), covered: s.covered });
    }
  }

  const connectionState = account.isDisconnected ? "Disconnected" : account.isLocked ? "Locked" : account.isQueuePaused ? "Queue paused" : "Active";
  const cadenceSummary = cadence
    ? [
        { label: "Mode", value: health?.scheduling.cadenceLabel ?? cadence.mode },
        { label: "Timezone", value: cadence.timezone },
        ...(cadence.mode === "irregular" ? [{ label: "Posts per week", value: String(cadence.postsPerWeek ?? "Not set") }] : []),
        { label: "Slot matching", value: cadence.matchMode === "same_day" ? "Same local day" : `Within ${cadence.matchToleranceMinutes} min of the slot` },
        { label: "Horizon", value: `${cadence.horizonDays} days` },
        { label: "Thresholds", value: `Warning < ${cadence.warningDays} days · Critical < ${cadence.criticalDays} days` },
        { label: "Stale after", value: cadence.staleAfterMinutes >= 120 ? `${Math.round(cadence.staleAfterMinutes / 60)} h` : `${cadence.staleAfterMinutes} min` },
      ]
    : [];

  return {
    brand: { id: brand.id, name: brand.name, timezone: tz },
    role,
    canManage: roleAtLeast(role, "manager"),
    account: {
      id: account.id,
      handle: account.handle,
      displayName: account.displayName,
      platformLabel: PLATFORM_LABEL[account.platform],
      avatarUrl: account.avatarUrl,
      externalUrl: account.externalUrl,
      providerTimezone: account.providerTimezone,
      connectionLabel: status?.connection.label ?? "Removed connection",
      removed: !status,
      isDemo: account.isDemo,
    },
    connectionState,
    health,
    freshness: health?.freshness ?? freshnessVM(null, now, tz),
    cadenceSummary,
    providerSchedule: weekGrid(account.providerPostingSchedule),
    cadenceSchedule: cadence && cadence.mode === "custom" ? weekGrid(cadence.days) : null,
    slotDays,
    statusFilter: opts.status,
    recentPosts,
    performance: {
      posts: perf28.length,
      medianViews: views.result.value === null ? "N/A" : `${fmtNum(views.result.value)} (n=${views.sampleSize})`,
      medianReach: caps.reach === "unsupported" ? "Unsupported" : reach.result.value === null ? "N/A" : `${fmtNum(reach.result.value)} (n=${reach.sampleSize})`,
      medianEr: erMed === null ? "N/A" : `${erMed.toFixed(2)}% (n=${ers.length})`,
      erDefinitionId: erCell({}, account.platform).definitionId,
      topPost: top && ranking.best[0] ? { title: (top.title || top.text || "Untitled post").slice(0, 120), explanation: ranking.best[0].explanation, externalUrl: top.externalUrl } : null,
      topPostNote: ranking.method,
    },
    availability,
  };
}
