ALTER TABLE "titles" ADD COLUMN "certifications" jsonb;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "rating_ages" jsonb;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "ratings_attempted_at" timestamp with time zone;