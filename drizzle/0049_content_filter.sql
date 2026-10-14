ALTER TABLE "media_files" ADD COLUMN "content_cues" jsonb;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "content_filter" jsonb DEFAULT '{}'::jsonb NOT NULL;