CREATE TABLE "error_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"last_ref" text,
	"last_request_id" text,
	"release" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "error_groups_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text,
	"last_duration_ms" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"runs" bigint DEFAULT 0 NOT NULL,
	"failures" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "error_groups_last_seen_at_index" ON "error_groups" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "error_groups_resolved_at_index" ON "error_groups" USING btree ("resolved_at");