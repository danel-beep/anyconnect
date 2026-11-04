CREATE TABLE "billing_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"workspace_id" text,
	"external_id" text,
	"plan_id" text,
	"status" text,
	"outcome" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "interval" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_workspace_id_index" ON "billing_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "billing_events_created_at_index" ON "billing_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_provider_external_id_index" ON "subscriptions" USING btree ("provider","external_id");