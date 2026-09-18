ALTER TABLE "posting_schedules" ALTER COLUMN "stale_after_minutes" SET DEFAULT 1560;--> statement-breakpoint
UPDATE "posting_schedules" SET "stale_after_minutes" = 1560 WHERE "stale_after_minutes" = 360;
