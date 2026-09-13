# Provider Capability Matrix

**Verification date:** 2026-09-13
**Method:**
1. Read the official Buffer developer documentation.
2. Introspected the live Buffer GraphQL schema with a supplied key (337 types).
3. Ran minimal **read-only** queries against the 5 supplied Buffer API keys: 11 requests in total, no mutations.

**Discovered scope:** 5 keys map to 5 Buffer accounts, 5 organizations and 12 channels (4 Instagram Business, 4 TikTok, 4 YouTube). There is one organization per account. A key is account-wide: Buffer documents *"no per-organization scoping at this time"*.

Status legend: **Verified**: confirmed with live data. **Documented, unverified**: in official docs or schema but not observed with these accounts. **Unavailable**: not offered by the provider. **Requires another connection**: needs a direct platform integration.

## Buffer GraphQL API (`https://api.buffer.com`)

| # | Capability | Status | Source (schema field) | Permissions | Limitations / notes |
|---|---|---|---|---|---|
| 1 | Organizations for a key | Verified | `account.organizations { id name channelCount limits }` | Personal API key (Bearer) | A key sees every organization of the Buffer account. Keys do not map 1:1 to brands, so channels are mapped to brands manually. |
| 2 | Channels and persistent identity | Verified | `channels(input:{organizationId})`: `id`, `service`, `serviceId`, `type`, `name`, `timezone`, `avatar`, `externalLink` | Same | `serviceId` is the platform's persistent id (IG user id, TikTok open id, YouTube channel id). BrandPulse uses it instead of usernames. |
| 3 | Channel health | Verified (fields) | `isDisconnected`, `isLocked`, `isQueuePaused`, `allowedActions` | Same | All 12 channels were healthy on the verification date, so the disconnected and locked states have not been seen live. |
| 4 | Queue posting slots | Verified | `postingSchedule { day paused times }` | Same | All 12 channels expose 2 slots/day. **The existing automations use `customScheduled` posts whose times do not match these slots** (e.g. slots 18:28/20:30 vs posts at 20:00 local). BrandPulse therefore lets you configure the intended cadence per account (default: Buffer slots, same-day matching). |
| 5 | Posting goal | Verified (null) | `postingGoal` | Same | Null on every channel. Not used. |
| 6 | Scheduled posts and resolved times | Verified | `posts(input:{filter:{status:[scheduled]}, sort:[{field:dueAt}]})` → `dueAt` | Same | Cursor pagination, max 100 per page. Observed 0–7 pending posts per channel. Orgs report `limits.scheduledPosts = 10`, yet one org held 21 pending posts (7 per channel), so how that limit is enforced is **unverified**. It still caps runway (≈5 days at 2 posts/day). |
| 7 | Pending posts without a resolved time | Documented, unverified | `filter.dueAtPresence: absent` | Same | 0 observed. BrandPulse shows these as uncertainty, never as coverage. |
| 8 | Approval and draft states | Documented, unverified | `PostStatus.needs_approval`, `draft` | Same | Live enum: `draft, needs_approval, scheduled, sending, sent, error`. The published reference page lists outdated values (`buffer, failed, approval, paused`); the live schema wins. **Verified provider defect:** a `status` filter that combines `needs_approval` with other statuses silently returns **0 posts** (e.g. `[scheduled]` → 21, `[scheduled, sending]` → 21, `[scheduled, needs_approval]` → 0; no error). BrandPulse queries approvals separately and cross-checks every queue sync against a status-agnostic upcoming listing. On a mismatch the run is marked `partial` and nothing is marked missing. |
| 9 | Publication status | Verified | `status: sent / sending`, `sentAt`, `externalLink` | Same | `externalLink` was present on all sent posts (direct links to original posts). |
| 10 | Failed publications | Verified | `status: error`, `error { message supportUrl }` | Same | 1 observed: *"Buffer has lost authorization to post on your behalf…"* (YouTube, 2026-09-05). |
| 11 | Overdue posts | Derived | `scheduled` posts with `dueAt` in the past | — | Not a provider field. Computed by BrandPulse with a grace period. |
| 12 | Posts published outside Buffer | Verified | `via: network` (vs `buffer`, `api`) | Same | Native posts appear with metrics (one Instagram account is 100% `network`). |
| 13 | Historical coverage | Verified (partial) | `posts(sort dueAt asc)` | Same | Oldest sent post per organization: 2023‑02‑05, 2025‑07‑27, 2025‑11‑16, 2026‑03‑17, 2026‑06‑24. Retention policy is not documented. BrandPulse backfills 90 days, then refreshes 35 days daily. |
| 14 | Post metrics: reactions, comments, views, provider engagement rate | Verified (IG, TikTok, YouTube) | `Post.metrics { type unit value }`, `metricsUpdatedAt` | Personal API key (documented requirement) | **Lifetime cumulative** per post. Refreshed by Buffer about **once per day** (lag up to ~24 h). **`value` defaults to 0 when the network did not report the metric**, so zeros are ambiguous (see METRIC_DICTIONARY.md). The `engagementRate` formula is undocumented. |
| 15 | Shares, reach | Verified (Instagram, TikTok) | same | same | **Not emitted for YouTube.** |
| 16 | Saves | Verified (Instagram) | same | same | — |
| 17 | Follows gained per post | Verified field, **values unusable** | `follows` (Instagram) | same | 0 on 100% of 78 posts across 3 accounts → treated as *likely not reported*. |
| 18 | Watch time | Verified (TikTok; some Instagram accounts) | `averageTimeWatched` (s), `totalTimeWatched` (min) | same | Not emitted for YouTube. |
| 19 | Impressions | Unavailable for these platforms | enum exists, not emitted | — | Meta deprecated IG `impressions` in favour of `views` (April 2025). |
| 20 | Clicks / CTR | Unavailable | enum exists, not emitted | — | CTR is shown as N/A (unsupported). |
| 21 | Retention / completion rate | Unavailable | — | — | No video duration or retention curves. |
| 22 | Followers / subscribers, audience growth | **Unavailable → requires another connection** | No audience fields in schema | — | Nothing in the 337-type schema exposes follower counts or history. |
| 23 | Account-level historical analytics | Unavailable | — | — | `aggregatedPostMetrics` only sums post metrics over a publish-date window. |
| 24 | `aggregatedPostMetrics` | Documented, not used | `aggregatedPostMetrics(input)` | Personal key | Mixed-network filters drop non-common metrics, and networks without a metric contribute 0. BrandPulse computes aggregates from post-level data with explicit rules instead. |
| 25 | Paid vs organic | Unavailable | — | — | Cannot be separated via Buffer. Reported as a limitation. |
| 26 | Webhooks / change notifications | Unavailable | not in docs or schema | — | Quota-aware polling is used. |
| 27 | Rate limits | Verified | `RateLimit`, `RateLimit-Policy` headers | — | These keys: **100 / 15 min, 250 / day, 3,000 / 30 days per account**. Docs list 100 / 250 / 3,000 for Free, 100 / 250 / 7,500 for Essentials and 100 / 500 / 15,000 for Team. Throttling returns `429 RATE_LIMIT_EXCEEDED` + `Retry-After`. **The budget is shared with the existing publishing automations.** |
| 28 | Error model | Verified | GraphQL `errors[].extensions.code` | — | Docs say HTTP 200 with codes `UNAUTHORIZED, FORBIDDEN, NOT_FOUND, UNEXPECTED, RATE_LIMIT_EXCEEDED`. Also observed live: **HTTP 502 with `UPSTREAM_SERVER_ERROR`** (transient; succeeded on retry). |
| 29 | Query complexity | Documented | — | — | Max cost 175,000, depth 25, 30 aliases, 15,000 tokens. |
| 30 | Mutations (create/edit/delete/move posts) | Available, **deliberately not used** | `createPost`, `editPost`, `deletePost`, `movePostInQueue`… | — | The BrandPulse client rejects any mutation document. Enabling mutations requires separate explicit authorization. |

Documentation: [Reference](https://developers.buffer.com/reference.html) · [Authentication](https://developers.buffer.com/guides/authentication.html) · [Post metrics](https://developers.buffer.com/guides/post-metrics.html) · [Rate limits](https://developers.buffer.com/guides/api-limits.html) · [Error handling](https://developers.buffer.com/guides/error-handling.html) · [Efficient usage & pagination](https://developers.buffer.com/guides/efficient-api-usage.html) · [Changelog](https://developers.buffer.com/changelog.html)

## Quota budget used by BrandPulse (per Buffer account)

| Job | Requests | Default frequency | ≈ per day |
|---|---|---|---|
| Queue sync (channels + pending + failed + recently sent) | 1 per org (+1 per extra 100 pending) | every 120 min, widened automatically | 12 |
| Organization refresh | 1 | every 24 h | 1 |
| Published posts + metrics | 1–4 per org (100 posts/page) | every 24 h | 1–4 |
| **Total** | | | **≈ 14–17 (≈ 450–510 / 30 days)** |

Reserves never spent by BrandPulse (configurable): 40% of the 15‑min window, 50% of the daily window, 40% of the 30‑day window. When a reserve is reached, sync pauses and the UI shows data age instead of an empty queue.

## Direct platform integrations (needed for audience metrics)

None are implemented; each needs its own authorization. The Buffer keys **cannot** substitute for them.

| Platform | Data | Official API | Requirements (documented) | Status |
|---|---|---|---|---|
| Instagram | `followers_count`; `follower_count` insight (daily) | Instagram API with Instagram Login: IG User + `/insights` | Professional (Business/Creator) account; permissions `instagram_business_basic` + `instagram_business_manage_insights` (or with Facebook Login `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`); Meta app. Standard Access is enough for accounts you own or manage. `follower_count` is unavailable under 100 followers; data can be delayed up to 48 h. | Documented, unverified. [IG insights](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/) |
| TikTok | `follower_count`, `likes_count`, `video_count` | Display API `GET /v2/user/info/` | OAuth user access token (Login Kit) with scope `user.info.stats`; registered TikTok developer app. The page does not state app-review requirements or historical data: **to confirm** during app registration. | Documented, unverified. [User info](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info) |
| YouTube | `statistics.subscriberCount` (rounded down to 3 significant figures; `hiddenSubscriberCount`) | YouTube Data API v3 `channels.list` (1 quota unit) | Google Cloud project. Whether an API key alone is enough for public statistics is not stated on the fetched page: **to confirm**. Historical subscriber gains need the YouTube Analytics API (OAuth). | Documented, unverified. [channels](https://developers.google.com/youtube/v3/docs/channels), [channels.list](https://developers.google.com/youtube/v3/docs/channels/list) |

The data model already has `audience_snapshots` (daily, per source) ready for these connections. History is recorded only from the first observation onward; nothing earlier is inferred.
