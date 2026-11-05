CREATE TABLE "vault_device_requests" (
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_device_requests_user_id_device_id_pk" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "vault_device_requests" ADD CONSTRAINT "vault_device_requests_user_id_user_vaults_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_vaults"("user_id") ON DELETE cascade ON UPDATE no action;