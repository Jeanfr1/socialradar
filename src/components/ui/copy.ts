/** Canonical microcopy (docs/product/PRODUCT_SPEC.md §5 and §6). Use verbatim. */
export const DEFINITIONS = {
  coverage:
    "Coverage: the percentage of expected posting slots — based on this account's posting schedule — that currently have a post scheduled, looking ahead to your configured target horizon. 100% means every expected slot through that horizon is filled.",
  runway:
    "Estimated runway: our best estimate of how many days of scheduled content remain before this account runs out of queued posts. This is an estimate based on current schedule and queue — not a guarantee, since posting behavior in Buffer can change after this was calculated.",
  firstUncovered:
    "First uncovered slot: the next date and time, based on this account's posting schedule, that has no post currently scheduled. Everything before this slot is covered; this is where the gap starts.",
  lastScheduled:
    "Last scheduled date: the date of the furthest-out post currently scheduled for this account. A single far-future post here does not by itself mean the account is well covered — check Coverage and First uncovered slot too.",
  postsNeeded:
    "Posts needed: how many additional posts you'd need to schedule, at this account's normal posting frequency, to keep coverage at 100% through your target horizon.",
  fillDeadline:
    "Deadline to fill first gap: schedule at least one post before this date to avoid an uncovered slot in this account's queue.",
  erReach:
    "Engagement rate (by reach): (reactions + comments + shares + saves) ÷ reach for this post. Used for Instagram and Facebook, where reach is reported.",
  erViews:
    "Engagement rate (by views): (reactions + comments + shares) ÷ views for this post. Used for TikTok and YouTube Shorts, where view count is the more reliable denominator.",
  na: "N/A: this platform did not report this metric for this post. It is not the same as zero — we simply have no data for it.",
  ambiguousZero:
    "0 shown here means the platform reported zero — or didn't report this metric at all and Buffer defaults to zero. We can't always tell these apart. Treat a lone 0 on an otherwise active post with caution; compare against reach/views for context.",
  lifetime:
    "Lifetime: total accumulated value for this post since it was published, as of the last sync. Period: the change in this post's metrics within the date range you've selected above. Lifetime numbers only ever go up; period numbers depend on your filter.",
  audienceUnavailable:
    "Requires direct platform connection: Buffer does not provide follower or subscriber counts. To see audience growth here, connect this brand directly to Instagram, TikTok, or YouTube (coming soon).",
  lastSynced:
    "Last synced: when we last successfully pulled fresh data from Buffer for this item. Buffer refreshes metrics roughly once every 24 hours, so this will rarely say 'moments ago.'",
  confidence:
    "Confidence: how consistent and well-sampled this finding is — based on sample size and how repeatable the pattern was — not a formal statistical guarantee.",
  snoozed:
    "This alert won't resurface until the snooze period ends, unless the underlying condition gets worse (e.g., Warning escalates to Critical).",
  pending: "Pending: Buffer has not ingested metrics for this post yet (this can take up to ~24h after publishing).",
  unsupported: "Unsupported: this metric is never available for this platform via Buffer.",
  notReported: "Not reported: metrics were synced for this post, but the platform did not include this metric.",
} as const;

export const STATUS_COPY = {
  healthy: { label: "Healthy", tip: "Healthy: coverage ≥ your warning threshold (default 7 days); account connected and active." },
  warning: { label: "Warning", tip: "Warning: coverage is below the warning threshold (default 7 days) and at or above the critical threshold (default 3 days)." },
  critical: { label: "Critical", tip: "Critical: coverage is below the critical threshold (default 3 days)." },
  empty: { label: "Empty", tip: "Empty: zero scheduled posts found. Every upcoming slot is uncovered." },
  paused: { label: "Paused", tip: "Paused: the Buffer queue is paused (or cadence monitoring is paused). Scheduled posts will not go out until it is resumed." },
  disconnected: { label: "Disconnected", tip: "Disconnected: the channel is disconnected from Buffer. We can't confirm its queue, and posts can't publish until it is reconnected in Buffer." },
  locked: { label: "Locked", tip: "Locked: Buffer reports this channel as locked. Check the channel in Buffer." },
  unknown: { label: "Unknown", tip: "Unknown: we can't determine coverage (no queue data yet, no posting cadence, or an invalid configuration)." },
  stale: {
    label: "Stale",
    tip: "Stale: this data comes from an older sync than your staleness window. The status beside it is the last known queue state, not a confirmed measurement.",
  },
} as const;
