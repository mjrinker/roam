CREATE TABLE "availability_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"season_id" uuid,
	"viewer_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"server_id" uuid,
	"kind" text NOT NULL,
	"title_id" uuid,
	"message" text NOT NULL,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ownership_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"season_id" uuid,
	"account_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ownership_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"data_base64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"season_id" uuid,
	"account_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"season_id" uuid,
	"account_id" uuid NOT NULL,
	"shared" boolean DEFAULT true NOT NULL,
	"via" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ownership_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "claim_mode" text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "limit_concurrent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "limit_kinds" jsonb DEFAULT '["movies","shows"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "availability_watches" ADD CONSTRAINT "availability_watches_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_watches" ADD CONSTRAINT "availability_watches_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_watches" ADD CONSTRAINT "availability_watches_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_watches" ADD CONSTRAINT "availability_watches_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_claims" ADD CONSTRAINT "ownership_claims_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_claims" ADD CONSTRAINT "ownership_claims_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_claims" ADD CONSTRAINT "ownership_claims_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_evidence" ADD CONSTRAINT "ownership_evidence_claim_id_ownership_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."ownership_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_owners" ADD CONSTRAINT "title_owners_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_owners" ADD CONSTRAINT "title_owners_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_owners" ADD CONSTRAINT "title_owners_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "availability_watches_unit_viewer_idx" ON "availability_watches" USING btree (coalesce("season_id", "title_id"),"viewer_id");--> statement-breakpoint
CREATE INDEX "notifications_account_idx" ON "notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_claims_open_idx" ON "ownership_claims" USING btree (coalesce("season_id", "title_id"),"account_id") WHERE "ownership_claims"."status" in ('pending','evidence_requested','evidence_submitted');--> statement-breakpoint
CREATE INDEX "ownership_claims_title_idx" ON "ownership_claims" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "playback_sessions_title_idx" ON "playback_sessions" USING btree ("title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playback_sessions_viewer_idx" ON "playback_sessions" USING btree ("viewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "title_owners_whole_idx" ON "title_owners" USING btree ("title_id","account_id") WHERE "title_owners"."season_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "title_owners_season_idx" ON "title_owners" USING btree ("season_id","account_id") WHERE "title_owners"."season_id" is not null;--> statement-breakpoint
CREATE INDEX "title_owners_account_idx" ON "title_owners" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "title_owners_title_idx" ON "title_owners" USING btree ("title_id");
--> statement-breakpoint
ALTER TABLE "title_owners" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ownership_claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ownership_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "playback_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "availability_watches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;
