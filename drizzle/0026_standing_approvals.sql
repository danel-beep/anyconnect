CREATE TABLE "standing_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"holder" text NOT NULL,
	"connector_id" text NOT NULL,
	"account_id" text NOT NULL,
	"actions" text[] NOT NULL,
	"scope" text NOT NULL,
	"granted_by" text NOT NULL,
	"purpose_encrypted" text,
	"max_uses" integer NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standing_approvals_account_id_scope_index" ON "standing_approvals" USING btree ("account_id","scope");--> statement-breakpoint
CREATE INDEX "standing_approvals_workspace_id_expires_at_index" ON "standing_approvals" USING btree ("workspace_id","expires_at");