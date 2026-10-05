ALTER TABLE "titles" ADD COLUMN "taken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "taken_at_source" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "meta_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "meta_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "titles_library_taken_idx" ON "titles" USING btree ("library_id","taken_at" DESC NULLS LAST,"id" DESC NULLS LAST);