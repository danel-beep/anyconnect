CREATE TABLE "referrals" (
	"referred_user_id" text PRIMARY KEY NOT NULL,
	"referrer_user_id" text NOT NULL,
	"status" text DEFAULT 'signed_up' NOT NULL,
	"reward" text,
	"rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sent_notices" (
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sent_notices_workspace_id_kind_key_pk" PRIMARY KEY("workspace_id","kind","key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_notices" ADD CONSTRAINT "sent_notices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referrals_referrer_user_id_index" ON "referrals" USING btree ("referrer_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referralCode_unique" UNIQUE("referral_code");