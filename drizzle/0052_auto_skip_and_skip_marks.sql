ALTER TABLE "media_files" ADD COLUMN "skip_marks" jsonb;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "auto_skip" jsonb DEFAULT '{}'::jsonb NOT NULL;