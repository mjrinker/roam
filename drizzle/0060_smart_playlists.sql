ALTER TABLE "playlists" ADD COLUMN "smart_rules" jsonb;--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "smart_refreshed_at" timestamp with time zone;