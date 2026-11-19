CREATE TABLE "hub_files" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"content_key" text NOT NULL,
	"name_encrypted" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"data_key_encrypted" text NOT NULL,
	"data" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_files" ADD CONSTRAINT "hub_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_files_workspace_id_content_key_index" ON "hub_files" USING btree ("workspace_id","content_key");--> statement-breakpoint
CREATE INDEX "hub_files_expires_at_index" ON "hub_files" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "hub_files_workspace_id_expires_at_index" ON "hub_files" USING btree ("workspace_id","expires_at");