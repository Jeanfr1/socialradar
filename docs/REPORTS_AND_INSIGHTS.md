# Reports and insights

BrandPulse produces deterministic weekly reports first. The optional AI layer may rewrite narrative paragraphs, but it cannot change tables, actions, evidence, or calculated values. If AI is disabled, unavailable, refuses, returns invalid JSON, or introduces an unverified number, the deterministic narrative is kept.

## Weekly period and lifecycle

- A report covers Monday 00:00 through the following Monday 00:00 in the brand timezone.
- The scheduled report runs Monday at 08:00 by default and is idempotent per brand and period.
- Manual regeneration creates a new version; earlier versions remain available.
- An incomplete week, missing/late published sync, stale queue sync, or metrics that have not refreshed after period end marks the report `preliminary`. Preliminary reports can be refreshed automatically; final reports are immutable.
- Every stored version contains its data snapshot and a SHA-256 hash so its narrative and exports remain auditable.

## KPI comparison

Post metrics from Buffer are lifetime cumulative counters. BrandPulse therefore never compares the latest values of two weeks when the posts have had different time to accumulate engagement.

For every account, the report chooses the latest real observation age at or below 168 hours for which every current-week post has a nearby provider refresh. The minimum comparison age is 24 hours and the maximum allowed observation gap is the smaller of 36 hours or half the chosen age. Both weeks are then evaluated at that same post age. If a complete sum cannot be formed, the comparison is withheld instead of presenting a misleading percentage.

The report shows:

- published post count;
- views, reach, reactions, comments, shares, and saves where supported;
- median primary engagement rate, using the platform-specific definition in `METRIC_DICTIONARY.md`;
- explicit N/A reasons such as unsupported, not reported, pending, incomplete sample, or insufficient post age.

Zeros remain marked as uncertain when Buffer may be using zero for a metric the network did not report.

## Content ranking

Ranking uses posts observed at least 72 hours after publication with reported, non-zero views. A post is compared only with posts from the same account, platform, and format in a 28-day baseline:

`score = post views / median views of its comparable cohort`

A cohort needs at least five posts. Scores of at least 1.2 are candidates for best content; scores of at most 0.8 are candidates for underperforming content. Lists are capped at five items and include the observation time, cohort size, score, and original post link. Captions and titles are treated as untrusted text and are never used as instructions.

## Recommendations

Recommendations are rule-based, evidence-backed, and deduplicated. Each one records an observed finding, sample window, post references, a hypothesis (never a causal claim), a concrete action, priority, confidence, success metric, and evaluation window.

Current rule families cover:

- disconnected accounts and publication failures;
- queue replenishment and posting consistency;
- format mix and content-pillar experiments;
- missing content tags;
- time-bucket experiments, explicitly presented as tests rather than a claim of a universal “best time”.

Minimum samples and thresholds live in `src/server/insights/rules.ts`. Dismissed or completed recommendations are not proposed again with the same dedupe key during the 30-day cooldown.

## AI safeguards

When enabled, the model receives only the deterministic facts and draft narrative after deep redaction. Connection credentials, users, emails, and provider secrets are excluded. Captions and provider messages are moved into explicitly untrusted fields, truncated, and escaped.

The response must match a strict JSON schema. Every numeric token in every returned paragraph must correspond to a number already present in the deterministic snapshot (locale formatting and ordinary rounding are accepted). Empty, oversized, malformed, refused, timed-out, or numerically unsupported output falls back to the deterministic report.

## Exports and access

PDF and CSV exports are generated from the stored report version, not recomputed live. Brand membership is checked for listing, viewing, regeneration, and download; unauthorized or unknown identifiers return 404. Downloads and regeneration are written to the audit log.
