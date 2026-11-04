CREATE TABLE "usage_counters" (
	"workspace_id" text NOT NULL,
	"day" date NOT NULL,
	"caller" text NOT NULL,
	"connector_id" text NOT NULL,
	"action" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_workspace_id_day_caller_connector_id_action_pk" PRIMARY KEY("workspace_id","day","caller","connector_id","action")
);
--> statement-breakpoint
ALTER TABLE "pending_calls" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "ai_subject" text;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_counters_caller_day_index" ON "usage_counters" USING btree ("caller","day");