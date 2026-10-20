ALTER TABLE "titles" ADD COLUMN "is_screenshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "hide_screenshots" boolean DEFAULT false NOT NULL;