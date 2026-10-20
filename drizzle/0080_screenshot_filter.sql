ALTER TABLE "titles" ADD COLUMN "screenshot_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "screenshot_filter" text DEFAULT 'show' NOT NULL;