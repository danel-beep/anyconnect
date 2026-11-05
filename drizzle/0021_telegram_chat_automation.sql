CREATE TABLE "telegram_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"telegram_user_key" text NOT NULL,
	"connection_key" text NOT NULL,
	"info_encrypted" text NOT NULL,
	"rights" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"account_id" text,
	"locale" text,
	"connected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_connections_telegramUserKey_unique" UNIQUE("telegram_user_key"),
	CONSTRAINT "telegram_connections_connectionKey_unique" UNIQUE("connection_key"),
	CONSTRAINT "telegram_connections_accountId_unique" UNIQUE("account_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"code_encrypted" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reconnect_account_id" text,
	"return_to" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"telegram_user_key" text,
	"telegram_encrypted" text,
	"confirm_code_hash" text,
	"confirm_attempts" integer DEFAULT 0 NOT NULL,
	"account_id" text,
	"error" text,
	"locale" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_reconnect_account_id_accounts_id_fk" FOREIGN KEY ("reconnect_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_links_telegram_user_key_index" ON "telegram_links" USING btree ("telegram_user_key");--> statement-breakpoint
CREATE INDEX "telegram_links_user_id_index" ON "telegram_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "telegram_links_expires_at_index" ON "telegram_links" USING btree ("expires_at");