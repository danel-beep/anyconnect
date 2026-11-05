CREATE TABLE "analytics_events" (
	"day" date NOT NULL,
	"name" text NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_events_day_name_key_pk" PRIMARY KEY("day","name","key")
);
--> statement-breakpoint
CREATE TABLE "analytics_pages" (
	"day" date NOT NULL,
	"path" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_pages_day_path_pk" PRIMARY KEY("day","path")
);
--> statement-breakpoint
CREATE TABLE "analytics_salts" (
	"day" date PRIMARY KEY NOT NULL,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_visits" (
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	"source" text NOT NULL,
	"medium" text NOT NULL,
	"campaign" text,
	"term" text,
	"content" text,
	"referrer_host" text,
	"landing_path" text NOT NULL,
	"country" text,
	"language" text,
	"device" text NOT NULL,
	"browser" text NOT NULL,
	"os" text NOT NULL,
	"known" boolean DEFAULT false NOT NULL,
	"pageviews" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_visits_day_visitor_pk" PRIMARY KEY("day","visitor")
);
--> statement-breakpoint
CREATE TABLE "user_attribution" (
	"user_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"medium" text NOT NULL,
	"campaign" text,
	"term" text,
	"content" text,
	"referrer_host" text,
	"landing_path" text,
	"country" text,
	"language" text,
	"device" text,
	"browser" text,
	"os" text,
	"matched" boolean NOT NULL,
	"first_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_attribution" ADD CONSTRAINT "user_attribution_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_visits_source_day_index" ON "analytics_visits" USING btree ("source","day");--> statement-breakpoint
CREATE INDEX "user_attribution_created_at_index" ON "user_attribution" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_attribution_source_index" ON "user_attribution" USING btree ("source");