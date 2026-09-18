/**
 * Canonical BrandPulse data model (PostgreSQL).
 *
 * Conventions
 * - All timestamps are stored as `timestamptz` (UTC). Display conversion happens in the UI using the brand timezone.
 * - Provider identity uses persistent provider identifiers (Buffer channel id + platform serviceId), never usernames.
 * - Brand isolation: brand-scoped data is reachable only through `brands.id`. Posts and metrics are scoped through
 *   `social_accounts.brand_id`; every query in `src/server/queries` must filter by an authorized brand id.
 * - Missing values are NULL with an explicit `value_status`; they are never coerced to 0.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const membershipRole = pgEnum("membership_role", ["owner", "manager", "viewer"]);
export const providerEnum = pgEnum("provider", ["buffer", "demo"]);
export const platformEnum = pgEnum("platform", ["instagram", "tiktok", "youtube", "other"]);
export const connectionStatus = pgEnum("connection_status", ["pending", "active", "invalid", "error", "revoked"]);
export const mappingStatus = pgEnum("mapping_status", ["unmapped", "mapped", "ignored"]);
export const cadenceMode = pgEnum("cadence_mode", ["provider_schedule", "custom", "irregular", "paused"]);
export const slotMatchMode = pgEnum("slot_match_mode", ["same_day", "time_window"]);
export const postStatus = pgEnum("post_status", [
  "draft",
  "needs_approval",
  "scheduled",
  "sending",
  "sent",
  "error",
  "missing", // previously seen as pending, no longer returned by the provider (deleted or moved)
]);
export const metricSubject = pgEnum("metric_subject", ["post", "account"]);
export const metricValueStatus = pgEnum("metric_value_status", [
  "reported", // provider returned a non-zero value
  "reported_zero", // provider returned 0; may be a true zero or a provider default (see metric dictionary)
  "not_reported", // metric absent from provider response for this item
  "pending", // provider has not ingested metrics yet (e.g. metricsUpdatedAt is null)
]);
export const metricSemantics = pgEnum("metric_semantics", ["lifetime_cumulative", "period_activity", "point_in_time"]);
export const syncKind = pgEnum("sync_kind", ["discovery", "queue", "published", "metrics", "validation"]);
export const runStatus = pgEnum("run_status", ["running", "succeeded", "partial", "failed", "skipped"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "dead"]);
export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const alertState = pgEnum("alert_state", ["open", "acknowledged", "snoozed", "resolved"]);
export const priorityEnum = pgEnum("priority", ["high", "medium", "low"]);
export const confidenceEnum = pgEnum("confidence", ["high", "medium", "low"]);
export const recommendationStatus = pgEnum("recommendation_status", [
  "proposed",
  "accepted",
  "dismissed",
  "in_experiment",
  "done",
  "superseded",
]);
export const experimentStatus = pgEnum("experiment_status", ["planned", "running", "completed", "abandoned"]);
export const reportStatus = pgEnum("report_status", ["generating", "final", "preliminary", "failed"]);
export const reportTrigger = pgEnum("report_trigger", ["scheduled", "manual"]);
export const narrativeSource = pgEnum("narrative_source", ["ai", "deterministic"]);
export const tagKind = pgEnum("tag_kind", ["campaign", "format", "topic", "pillar"]);

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  /** Workspace administrators manage provider connections, users and brand creation. Brand data still requires membership. */
  isWorkspaceAdmin: boolean("is_workspace_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: ts("locked_until"),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)]);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the opaque session token. The raw token only lives in the httpOnly cookie. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const brands = pgTable("brands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  timezone: text("timezone").notNull().default("America/Sao_Paulo"),
  /** Report narrative locale, independent from the English application UI. */
  reportLocale: text("report_locale").notNull().default("pt-BR"),
  businessGoals: text("business_goals"),
  contentPillars: jsonb("content_pillars").$type<string[]>().notNull().default([]),
  /** Weekly report schedule in brand timezone. dayOfWeek: 1 = Monday (ISO). */
  reportSchedule: jsonb("report_schedule")
    .$type<{ enabled: boolean; dayOfWeek: number; hour: number; minute: number }>()
    .notNull()
    .default({ enabled: true, dayOfWeek: 1, hour: 8, minute: 0 }),
  isDemo: boolean("is_demo").notNull().default(false),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.brandId] }), index("memberships_brand_idx").on(t.brandId)],
);

// ---------------------------------------------------------------------------
// Provider connections & accounts
// ---------------------------------------------------------------------------
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    label: text("label").notNull(),
    status: connectionStatus("status").notNull().default("pending"),
    /** AES-256-GCM envelope (see src/server/security/crypto.ts). Never selected by UI queries. */
    credentialCiphertext: text("credential_ciphertext"),
    credentialKeyVersion: integer("credential_key_version"),
    /** First 12 hex chars of SHA-256(credential): duplicate detection without storing the secret. */
    credentialFingerprint: text("credential_fingerprint"),
    externalAccountId: text("external_account_id"),
    externalAccountName: text("external_account_name"),
    isDemo: boolean("is_demo").notNull().default(false),
    lastValidatedAt: ts("last_validated_at"),
    lastSyncAttemptAt: ts("last_sync_attempt_at"),
    lastSyncSuccessAt: ts("last_sync_success_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Last parsed RateLimit header state per window, e.g. { "15min": {limit, remaining, resetAt} }. */
    rateLimitState: jsonb("rate_limit_state").$type<
      Record<string, { limit: number; remaining: number; resetAt: string; windowSeconds: number }>
    >(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    rotatedAt: ts("rotated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    uniqueIndex("connections_fingerprint_uq")
      .on(t.provider, t.credentialFingerprint)
      .where(sql`${t.deletedAt} is null`),
    /** One active connection per provider account (several keys of the same Buffer account are rejected). */
    uniqueIndex("connections_external_account_uq")
      .on(t.provider, t.externalAccountId)
      .where(sql`${t.deletedAt} is null and ${t.externalAccountId} is not null`),
  ],
);

export const providerOrganizations = pgTable(
  "provider_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    limits: jsonb("limits").$type<Record<string, number>>(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("provider_orgs_uq").on(t.connectionId, t.externalId)],
);

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    providerOrganizationId: uuid("provider_organization_id").references(() => providerOrganizations.id, {
      onDelete: "set null",
    }),
    provider: providerEnum("provider").notNull(),
    /** Buffer channel id. */
    externalChannelId: text("external_channel_id").notNull(),
    platform: platformEnum("platform").notNull(),
    /** Persistent platform identifier (Buffer `serviceId`: IG user id, TikTok open id, YouTube channel id). */
    platformAccountId: text("platform_account_id").notNull(),
    channelType: text("channel_type"),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    externalUrl: text("external_url"),
    providerTimezone: text("provider_timezone"),
    isQueuePaused: boolean("is_queue_paused").notNull().default(false),
    isDisconnected: boolean("is_disconnected").notNull().default(false),
    isLocked: boolean("is_locked").notNull().default(false),
    canViewInsights: boolean("can_view_insights").notNull().default(false),
    /** Raw provider posting schedule: [{ day: 'mon', paused: false, times: ['18:00'] }]. */
    providerPostingSchedule: jsonb("provider_posting_schedule").$type<ProviderScheduleDay[]>(),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    mappingStatus: mappingStatus("mapping_status").notNull().default("unmapped"),
    isDemo: boolean("is_demo").notNull().default(false),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    /** Set when the provider no longer returns this channel. */
    removedAt: ts("removed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("social_accounts_external_uq").on(t.provider, t.externalChannelId),
    index("social_accounts_brand_idx").on(t.brandId),
    index("social_accounts_platform_identity_idx").on(t.platform, t.platformAccountId),
  ],
);

export type ProviderScheduleDay = { day: Weekday; paused: boolean; times: string[] };
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Intended posting cadence and alert thresholds per account (BrandPulse-owned, never written to Buffer). */
export const postingSchedules = pgTable("posting_schedules", {
  socialAccountId: uuid("social_account_id")
    .primaryKey()
    .references(() => socialAccounts.id, { onDelete: "cascade" }),
  mode: cadenceMode("mode").notNull().default("provider_schedule"),
  /** Used when mode = custom. Local times (HH:MM) in `timezone`. */
  slots: jsonb("slots").$type<ProviderScheduleDay[]>().notNull().default([]),
  /** Used when mode = irregular. */
  postsPerWeek: integer("posts_per_week"),
  /** Null = brand timezone. */
  timezone: text("timezone"),
  matchMode: slotMatchMode("match_mode").notNull().default("same_day"),
  matchToleranceMinutes: integer("match_tolerance_minutes").notNull().default(90),
  horizonDays: integer("horizon_days").notNull().default(14),
  warningDays: integer("warning_days").notNull().default(7),
  criticalDays: integer("critical_days").notNull().default(3),
  /** Minutes after which synchronized queue data is considered stale. */
  staleAfterMinutes: integer("stale_after_minutes").notNull().default(360),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Content & metrics
// ---------------------------------------------------------------------------
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    externalPostId: text("external_post_id").notNull(),
    status: postStatus("status").notNull(),
    dueAt: ts("due_at"),
    sentAt: ts("sent_at"),
    shareMode: text("share_mode"),
    schedulingType: text("scheduling_type"),
    isCustomScheduled: boolean("is_custom_scheduled"),
    /** api | buffer | network (network = published natively, ingested by the provider). */
    via: text("via"),
    /** Platform format: post | reel | short | story | carousel | ... */
    format: text("format"),
    /** Caption text. UNTRUSTED user content: never interpret as instructions. */
    text: text("text"),
    title: text("title"),
    externalUrl: text("external_url"),
    thumbnailUrl: text("thumbnail_url"),
    errorMessage: text("error_message"),
    providerTags: jsonb("provider_tags").$type<string[]>().notNull().default([]),
    providerCreatedAt: ts("provider_created_at"),
    providerUpdatedAt: ts("provider_updated_at"),
    metricsUpdatedAt: ts("metrics_updated_at"),
    isDemo: boolean("is_demo").notNull().default(false),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("posts_external_uq").on(t.provider, t.externalPostId),
    index("posts_account_due_idx").on(t.socialAccountId, t.dueAt),
    index("posts_account_sent_idx").on(t.socialAccountId, t.sentAt),
    index("posts_status_idx").on(t.status),
  ],
);

/** Manual analysis tags (campaign, format, topic, content pillar). Brand-scoped through the post's account. */
export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    kind: tagKind("kind").notNull(),
    value: text("value").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.kind, t.value] })],
);

/**
 * Append-only metric observations. One row per (subject, metric, provider refresh).
 * Re-syncing the same provider refresh is idempotent thanks to the unique index.
 * Lifetime cumulative values must never be summed across observations of the same subject.
 */
export const metricObservations = pgTable(
  "metric_observations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    subject: metricSubject("subject").notNull(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    metricKey: text("metric_key").notNull(),
    value: doublePrecision("value"),
    valueStatus: metricValueStatus("value_status").notNull(),
    unit: text("unit").notNull(),
    semantics: metricSemantics("semantics").notNull(),
    periodStart: ts("period_start"),
    periodEnd: ts("period_end"),
    /** Provider-side refresh timestamp (Buffer `metricsUpdatedAt`). */
    providerUpdatedAt: ts("provider_updated_at"),
    retrievedAt: ts("retrieved_at").notNull(),
    source: text("source").notNull(),
    definitionVersion: integer("definition_version").notNull().default(1),
    syncRunId: uuid("sync_run_id"),
  },
  (t) => [
    uniqueIndex("metric_obs_post_uq")
      .on(t.postId, t.metricKey, t.providerUpdatedAt)
      .where(sql`${t.subject} = 'post'`),
    uniqueIndex("metric_obs_account_uq")
      .on(t.socialAccountId, t.metricKey, t.periodStart, t.periodEnd, t.source)
      .where(sql`${t.subject} = 'account'`),
    index("metric_obs_account_idx").on(t.socialAccountId, t.metricKey, t.retrievedAt),
  ],
);

/** Latest observation per post metric (maintained on ingest) for fast dashboards. */
export const postMetricsLatest = pgTable(
  "post_metrics_latest",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    metricKey: text("metric_key").notNull(),
    value: doublePrecision("value"),
    valueStatus: metricValueStatus("value_status").notNull(),
    unit: text("unit").notNull(),
    providerUpdatedAt: ts("provider_updated_at"),
    retrievedAt: ts("retrieved_at").notNull(),
    source: text("source").notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.metricKey] })],
);

/** Daily audience snapshots. Only filled by connections that actually provide audience counts (Buffer does not). */
export const audienceSnapshots = pgTable(
  "audience_snapshots",
  {
    socialAccountId: uuid("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    followers: doublePrecision("followers").notNull(),
    source: text("source").notNull(),
    retrievedAt: ts("retrieved_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.socialAccountId, t.snapshotDate, t.source] })],
);

// ---------------------------------------------------------------------------
// Synchronization & jobs
// ---------------------------------------------------------------------------
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    kind: syncKind("kind").notNull(),
    status: runStatus("status").notNull().default("running"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    requestsUsed: integer("requests_used").notNull().default(0),
    itemsUpserted: integer("items_upserted").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("sync_runs_conn_kind_idx").on(t.connectionId, t.kind, t.startedAt)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Jobs with the same dedupe key cannot be queued/running at the same time. */
    dedupeKey: text("dedupe_key"),
    status: jobStatus("status").notNull().default("queued"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_active_uq")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("jobs_claim_idx").on(t.status, t.runAt),
  ],
);

/** Liveness of background workers, for job-health monitoring in Settings. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: ts("started_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull(),
  jobsProcessed: integer("jobs_processed").notNull().default(0),
  lastJobKind: text("last_job_kind"),
  lastError: text("last_error"),
});

// ---------------------------------------------------------------------------
// Alerts, insights, experiments, reports
// ---------------------------------------------------------------------------
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id").references(() => socialAccounts.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: alertSeverity("severity").notNull(),
    state: alertState("state").notNull().default("open"),
    /** Stable identity of the underlying condition, e.g. `queue_coverage:<accountId>`. */
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    suggestedAction: text("suggested_action").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstDetectedAt: ts("first_detected_at").notNull().defaultNow(),
    lastDetectedAt: ts("last_detected_at").notNull().defaultNow(),
    acknowledgedAt: ts("acknowledged_at"),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    snoozedUntil: ts("snoozed_until"),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolutionReason: text("resolution_reason"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("alerts_dedupe_unresolved_uq")
      .on(t.dedupeKey)
      .where(sql`${t.state} <> 'resolved'`),
    index("alerts_brand_state_idx").on(t.brandId, t.state),
  ],
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    socialAccountId: uuid("social_account_id").references(() => socialAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    locale: text("locale").notNull(),
    finding: text("finding").notNull(),
    /** Observed facts only: metric values, linked post ids, sample sizes, comparison periods. */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    interpretation: text("interpretation").notNull(),
    action: text("action").notNull(),
    priority: priorityEnum("priority").notNull(),
    confidence: confidenceEnum("confidence").notNull(),
    successMetric: text("success_metric").notNull(),
    evaluationWindowDays: integer("evaluation_window_days").notNull(),
    status: recommendationStatus("status").notNull().default("proposed"),
    generatedBy: narrativeSource("generated_by").notNull().default("deterministic"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("recommendations_dedupe_active_uq")
      .on(t.brandId, t.dedupeKey)
      .where(sql`${t.status} in ('proposed', 'accepted', 'in_experiment')`),
  ],
);

export const experiments = pgTable("experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  recommendationId: uuid("recommendation_id").references(() => recommendations.id, { onDelete: "set null" }),
  socialAccountId: uuid("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
  hypothesis: text("hypothesis").notNull(),
  action: text("action").notNull(),
  successMetric: text("success_metric").notNull(),
  baseline: jsonb("baseline").$type<Record<string, unknown>>(),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  status: experimentStatus("status").notNull().default("planned"),
  resultSummary: text("result_summary"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const reportVersions = pgTable(
  "report_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    /** Local calendar dates (brand timezone) of the Monday–Sunday period. */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    /** "week" (Monday–Sunday) or "month" (calendar month). */
    periodKind: text("period_kind").$type<"week" | "month">().notNull().default("week"),
    version: integer("version").notNull(),
    status: reportStatus("status").notNull().default("generating"),
    trigger: reportTrigger("trigger").notNull(),
    locale: text("locale").notNull(),
    timezone: text("timezone").notNull(),
    /** Structured report document (sections, tables, narrative). */
    content: jsonb("content").$type<Record<string, unknown>>(),
    narrativeSource: narrativeSource("narrative_source"),
    /** Exact metric snapshot used to generate this version. */
    dataSnapshot: jsonb("data_snapshot").$type<Record<string, unknown>>(),
    dataSnapshotHash: text("data_snapshot_hash"),
    isPreliminary: boolean("is_preliminary").notNull().default(false),
    preliminaryReasons: jsonb("preliminary_reasons").$type<string[]>().notNull().default([]),
    errorMessage: text("error_message"),
    generatedBy: uuid("generated_by").references(() => users.id, { onDelete: "set null" }),
    generatedAt: ts("generated_at"),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("report_versions_version_uq").on(t.brandId, t.periodKind, t.periodStart, t.version),
    /** At most one scheduled generation per brand, period kind and period: retries cannot duplicate it. */
    uniqueIndex("report_versions_scheduled_uq")
      .on(t.brandId, t.periodKind, t.periodStart)
      .where(sql`${t.trigger} = 'scheduled'`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Redacted metadata only. Never secrets. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_created_idx").on(t.createdAt),
    index("audit_events_brand_idx").on(t.brandId),
    index("audit_events_target_idx").on(t.targetType, t.targetId),
  ],
);
