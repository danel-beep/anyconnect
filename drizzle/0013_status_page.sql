CREATE TABLE "status_components" (
	"component" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sample_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_days" (
	"component" text NOT NULL,
	"day" date NOT NULL,
	"ok_minutes" integer DEFAULT 0 NOT NULL,
	"degraded_minutes" integer DEFAULT 0 NOT NULL,
	"down_minutes" integer DEFAULT 0 NOT NULL,
	"missing_minutes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "status_days_component_day_pk" PRIMARY KEY("component","day")
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "status_incidents_started_at_index" ON "status_incidents" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "status_incidents_component_ended_at_index" ON "status_incidents" USING btree ("component","ended_at");--> statement-breakpoint
CREATE INDEX "tool_calls_created_at_index" ON "tool_calls" USING btree ("created_at");