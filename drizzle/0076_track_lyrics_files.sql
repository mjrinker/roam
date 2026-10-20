ALTER TABLE "track_lyrics" ADD COLUMN "source" text DEFAULT 'lrclib' NOT NULL;--> statement-breakpoint
ALTER TABLE "track_lyrics" ADD COLUMN "file_id" text;--> statement-breakpoint
ALTER TABLE "track_lyrics" ADD COLUMN "file_modified_at" timestamp with time zone;