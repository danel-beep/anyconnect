CREATE TABLE "billing_usage" (
	"payer_id" text NOT NULL,
	"day" date NOT NULL,
	"workspace_id" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_payer_id_day_workspace_id_pk" PRIMARY KEY("payer_id","day","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_mode" text DEFAULT 'payer' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_usage" ADD CONSTRAINT "billing_usage_payer_id_workspaces_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_billing_user_id_users_id_fk" FOREIGN KEY ("billing_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- What each person's plan has used this month and last: a personal workspace pays for itself, and
-- every existing team for now through its owner.
INSERT INTO "billing_usage" ("payer_id", "day", "workspace_id", "calls")
SELECT COALESCE(p."id", u."workspace_id"), u."day", u."workspace_id", SUM(u."calls")::integer
FROM "usage_counters" AS u
JOIN "workspaces" AS w ON w."id" = u."workspace_id"
LEFT JOIN LATERAL (
  SELECT pw."id"
  FROM "workspace_members" AS o
  JOIN "workspace_members" AS pm ON pm."user_id" = o."user_id" AND pm."role" = 'owner'
  JOIN "workspaces" AS pw ON pw."id" = pm."workspace_id" AND pw."kind" = 'personal'
  WHERE w."kind" = 'team' AND o."workspace_id" = w."id" AND o."role" = 'owner'
  ORDER BY pm."created_at"
  LIMIT 1
) AS p ON true
WHERE u."day" >= (date_trunc('month', now()) - interval '1 month')::date
GROUP BY 1, 2, 3;
