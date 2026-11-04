CREATE TABLE "data_keys" (
	"purpose" text PRIMARY KEY NOT NULL,
	"key_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_accounts" (
	"account_id" text PRIMARY KEY NOT NULL,
	"lease_owner" text,
	"lease_owner_url" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'needs_login' NOT NULL,
	"problem" text,
	"problem_message" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_online_at" timestamp with time zone,
	"send_paused_until" timestamp with time zone,
	"send_pause_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"external_key" text NOT NULL,
	"info_encrypted" text NOT NULL,
	"kind" text NOT NULL,
	"title_index" integer[] DEFAULT '{}'::int[] NOT NULL,
	"unread" integer DEFAULT 0 NOT NULL,
	"has_inbound" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_messages" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messenger_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text NOT NULL,
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"external_key" text NOT NULL,
	"direction" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted" boolean DEFAULT false NOT NULL,
	"body_encrypted" text NOT NULL,
	"search_index" integer[] DEFAULT '{}'::int[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_messages_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "messenger_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_encrypted" text NOT NULL,
	"content_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"new_contact" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messenger_state" (
	"account_id" text NOT NULL,
	"key" text NOT NULL,
	"value_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_state_account_id_key_pk" PRIMARY KEY("account_id","key")
);
--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD CONSTRAINT "messenger_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_chats" ADD CONSTRAINT "messenger_chats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_chat_id_messenger_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."messenger_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_outbox" ADD CONSTRAINT "messenger_outbox_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_outbox" ADD CONSTRAINT "messenger_outbox_chat_id_messenger_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."messenger_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_state" ADD CONSTRAINT "messenger_state_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messenger_accounts_lease_expires_at_index" ON "messenger_accounts" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_chats_account_id_external_key_index" ON "messenger_chats" USING btree ("account_id","external_key");--> statement-breakpoint
CREATE INDEX "messenger_chats_account_id_last_message_at_index" ON "messenger_chats" USING btree ("account_id","last_message_at");--> statement-breakpoint
CREATE INDEX "messenger_chats_title_index_index" ON "messenger_chats" USING gin ("title_index");--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_messages_chat_id_external_key_index" ON "messenger_messages" USING btree ("chat_id","external_key");--> statement-breakpoint
CREATE INDEX "messenger_messages_account_id_sent_at_index" ON "messenger_messages" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "messenger_messages_chat_id_sent_at_index" ON "messenger_messages" USING btree ("chat_id","sent_at");--> statement-breakpoint
CREATE INDEX "messenger_messages_account_id_seq_index" ON "messenger_messages" USING btree ("account_id","seq");--> statement-breakpoint
CREATE INDEX "messenger_messages_search_index_index" ON "messenger_messages" USING gin ("search_index");--> statement-breakpoint
CREATE INDEX "messenger_outbox_status_not_before_index" ON "messenger_outbox" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "messenger_outbox_account_id_sent_at_index" ON "messenger_outbox" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "messenger_outbox_account_id_content_key_created_at_index" ON "messenger_outbox" USING btree ("account_id","content_key","created_at");