/**
 * Operational-health view model per account, derived from the shared account-status loader
 * (coverage math stays in src/domain/coverage.ts; this module only labels and formats it).
 */
import type { CoverageReason } from "@/domain/coverage";
import type { AccountStatus } from "@/server/queries/account-status";
import type { FreshnessVM } from "@/components/ui/Freshness";
import type { StatusKind } from "@/components/ui/StatusBadge";
import { fmtDateTimeShort, fmtDays, fmtRelative, fmtSynced, fmtDateTime, hoursSince, PLATFORM_LABEL, plural, zoneLabel } from "./format";

export type { StatusKind };

/** Worst-status-wins ordering (lower = worse). Inability to confirm (disconnected/locked) outranks measurements. */
export const STATUS_RANK: Record<StatusKind, number> = {
  disconnected: 0,
  critical: 1,
  empty: 2,
  locked: 3,
  warning: 4,
  unknown: 5,
  paused: 6,
  healthy: 7,
};

export function worstStatus(list: StatusKind[]): StatusKind {
  return list.reduce<StatusKind>((w, s) => (STATUS_RANK[s] < STATUS_RANK[w] ? s : w), "healthy");
}

export interface SchedulingVM {
  /** Set when figures must not be shown (e.g. "Unavailable — account disconnected"). */
  unavailable: string | null;
  scheduledCount: number;
  nextScheduled: string | null;
  lastScheduled: string | null;
  coveragePct: string | null;
  coveredSlots: number;
  expectedSlots: number;
  horizonLabel: string;
  firstUncoveredSlot: string | null;
  firstUncoveredRelative: string | null;
  coveredDays: string | null;
  runway: string | null;
  postsNeeded: number;
  fillDeadline: string | null;
  horizonEnd: string;
  unresolvedCount: number;
  overdueCount: number;
  failedCount: number;
  unmatchedItems: number;
  beyondHorizonCount: number;
  isEstimate: boolean;
  cadenceLabel: string;
  /** Plain-language explanations of the computation reasons. */
  notes: string[];
  capNote: string | null;
  /** Operationally urgent empty-queue copy. */
  emptyCopy: string | null;
  pausedCopy: string | null;
}

export interface AccountHealthVM {
  accountId: string;
  brandId: string | null;
  platform: AccountStatus["account"]["platform"];
  platformLabel: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  externalUrl: string | null;
  isDemo: boolean;
  status: StatusKind;
  statusNote: string | null;
  stale: { label: string } | null;
  connectionIssue: string | null;
  cadenceTimezone: string;
  cadenceZoneLabel: string;
  freshness: FreshnessVM;
  scheduling: SchedulingVM;
  coveredDaysRaw: number | null;
  coverageRatioRaw: number | null;
  recentErrors: { postId: string; due: string | null; message: string; externalUrl: string | null }[];
  overdue: { postId: string; due: string }[];
  /** Mini action for dashboard rows: "Needs 4 posts by Tue 16 Sep, 20:00 GMT-3". */
  needsLine: string | null;
  flags: { isQueuePaused: boolean; isDisconnected: boolean; isLocked: boolean };
}

const MODE_LABEL: Record<string, string> = {
  provider_schedule: "Buffer posting schedule",
  custom: "Custom slots",
  irregular: "Irregular (posts per week)",
  paused: "Monitoring paused",
};

function reasonNote(r: CoverageReason, s: AccountStatus): string | null {
  const c = s.coverage;
  switch (r) {
    case "invalid_timezone":
      return `The cadence timezone "${s.cadence.timezone}" is invalid, so coverage can't be computed. Fix it in cadence settings.`;
    case "invalid_horizon":
      return "The coverage horizon is invalid. Set a horizon of 1–60 days in cadence settings.";
    case "horizon_shorter_than_warning":
      return "The horizon is shorter than the warning threshold, so full coverage can never read Healthy. Extend the horizon.";
    case "invalid_slot_time":
      return "Some posting times are malformed and were ignored.";
    case "no_cadence":
      return "No expected posting slots: this account has no posting schedule in Buffer and no cadence configured in BrandPulse.";
    case "cadence_paused":
      return "Cadence monitoring is paused for this account in BrandPulse settings.";
    case "queue_paused":
      return "The Buffer queue is paused. Scheduled posts will not go out until it is resumed; figures reflect the queue as of the pause.";
    case "account_disconnected":
      return "The channel is disconnected from Buffer. Reconnect it directly in Buffer.";
    case "never_synced":
      return "No queue sync has completed yet for this account's connection.";
    case "stale_sync":
      return `Queue data is older than the ${fmtDays(s.cadence.staleAfterMinutes / 1440) ?? ""} staleness window; figures reflect the last successful sync and are not a confirmed measurement.`;
    case "irregular_virtual_slots":
      return "Irregular cadence: expected slots are estimated from the weekly post target, so coverage figures are estimates.";
    case "dst_nonexistent_time_shifted":
    case "dst_slots_merged":
      return "A daylight-saving transition shifted or merged some slot times.";
    case "distant_post_ignored_for_severity":
      return "Posts scheduled after the first gap do not count toward continuous coverage — a distant post doesn't make the account healthy.";
    case "unresolved_items_not_counted":
      return `${plural(c.unresolvedCount, "post")} without a confirmed time (draft, awaiting approval or unscheduled) ${c.unresolvedCount === 1 ? "is" : "are"} not counted as coverage.`;
    case "overdue_items_not_counted":
      return `${plural(c.overdueCount, "scheduled post")} past due ${c.overdueCount === 1 ? "is" : "are"} not counted as coverage.`;
    case "inventory_beyond_horizon":
      return `${plural(c.beyondHorizonCount, "post")} scheduled beyond the ${plural(s.cadence.horizonDays, "day")} horizon ${c.beyondHorizonCount === 1 ? "is" : "are"} not counted in coverage.`;
    case "provider_inventory_cap":
    case "provider_inventory_cap_blocks_healthy":
      return null; // rendered as capNote
    default:
      return null;
  }
}

function capNote(s: AccountStatus): string | null {
  const c = s.coverage;
  if (!c.reasons.includes("provider_inventory_cap")) return null;
  const best = fmtDays(c.maxAchievableCoveredDays);
  let text = `Buffer plan limit: at most ${c.inventoryCap} scheduled posts per organization (shared by its channels; enforcement per channel is unverified), fewer than the ${c.expectedSlots} expected slots in this horizon. Full coverage isn't achievable${best ? `; the best reachable continuous coverage is about ${best}` : ""}.`;
  if (c.reasons.includes("provider_inventory_cap_blocks_healthy")) {
    text += " Even the warning threshold can't be reached within this limit, so Warning or Critical here is structural — top up the queue as posts publish.";
  }
  return text;
}

export function freshnessVM(at: Date | null, now: Date, tz: string): FreshnessVM {
  const h = hoursSince(at, now);
  return {
    label: fmtSynced(at, now),
    absolute: fmtDateTime(at, tz),
    level: h === null || h > 48 ? "hard" : h > 24 ? "soft" : "fresh",
  };
}

export function deriveStatus(s: AccountStatus): { status: StatusKind; stale: { label: string } | null; note: string | null } {
  const { account, coverage } = s;
  const stale = coverage.freshness === "fresh" ? null : { label: coverage.freshness === "never_synced" ? "Never synced" : "Stale" };
  if (account.isDisconnected) return { status: "disconnected", stale: null, note: null };
  if (account.isLocked) return { status: "locked", stale, note: null };
  if (s.cadence.mode === "paused") return { status: "paused", stale, note: "Cadence monitoring is paused in BrandPulse." };
  if (account.isQueuePaused) return { status: "paused", stale, note: "The Buffer queue is paused." };
  if (coverage.state === "unknown") {
    if (coverage.freshness === "stale" && coverage.underlyingState) {
      return { status: coverage.underlyingState, stale, note: "Last known queue state from an older sync." };
    }
    const note = coverage.reasons.includes("no_cadence")
      ? "No posting cadence is configured."
      : coverage.reasons.includes("invalid_timezone")
        ? "The cadence timezone is invalid."
        : coverage.freshness === "never_synced"
          ? "No queue data yet."
          : null;
    return { status: "unknown", stale, note };
  }
  return { status: coverage.state, stale, note: null };
}

export function buildAccountHealth(s: AccountStatus, now: Date): AccountHealthVM {
  const { account, coverage: c, cadence } = s;
  const tz = cadence.timezone;
  const fmt = (d: Date | null) => fmtDateTimeShort(d, tz, now);
  const { status, stale, note } = deriveStatus(s);
  const connectionIssue = ["invalid", "error", "revoked"].includes(s.connection.status)
    ? "Data unavailable this sync"
    : s.connection.consecutiveFailures > 0
      ? `Last ${plural(s.connection.consecutiveFailures, "sync")} failed`
      : null;

  const unavailable = account.isDisconnected ? "Unavailable — account disconnected" : null;
  const notes = c.reasons.map((r) => reasonNote(r, s)).filter((x): x is string => !!x);
  const horizonEnd = fmtDateTimeShort(c.horizonEnd, tz, now) ?? "";
  const scheduling: SchedulingVM = {
    unavailable,
    scheduledCount: c.scheduledCount,
    nextScheduled: fmt(c.nextScheduledAt),
    lastScheduled: fmt(c.lastScheduledAt),
    coveragePct: c.coverageRatio === null ? null : `${Math.round(c.coverageRatio * 100)}%`,
    coveredSlots: c.coveredSlots,
    expectedSlots: c.expectedSlots,
    horizonLabel: `next ${plural(cadence.horizonDays, "day")} (through ${horizonEnd})`,
    firstUncoveredSlot: fmt(c.firstUncoveredSlot),
    firstUncoveredRelative: fmtRelative(c.firstUncoveredSlot, now),
    coveredDays: fmtDays(c.coveredDays),
    runway: c.estimatedRunwayDays === null ? null : `~${fmtDays(c.estimatedRunwayDays)}`,
    postsNeeded: c.postsNeeded,
    fillDeadline: fmt(c.fillDeadline),
    horizonEnd,
    unresolvedCount: c.unresolvedCount,
    overdueCount: s.overdue.length,
    failedCount: s.recentErrors.length,
    unmatchedItems: c.unmatchedItems,
    beyondHorizonCount: c.beyondHorizonCount,
    isEstimate: c.isEstimate,
    cadenceLabel: `${MODE_LABEL[cadence.mode] ?? cadence.mode}${s.cadenceIsDefault ? " (default settings)" : ""}`,
    notes: [...new Set(notes)],
    capNote: capNote(s),
    emptyCopy:
      !account.isDisconnected && c.scheduledCount === 0 && c.expectedSlots > 0
        ? "This account has no scheduled content. Every upcoming slot is uncovered."
        : null,
    pausedCopy: account.isQueuePaused
      ? "This account's queue is paused in Buffer. Scheduled posts will not go out until it's resumed. Coverage numbers below reflect the queue as of the pause."
      : null,
  };

  const needsLine =
    unavailable || c.expectedSlots === 0 || c.postsNeeded === 0
      ? null
      : `Needs ${plural(c.postsNeeded, "post")}${c.fillDeadline ? ` · first gap ${fmt(c.fillDeadline)}` : ""}`;

  return {
    accountId: account.id,
    brandId: account.brandId,
    platform: account.platform,
    platformLabel: PLATFORM_LABEL[account.platform],
    handle: account.handle,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    externalUrl: account.externalUrl,
    isDemo: account.isDemo,
    status,
    statusNote: note,
    stale,
    connectionIssue,
    cadenceTimezone: tz,
    cadenceZoneLabel: zoneLabel(now, tz),
    freshness: freshnessVM(s.lastQueueSyncAt, now, tz),
    scheduling,
    coveredDaysRaw: unavailable ? null : c.coveredDays,
    coverageRatioRaw: c.coverageRatio,
    recentErrors: s.recentErrors.map((e) => ({ postId: e.postId, due: fmt(e.dueAt), message: e.message, externalUrl: e.externalUrl })),
    overdue: s.overdue.map((o) => ({ postId: o.postId, due: fmt(o.dueAt) ?? "" })),
    needsLine,
    flags: { isQueuePaused: account.isQueuePaused, isDisconnected: account.isDisconnected, isLocked: account.isLocked },
  };
}

export function needsAttention(vm: AccountHealthVM): boolean {
  return (
    vm.status === "critical" ||
    vm.status === "empty" ||
    vm.status === "disconnected" ||
    vm.status === "locked" ||
    vm.stale !== null ||
    vm.connectionIssue !== null
  );
}
