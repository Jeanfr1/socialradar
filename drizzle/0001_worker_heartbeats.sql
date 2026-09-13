CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"jobs_processed" integer DEFAULT 0 NOT NULL,
	"last_job_kind" text,
	"last_error" text
);
