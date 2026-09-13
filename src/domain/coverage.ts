/**
 * Queue coverage: how far into the future an account's expected posting slots are covered by
 * confirmed scheduled content.
 *
 * Canonical rules (see docs/METRIC_DICTIONARY.md § Queue coverage)
 * - Inventory = items with status "scheduled" AND a resolved dueAt strictly after `now`.
 *   draft / needs_approval / scheduled-without-dueAt → `unresolvedCount` (uncertainty, never coverage).
 *   "sending" counts neither as future coverage nor as missing. Scheduled items with dueAt <= now are
 *   overdue (reported separately, never coverage).
 * - Horizon: slots in (now, horizonEnd], where horizonEnd = now + horizonDays in LOCAL calendar days
 *   (wall-clock preserving), so "next 7 days" always contains 7 local days of slots across DST.
 * - DST: a slot whose local time does not exist (spring-forward gap) is shifted forward by the gap
 *   (02:30 → 03:30); if that collides with another slot the two are merged into one. An ambiguous local
 *   time (fall-back overlap) is placed at its FIRST occurrence.
 * - Matching (each post covers at most one slot, each slot at most one post; posts processed in
 *   ascending dueAt, ties by id):
 *     same_day    → the earliest unmatched slot on the post's local calendar day (cadence timezone).
 *     time_window → the nearest unmatched slot with |post − slot| <= tolerance (tie → earlier slot).
 * - Severity derives from `coveredDays` (continuous coverage from now to the first uncovered slot),
 *   NEVER from lastScheduledAt or runway: a single distant post cannot make an account healthy.
 * - Irregular cadence (postsPerWeek, no fixed times) uses deterministic VIRTUAL SLOTS, see `virtualSlots`.
 *
 * State precedence (first match wins; reasons accumulate for every applicable condition):
 *   invalid timezone → unknown
 *   cadence mode "paused" → paused
 *   account disconnected → unknown  (the queue cannot be confirmed and posts cannot publish; the
 *                                    account_disconnected alert is the actionable signal — even an
 *                                    empty queue is reported as unknown, since a disconnected channel's
 *                                    queue data is not trustworthy)
 *   never synced → unknown; stale sync → unknown (numbers kept; "stale_sync" — never shown as confirmed depletion)
 *   queue paused → paused
 *   no expected slots → unknown ("no_cadence")
 *   scheduledCount 0 → empty; coveredDays < criticalDays → critical; < warningDays → warning; else healthy
 */
import { DateTime } from "luxon";
import type { CadenceConfig, CoverageInput, CoverageResult, CoverageSlot, CoverageState, QueueItem, Weekday } from "./types";
import { isValidTimezone, localDateKey } from "./periods";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Index = luxon weekday − 1 (ISO: Monday = 1). */
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type CoverageReason =
  | "invalid_timezone"
  | "invalid_horizon"
  | "horizon_shorter_than_warning"
  | "invalid_slot_time"
  | "no_cadence"
  | "cadence_paused"
  | "queue_paused"
  | "account_disconnected"
  | "never_synced"
  | "stale_sync"
  | "irregular_virtual_slots"
  | "dst_nonexistent_time_shifted"
  | "dst_slots_merged"
  | "distant_post_ignored_for_severity"
  | "unresolved_items_not_counted"
  | "overdue_items_not_counted"
  | "inventory_beyond_horizon"
  | "provider_inventory_cap"
  | "provider_inventory_cap_blocks_healthy";

export interface CoverageOptions {
  /**
   * Maximum number of pending scheduled posts the provider allows for this account (e.g. Buffer Free
   * `scheduledPosts: 10`, divided by the caller across channels sharing the org limit). Null/undefined = no cap.
   */
  inventoryCap?: number | null;
}

/** Severity computed from the queue alone, ignoring freshness/pause/disconnection. */
export type UnderlyingCoverageState = Extract<CoverageState, "healthy" | "warning" | "critical" | "empty">;

export interface CoverageResultDetailed extends CoverageResult {
  reasons: CoverageReason[];
  /**
   * What the state would be if data were fresh and the account active. Lets the UI show
   * "Critical + stale badge" as an overlay while `state` stays "unknown". Null when there is no cadence.
   */
  underlyingState: UnderlyingCoverageState | null;
  /** Average expected posts per calendar day from the weekly cadence (null when none). */
  expectedPostsPerDay: number | null;
  /** Scheduled items whose dueAt is <= now (not sent yet). */
  overdueCount: number;
  sendingCount: number;
  /** Inventory scheduled after the horizon (counts in scheduledCount, never in coverage or unmatchedItems). */
  beyondHorizonCount: number;
  inventoryCap: number | null;
  /** inventoryCap − scheduledCount (floored at 0); null without a cap. */
  remainingCapacity: number | null;
  /** Best coveredDays reachable if the whole cap were used on consecutive slots; null without a cap or cadence. */
  maxAchievableCoveredDays: number | null;
}

interface SlotDraft {
  at: number;
  /** Irregular virtual slots only: the window (windowStart, at] a post must fall into. */
  windowStart?: number;
}

interface SlotPlan {
  slots: SlotDraft[];
  expectedPostsPerDay: number | null;
  reasons: CoverageReason[];
  virtual: boolean;
}

/** Parses "HH:MM" (also "H:MM"). */
export function parseSlotTime(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

interface DayRule {
  paused: boolean;
  times: { hour: number; minute: number }[];
}

/** Merges cadence entries per weekday: a day is paused if any entry for it is paused; times are unioned. */
function buildDayRules(cadence: CadenceConfig, reasons: CoverageReason[]): Map<Weekday, DayRule> {
  const rules = new Map<Weekday, DayRule>();
  for (const entry of cadence.days) {
    const rule = rules.get(entry.day) ?? { paused: false, times: [] };
    rule.paused = rule.paused || entry.paused;
    for (const raw of entry.times) {
      const t = parseSlotTime(raw);
      if (!t) {
        reasons.push("invalid_slot_time");
        continue;
      }
      if (!rule.times.some((x) => x.hour === t.hour && x.minute === t.minute)) rule.times.push(t);
    }
    rules.set(entry.day, rule);
  }
  return rules;
}

function localDays(now: Date, horizonEnd: DateTime, tz: string): DateTime[] {
  const days: DateTime[] = [];
  let cursor = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  const lastKey = horizonEnd.toISODate() as string;
  // Compare by ISO date strings (lexicographic order == chronological order).
  while ((cursor.toISODate() as string) <= lastKey) {
    days.push(cursor);
    const next = cursor.plus({ days: 1 });
    cursor = DateTime.fromObject({ year: next.year, month: next.month, day: next.day }, { zone: tz });
  }
  return days;
}

function fixedSlots(now: Date, horizonEnd: DateTime, cadence: CadenceConfig): SlotPlan {
  const reasons: CoverageReason[] = [];
  const tz = cadence.timezone;
  const rules = buildDayRules(cadence, reasons);

  let perWeek = 0;
  for (const rule of rules.values()) if (!rule.paused) perWeek += rule.times.length;

  const seen = new Map<number, boolean>(); // at → wasShifted
  const slots: SlotDraft[] = [];
  const nowMs = now.getTime();
  const endMs = horizonEnd.toMillis();

  for (const day of localDays(now, horizonEnd, tz)) {
    const rule = rules.get(WEEKDAYS[day.weekday - 1] as Weekday);
    if (!rule || rule.paused) continue;
    for (const t of rule.times) {
      const dt = DateTime.fromObject(
        { year: day.year, month: day.month, day: day.day, hour: t.hour, minute: t.minute },
        { zone: tz },
      );
      const shifted = dt.hour !== t.hour || dt.minute !== t.minute;
      const at = dt.toMillis();
      if (at <= nowMs || at > endMs) continue;
      if (shifted) reasons.push("dst_nonexistent_time_shifted");
      if (seen.has(at)) {
        if (shifted || seen.get(at)) reasons.push("dst_slots_merged");
        continue;
      }
      seen.set(at, shifted);
      slots.push({ at });
    }
  }
  slots.sort((a, b) => a.at - b.at);
  return { slots, expectedPostsPerDay: perWeek > 0 ? perWeek / 7 : null, reasons, virtual: false };
}

/**
 * Irregular cadence — deterministic virtual slots.
 *
 * Expected posts accrue continuously at `postsPerWeek / (activeDays × 24h)` during ACTIVE local days
 * (every weekday not explicitly paused in `cadence.days`) starting at `now`. The k-th virtual slot's
 * deadline is the instant the cumulative expectation reaches k. Slot k owns the window
 * (deadline_{k−1}, deadline_k] with deadline_0 = now; a post covers slot k only if its dueAt falls in
 * that window. So a batch of posts on one day covers one slot, not a whole week, and a distant post
 * never covers near-term slots. Results are flagged `isEstimate`.
 */
function virtualSlots(now: Date, horizonEnd: DateTime, cadence: CadenceConfig): SlotPlan {
  const reasons: CoverageReason[] = ["irregular_virtual_slots"];
  const ppw = cadence.postsPerWeek;
  const pausedDays = new Set(cadence.days.filter((d) => d.paused).map((d) => d.day));
  const activeCount = 7 - pausedDays.size;
  if (ppw === null || !Number.isFinite(ppw) || ppw <= 0 || activeCount <= 0) {
    return { slots: [], expectedPostsPerDay: null, reasons, virtual: true };
  }
  const tz = cadence.timezone;
  const ratePerMs = ppw / (activeCount * DAY_MS);
  const nowMs = now.getTime();
  const endMs = horizonEnd.toMillis();
  const EPS = 1e-9;

  const deadlines: number[] = [];
  let cumulative = 0;
  for (const day of localDays(now, horizonEnd, tz)) {
    if (pausedDays.has(WEEKDAYS[day.weekday - 1] as Weekday)) continue;
    const next = day.plus({ days: 1 });
    const dayEnd = DateTime.fromObject({ year: next.year, month: next.month, day: next.day }, { zone: tz }).toMillis();
    const segStart = Math.max(day.toMillis(), nowMs);
    const segEnd = Math.min(dayEnd, endMs);
    if (segEnd <= segStart) continue;
    const segExpected = (segEnd - segStart) * ratePerMs;
    let k = deadlines.length + 1;
    while (k <= cumulative + segExpected + EPS) {
      const at = Math.min(segEnd, Math.round(segStart + (k - cumulative) / ratePerMs));
      deadlines.push(at);
      k++;
    }
    cumulative += segExpected;
  }
  const slots: SlotDraft[] = deadlines.map((at, i) => ({ at, windowStart: i === 0 ? nowMs : (deadlines[i - 1] as number) }));
  return { slots, expectedPostsPerDay: ppw / 7, reasons, virtual: true };
}

function byDueThenId(a: QueueItem & { dueAt: Date }, b: QueueItem & { dueAt: Date }): number {
  return a.dueAt.getTime() - b.dueAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function computeCoverage(input: CoverageInput, opts: CoverageOptions = {}): CoverageResultDetailed {
  const { now, cadence, items } = input;
  const nowMs = now.getTime();
  const reasons: CoverageReason[] = [];
  const tzValid = isValidTimezone(cadence.timezone);
  const tz = tzValid ? cadence.timezone : "UTC";
  if (!tzValid) reasons.push("invalid_timezone");

  // --- Inventory classification -------------------------------------------------------------
  const inventory: (QueueItem & { dueAt: Date })[] = [];
  let unresolvedCount = 0;
  let overdueCount = 0;
  let sendingCount = 0;
  for (const item of items) {
    if (item.status === "sending") {
      sendingCount++;
    } else if (item.status === "draft" || item.status === "needs_approval" || item.dueAt === null) {
      unresolvedCount++;
    } else if (item.dueAt.getTime() > nowMs) {
      inventory.push(item as QueueItem & { dueAt: Date });
    } else {
      overdueCount++;
    }
  }
  inventory.sort(byDueThenId);
  if (unresolvedCount > 0) reasons.push("unresolved_items_not_counted");
  if (overdueCount > 0) reasons.push("overdue_items_not_counted");

  const scheduledCount = inventory.length;
  const nextScheduledAt = inventory[0]?.dueAt ?? null;
  const lastScheduledAt = inventory[inventory.length - 1]?.dueAt ?? null;

  // --- Horizon & slots ----------------------------------------------------------------------
  const horizonValid = Number.isFinite(cadence.horizonDays) && cadence.horizonDays > 0;
  if (!horizonValid) reasons.push("invalid_horizon");
  // Config smell: full coverage can never reach `healthy` when the horizon is shorter than the warning threshold.
  else if (cadence.horizonDays < cadence.warningDays) reasons.push("horizon_shorter_than_warning");
  const horizonEndDt = DateTime.fromJSDate(now, { zone: tz }).plus({ days: horizonValid ? cadence.horizonDays : 0 });
  const horizonEndMs = horizonEndDt.toMillis();

  let plan: SlotPlan = { slots: [], expectedPostsPerDay: null, reasons: [], virtual: cadence.mode === "irregular" };
  if (tzValid && horizonValid) {
    plan = cadence.mode === "irregular" ? virtualSlots(now, horizonEndDt, cadence) : fixedSlots(now, horizonEndDt, cadence);
  }
  reasons.push(...plan.reasons);
  const drafts = plan.slots;

  // --- Matching -----------------------------------------------------------------------------
  const assigned: (string | null)[] = drafts.map(() => null);
  const lastSlotMs = drafts[drafts.length - 1]?.at ?? horizonEndMs;
  let unmatchedItems = 0;
  let beyondHorizonCount = 0;
  const tolMs = Math.max(0, cadence.matchToleranceMinutes) * MINUTE_MS;
  const slotsByDay = new Map<string, number[]>();
  if (!plan.virtual && cadence.matchMode === "same_day") {
    drafts.forEach((s, i) => {
      const key = localDateKey(new Date(s.at), tz);
      const list = slotsByDay.get(key) ?? [];
      list.push(i);
      slotsByDay.set(key, list);
    });
  }

  for (const post of inventory) {
    const due = post.dueAt.getTime();
    let slotIndex = -1;
    if (plan.virtual) {
      slotIndex = drafts.findIndex((s, i) => assigned[i] === null && due > (s.windowStart as number) && due <= s.at);
    } else if (cadence.matchMode === "same_day") {
      const candidates = slotsByDay.get(localDateKey(post.dueAt, tz)) ?? [];
      slotIndex = candidates.find((i) => assigned[i] === null) ?? -1;
    } else {
      let bestDiff = Infinity;
      drafts.forEach((s, i) => {
        if (assigned[i] !== null) return;
        const diff = Math.abs(s.at - due);
        if (diff <= tolMs && diff < bestDiff) {
          bestDiff = diff;
          slotIndex = i; // strict "<" keeps the earlier slot on ties (slots are sorted)
        }
      });
    }
    if (slotIndex >= 0) {
      assigned[slotIndex] = post.id;
    } else if (due > (plan.virtual ? lastSlotMs : horizonEndMs)) {
      beyondHorizonCount++;
    } else {
      unmatchedItems++;
    }
  }
  if (beyondHorizonCount > 0) reasons.push("inventory_beyond_horizon");

  const slots: CoverageSlot[] = drafts.map((s, i) => ({
    at: new Date(s.at),
    covered: assigned[i] !== null,
    postId: assigned[i] ?? null,
  }));
  const expectedSlots = slots.length;
  const coveredSlots = slots.filter((s) => s.covered).length;
  const firstUncovered = slots.find((s) => !s.covered)?.at ?? null;
  const horizonDays = horizonValid ? cadence.horizonDays : 0;
  const coveredDays = expectedSlots === 0 ? null : firstUncovered ? (firstUncovered.getTime() - nowMs) / DAY_MS : horizonDays;

  if (expectedSlots === 0 && tzValid && horizonValid) reasons.push("no_cadence");
  if (firstUncovered && lastScheduledAt && lastScheduledAt.getTime() > firstUncovered.getTime()) {
    reasons.push("distant_post_ignored_for_severity");
  }

  // --- Underlying severity (queue only) -----------------------------------------------------
  let underlyingState: UnderlyingCoverageState | null = null;
  if (expectedSlots > 0 && coveredDays !== null) {
    if (scheduledCount === 0) underlyingState = "empty";
    else if (coveredDays < cadence.criticalDays) underlyingState = "critical";
    else if (coveredDays < cadence.warningDays) underlyingState = "warning";
    else underlyingState = "healthy";
  }

  // --- Provider inventory cap ---------------------------------------------------------------
  const cap = opts.inventoryCap ?? null;
  const validCap = cap !== null && Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : null;
  let remainingCapacity: number | null = null;
  let maxAchievableCoveredDays: number | null = null;
  if (validCap !== null) {
    remainingCapacity = Math.max(0, validCap - scheduledCount);
    if (expectedSlots > 0) {
      if (expectedSlots > validCap) reasons.push("provider_inventory_cap");
      const warningEdge = nowMs + cadence.warningDays * DAY_MS;
      if (slots.filter((s) => s.at.getTime() < warningEdge).length > validCap) {
        reasons.push("provider_inventory_cap_blocks_healthy");
      }
      const capSlot = slots[validCap];
      maxAchievableCoveredDays = capSlot ? (capSlot.at.getTime() - nowMs) / DAY_MS : horizonDays;
    }
  }

  // --- Freshness & final state --------------------------------------------------------------
  const freshness: CoverageResult["freshness"] =
    input.lastQueueSyncAt === null
      ? "never_synced"
      : nowMs - input.lastQueueSyncAt.getTime() > cadence.staleAfterMinutes * MINUTE_MS
        ? "stale"
        : "fresh";
  if (freshness === "never_synced") reasons.push("never_synced");
  if (freshness === "stale") reasons.push("stale_sync");
  if (cadence.mode === "paused") reasons.push("cadence_paused");
  if (input.accountDisconnected) reasons.push("account_disconnected");
  if (input.queuePaused) reasons.push("queue_paused");

  let state: CoverageState;
  if (!tzValid) state = "unknown";
  else if (cadence.mode === "paused") state = "paused";
  else if (input.accountDisconnected) state = "unknown";
  else if (freshness !== "fresh") state = "unknown";
  else if (input.queuePaused) state = "paused";
  else state = underlyingState ?? "unknown";

  const postsNeeded = expectedSlots - coveredSlots;
  return {
    state,
    freshness,
    scheduledCount,
    unresolvedCount,
    nextScheduledAt,
    lastScheduledAt,
    horizonStart: new Date(nowMs),
    horizonEnd: new Date(horizonEndMs),
    expectedSlots,
    coveredSlots,
    coverageRatio: expectedSlots === 0 ? null : coveredSlots / expectedSlots,
    firstUncoveredSlot: firstUncovered,
    coveredDays,
    estimatedRunwayDays: plan.expectedPostsPerDay ? scheduledCount / plan.expectedPostsPerDay : null,
    postsNeeded,
    fillDeadline: firstUncovered,
    unmatchedItems,
    slots,
    isEstimate: cadence.mode === "irregular",
    reasons: [...new Set(reasons)],
    underlyingState,
    expectedPostsPerDay: plan.expectedPostsPerDay,
    overdueCount,
    sendingCount,
    beyondHorizonCount,
    inventoryCap: validCap,
    remainingCapacity,
    maxAchievableCoveredDays,
  };
}
