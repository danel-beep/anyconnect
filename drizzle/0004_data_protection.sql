CREATE TABLE "access_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"ai_client_id" text,
	"persona_id" text,
	"connector_id" text,
	"account_id" text,
	"access" text,
	"confirm" text,
	"undo_window_seconds" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"match_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"address" text,
	"label" text,
	"link_code_hash" text,
	"link_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"principal" jsonb NOT NULL,
	"tool_name" text NOT NULL,
	"connector_id" text NOT NULL,
	"action" text NOT NULL,
	"account_id" text NOT NULL,
	"risk" text NOT NULL,
	"reason" text,
	"args_encrypted" text NOT NULL,
	"args_hash" text NOT NULL,
	"status" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"decided_via" text,
	"decided_at" timestamp with time zone,
	"undo_window_seconds" integer DEFAULT 0 NOT NULL,
	"execute_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"result_encrypted" text,
	"consumed_at" timestamp with time zone,
	"telegram_message" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_logins" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amr" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"account_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_access" text DEFAULT 'full' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret_encrypted" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"challenge_hash" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text,
	"binding_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credentialId_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "data_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "ai_client_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "ai_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "ai_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "persona_id" text;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "amr" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_ai_client_id_ai_clients_id_fk" FOREIGN KEY ("ai_client_id") REFERENCES "public"."ai_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rules" ADD CONSTRAINT "access_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_clients" ADD CONSTRAINT "ai_clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_calls" ADD CONSTRAINT "pending_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_calls" ADD CONSTRAINT "pending_calls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_logins" ADD CONSTRAINT "pending_logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_rules_workspace_id_index" ON "access_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_clients_workspace_id_match_key_index" ON "ai_clients" USING btree ("workspace_id","match_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_user_id_kind_index" ON "notification_channels" USING btree ("user_id","kind");--> statement-breakpoint
CREATE INDEX "notification_channels_link_code_hash_index" ON "notification_channels" USING btree ("link_code_hash");--> statement-breakpoint
CREATE INDEX "pending_calls_status_execute_at_index" ON "pending_calls" USING btree ("status","execute_at");--> statement-breakpoint
CREATE INDEX "pending_calls_workspace_id_created_at_index" ON "pending_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "pending_calls_workspace_id_args_hash_index" ON "pending_calls" USING btree ("workspace_id","args_hash");--> statement-breakpoint
CREATE INDEX "pending_logins_expires_at_index" ON "pending_logins" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_workspace_id_slug_index" ON "personas" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_id_index" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_at_index" ON "webauthn_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_id_index" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_ai_client_id_ai_clients_id_fk" FOREIGN KEY ("ai_client_id") REFERENCES "public"."ai_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_ai_client_id_ai_clients_id_fk" FOREIGN KEY ("ai_client_id") REFERENCES "public"."ai_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE cascade ON UPDATE no action;