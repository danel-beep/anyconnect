CREATE TABLE "account_oauth" (
	"account_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"app_ref" text NOT NULL,
	"tokens_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"refreshed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_connect_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"account_id" text,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"app_ref" text NOT NULL,
	"code_verifier_encrypted" text,
	"redirect_uri" text NOT NULL,
	"return_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_oauth" ADD CONSTRAINT "account_oauth_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connect_states" ADD CONSTRAINT "oauth_connect_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connect_states" ADD CONSTRAINT "oauth_connect_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connect_states" ADD CONSTRAINT "oauth_connect_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_oauth_expires_at_index" ON "account_oauth" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_apps_workspace_id_provider_id_index" ON "oauth_apps" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE INDEX "oauth_connect_states_expires_at_index" ON "oauth_connect_states" USING btree ("expires_at");