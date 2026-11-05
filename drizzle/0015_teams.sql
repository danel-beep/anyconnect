CREATE TABLE "account_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"user_id" text,
	"access" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_invitations_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "kind" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_shares" ADD CONSTRAINT "account_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_shares_workspace_id_index" ON "account_shares" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_shares_account_id_user_id_index" ON "account_shares" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_shares_team_unique" ON "account_shares" USING btree ("account_id") WHERE "account_shares"."user_id" is null;--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_id_index" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_invitations_email_index" ON "workspace_invitations" USING btree ("email");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_owner_user_id_index" ON "accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_id_handle_index" ON "workspace_members" USING btree ("workspace_id","handle");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_unique" UNIQUE("slug");--> statement-breakpoint
-- Every existing account belongs to the owner of its (personal) workspace.
UPDATE "accounts" AS a SET "owner_user_id" = m."user_id" FROM "workspace_members" AS m WHERE m."workspace_id" = a."workspace_id" AND m."role" = 'owner' AND a."owner_user_id" IS NULL;
