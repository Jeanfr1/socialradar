/**
 * Framework-free domain contracts shared by the analytics engine, alerts, insights, reports and UI.
 * Pure types only. Implementations live in src/domain/*.ts and must be deterministic (inject `now`).
 */

export type Platform = "instagram" | "tiktok" | "youtube" | "other";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// ---------------------------------------------------------------------------
// Queue coverage
// ---------------------------------------------------------------------------
export interface CadenceDay {
  day: Weekday;
  paused: boolean;
  /** Local wall-clock times "HH:MM" in the cadence timezone. */
  times: string[];
}

export interface CadenceConfig {
  /**
   * provider_schedule: use Buffer's posting schedule slots.
   * custom: BrandPulse-configured slots.
   * irregular: `postsPerWeek` target without fixed times (results are estimates).
   * paused: monitoring of cadence is paused for this account.
   */
  mode: "provider_schedule" | "custom" | "irregular" | "paused";
  timezone: string; // IANA
  days: CadenceDay[];
  postsPerWeek: number | null;
  /** same_day: a post covers an unmatched slot on the same local calendar day. time_window: |post - slot| <= tolerance. */
  matchMode: "same_day" | "time_window";
  matchToleranceMinutes: number;
  horizonDays: number;
  warningDays: number;
  criticalDays: number;
  staleAfterMinutes: number;
}

export interface QueueItem {
  id: string;
  /** Null when the provider has not resolved a publication time yet. */
  dueAt: Date | null;
  status: "scheduled" | "needs_approval" | "draft" | "sending";
}

export interface CoverageInput {
  now: Date;
  cadence: CadenceConfig;
  /** Pending items for the account as of the last successful queue sync. */
  items: QueueItem[];
  lastQueueSyncAt: Date | null;
  queuePaused: boolean;
  accountDisconnected: boolean;
}

export type CoverageState = "healthy" | "warning" | "critical" | "empty" | "paused" | "unknown";

export interface CoverageSlot {
  at: Date;
  covered: boolean;
  postId: string | null;
}

export interface CoverageResult {
  state: CoverageState;
  freshness: "fresh" | "stale" | "never_synced";
  /** Only `scheduled` items with a resolved dueAt in the future count as inventory. */
  scheduledCount: number;
  /** Pending items without a resolved time, or awaiting approval/draft (shown as uncertainty, not coverage). */
  unresolvedCount: number;
  nextScheduledAt: Date | null;
  /** Furthest known scheduled publication. */
  lastScheduledAt: Date | null;
  horizonStart: Date;
  horizonEnd: Date;
  expectedSlots: number;
  coveredSlots: number;
  /** coveredSlots / expectedSlots; null when no slots are expected. */
  coverageRatio: number | null;
  /** Next expected slot without matching content (null when every slot in horizon is covered or no cadence). */
  firstUncoveredSlot: Date | null;
  /** Continuous covered time from now until the first uncovered slot, in days. Drives severity. */
  coveredDays: number | null;
  /** Estimate: inventory / expected posts per day. Always labeled as an estimate. */
  estimatedRunwayDays: number | null;
  /** Additional posts needed so every slot in the horizon is covered. */
  postsNeeded: number;
  /** Deadline to fill the first gap (equals firstUncoveredSlot). */
  fillDeadline: Date | null;
  /** Scheduled items that did not match any expected slot (extra or off-cadence content). */
  unmatchedItems: number;
  slots: CoverageSlot[];
  isEstimate: boolean;
  /** Machine-readable explanation codes, e.g. "stale_sync", "distant_post_ignored_for_severity". */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export type MetricKey =
  | "reactions"
  | "comments"
  | "shares"
  | "saves"
  | "views"
  | "reach"
  | "impressions"
  | "clicks"
  | "follows"
  | "provider_engagement_rate"
  | "avg_watch_time_seconds"
  | "total_watch_time_minutes"
  | "followers";

export type ValueStatus = "reported" | "reported_zero" | "not_reported" | "pending" | "unsupported";

export interface MetricValue {
  key: MetricKey;
  value: number | null;
  status: ValueStatus;
}

export interface NAReason {
  code:
    | "denominator_zero"
    | "denominator_unavailable"
    | "numerator_unavailable"
    | "starting_audience_not_positive"
    | "insufficient_sample"
    | "incompatible_definitions"
    | "not_summable"
    | "partial_period"
    | "unsupported_by_provider"
    | "no_data";
  message: string;
}

export type Computed = { value: number; na: null } | { value: null; na: NAReason };

export interface PostPerformance {
  postId: string;
  socialAccountId: string;
  platform: Platform;
  format: string | null;
  publishedAt: Date;
  metricsUpdatedAt: Date | null;
  metrics: Partial<Record<MetricKey, MetricValue>>;
  tags: { kind: "campaign" | "format" | "topic" | "pillar"; value: string }[];
  externalUrl: string | null;
}
