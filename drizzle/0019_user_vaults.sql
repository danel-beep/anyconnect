CREATE TABLE "user_vaults" (
	"user_id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_wraps" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"wrapped" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "vault_wraps_user_id_kind_ref_pk" PRIMARY KEY("user_id","kind","ref")
);
--> statement-breakpoint
ALTER TABLE "user_vaults" ADD CONSTRAINT "user_vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_wraps" ADD CONSTRAINT "vault_wraps_user_id_user_vaults_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_vaults"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_wraps_kind_ref_index" ON "vault_wraps" USING btree ("kind","ref");