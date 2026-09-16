> **Language update (2026-09-16):** the product owner asked for the application UI in Brazilian Portuguese. The English copy below is kept as the source of meaning; the shipped UI is pt-BR (report narratives and recommendations were already pt-BR). Code, comments and logs stay in English.

# BrandPulse — Product Specification

**Status:** Draft v1.0 · **Scope:** Read-only multi-brand social monitoring (no publish/edit/delete of posts) · **UI language:** English (report narratives are configurable per brand, independent of UI language) · **Data source of truth today:** Buffer GraphQL API (verified schema, 2026-09-13)

This document translates the product brief into journeys, screen specs, acceptance criteria, and a backlog. It is the reference for engineering, design, and QA. It assumes the constraints below are permanent product facts, not temporary gaps — the UI must communicate them honestly rather than hide them.

## 0. Non-negotiable provider constraints (read before designing any screen)

- Buffer gives per-post metrics (reactions, comments, shares, saves, reach, impressions, views, clicks, engagement rate, watch time, follows) refreshed **at most once every 24h**. Never imply real-time; always show "Last synced X ago."
- Buffer reports `0` when a network simply didn't report a metric. A `0` is **ambiguous** — it can mean "truly zero" or "not reported." The UI must never silently render a bare `0` for these fields without a way to disambiguate (see §6).
- Buffer does **not** provide follower/subscriber counts or historical audience size. Any audience-growth surface shows **"Requires direct platform connection"** — never `0`, never a blank chart.
- Buffer rate limits are tight (100 req/15min, 250/day, 3,000/30 days on Free, per key). Sync is periodic and batched, not on-demand-per-view. Every screen that shows Buffer-sourced data must show a freshness indicator.
- A channel can be `isQueuePaused`, `isDisconnected`, or `isLocked`. These are distinct states and must render distinctly — a paused queue is not the same problem as a disconnected channel.
- `postingSchedule` is per-weekday HH:MM slots with optional paused days; a post's `dueAt` can be unresolved/approximate for draft or needs-approval posts. Any coverage/runway calculation built on an irregular or partially-paused schedule must flag uncertainty rather than present a false precise number.

---

## 1. Personas & Roles

### Personas

- **Agency Owner / Founder** — manages the portfolio across all brands and clients. Cares about which accounts are at risk *today*, whether the agency is delivering on schedule, and what to show clients weekly. Time budget: skims Portfolio Overview + Alerts daily.
- **Account Manager** — owns 1–5 brands day to day. Lives in Brand Dashboard, Content Calendar, and Alerts for their brands. Needs to know exactly what to schedule, by when, and what happened with last week's content.
- **Viewer (Client or Junior Staff)** — read-only access to specific brand(s), typically to check Weekly Reports and Content Performance. Should never see Connections/Settings or other brands' data.

### Roles & Permissions Matrix

| Capability | Owner | Manager | Viewer |
|---|---|---|---|
| View Portfolio Overview (all brands) | Yes | Only assigned brands | Only assigned brands |
| View Brand Dashboard / Account Detail | All brands | Assigned brands | Assigned brands |
| View Content Calendar | All brands | Assigned brands | Assigned brands (read-only) |
| View Content Performance | All brands | Assigned brands | Assigned brands |
| View Alerts | All brands | Assigned brands | Assigned brands (view only) |
| Acknowledge / snooze / resolve alerts | Yes | Yes (assigned brands) | No |
| View Recommendations & Experiments | All brands | Assigned brands | Assigned brands |
| Mark recommendation as tried / dismiss | Yes | Yes | No |
| View Weekly Reports (in-app, PDF, CSV) | All brands | Assigned brands | Assigned brands |
| Configure report language / schedule | Yes | Yes (assigned brands) | No |
| Manage Buffer connections (add/remove API key) | Yes | No | No |
| Map channels to brands | Yes | Suggest only (owner approves) | No |
| Set cadence targets / alert thresholds | Yes | Yes (assigned brands) | No |
| Manage brands (create/archive) | Yes | No | No |
| Manage users & roles | Yes | No | No |
| Enable/exit Demo Mode | Yes | Yes | No |

Notes:
- BrandPulse never writes to Buffer. There is no role that can schedule, edit, or delete a post — this is true for every role, including Owner.
- A user with no brands assigned sees an empty Portfolio Overview with a "You have no brands assigned yet — contact your admin" state, not an error.

---

## 2. Top User Journeys

### Journey A — First-run setup (Owner)
1. Sign up / log in → lands on **Portfolio Overview**, empty state: "No brands yet."
2. Click **Create Brand** → name, timezone, report language (default: English), logo (optional) → brand created, no accounts yet.
3. Go to **Settings → Connections** → **Add Buffer Connection** → secure server-side form: paste Buffer API key (key is sent directly to backend, never rendered again in full, masked as `••••••3f9c` after save) → backend validates key against Buffer, stores encrypted.
4. Backend calls Buffer, discovers organizations and channels under that key → **Discovery** screen lists all found channels (service icon, name, avatar, timezone) grouped by organization, each with a status chip: Active / Queue Paused / Disconnected / Locked.
5. Owner **maps each channel to a brand** (dropdown per channel: "Assign to brand…" or "Create new brand"). Unmapped channels are visibly flagged and excluded from all dashboards until mapped.
6. For each brand, Owner sets **cadence target** (e.g., "3 posts/week per channel") and confirms/adjusts default thresholds (Warning < 7 days, Critical < 3 days) — can override per brand or per account.
7. Owner is returned to **Portfolio Overview**, now populated. A one-time banner: "Buffer syncs on a schedule (not real-time) — first full sync may take up to a few minutes."

### Journey B — Daily check-in (Owner or Manager)
1. Open **Portfolio Overview** → scan brand cards for status chips (Critical/Warning/Healthy/Paused/Disconnected).
2. Click into a brand showing Critical → **Brand Dashboard** shows which account(s) are the problem and why (empty queue vs. stale sync vs. disconnected).
3. Click through to **Alerts** filtered to that brand → read evidence, see suggested action ("Schedule 4 posts for @brand_tiktok by Sep 16 to keep 7-day coverage") → acknowledge or snooze.
4. Manager schedules the actual posts *in Buffer* (outside BrandPulse) → returns later; BrandPulse reflects the fix at next sync and the alert auto-resolves.

### Journey C — Weekly review / client reporting (Owner or Manager)
1. Monday morning → **Weekly Reports** for a brand → review the auto-generated report (flagged "Preliminary" if data was delayed).
2. Read narrative sections (in the brand's configured report language), check "what went well" / "what needs improvement" / prioritized actions.
3. Export PDF for client email, or CSV for internal tracking. Compare against last week via version history.

### Journey D — Understanding performance & acting on it (Manager)
1. **Content Performance** → filter by brand/account/date range/platform → sort by engagement rate.
2. Open top post → see supporting metrics and "why it might have worked" interpretation, clearly separated from observed numbers.
3. Go to **Recommendations & Experiments** → see a finding tied to that pattern (e.g., "Posts under 15s outperform longer posts on TikTok") with linked posts, sample size, confidence, and a concrete next action.
4. Manager marks the recommendation "Trying this" to track it as an informal experiment; revisits next week to see if the success metric moved.

### Journey E — Investigating a specific account (Manager)
1. From Brand Dashboard, click an account tile → **Account Detail**.
2. See full posting schedule (per weekday), scheduled queue, last N sent posts with status (sent/error), and the exact runway calculation with its inputs shown.
3. If in error state (e.g., `isDisconnected`), see the reconnection instruction pointing to Buffer, since BrandPulse cannot fix the connection itself.

---

## 3. Information Architecture & Navigation

**Sidebar (persistent, left):**
- Portfolio (`/portfolio`) — default landing page
- Brands (expandable list, each brand → its own sub-nav)
  - Dashboard (`/brands/[brandId]`)
  - Accounts (`/brands/[brandId]/accounts/[accountId]`)
  - Calendar (`/brands/[brandId]/calendar`)
  - Content (`/brands/[brandId]/content`)
  - Recommendations (`/brands/[brandId]/recommendations`)
  - Reports (`/brands/[brandId]/reports`)
- Alerts (`/alerts`) — global, cross-brand, with brand filter
- Settings (`/settings`)
  - Connections (`/settings/connections`)
  - Brands (`/settings/brands`)
  - Users & Roles (`/settings/users`)
- Demo Mode toggle — always visible at the top of the sidebar, never buried in Settings (see §5 for treatment)

**Top bar:** brand switcher (when inside a brand context), global search (posts/brands), last-sync timestamp for the current view, user menu.

**Routing rules:**
- `/alerts` and `/portfolio` are the only cross-brand views; everything else is brand-scoped.
- Viewer role never sees `/settings/*`; direct navigation returns a 403-style in-app message, not a blank page.
- Demo Mode is a distinct session flag reflected in the URL query (`?demo=1`) and a persistent banner — never mixed silently with real data.

---

## 4. Screens

Each screen lists: purpose, primary questions answered, components in priority order, data/labels/tooltips, filters, and the five states with exact copy.

### 4.0 Login

**Purpose:** authenticate; route to Portfolio Overview.
**Components:** email/password (or SSO if configured), "Forgot password," no sign-up self-serve (invite-only, since this is an agency tool).
**States:**
- Loading: spinner, no copy needed beyond disabled button showing "Signing in…"
- Empty: n/a
- Unavailable: n/a
- Stale: n/a
- Error: "We couldn't sign you in. Check your email and password and try again." Below: "Still stuck? Contact your admin."

---

### 4.1 Portfolio Overview (`/portfolio`)

**Purpose:** one glance across every brand: what needs attention right now.
**Primary questions:** What is happening with every brand? Which accounts are about to run out of content? Are things publishing successfully?

**Components (priority order):**
1. **Attention banner** (only renders if any brand is Critical or Disconnected): "3 accounts need attention" with a jump link to Alerts.
2. **Brand cards grid** — one card per brand: brand name/logo, worst-status chip among its accounts (Critical > Warning > Empty > Unknown/Stale > Paused > Healthy), account count by platform (icons for IG/TikTok/YouTube with per-platform status dot), "Last synced X ago," mini sparkline of combined engagement (7d), a "View Brand" CTA.
3. **Portfolio-wide alert summary strip** — count of open alerts by severity, clickable to `/alerts`.
4. **Demo Mode banner** (if active) — full-width, high-contrast, non-dismissible-without-exit: "You are viewing DEMO DATA. No real accounts are connected in this view. [Exit Demo Mode]"

**Data shown & tooltips:**
- "Last synced [X ago]" — tooltip: "Buffer refreshes data on a schedule, not instantly. This is when we last pulled data for this brand."
- Status chip — tooltip per state, see §5.

**Filters:** by client group/tag (if configured), by status (show only Critical/Warning), search by brand name.

**States:**
- **Loading:** skeleton cards (5–6 grey placeholders matching card layout) — no spinner-only screen.
- **Empty:** "No brands yet. [Create your first brand] to start monitoring." (Owner) / "You have no brands assigned yet. Contact your admin to get access." (Manager/Viewer)
- **Unavailable:** if Buffer connection entirely fails at the account level: brand card shows "Connection unavailable" chip with tooltip "We can't reach Buffer for this brand's accounts right now. This is not the same as no scheduled posts — we simply can't confirm status." — never render this as "Empty."
- **Stale:** if a brand's most recent sync is older than 48h, card shows a muted amber dot next to "Last synced 3d ago" with tooltip: "This brand hasn't synced recently. Numbers below may be out of date."
- **Error:** if the API/backend itself errors on load: "We couldn't load your portfolio. [Retry]" full-width banner, cards area empty.

---

### 4.2 Brand Dashboard (`/brands/[brandId]`)

**Purpose:** the brand-level command center — separates operational health (scheduling/publishing) from content performance, per the brief's requirement never to blend them into one score.

**Primary questions:** What's the state of this brand's accounts? Which need posts scheduled, and by when? How is performance trending? What did this brand achieve this week?

**Components (priority order):**
1. **Two clearly separated panels side by side (never merged into one score):**
   - **Left: Operational Health** — one row per account (platform icon, name, status chip, "Coverage: X days," "First uncovered slot: [date]," mini action "Needs N posts by [date]").
   - **Right: Content Performance (7d/28d toggle)** — top-line metrics per platform: reach, engagement rate, posts published, sorted list of top 3 posts this period.
2. **This Week card** — pulls directly from the latest Weekly Report summary: "3 posts published, engagement rate up 12% vs last week" with link to full report.
3. **Alerts for this brand** (top 3, severity-sorted) with link to full Alerts view filtered to this brand.
4. **Account tiles row** — click-through to Account Detail.

**Data & tooltips:**
- "Coverage" tooltip: "The share of your expected posting slots (based on this account's schedule) that currently have a scheduled post, looking ahead to your target horizon."
- "Engagement rate" tooltip: see §6 — clarify denominator (reach vs. views) per platform.
- Audience growth tile: shows **"Requires direct platform connection"** with a "Learn more" link explaining Buffer doesn't expose follower counts — never a 0 or blank chart.

**Filters:** date range (7d/28d/custom) for the performance panel; platform filter (IG/TikTok/YouTube/All).

**States:**
- **Loading:** two skeleton panels, shimmering rows.
- **Empty:** brand has accounts mapped but zero posts of any kind found — Operational panel: "No scheduled or sent posts found for this brand yet." Performance panel: "No content data yet — once posts are published, performance will appear here."
- **Unavailable:** an account's data couldn't be fetched this sync — row shows "Data unavailable this sync" chip, rest of dashboard still renders with available accounts; never blocks the whole page for one bad account.
- **Stale:** banner at top of panel: "Some data here is more than 24h old. [See sync details]" — only shown when relevant, not by default.
- **Error:** "We couldn't load performance data for this brand. Operational health may still be shown below. [Retry]" — partial failure is rendered as partial, not as a full blank page.

---

### 4.3 Account Detail (`/brands/[brandId]/accounts/[accountId]`)

**Purpose:** the deepest operational view of a single Buffer channel — exact scheduling math, exposed transparently.

**Primary questions:** How many more posts to schedule, and by when? Is this account publishing successfully? What's its exact queue state?

**Components (priority order):**
1. **Header:** platform icon, handle, avatar, connection status (Active/Queue Paused/Disconnected/Locked), timezone, "Last synced X ago."
2. **Scheduling math card** (the single most important card on this screen):
   - Last scheduled date (furthest known scheduled post)
   - Cadence coverage (%, with the day-range window it's computed over)
   - First uncovered slot (exact date/time of the next expected slot with no content)
   - Estimated runway ("~X days," explicitly labeled as an estimate)
   - Posts needed to reach target horizon (e.g., "Schedule 4 more posts to stay covered through Sep 30")
   - Deadline to fill first gap
   - Each of the six values has its own tooltip (see §6) — this card must never collapse these into one number.
3. **Posting schedule** — weekly grid (Mon–Sun) showing configured time slots and any paused days, sourced directly from Buffer's `postingSchedule`.
4. **Recent posts table** — status (draft/needs_approval/scheduled/sending/sent/error), dueAt/sentAt, error message if any, external link to the live post, per-post metrics (reach, engagement, etc.) with "as of last sync" freshness.
5. **Performance summary** (28d) — reach, engagement rate, top post.

**Data & tooltips:**
- "Estimated runway" tooltip: "Our best estimate of how many days of scheduled content remain, based on your posting schedule and currently queued posts. This is an estimate, not a guarantee — Buffer's own queue behavior can vary." (See §6 for the full copy bank.)
- Error rows: exact Buffer error message shown verbatim in a collapsible "Details" affordance, plus a plain-English gloss where possible (e.g., "This post failed to publish. Buffer reported: '[error text]'").

**Filters:** post status filter (All / Sent / Scheduled / Error / Draft), date range for recent posts.

**States:**
- **Loading:** skeleton for scheduling math card (6 placeholder stat blocks) + table skeleton.
- **Empty:** no scheduled or sent posts at all — Scheduling math card renders explicitly: "Last scheduled date: None. Cadence coverage: 0%. First uncovered slot: Now." Copy: "This account has no scheduled content. Every upcoming slot is uncovered." (Never shows a friendly blank state here — an empty queue is operationally urgent and must read as such.)
- **Unavailable:** if `isDisconnected` — "This account is disconnected from Buffer. We can't retrieve current queue or performance data. Reconnect it directly in Buffer, then it will sync here again." No fabricated runway number is shown; all six scheduling fields read "Unavailable — account disconnected."
- **Stale:** if `isQueuePaused` — chip "Queue Paused" (distinct color from Critical) + copy: "This account's queue is paused in Buffer. Scheduled posts will not go out until it's resumed. Coverage numbers below reflect the queue as of the pause." Also applies to sync staleness: "Last synced 30h ago — figures below may not reflect the very latest changes in Buffer."
- **Error:** "We couldn't load this account's data. [Retry]" scoped to the failing card only if other cards succeeded (partial degrade preferred over full-page error).

---

### 4.4 Content Calendar (`/brands/[brandId]/calendar`)

**Purpose:** visual, brand-wide (or per-account) calendar of scheduled/sent posts — must make gaps impossible to miss, per the brief ("a single distant post must not make an empty calendar look healthy").

**Primary questions:** What's scheduled, when, and where are the gaps?

**Components (priority order):**
1. **Month/Week toggle grid**, one lane per account (or combined). Each cell: post thumbnail/platform icon count, or an explicit **gap indicator** if the cell falls before the first uncovered slot's horizon and has nothing scheduled.
2. **Gap shading** — any date range between "today" and "first uncovered slot" that has zero posts is visually shaded distinctly (diagonal hatch pattern, not just a color, for accessibility) — this directly prevents the "one distant post = healthy calendar" failure mode called out in the brief.
3. **Legend** explaining hatch pattern + status colors.
4. **Side panel on cell click:** post detail (status, dueAt, text preview, tags).
5. **Uncertainty markers** — posts with unresolved/approximate `dueAt` (draft/needs_approval) render with a dashed border and a "Time not confirmed" tag rather than a solid slot, so they don't visually count as confirmed coverage.

**Filters:** account/platform, status (scheduled/sent/error/draft), date range/month navigation.

**States:**
- **Loading:** skeleton calendar grid.
- **Empty:** "No posts found for this period." If the *entire* upcoming range is empty, the gap-shading covers the whole visible calendar with a top banner: "No scheduled content found for [account/brand] in this view."
- **Unavailable:** account disconnected — that lane renders hatched grey with "Unavailable" label instead of white/empty, so it's distinguishable from "confirmed no posts."
- **Stale:** small "synced Xh ago" tag pinned to the calendar header, amber if >24h.
- **Error:** inline banner above the grid: "We couldn't load some calendar data. [Retry]" — grid still renders what did load.

---

### 4.5 Content Performance (`/brands/[brandId]/content`)

**Purpose:** understand what performed well/poorly and why it might have.

**Primary questions:** How do followers/engagement/views/likes/comments/shares change? Which content performs well and why? What to improve?

**Components (priority order):**
1. **Filter bar:** date range, platform, account, sort (engagement rate, reach, comments, shares, recency).
2. **Metrics summary strip** — totals for the filtered range: posts published, total reach/views, total engagement, average engagement rate — each labeled with its exact definition (see §6) and a "lifetime vs. period" toggle explained by tooltip.
3. **Post grid/table** — thumbnail, platform, publish date, core metrics, engagement rate, a "why it might have worked" chip (short heuristic tag like "Short-form, high replay") clearly marked as **interpretation**, separated visually (different background/icon) from the observed metric numbers next to it.
4. **Post detail drawer** — full metrics, external link to the live post, comparison to account average.
5. **Audience growth section** — explicit **"Requires direct platform connection"** empty-state module (never blank, never 0) explaining Buffer doesn't provide follower history, with a CTA if/when direct platform OAuth is available (P2 feature).

**Data & tooltips:** see §6 for exact metric copy, especially the ambiguous-zero and lifetime-vs-period rules.

**Filters:** date range, platform, account, content type (if tags allow), sort order.

**States:**
- **Loading:** skeleton grid/table + skeleton summary strip.
- **Empty:** "No published posts found for this filter." (distinguish from "no posts at all" by suggesting filter reset: "[Clear filters]").
- **Unavailable:** a specific metric wasn't reported by the platform for a post — cell shows "N/A" with tooltip "This platform didn't report this metric for this post." (never a bare 0 — see §6 ambiguous zero rule).
- **Stale:** summary strip shows "Metrics current as of [sync time]" always visible (not just when stale) since metrics are inherently up-to-24h behind by design; if >48h, an amber "outdated" tag appears additionally.
- **Error:** "We couldn't load content performance for this selection. [Retry]" — filter bar remains usable.

---

### 4.6 Alerts (`/alerts`)

**Purpose:** the actionable, deduplicated queue of everything needing human attention across brands.

**Primary questions:** What's urgent right now, across the whole portfolio? What should I do about it?

**Components (priority order):**
1. **Severity filter tabs:** Critical / Warning / All, with counts.
2. **Alert list**, each item: brand + account, severity chip, title (e.g., "Queue running out in 2 days"), evidence line ("Last scheduled post: Sep 14. No posts scheduled after."), suggested action ("Schedule at least 3 posts by Sep 16 to restore 7-day coverage"), timestamps (first detected, last updated), and controls: **Acknowledge**, **Snooze** (1d/3d/7d/custom), **Resolve**.
3. **Deduplication logic surfaced in UI:** if the same underlying condition persists, the alert updates in place ("Ongoing since Sep 12") rather than creating duplicates — shown via a small "Updated Xh ago" tag instead of a new list entry.
4. **Brand/account filter**, **status filter** (Open/Acknowledged/Snoozed/Resolved).
5. Empty severity tab still shows count-zero tabs, not hidden tabs (so a Manager can see "0 Critical" as reassurance, not absence of the concept).

**Data & tooltips:**
- "Snoozed until [date]" — tooltip: "This alert won't resurface until the snooze period ends, unless the underlying condition gets worse (e.g., Warning escalates to Critical)."
- Severity chip tooltips reuse §5 vocabulary exactly.

**Filters:** severity, brand, account, status, alert type (Scheduling / Publishing / Sync).

**States:**
- **Loading:** skeleton list rows (5–8).
- **Empty:** "No open alerts. Everything is within your configured thresholds." (calm, positive empty state — this is a good outcome, so no urgency styling).
- **Unavailable:** n/a at the list level; individual alerts always resolve from already-synced data, so this screen doesn't have a distinct "unavailable" state beyond Error.
- **Stale:** header note: "Alerts reflect data as of [last sync]. New issues may exist that haven't been detected yet." shown whenever any contributing brand's sync is >24h old.
- **Error:** "We couldn't load alerts. [Retry]" full-width, since this is a safety-critical screen — no silent partial failure here; if partial data is available it's shown below the error banner labeled "Partial results below, may be incomplete."

---

### 4.7 Recommendations & Experiments (`/brands/[brandId]/recommendations`)

**Purpose:** turn performance patterns into concrete next actions, with rigor about what's fact vs. interpretation.

**Primary questions:** What should we improve, concretely? What's driving performance?

**Components (priority order):**
1. **Recommendation cards**, each with:
   - **Finding** (the observed fact, e.g., "Posts published before 9am get 40% higher reach on average")
   - **Supporting metrics + linked posts** (clickable list of the specific posts behind the finding)
   - **Comparison period + sample size** ("Last 28 days, n=17 posts vs. n=9 posts")
   - **Interpretation** — visually separated (distinct card region, labeled "Our interpretation:") from the Finding — e.g., "This may be because early posts catch users during their morning scroll window."
   - **Concrete action** ("Shift your next 5 scheduled posts to 8:00–9:00 local time")
   - **Priority** (High/Medium/Low chip)
   - **Confidence** (High/Medium/Low chip, with tooltip explaining it reflects sample size + consistency, not statistical certainty)
   - **Success metric + evaluation window** ("Watch average reach per post over the next 2 weeks")
2. **Status controls per card:** "Mark as trying," "Dismiss," "Trying since [date]" tracker.
3. **Filter:** by priority, by status (New/Trying/Dismissed), by platform.

**States:**
- **Loading:** skeleton cards.
- **Empty:** "Not enough data yet to generate recommendations for this brand. We typically need at least [N] published posts over [window]." — sets expectation rather than looking broken.
- **Unavailable:** n/a (derived screen; if underlying performance data is unavailable, falls to Error).
- **Stale:** "Recommendations were last generated on [date] using data as of [sync time]." always shown (not urgency-styled) since these are inherently periodic, not real-time.
- **Error:** "We couldn't load recommendations. [Retry]"

---

### 4.8 Weekly Reports (`/brands/[brandId]/reports`)

**Purpose:** the shareable weekly narrative deliverable per brand.

**Primary questions:** What did this brand achieve this week? What should a client see?

**Components (priority order):**
1. **Report list** (most recent first): week range, generated timestamp, "Preliminary" flag if applicable, language tag (e.g., "PT-BR"), View / Download PDF / Download CSV / Version history actions.
2. **In-app report view**, rendering the 10 required sections in order:
   1. Executive summary
   2. Account KPI table
   3. Publication consistency & scheduling health
   4. Best content (with ranking method stated inline, e.g., "Ranked by engagement rate among posts with ≥100 impressions")
   5. Underperforming content (with the same fairness caveat — compared only within similar post types/time windows)
   6. Audience growth & engagement trends (shows "Requires direct platform connection" module where follower data is unavailable)
   7. What went well
   8. What needs improvement
   9. 3–5 prioritized actions
   10. Data freshness, missing metrics, and limitations (explicit disclosure section — always present, never omitted even when data is complete: "All metrics current as of [sync time]. No missing data this period.")
3. **Preliminary banner** (only if flagged): "This report was generated with data that may still be updating. A finalized version will replace it once all metrics have synced."
4. **Version history drawer:** prior versions of the same week's report (e.g., preliminary → final), diff-able at a glance.
5. **Language selector** (per brand, in Settings, referenced here): report narrative language, independent of the English UI chrome around it.

**Filters:** week selector/date range, format (In-app/PDF/CSV).

**States:**
- **Loading:** skeleton report list + skeleton section blocks when a report is opening.
- **Empty:** "No reports yet. The first weekly report will generate this Monday at 08:00 [brand timezone]." (Brands added mid-week see this rather than a broken report.)
- **Unavailable:** n/a (reports are generated artifacts; if generation failed, see Error).
- **Stale:** not applicable to historical reports (they're timestamped snapshots by design); the report itself carries "as of" timestamps in section 10 instead of a page-level stale banner.
- **Error:** "This week's report couldn't be generated in full. [View partial report] [Contact support]" — never silently skip a week; a failed/partial generation is itself surfaced as an entry in the list with a "Generation incomplete" tag.

---

### 4.9 Connections & Settings

#### 4.9.1 Connections (`/settings/connections`)
**Purpose:** manage Buffer API key connections and channel-to-brand mapping.
**Components:** connection list (masked key, added date, last validated, status), "Add Buffer Connection" (secure server-side form — key never displayed again after save, never logged to client-side analytics), per-connection "Re-discover channels" action, channel mapping table (channel → brand dropdown, status chip, "Unmapped" filter).
**States:**
- Loading: skeleton list.
- Empty: "No Buffer connections yet. [Add Buffer Connection] to start discovering your channels."
- Unavailable: if a stored key fails validation: "This connection can't reach Buffer. The API key may have been revoked. [Re-enter key]"
- Stale: "Channels last discovered [X ago]. [Re-discover now]"
- Error: "We couldn't save this connection. Check the key and try again." (validation happens server-side; the raw key is never round-tripped to the client after the initial submit)

#### 4.9.2 Brands (`/settings/brands`)
**Purpose:** create/archive brands, set per-brand cadence targets, thresholds, and report language.
**Components:** brand list, create/edit form (name, timezone, report language, cadence target per platform, Warning/Critical thresholds with defaults pre-filled at 7d/3d, archive toggle).
**States:** standard CRUD states; Empty: "No brands yet. [Create Brand]"; Error: "We couldn't save these settings. [Retry]"

#### 4.9.3 Users & Roles (`/settings/users`)
**Purpose:** invite users, assign role + brand scope.
**Components:** user list (name, email, role, assigned brands, last login), invite form, role/brand-scope editor.
**States:** Empty: "No team members yet besides you. [Invite someone]"; Error: "We couldn't send this invite. [Retry]"

---

## 5. Status Vocabulary & Color Semantics

Every status is communicated with **icon + text label + color** — never color alone (WCAG 1.4.1).

| Status | Meaning | Icon | Color (hex, on white) | Where used |
|---|---|---|---|---|
| **Healthy** | Coverage ≥ 7 days; account connected and active | check-circle | `#1B7A43` (green) | Operational health |
| **Warning** | Coverage < 7 days and ≥ 3 days | alert-triangle | `#B15C00` (amber-brown, AA-safe on white) | Operational health |
| **Critical** | Coverage < 3 days | alert-octagon | `#C4291C` (red) | Operational health, Alerts |
| **Empty** | Zero scheduled posts found | circle-slash | `#6B7280` (neutral grey) with red text label "Empty" | Operational health, Calendar |
| **Paused** | `isQueuePaused` true | pause-circle | `#5B4B8A` (violet, distinct from Critical red) | Account status |
| **Disconnected** | `isDisconnected` true | plug-off / unlink | `#8A1F3D` (dark maroon, distinct from Critical) | Account status |
| **Locked** | `isLocked` true | lock | `#4B5563` (slate) | Account status |
| **Unknown / Stale** | Last sync > 24h (soft) / > 48h (hard) old | clock-alert | `#946200` (muted amber, lighter than Warning) | Global freshness indicator |

Rules:
- Disconnected/Paused/Locked always outrank Healthy/Warning/Critical in card summaries ("worst status wins") because they represent *inability to confirm* operational health, not a confirmed measurement — this is why they get distinct hues rather than reusing red/amber/green.
- Stale is an overlay, not a replacement: a Critical account that is also stale shows both — "Critical" chip plus a small clock-alert badge — never collapsed into one signal, since "confirmed depletion" and "we haven't checked recently" are different problems (per brief).
- Text labels are never abbreviated to color-coded dots alone in any table or list row.

---

## 6. Exact Microcopy — Metric & Concept Tooltips

Use verbatim. These are the canonical definitions; do not paraphrase differently across screens.

**Coverage**
> "Coverage: the percentage of expected posting slots — based on this account's posting schedule — that currently have a post scheduled, looking ahead to your configured target horizon. 100% means every expected slot through that horizon is filled."

**Runway (Estimated runway)**
> "Estimated runway: our best estimate of how many days of scheduled content remain before this account runs out of queued posts. This is an estimate based on current schedule and queue — not a guarantee, since posting behavior in Buffer can change after this was calculated."

**First uncovered slot**
> "First uncovered slot: the next date and time, based on this account's posting schedule, that has no post currently scheduled. Everything before this slot is covered; this is where the gap starts."

**Last scheduled date**
> "Last scheduled date: the date of the furthest-out post currently scheduled for this account. A single far-future post here does not by itself mean the account is well covered — check Coverage and First uncovered slot too."

**Posts needed to reach target horizon**
> "Posts needed: how many additional posts you'd need to schedule, at this account's normal posting frequency, to keep coverage at 100% through your target horizon."

**Deadline to fill first gap**
> "Deadline to fill first gap: schedule at least one post before this date to avoid an uncovered slot in this account's queue."

**Engagement rate (by reach)**
> "Engagement rate (by reach): (reactions + comments + shares + saves) ÷ reach for this post. Used for Instagram and Facebook, where reach is reported."

**Engagement rate (by views)**
> "Engagement rate (by views): (reactions + comments + shares) ÷ views for this post. Used for TikTok and YouTube Shorts, where view count is the more reliable denominator."

**N/A (metric not available)**
> "N/A: this platform did not report this metric for this post. It is not the same as zero — we simply have no data for it."

**Ambiguous zero**
> "0 shown here means the platform reported zero — or didn't report this metric at all and Buffer defaults to zero. We can't always tell these apart. Treat a lone 0 on an otherwise active post with caution; compare against reach/views for context."

**Lifetime vs. period metrics**
> "Lifetime: total accumulated value for this post since it was published, as of the last sync. Period: the change in this post's metrics within the date range you've selected above. Lifetime numbers only ever go up; period numbers depend on your filter."

**Audience growth unavailable**
> "Requires direct platform connection: Buffer does not provide follower or subscriber counts. To see audience growth here, connect this brand directly to Instagram, TikTok, or YouTube (coming soon)."

**Last synced**
> "Last synced: when we last successfully pulled fresh data from Buffer for this item. Buffer refreshes metrics roughly once every 24 hours, so this will rarely say 'moments ago.'"

**Confidence (Recommendations)**
> "Confidence: how consistent and well-sampled this finding is — based on sample size and how repeatable the pattern was — not a formal statistical guarantee."

---

## 7. Acceptance Criteria (Given/When/Then)

**Portfolio Overview**
- Given a brand has at least one Critical account, when the Portfolio Overview loads, then that brand's card shows a Critical chip (icon + red + text) even if other accounts in the brand are Healthy.
- Given the API request for portfolio data fails, when the page loads, then an error banner with a Retry button is shown and no brand cards render silently blank.
- Given a user has zero assigned brands, when they load Portfolio Overview, then the empty-state copy for their role is shown, not a loading spinner that never resolves.

**Brand Dashboard**
- Given a brand has accounts with performance data but no scheduled posts, when the dashboard loads, then Operational Health shows Empty/Critical states per account while Content Performance still renders historical metrics — the two panels never gate each other.
- Given one account's data fetch fails while others succeed, when the dashboard renders, then only that account's row shows "Data unavailable this sync" and the rest of the dashboard remains fully interactive.
- Given no direct platform connection exists, when the Audience Growth tile renders, then it shows "Requires direct platform connection" and never a numeric 0 or blank chart.

**Account Detail**
- Given an account has one post scheduled 40 days out and nothing else, when the Scheduling math card renders, then Coverage shows a low percentage (reflecting the many uncovered near-term slots) and First uncovered slot shows a near-term date — the single far post must not make Coverage read as healthy.
- Given `isDisconnected` is true for an account, when Account Detail loads, then all six scheduling fields read "Unavailable — account disconnected" and no fabricated runway number is shown.
- Given `isQueuePaused` is true, when Account Detail loads, then the header shows a Paused chip (violet, distinct from red Critical) and the scheduling math card explains figures reflect the queue as of the pause.

**Content Calendar**
- Given today's date and a first-uncovered-slot 20 days out, when the calendar renders the intervening days with zero posts, then those days show hatch-pattern gap shading, not plain empty white cells.
- Given a post has an unresolved `dueAt` (draft/needs_approval), when it renders on the calendar, then it shows a dashed border and "Time not confirmed" tag instead of a solid scheduled slot.

**Content Performance**
- Given a post's platform did not report `saves`, when the post row renders, then the saves cell shows "N/A" with the ambiguous-metric tooltip, never a bare "0" styled identically to a confirmed zero.
- Given a user toggles from Period to Lifetime view, when metrics re-render, then the values change accordingly and the toggle's current state is visibly labeled.

**Alerts**
- Given the same underlying condition persists across two sync cycles, when Alerts loads, then only one alert entry exists for it, with an "Updated Xh ago" indicator — no duplicate entries.
- Given a user snoozes an alert for 3 days, when 2 days pass and the underlying condition escalates from Warning to Critical, then the alert resurfaces before the snooze period ends.
- Given zero open alerts exist, when Alerts loads, then a calm, non-urgent empty state renders ("Everything is within your configured thresholds"), not a stark blank page.

**Recommendations & Experiments**
- Given a recommendation card renders, when a user reads it, then the Finding (fact) and Interpretation (inference) appear in visually distinct regions with different labels, never merged into one paragraph.
- Given fewer than the minimum required published posts exist for a brand, when Recommendations loads, then the "not enough data yet" empty state renders with the specific threshold stated.

**Weekly Reports**
- Given a report is generated with delayed data, when a user opens it, then a "Preliminary" banner is visible at the top and the same banner disappears once a finalized version replaces it (tracked in version history).
- Given a brand's report language is set to Portuguese, when a report is viewed, then all narrative sections render in Portuguese while surrounding UI chrome (buttons, filters, nav) remains in English.
- Given report generation partially fails for a week, when the report list loads, then that week's entry shows a "Generation incomplete" tag and a partial report is still accessible rather than the week being silently skipped.

**Connections & Settings**
- Given an Owner submits a Buffer API key, when it's saved successfully, then the key displays only as a masked suffix (e.g., `••••••3f9c`) everywhere thereafter, and is never returned in full to the client again.
- Given a channel is discovered but not yet mapped to a brand, when any dashboard loads, then that channel does not appear in any brand's metrics until it is explicitly mapped.
- Given a Manager (not Owner) attempts to navigate directly to `/settings/connections`, when the page loads, then an in-app permission message is shown, not a raw 403 or blank screen.

---

## 8. Prioritized Backlog

### P0 — MVP (must ship for the tool to be usable at all)
1. Buffer connection setup + channel discovery + brand mapping (Journey A) — nothing else works without this.
2. Portfolio Overview with worst-status-wins brand cards and freshness indicators.
3. Brand Dashboard with the Operational Health / Content Performance split (the brief's core visual-separation requirement).
4. Account Detail scheduling math card (last scheduled date, coverage, first uncovered slot, runway, posts needed, deadline) — this is the single most-referenced calculation across the whole product; everything else (alerts, calendar shading, dashboard chips) derives from it.
5. Alerts (deduplicated, severity, evidence, suggested action, acknowledge/snooze/resolve) — the brief explicitly calls out urgent scheduling issues as the top priority signal.
6. Content Calendar with gap shading (directly addresses "a single distant post must not make an empty calendar look healthy").
7. Status vocabulary + color system implemented consistently (icon+text, never color-only) across all screens — a cross-cutting P0 since every other screen depends on it.
8. Core five-state handling (loading/empty/unavailable/stale/error) built as shared components, not per-screen one-offs — prevents inconsistent copy and rework later.
9. Users & Roles (owner/manager/viewer) — needed from day one since this is a multi-client agency tool; retrofitting permissions later is high-risk.

*Rationale:* P0 answers the two most urgent brief questions — "is anything about to break" and "is it publishing" — and establishes the shared visual/data vocabulary every later screen reuses. Shipping Weekly Reports or Recommendations before the scheduling-math primitives exist would mean rebuilding their data foundation later.

### P1 — high value, follows immediately after P0
1. Content Performance screen (full filtering, sort, N/A vs ambiguous-zero handling).
2. Weekly Reports (in-app + PDF/CSV, preliminary flag, version history) — clients expect this cadence quickly, but it depends on P0's performance data pipeline being solid first.
3. Recommendations & Experiments (finding/interpretation split, confidence, success metric) — needs a performance data history window (P1 Content Performance) to have enough signal to be non-trivial.
4. Connections management refinements: re-discovery, connection health monitoring, per-key rate-limit visibility.
5. Cadence/threshold customization per brand/account (beyond the global defaults shipped in P0).

*Rationale:* these are the "why" and "so what" layer on top of P0's "what's happening" layer — valuable, but each depends on P0 data structures being stable first.

### P2 — valuable, not launch-blocking
1. Direct platform connections (Instagram/Meta, TikTok, YouTube OAuth) to unlock real audience/follower growth — explicitly called out as unavailable via Buffer; this is a distinct, larger integration effort.
2. Cross-brand comparative analytics (benchmark one brand against portfolio averages).
3. Alert delivery beyond in-app (email/Slack digest) — brief specifies in-app only "initially."
4. Experiment tracking with structured before/after measurement (beyond the informal "mark as trying" of P1).
5. Custom report section reordering / white-labeling for client-facing exports.
6. Saved views / dashboard customization per user.

*Rationale:* these expand reach and polish but are not required to answer the core brief questions and often depend on integrations (direct platform OAuth) outside this app's current scope.

---

## 9. Visual Design Direction

**Overall feel:** professional agency tool — dense enough for power users (Owners/Managers scanning many brands daily) but never cluttered; performance-dashboard, not marketing-site.

**Layout & density**
- 12-column responsive grid, max content width ~1440px, sidebar fixed at 240px (collapsible to 64px icon rail).
- Card padding: 16px standard, 24px for primary summary cards. Row height in dense tables: 44px; comfortable mode toggle available for 56px.
- Base spacing unit: 4px scale (4/8/12/16/24/32/48).

**Typography**
- One typeface family (system-ui stack or Inter) for both UI and data — no display font needed for a tool this data-dense.
- Scale: 12px (captions/tooltips) / 14px (body/table default) / 16px (emphasized body) / 20px (card titles) / 24px (section headers) / 32px (page titles). Line-height 1.4–1.5 for body, 1.2 for headers.
- Numeric data (metrics, dates) uses tabular-nums for column alignment in tables.

**Color**
- Neutral base: background `#F7F8FA`, surface/card `#FFFFFF`, border `#E2E5EA`, primary text `#111827`, secondary text `#5B6472` — all meet WCAG AA against their backgrounds.
- Semantic status colors as defined in §5 — each verified at AA contrast (≥4.5:1 for text, ≥3:1 for large icons) against white card backgrounds.
- Accent/brand action color (buttons, links, active nav): a single blue, e.g. `#2451B0`, reserved for interactive elements only — never reused for status, so status and "clickable" are never confused.
- Demo Mode uses a distinct fifth hue (e.g., `#7A3FA0` violet-purple band) not used anywhere else in the system, so it's unmistakable at a glance.

**Charts**
- Never use dual y-axes — if two metrics have different scales, use two stacked small charts instead, each with its own labeled axis.
- Always label the unit on the axis itself (e.g., "Reach", "%"), never rely on a legend alone.
- Missing/N/A data points render as a visible gap in the line (dashed segment or break), never interpolated or dropped silently, and never rendered as zero.
- Sparklines in cards are for trend direction only — always paired with the actual current value in text next to them, never standing alone as the only representation of a metric.
- Bar/line colors reuse the neutral+accent palette, not the status palette, to keep "this chart is red" from being confused with "this account is Critical."

**Accessibility baseline**
- Every status indicator: icon + label + color, per §5.
- Minimum touch/click target 40x40px for row actions (acknowledge/snooze/resolve buttons).
- Focus states visible (2px accent outline) on all interactive elements for keyboard navigation, since this is a daily-use internal tool likely to see power-user keyboard workflows.
