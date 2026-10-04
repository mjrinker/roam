ALTER TABLE "titles" ADD COLUMN "tag_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "thumb_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "thumb_attempted_at" timestamp with time zone;