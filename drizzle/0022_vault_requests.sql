CREATE TABLE "vault_requests" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_requests_user_id_kind_subject_pk" PRIMARY KEY("user_id","kind","subject")
);
--> statement-breakpoint
ALTER TABLE "vault_requests" ADD CONSTRAINT "vault_requests_user_id_user_vaults_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_vaults"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Browsers that were already waiting keep their request (one key: the device's own).
INSERT INTO "vault_requests" ("user_id", "kind", "subject", "keys", "created_at")
SELECT "user_id", 'device', "device_id", jsonb_build_array(jsonb_build_object('ref', "device_id", 'publicKey', "public_key")), "created_at"
FROM "vault_device_requests"
ON CONFLICT DO NOTHING;
