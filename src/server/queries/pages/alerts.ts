/**
 * Alerts across all accessible brands. Connection-level alerts (no brand) are visible to workspace admins only.
 */
import { and, count, desc, eq, gte, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { isValidTimezone } from "@/domain/periods";
import { listAccessibleBrands, NotFoundError, requireAccountInBrand, roleAtLeast } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { alerts, brands, connections, socialAccounts } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { loadAccountStatuses } from "@/server/queries/account-status";
import { fmtDateTimeShort, fmtDays, fmtRelative, PLATFORM_LABEL, zoneLabel } from "./format";

export const ALERT_SEVERITIES = ["all", "critical", "warning", "info"] as const;
export const ALERT_STATES = ["active", "open", "acknowledged", "snoozed", "resolved"] as const;
export const ALERT_TYPES = ["all", "scheduling", "publishing", "sync"] as const;

const TYPE_GROUPS: Record<Exclude<(typeof ALERT_TYPES)[number], "all">, string[]> = {
  scheduling: ["queue_empty", "queue_coverage", "queue_paused", "post_overdue", "unresolved_times"],
  publishing: ["publish_failed", "account_disconnected"],
  sync: ["sync_stale", "connection_failing"],
};

export interface AlertFilters {
  severity: (typeof ALERT_SEVERITIES)[number];
  state: (typeof ALERT_STATES)[number];
  type: (typeof ALERT_TYPES)[number];
  brand?: string;
  account?: string;
}

export interface AlertItemVM {
  id: string;
  severity: "info" | "warning" | "critical";
  state: "open" | "acknowledged" | "snoozed" | "resolved";
  type: string;
  typeLabel: string;
  title: string;
  scope: string;
  brandId: string | null;
  brandHref: string | null;
  isDemo: boolean;
  evidence: { label: string; value: string }[];
  suggestedAction: string;
  firstDetected: string;
  lastDetected: string;
  updatedRelative: string;
  ongoingSince: string;
  occurrenceCount: number;
  stateLine: string | null;
  snoozedUntil: string | null;
  canManage: boolean;
  zone: string;
  timezone: string;
}

export interface AlertsVM {
  filters: AlertFilters;
  counts: { all: number; critical: number; warning: number; info: number };
  items: AlertItemVM[];
  truncated: boolean;
  options: { brands: { id: string; name: string; isDemo: boolean }[]; accounts: { id: string; label: string }[] };
  isWorkspaceAdmin: boolean;
  hasDemo: boolean;
  staleNote: string | null;
  anyManageable: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  queue_empty: "Empty queue",
  queue_coverage: "Queue coverage",
  queue_paused: "Queue paused",
  post_overdue: "Overdue posts",
  unresolved_times: "Unconfirmed times",
  publish_failed: "Publishing failed",
  account_disconnected: "Account disconnected",
  sync_stale: "Stale sync",
  connection_failing: "Connection failing",
};

const HIDDEN_EVIDENCE = new Set(["accountId", "connectionId", "postId"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function formatEvidence(evidence: Record<string, unknown>, tz: string, now: Date): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(evidence)) {
    if (HIDDEN_EVIDENCE.has(key)) continue;
    let value: string;
    if (raw === null || raw === undefined) value = "—";
    else if (key === "coverageRatio" && typeof raw === "number") value = `${Math.round(raw * 100)}%`;
    else if (key === "coveredDays" && typeof raw === "number") value = fmtDays(raw) ?? String(raw);
    else if (key === "postIds" && Array.isArray(raw)) value = `${raw.length} ${raw.length === 1 ? "post" : "posts"}`;
    else if (key === "providerMessage" && typeof raw === "string") value = raw.slice(0, 500);
    else if (typeof raw === "string" && ISO_RE.test(raw)) {
      const d = new Date(raw);
      value = Number.isNaN(d.getTime()) ? raw : `${fmtDateTimeShort(d, tz, now)} (${fmtRelative(d, now)})`;
    } else if (typeof raw === "boolean") value = raw ? "Yes" : "No";
    else if (typeof raw === "number") value = Number.isInteger(raw) ? String(raw) : raw.toFixed(2);
    else if (Array.isArray(raw)) value = raw.map((x) => (typeof x === "string" ? x.replace(/_/g, " ") : JSON.stringify(x))).join(", ") || "—";
    else if (typeof raw === "string") value = raw.replace(/_/g, key === "handle" ? "_" : " ");
    else value = JSON.stringify(raw).slice(0, 200);
    out.push({ label: humanize(key), value });
  }
  return out;
}

export async function loadAlerts(db: Db, user: SessionUser, now: Date, filters: AlertFilters): Promise<AlertsVM> {
  const accessible = await listAccessibleBrands(db, user.id);
  const roleByBrand = new Map(accessible.map((b) => [b.id, b.role]));
  if (filters.brand && !roleByBrand.has(filters.brand)) throw new NotFoundError();
  if (filters.account) await requireAccountInBrand(db, user, filters.account, "viewer", filters.brand ? { brandId: filters.brand } : {});

  const brandIds = filters.brand ? [filters.brand] : accessible.map((b) => b.id);
  const scope: SQL[] = [];
  if (brandIds.length) scope.push(inArray(alerts.brandId, brandIds));
  if (user.isWorkspaceAdmin && !filters.brand && !filters.account) scope.push(isNull(alerts.brandId));

  const statuses = brandIds.length ? await loadAccountStatuses(db, { brandIds }, now).catch((err) => {
    logger.warn("alerts: account statuses unavailable", { err });
    return null;
  }) : [];

  const vmBase = {
    filters,
    options: {
      brands: accessible.map((b) => ({ id: b.id, name: b.name, isDemo: b.isDemo })),
      accounts: (statuses ?? []).map((s) => ({ id: s.account.id, label: `@${s.account.handle.replace(/^@/, "")} (${PLATFORM_LABEL[s.account.platform]})` })),
    },
    isWorkspaceAdmin: user.isWorkspaceAdmin,
  };
  if (scope.length === 0) {
    return { ...vmBase, counts: { all: 0, critical: 0, warning: 0, info: 0 }, items: [], truncated: false, hasDemo: false, staleNote: null, anyManageable: false };
  }

  const conds: SQL[] = [or(...scope)!];
  if (filters.account) conds.push(eq(alerts.socialAccountId, filters.account));
  if (filters.state === "active") conds.push(ne(alerts.state, "resolved"));
  else if (filters.state === "resolved") conds.push(eq(alerts.state, "resolved"), gte(alerts.resolvedAt, new Date(now.getTime() - 30 * 86_400_000)));
  else conds.push(eq(alerts.state, filters.state));
  if (filters.type !== "all") conds.push(inArray(alerts.type, TYPE_GROUPS[filters.type]));

  const countRows = await db.select({ severity: alerts.severity, n: count() }).from(alerts).where(and(...conds)).groupBy(alerts.severity);
  const counts = { all: 0, critical: 0, warning: 0, info: 0 };
  for (const r of countRows) {
    counts[r.severity] = Number(r.n);
    counts.all += Number(r.n);
  }

  const listConds = filters.severity === "all" ? conds : [...conds, eq(alerts.severity, filters.severity)];
  const LIMIT = 300;
  const rows = await db
    .select({
      alert: alerts,
      brandName: brands.name,
      brandTz: brands.timezone,
      handle: socialAccounts.handle,
      platform: socialAccounts.platform,
      connectionLabel: connections.label,
    })
    .from(alerts)
    .leftJoin(brands, eq(brands.id, alerts.brandId))
    .leftJoin(socialAccounts, eq(socialAccounts.id, alerts.socialAccountId))
    .leftJoin(connections, eq(connections.id, alerts.connectionId))
    .where(and(...listConds))
    .orderBy(desc(alerts.severity), desc(alerts.lastDetectedAt))
    .limit(LIMIT + 1);

  const items: AlertItemVM[] = rows.slice(0, LIMIT).map(({ alert: a, brandName, brandTz, handle, platform, connectionLabel }) => {
    const tz = brandTz && isValidTimezone(brandTz) ? brandTz : "UTC";
    const role = a.brandId ? roleByBrand.get(a.brandId) : null;
    const who = handle ? `@${handle.replace(/^@/, "")}${platform ? ` (${PLATFORM_LABEL[platform]})` : ""}` : null;
    const scopeLabel = a.brandId ? [brandName, who].filter(Boolean).join(" · ") : `Connection${connectionLabel ? `: ${connectionLabel}` : ""}${who ? ` · ${who}` : ""}`;
    return {
      id: a.id,
      severity: a.severity,
      state: a.state,
      type: a.type,
      typeLabel: TYPE_LABEL[a.type] ?? humanize(a.type),
      title: a.title,
      scope: scopeLabel,
      brandId: a.brandId,
      brandHref: a.brandId ? (a.socialAccountId ? `/brands/${a.brandId}/accounts/${a.socialAccountId}` : `/brands/${a.brandId}`) : null,
      isDemo: a.isDemo,
      evidence: formatEvidence(a.evidence, tz, now),
      suggestedAction: a.suggestedAction,
      firstDetected: fmtDateTimeShort(a.firstDetectedAt, tz, now) ?? "",
      lastDetected: fmtDateTimeShort(a.lastDetectedAt, tz, now) ?? "",
      updatedRelative: `Updated ${fmtRelative(a.lastDetectedAt, now)}`,
      ongoingSince: `Ongoing since ${fmtDateTimeShort(a.firstDetectedAt, tz, now)}`,
      occurrenceCount: a.occurrenceCount,
      stateLine:
        a.state === "acknowledged" && a.acknowledgedAt
          ? `Acknowledged ${fmtRelative(a.acknowledgedAt, now)}`
          : a.state === "resolved" && a.resolvedAt
            ? `Resolved ${fmtRelative(a.resolvedAt, now)}${a.resolutionReason ? ` (${a.resolutionReason.replace(/_/g, " ")})` : ""}`
            : null,
      snoozedUntil: a.state === "snoozed" && a.snoozedUntil ? fmtDateTimeShort(a.snoozedUntil, tz, now) : null,
      canManage: a.brandId ? roleAtLeast(role, "manager") : user.isWorkspaceAdmin,
      zone: zoneLabel(now, tz),
      timezone: tz,
    };
  });

  let staleNote: string | null = null;
  if (statuses === null) {
    staleNote = "Alerts reflect data as of the last sync. We couldn't check sync freshness right now, so new issues may exist that haven't been detected yet.";
  } else {
    const stale = statuses.filter((s) => !s.lastQueueSyncAt || now.getTime() - s.lastQueueSyncAt.getTime() > 24 * 3_600_000);
    if (stale.length) {
      const oldest = stale.reduce<Date | null>((m, s) => (s.lastQueueSyncAt && (!m || s.lastQueueSyncAt < m) ? s.lastQueueSyncAt : m), null);
      staleNote = `Alerts reflect data as of ${oldest ? `the last sync (oldest: ${fmtRelative(oldest, now)})` : "the last sync (some accounts have never synced)"}. New issues may exist that haven't been detected yet.`;
    }
  }

  return {
    ...vmBase,
    counts,
    items,
    truncated: rows.length > LIMIT,
    hasDemo: items.some((i) => i.isDemo),
    staleNote,
    anyManageable: items.some((i) => i.canManage),
  };
}
