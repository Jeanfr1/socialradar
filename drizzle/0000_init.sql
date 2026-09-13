CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_state" AS ENUM('open', 'acknowledged', 'snoozed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."cadence_mode" AS ENUM('provider_schedule', 'custom', 'irregular', 'paused');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'active', 'invalid', 'error', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('planned', 'running', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."mapping_status" AS ENUM('unmapped', 'mapped', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'manager', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."metric_semantics" AS ENUM('lifetime_cumulative', 'period_activity', 'point_in_time');--> statement-breakpoint
CREATE TYPE "public"."metric_subject" AS ENUM('post', 'account');--> statement-breakpoint
CREATE TYPE "public"."metric_value_status" AS ENUM('reported', 'reported_zero', 'not_reported', 'pending');--> statement-breakpoint
CREATE TYPE "public"."narrative_source" AS ENUM('ai', 'deterministic');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('instagram', 'tiktok', 'youtube', 'other');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'needs_approval', 'scheduled', 'sending', 'sent', 'error', 'missing');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('buffer', 'demo');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('proposed', 'accepted', 'dismissed', 'in_experiment', 'done', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('generating', 'final', 'preliminary', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."slot_match_mode" AS ENUM('same_day', 'time_window');--> statement-breakpoint
CREATE TYPE "public"."sync_kind" AS ENUM('discovery', 'queue', 'published', 'metrics', 'validation');--> statement-breakpoint
CREATE TYPE "public"."tag_kind" AS ENUM('campaign', 'format', 'topic', 'pillar');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid,
	"social_account_id" uuid,
	"connection_id" uuid,
	"type" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"state" "alert_state" DEFAULT 'open' NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suggested_action" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"snoozed_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience_snapshots" (
	"social_account_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"followers" double precision NOT NULL,
	"source" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audience_snapshots_social_account_id_snapshot_date_source_pk" PRIMARY KEY("social_account_id","snapshot_date","source")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"brand_id" uuid,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo_url" text,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"report_locale" text DEFAULT 'pt-BR' NOT NULL,
	"business_goals" text,
	"content_pillars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report_schedule" jsonb DEFAULT '{"enabled":true,"dayOfWeek":1,"hour":8,"minute":0}'::jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"label" text NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"credential_ciphertext" text,
	"credential_key_version" integer,
	"credential_fingerprint" text,
	"external_account_id" text,
	"external_account_name" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_sync_attempt_at" timestamp with time zone,
	"last_sync_success_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"rate_limit_state" jsonb,
	"created_by" uuid,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"recommendation_id" uuid,
	"social_account_id" uuid,
	"hypothesis" text NOT NULL,
	"action" text NOT NULL,
	"success_metric" text NOT NULL,
	"baseline" jsonb,
	"start_date" date,
	"end_date" date,
	"status" "experiment_status" DEFAULT 'planned' NOT NULL,
	"result_summary" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_brand_id_pk" PRIMARY KEY("user_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "metric_observations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "metric_observations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject" "metric_subject" NOT NULL,
	"post_id" uuid,
	"social_account_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"value" double precision,
	"value_status" "metric_value_status" NOT NULL,
	"unit" text NOT NULL,
	"semantics" "metric_semantics" NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"definition_version" integer DEFAULT 1 NOT NULL,
	"sync_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "post_metrics_latest" (
	"post_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"value" double precision,
	"value_status" "metric_value_status" NOT NULL,
	"unit" text NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "post_metrics_latest_post_id_metric_key_pk" PRIMARY KEY("post_id","metric_key")
);
--> statement-breakpoint
CREATE TABLE "post_tags" (
	"post_id" uuid NOT NULL,
	"kind" "tag_kind" NOT NULL,
	"value" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_tags_post_id_kind_value_pk" PRIMARY KEY("post_id","kind","value")
);
--> statement-breakpoint
CREATE TABLE "posting_schedules" (
	"social_account_id" uuid PRIMARY KEY NOT NULL,
	"mode" "cadence_mode" DEFAULT 'provider_schedule' NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"posts_per_week" integer,
	"timezone" text,
	"match_mode" "slot_match_mode" DEFAULT 'same_day' NOT NULL,
	"match_tolerance_minutes" integer DEFAULT 90 NOT NULL,
	"horizon_days" integer DEFAULT 14 NOT NULL,
	"warning_days" integer DEFAULT 7 NOT NULL,
	"critical_days" integer DEFAULT 3 NOT NULL,
	"stale_after_minutes" integer DEFAULT 360 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"external_post_id" text NOT NULL,
	"status" "post_status" NOT NULL,
	"due_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"share_mode" text,
	"scheduling_type" text,
	"is_custom_scheduled" boolean,
	"via" text,
	"format" text,
	"text" text,
	"title" text,
	"external_url" text,
	"thumbnail_url" text,
	"error_message" text,
	"provider_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"metrics_updated_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"limits" jsonb,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"social_account_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"locale" text NOT NULL,
	"finding" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"interpretation" text NOT NULL,
	"action" text NOT NULL,
	"priority" "priority" NOT NULL,
	"confidence" "confidence" NOT NULL,
	"success_metric" text NOT NULL,
	"evaluation_window_days" integer NOT NULL,
	"status" "recommendation_status" DEFAULT 'proposed' NOT NULL,
	"generated_by" "narrative_source" DEFAULT 'deterministic' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"version" integer NOT NULL,
	"status" "report_status" DEFAULT 'generating' NOT NULL,
	"trigger" "report_trigger" NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL,
	"content" jsonb,
	"narrative_source" "narrative_source",
	"data_snapshot" jsonb,
	"data_snapshot_hash" text,
	"is_preliminary" boolean DEFAULT false NOT NULL,
	"preliminary_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"generated_by" uuid,
	"generated_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_organization_id" uuid,
	"provider" "provider" NOT NULL,
	"external_channel_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_account_id" text NOT NULL,
	"channel_type" text,
	"handle" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"external_url" text,
	"provider_timezone" text,
	"is_queue_paused" boolean DEFAULT false NOT NULL,
	"is_disconnected" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"can_view_insights" boolean DEFAULT false NOT NULL,
	"provider_posting_schedule" jsonb,
	"brand_id" uuid,
	"mapping_status" "mapping_status" DEFAULT 'unmapped' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" "sync_kind" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"requests_used" integer DEFAULT 0 NOT NULL,
	"items_upserted" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_workspace_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_snapshots" ADD CONSTRAINT "audience_snapshots_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics_latest" ADD CONSTRAINT "post_metrics_latest_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_schedules" ADD CONSTRAINT "posting_schedules_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_schedules" ADD CONSTRAINT "posting_schedules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_organizations" ADD CONSTRAINT "provider_organizations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_provider_organization_id_provider_organizations_id_fk" FOREIGN KEY ("provider_organization_id") REFERENCES "public"."provider_organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_unresolved_uq" ON "alerts" USING btree ("dedupe_key") WHERE "alerts"."state" <> 'resolved';--> statement-breakpoint
CREATE INDEX "alerts_brand_state_idx" ON "alerts" USING btree ("brand_id","state");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_brand_idx" ON "audit_events" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_fingerprint_uq" ON "connections" USING btree ("provider","credential_fingerprint") WHERE "connections"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "memberships_brand_idx" ON "memberships" USING btree ("brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_obs_post_uq" ON "metric_observations" USING btree ("post_id","metric_key","provider_updated_at") WHERE "metric_observations"."subject" = 'post';--> statement-breakpoint
CREATE UNIQUE INDEX "metric_obs_account_uq" ON "metric_observations" USING btree ("social_account_id","metric_key","period_start","period_end","source") WHERE "metric_observations"."subject" = 'account';--> statement-breakpoint
CREATE INDEX "metric_obs_account_idx" ON "metric_observations" USING btree ("social_account_id","metric_key","retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_external_uq" ON "posts" USING btree ("provider","external_post_id");--> statement-breakpoint
CREATE INDEX "posts_account_due_idx" ON "posts" USING btree ("social_account_id","due_at");--> statement-breakpoint
CREATE INDEX "posts_account_sent_idx" ON "posts" USING btree ("social_account_id","sent_at");--> statement-breakpoint
CREATE INDEX "posts_status_idx" ON "posts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_orgs_uq" ON "provider_organizations" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_dedupe_active_uq" ON "recommendations" USING btree ("brand_id","dedupe_key") WHERE "recommendations"."status" in ('proposed', 'accepted', 'in_experiment');--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_version_uq" ON "report_versions" USING btree ("brand_id","period_start","version");--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_scheduled_uq" ON "report_versions" USING btree ("brand_id","period_start") WHERE "report_versions"."trigger" = 'scheduled';--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_external_uq" ON "social_accounts" USING btree ("provider","external_channel_id");--> statement-breakpoint
CREATE INDEX "social_accounts_brand_idx" ON "social_accounts" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "social_accounts_platform_identity_idx" ON "social_accounts" USING btree ("platform","platform_account_id");--> statement-breakpoint
CREATE INDEX "sync_runs_conn_kind_idx" ON "sync_runs" USING btree ("connection_id","kind","started_at");