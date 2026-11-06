CREATE TABLE "ai_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"model" text NOT NULL,
	"key_encrypted" text NOT NULL,
	"key_hint" text NOT NULL,
	"daily_runs" integer,
	"last_used_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_cursors" (
	"trigger_id" text NOT NULL,
	"account_id" text NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_cursors_trigger_id_account_id_pk" PRIMARY KEY("trigger_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trigger_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"event_key" text NOT NULL,
	"counterpart_key" text NOT NULL,
	"status" text NOT NULL,
	"body_encrypted" text NOT NULL,
	"ai_key_id" text,
	"tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "trigger_events_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"connector_id" text,
	"account_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"action_kind" text NOT NULL,
	"ai_key_id" text,
	"spec_encrypted" text NOT NULL,
	"daily_runs" integer,
	"paused_reason" text,
	"paused_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_cursors" ADD CONSTRAINT "trigger_cursors_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_cursors" ADD CONSTRAINT "trigger_cursors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_ai_key_id_ai_keys_id_fk" FOREIGN KEY ("ai_key_id") REFERENCES "public"."ai_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_keys_workspace_id_index" ON "ai_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_events_trigger_id_event_key_index" ON "trigger_events" USING btree ("trigger_id","event_key");--> statement-breakpoint
CREATE INDEX "trigger_events_workspace_id_seq_index" ON "trigger_events" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "trigger_events_trigger_id_created_at_index" ON "trigger_events" USING btree ("trigger_id","created_at");--> statement-breakpoint
CREATE INDEX "trigger_events_trigger_id_counterpart_key_created_at_index" ON "trigger_events" USING btree ("trigger_id","counterpart_key","created_at");--> statement-breakpoint
CREATE INDEX "trigger_events_ai_key_id_created_at_index" ON "trigger_events" USING btree ("ai_key_id","created_at");--> statement-breakpoint
CREATE INDEX "trigger_events_created_at_index" ON "trigger_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "triggers_workspace_id_index" ON "triggers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "triggers_source_enabled_index" ON "triggers" USING btree ("source","enabled");