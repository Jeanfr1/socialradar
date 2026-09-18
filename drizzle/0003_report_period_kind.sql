DROP INDEX "report_versions_version_uq";--> statement-breakpoint
DROP INDEX "report_versions_scheduled_uq";--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "period_kind" text DEFAULT 'week' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_version_uq" ON "report_versions" USING btree ("brand_id","period_kind","period_start","version");--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_scheduled_uq" ON "report_versions" USING btree ("brand_id","period_kind","period_start") WHERE "report_versions"."trigger" = 'scheduled';