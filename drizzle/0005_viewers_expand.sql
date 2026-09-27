CREATE TABLE "viewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"avatar_key" text DEFAULT 'teal-user' NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"max_age" integer,
	"allow_unrated" boolean DEFAULT false NOT NULL,
	"pin_hash" text,
	"pin_version" integer DEFAULT 0 NOT NULL,
	"playback_rate" real DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_state" ADD COLUMN "viewer_id" uuid;--> statement-breakpoint
ALTER TABLE "viewers" ADD CONSTRAINT "viewers_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viewers_account_idx" ON "viewers" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "watch_state" ADD CONSTRAINT "watch_state_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_state_viewer_owner_idx" ON "watch_state" USING btree ("viewer_id","owner_kind","owner_id");
--> statement-breakpoint
-- Data backfill (hand-written; drizzle-kit only generates DDL). Every existing
-- account gets one default viewer that REUSES the account's id, so this is safe
-- to re-run and later lookups can rely on viewer.id = account.id for defaults.
INSERT INTO "viewers" ("id", "account_id", "name", "avatar_key", "playback_rate", "sort_order")
SELECT p."id", p."id",
       left(COALESCE(NULLIF(btrim(p."display_name"), ''), NULLIF(split_part(p."email", '@', 1), ''), 'Me'), 40),
       'teal-user',
       p."playback_rate",
       0
FROM "profiles" p
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Existing watch history belongs to that default viewer.
UPDATE "watch_state" SET "viewer_id" = "profile_id" WHERE "viewer_id" IS NULL;
