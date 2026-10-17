ALTER TABLE "media_files" ADD COLUMN "detected_skip_marks" jsonb;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "skip_detected_at" timestamp with time zone;