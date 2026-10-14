ALTER TABLE "media_files" ADD COLUMN "marked_cues" jsonb;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "language_cues" jsonb;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "language_source" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "language_built_at" timestamp with time zone;