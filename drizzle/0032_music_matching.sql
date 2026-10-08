ALTER TABLE "libraries" ADD COLUMN "music_lookup" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "music_albums" ADD COLUMN "mbid" text;--> statement-breakpoint
ALTER TABLE "music_albums" ADD COLUMN "match_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "music_albums" ADD COLUMN "match_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "music_albums" ADD COLUMN "match_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "music_albums" ADD COLUMN "matched_track_count" integer;--> statement-breakpoint
ALTER TABLE "music_artists" ADD COLUMN "mbid" text;