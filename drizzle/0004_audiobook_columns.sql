ALTER TABLE "libraries" ADD COLUMN "audible_region" text DEFAULT 'us' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "probe_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "chapters" jsonb;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "playback_rate" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "authors" jsonb;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "narrators" jsonb;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "folder_author" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "series_name" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "series_position" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "asin" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "chapters" jsonb;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "chapters_source" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "metadata_attempted_at" timestamp with time zone;