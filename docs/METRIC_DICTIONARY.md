# BrandPulse Metric Dictionary

**Status:** v1 · **Source of truth in code:** `src/domain/metrics.ts`, `coverage.ts`, `periods.ts`, `ranking.ts`, `alert-rules.ts` · **Provider facts verified:** Buffer GraphQL schema and live data, 2026-09-13.

This dictionary defines what every number in BrandPulse means, how it is computed, when it is **N/A**, and when two numbers may be compared. UI copy, reports and AI narratives must follow it. When code and this document disagree, the code's tests decide and this document gets fixed.

---

## 1. Foundations

### 1.1 Value statuses: missing is never zero

Every metric value has a status. Only `reported` and `reported_zero` enter calculations.

| Status | Meaning | Shown as | Used in calculations |
|---|---|---|---|
| `reported` | Provider returned a non-zero value | The number | Yes |
| `reported_zero` | Provider returned `0`. This may be a real zero **or** Buffer's default for "network did not report" | `0` with ambiguous-zero marker | Yes, but results carry `containsZeroUncertainty` |
| `not_reported` | Metrics were ingested, but this metric is absent from the list (or non-numeric) | N/A | No |
| `pending` | `metricsUpdatedAt` is null: Buffer has not ingested metrics yet (up to ~24h after publish) | "Pending" | No |
| `unsupported` | Metric is absent and never available for this platform via Buffer (capability table §3) | "Not available on {platform}" | No |

Classification order (`classifyProviderMetrics`):
1. Absent and unsupported on the platform → `unsupported`.
2. `metricsUpdatedAt` null → `pending`. Values present before ingestion are defaults and are discarded.
3. Absent, or not a finite number → `not_reported`.
4. `0` → `reported_zero`. Anything else → `reported`.

A metric **present** in the provider list is always trusted, even when the capability table says "unsupported". Buffer documents that absent metrics are the unsupported ones.

**Always-zero series.** `detectAlwaysZeroSeries(posts, key, minSample)` flags a metric that is `reported_zero` on every distinct post of a sample of at least `minSample`, for example Instagram `follows`, which was 0 on 78 of 78 posts across 3 accounts. The flag (`likelyNotReported`) is for the UI ("likely not reported"). Stored values are **not** rewritten. Run the check per account and platform.

### 1.2 N/A reasons

Every computed value is `{ value: number, na: null }` or `{ value: null, na: { code, message } }`.

| Code | When |
|---|---|
| `numerator_unavailable` | A formula component is pending, not reported, unsupported or missing |
| `denominator_unavailable` | The denominator is pending, not reported or missing |
| `denominator_zero` | The denominator is 0, so the rate is undefined |
| `unsupported_by_provider` | The metric or definition does not exist for this platform via Buffer |
| `starting_audience_not_positive` | Growth % with a starting audience ≤ 0 |
| `insufficient_sample` | Too few weeks or posts for a baseline |
| `incompatible_definitions` | Comparing values with different definition ids |
| `not_summable` | Summing a non-summable metric (reach, rates, point-in-time values) across posts |
| `partial_period` | A compared period is incomplete |
| `no_data` | No usable input at all (e.g. no audience snapshots, no post with a usable value) |

### 1.3 Semantics

| Semantics | Meaning | Example |
|---|---|---|
| `lifetime_cumulative` | Running total per post since publication, as of `metricsUpdatedAt`. Only ever grows (barring platform corrections) | views, reactions |
| `point_in_time` | A state or ratio valid at the observation time | followers, provider engagement rate, average watch time |
| `period_activity` | Activity inside a date range. **No Buffer metric has this semantics** | (reserved for direct platform connections) |

### 1.4 "Earned during the week" vs "posts published that week"

- **Performance earned during a week** is the increase of every post's counters between two snapshots at the week boundaries, including older posts that are still accruing. Buffer only exposes the *current lifetime* counter per post, so this needs consistent daily snapshots of all posts. **BrandPulse does not report it.**
- **Lifetime performance of posts published that week** is the latest lifetime counters of posts whose `publishedAt` falls inside the week, labeled "as of {metricsUpdatedAt}". **This is what BrandPulse reports.** Young posts are still accruing, so always show the observation time and `postAgeAtObservationHours(publishedAt, metricsUpdatedAt)`.

### 1.5 Snapshots and double counting

- Metric observations are append-only (one row per post, metric and provider refresh). Lifetime values of the **same post must never be summed** across observations.
- Aggregations use only the latest observation per distinct post (`aggregatePostMetrics`, `medianMetric`). Older duplicates are excluded with reason `duplicate_observation`.
- In weekly baselines, a week that appears more than once is excluded as `duplicate_week`, a sign of double ingestion.

---

## 2. Metric definitions

Unit legend: `count` = events · `people` = unique accounts · `percent` = 0–100 scale (may exceed 100) · `seconds` / `minutes`.

| Key | Label | Definition | Unit | Semantics | Summable across posts | Buffer type |
|---|---|---|---|---|---|---|
| `reactions` | Reactions | Likes/reactions on the post | count | lifetime_cumulative | Yes | `reactions` |
| `comments` | Comments | Comments on the post | count | lifetime_cumulative | Yes | `comments` |
| `shares` | Shares | Times the post was shared | count | lifetime_cumulative | Yes | `shares` |
| `saves` | Saves | Times the post was saved/bookmarked | count | lifetime_cumulative | Yes | `saves` |
| `views` | Views | Plays/views as counted by the platform (not people) | count | lifetime_cumulative | Yes (total = plays) | `views` |
| `reach` | Reach | Unique accounts that saw the post | people | lifetime_cumulative | **No**: use median per post | `reach` |
| `impressions` | Impressions | Times the post was displayed | count | lifetime_cumulative | Yes | `impressions` |
| `clicks` | Clicks | Link clicks | count | lifetime_cumulative | Yes | `clicks` |
| `follows` | Follows from post | Accounts that followed from this post | count | lifetime_cumulative | Yes (see always-zero caveat) | `follows` |
| `provider_engagement_rate` | Engagement rate (provider) | Rate computed by Buffer/network; **formula undocumented** | percent | point_in_time | **No** | `engagementRate` |
| `avg_watch_time_seconds` | Average watch time | Average time viewers watched | seconds | point_in_time | **No** | `averageTimeWatched` |
| `total_watch_time_minutes` | Total watch time | Total time all viewers watched | minutes | lifetime_cumulative | Yes | `totalTimeWatched` |
| `followers` | Followers | Account audience size at a point in time | people | point_in_time (account) | **No** (audiences overlap) | none (not in Buffer) |

### 2.1 Computed metrics

Rates are expressed in **percent**. Every computed rate carries a `definitionId`; values with different ids are never compared.

| Metric | Formula | Definition id | N/A rules |
|---|---|---|---|
| Interactions | Sum of the platform's interaction components (§2.2) | — | Any component unusable → `numerator_unavailable`. Platform `other` → `unsupported_by_provider` |
| Engagement rate by reach | interactions ÷ reach × 100 | `er_reach:{platform}:v1` | Reach unsupported (YouTube) → `unsupported_by_provider`; reach pending/not reported → `denominator_unavailable`; component unusable → `numerator_unavailable`; reach 0 → `denominator_zero` |
| Engagement rate by views | interactions ÷ views × 100 | `er_views:{platform}:v1` | Same rules with views |
| Primary engagement rate | Instagram: by reach · TikTok, YouTube: by views | as above | Platform `other` → `unsupported_by_provider` (`er:other:v1`) |
| Click-through rate | clicks ÷ impressions × 100 | `ctr:v1` | Impressions unusable → `denominator_unavailable` / `unsupported_by_provider`; clicks unusable → `numerator_unavailable`; impressions 0 → `denominator_zero` |
| Net audience growth | followers_end − followers_start | — | Either snapshot missing → `no_data` (never estimated or backfilled) |
| Audience growth % | (end − start) ÷ start × 100 | — | Missing snapshot → `no_data`; start ≤ 0 → `starting_audience_not_positive` |
| Post age at observation | (metricsUpdatedAt − publishedAt) in hours, floored at 0 | — | `null` while metrics are pending |

A `reported_zero` component counts as 0 and sets `containsZeroUncertainty: true`. The UI must show the ambiguous-zero marker next to such rates.

### 2.2 Interaction components per platform

Only metrics Buffer actually provides for the platform are included, so a rate is never N/A merely because of a structurally missing metric.

| Platform | Components |
|---|---|
| Instagram | reactions + comments + shares + saves |
| TikTok | reactions + comments + shares |
| YouTube (Shorts) | reactions + comments |
| Other | not defined (N/A) |

Consequence: engagement rates are **not comparable across platforms**, because the definition ids differ.

---

## 3. Provider availability (Buffer, observed 2026-09-13)

✓ supported · ~ sometimes present · — unsupported (absent → `unsupported`)

| Metric | Instagram | TikTok | YouTube (Shorts) |
|---|---|---|---|
| reactions | ✓ | ✓ | ✓ |
| comments | ✓ | ✓ | ✓ |
| shares | ✓ | ✓ | — |
| saves | ✓ | — | — |
| views | ✓ | ✓ | ✓ |
| reach | ✓ | ✓ | — |
| impressions | — | — | — |
| clicks | — | — | — |
| follows | ✓ (always 0 observed) | — | — |
| provider_engagement_rate | ✓ | ✓ | ✓ |
| avg_watch_time_seconds | ~ | ✓ | — |
| total_watch_time_minutes | ~ | ✓ | — |
| followers | — | — | — |

"Sometimes present" metrics are classified as supported: when absent they are `not_reported`, not `unsupported`.

Refresh: post metrics refresh about once a day (`metricsUpdatedAt`). They stay null until first ingestion, which can take up to ~24h after publishing.

---

## 4. Aggregation rules

| Operation | Rule |
|---|---|
| Sum (`aggregatePostMetrics`) | Only summable lifetime metrics; distinct posts; latest observation per post. Returns `postsIncluded`, `postsExcluded` with reasons, and `isComplete` (false = the total is a lower bound). Non-summable key → `not_summable`. No usable post → `no_data`, **never 0** |
| Median (`medianMetric`) | Any metric, distinct posts, latest observation. Recommended for reach, rates and averages |
| Average of rates | Not provided. Averaging per-post rates ignores denominators; use the median |
| Reach across posts, accounts or platforms | Never summed and never deduplicated (the same person may be reached many times) |
| Totals across platforms | Views may be shown per platform; a cross-platform "total views" must be labeled as plays counted differently by each platform, and is never used for ranking |

---

## 5. Periods and comparisons

### 5.1 Weeks (`periods.ts`)
- A week is Monday 00:00 to next Monday 00:00 in the **brand timezone** (`start`/`end` local dates, `startUtc`/`endUtcExclusive` instants).
- DST weeks last 167h or 169h; never assume 7 × 24h. Sunday 23:30 local belongs to that local week even when UTC is already Monday.
- A period is complete once `now >= endUtcExclusive`.
- `rollingWeeks(period, n)` returns `n` contiguous weeks ending with `period`, oldest first.
- Report schedules (`nextReportRunAt`) keep local wall time. A nonexistent time (spring-forward gap) shifts forward by the gap; an ambiguous time (fall-back overlap) uses its **first** occurrence.

### 5.2 Comparison rules (`compareValues`)
Checked in this order:
1. Different definition ids (e.g. `er_reach:instagram:v1` vs `er_views:instagram:v1`) → `incompatible_definitions`.
2. Either period incomplete → `partial_period`. A partial week is never compared with a complete one.
3. Either value N/A → that N/A reason propagates. Missing is never compared as zero.
4. Absolute change = current − previous, in the metric unit (**percentage points** for percent metrics).
5. Percent change = (current − previous) ÷ |previous| × 100. Previous = 0 → percent is `denominator_zero`, but the absolute change stays valid.

Additional rules for callers:
- Compare "posts published in week W" with "posts published in week W−1" only when both are observed at comparable post ages. Otherwise the more recent week is systematically lower. Reports must state observation times.
- Do not compare the provider engagement rate with BrandPulse engagement rates (undocumented formula, different ids).

### 5.3 Rolling baseline (`rollingBaseline`)
- Window = the `weeks` (default 4) most recent **distinct** prior weeks. Missing weeks must be passed with `value: null`, not omitted.
- Usable = complete **and** has a value. Incomplete, null and duplicated weeks are excluded with reasons. Older weeks are **not** pulled in to compensate.
- Fewer than `minWeeks` (default 3) usable → `insufficient_sample`. Otherwise the result is the mean and median of the usable weeks.

---

## 6. Queue coverage (`coverage.ts`)

| Field | Definition |
|---|---|
| Inventory / `scheduledCount` | Items with status `scheduled` **and** a resolved `dueAt` strictly after `now` |
| `unresolvedCount` | `draft`, `needs_approval`, or `scheduled` with `dueAt` null: uncertainty, **never coverage** |
| `sending` | Counted neither as future coverage nor as missing |
| Overdue | `scheduled` with `dueAt <= now`: not coverage; reported via `post_overdue` |
| Horizon | Slots in (now, now + horizonDays], with horizonDays counted in **local calendar days** so "next 7 days" always has 7 days of slots across DST |
| Expected slots | `provider_schedule` / `custom`: weekday HH:MM times in the cadence timezone, skipping paused days. Duplicate weekday entries merge (paused if any entry is paused) |
| DST | Nonexistent local slot → shifted forward by the gap (`dst_nonexistent_time_shifted`); collision with another slot → merged (`dst_slots_merged`); ambiguous → first occurrence |
| Irregular cadence | Virtual slots: expected posts accrue at `postsPerWeek ÷ (active days × 24h)` over non-paused local days from `now`; slot *k* has the window (deadline₍ₖ₋₁₎, deadlineₖ]. `isEstimate = true` |
| Matching | `same_day`: earliest unmatched slot on the post's **local** calendar day. `time_window`: nearest unmatched slot within tolerance (tie → earlier). Irregular: the post must fall inside the slot window. One post per slot, one slot per post, processed in dueAt order (ties by id) |
| `unmatchedItems` | Inventory inside the horizon that matched no slot (extra or off-cadence). Inventory beyond the horizon is counted separately (`beyondHorizonCount`, `inventory_beyond_horizon`) |
| `coverageRatio` | coveredSlots ÷ expectedSlots; null without expected slots |
| `firstUncoveredSlot` = `fillDeadline` | Earliest uncovered slot |
| `coveredDays` | (firstUncoveredSlot − now) in days (elapsed time); = horizonDays when all slots are covered; null without cadence |
| `postsNeeded` | Uncovered slots within the horizon |
| `lastScheduledAt` / `nextScheduledAt` | Max / min inventory dueAt. **Never used for severity** |
| `estimatedRunwayDays` | scheduledCount ÷ expected posts per day (weekly cadence ÷ 7). Always labeled an estimate; never used for severity |

**Severity** comes from `coveredDays` only: scheduledCount 0 → `empty`; coveredDays < criticalDays → `critical`; < warningDays → `warning`; otherwise `healthy`. A single distant post covers at most its own slot, so the near-term gap still drives severity (`distant_post_ignored_for_severity`).

**State precedence:** invalid timezone → `unknown` · cadence mode paused → `paused` · account disconnected → `unknown` (even with an empty queue: a disconnected channel's queue cannot be confirmed and cannot publish) · never synced / stale (sync older than `staleAfterMinutes`) → `unknown` with numbers kept (`never_synced` / `stale_sync`) · queue paused → `paused` · no expected slots → `unknown` (`no_cadence`) · otherwise the severity above. `underlyingState` exposes the queue-only severity so the UI can overlay "Critical + stale". A horizon shorter than `warningDays` is flagged `horizon_shorter_than_warning`, because full coverage can then never read healthy.

**Provider inventory cap.** Buffer Free allows 10 pending scheduled posts per organization; at 2 posts/day that is ~5 days of runway. With `inventoryCap`, the result includes `remainingCapacity` and `maxAchievableCoveredDays`, plus `provider_inventory_cap` (horizon unreachable) and `provider_inventory_cap_blocks_healthy` (even the warning threshold is unreachable, so warnings are structural). The cap is per org; callers must apportion it across the org's channels.

---

## 7. Alerts (`alert-rules.ts`)

| Type | Severity | Dedupe key | Emitted when |
|---|---|---|---|
| `queue_empty` | critical | `queue_coverage:{accountId}` | Fresh data, not paused or disconnected, state `empty` |
| `queue_coverage` | warning / critical | `queue_coverage:{accountId}` | Fresh data, state `warning` / `critical` |
| `sync_stale` | info (never synced) / warning (stale) | `sync_stale:{accountId}` | Coverage freshness is not fresh. **Replaces** queue alerts: stale data is never presented as confirmed depletion |
| `queue_paused` | warning | `queue_paused:{accountId}` | Buffer queue paused (suppresses queue alerts) |
| `account_disconnected` | critical | `account_disconnected:{accountId}` | Channel disconnected (suppresses queue and stale alerts) |
| `publish_failed` | critical (≤24h or no dueAt) / warning | `publish_failed:{postId}` | Per failed post |
| `post_overdue` | warning; info when paused or disconnected | `post_overdue:{accountId}` | Scheduled posts past due + grace, not failed |
| `unresolved_times` | info | `unresolved_times:{accountId}` | Drafts / needs-approval / scheduled posts without a time |
| `connection_failing` | critical (credential rejected, or ≥ 2× threshold failures) / warning | `connection_failing:{connectionId}` | Invalid or revoked key, `unauthorized`/`forbidden`, or ≥ threshold (default 3) consecutive failures; rate limiting stays a warning |
| `sync_stale` (connection) | warning; critical when > 4× the staleness window | `sync_stale:connection:{connectionId}` | No successful sync within the window and no `connection_failing` alert |

Queue depletion is one condition, so `queue_empty` and `queue_coverage` share a dedupe key and escalate in place. `resolveMissing(openKeys, candidates)` returns open keys of the **evaluated scope** that no longer have a candidate (auto-resolve).

---

## 8. Content ranking (`ranking.ts`)

- **Cohort:** same account + platform + format (null format → `unknown`). Raw counts are never compared across cohorts.
- **Eligible:** metrics ingested, age at `metricsUpdatedAt` ≥ 72h, views reported and > 0. Views reported as 0 are ambiguous and excluded (`primary_metric_ambiguous_zero`).
- **Baseline:** eligible cohort posts published in the trailing 28 days ending at the period end (candidates included).
- **Score:** views ÷ cohort median views. Cohort < 5 → not ranked (`cohort_too_small`).
- **Secondary:** primary engagement rate (Instagram by reach; TikTok and YouTube by views) with its cohort median. Used as evidence and tie-breaker only.
- **Lists:** best = score ≥ 1.2×; underperforming = score ≤ 0.8× (defaults configurable). Every item carries value, cohort median, ratio, cohort size, age, baseline window and an English explanation. The result carries a method description.
- **Confidence:** high = cohort ≥ 10 and age within 0.5–2× the cohort median age; medium = age within 0.25–4×; low otherwise.

---

## 9. Known limitations (disclose in reports, section 10)

1. **Ambiguous zero.** Buffer returns 0 when a network did not report a metric. `reported_zero` may be a real zero.
2. **Always-zero metrics.** Instagram `follows` was 0 on every sampled post; treat it as likely not reported.
3. **Daily refresh lag.** Metrics refresh ~once a day and are null up to ~24h after publishing. Recent posts are under-counted relative to older ones.
4. **No audience data from Buffer.** No follower or subscriber counts or history for any platform. Audience growth is "Requires direct platform connection", never 0.
5. **Provider engagement rate formula is undocumented.** It is shown as-is and never compared with BrandPulse rates.
6. **Reach is not deduplicable** across posts, accounts or platforms.
7. **No period activity.** "Performance earned during a week" cannot be derived from lifetime counters without complete daily snapshots.
8. **Paid vs organic is not identifiable** via Buffer. All figures may include boosted distribution.
9. **Views differ by platform.** Each network defines a view differently; views are compared only within a cohort.
10. **Coverage is based on the last successful sync** and on BrandPulse's cadence model. Automations posting at custom times may not align with Buffer's schedule slots (hence default `same_day` matching). Irregular cadences are estimates.
11. **Plan inventory cap.** Buffer Free's 10 pending scheduled posts per organization can make healthy coverage structurally unreachable.
