UPDATE "viewers" SET "screenshot_filter" = 'hide' WHERE "hide_screenshots";--> statement-breakpoint
ALTER TABLE "viewers" DROP COLUMN "hide_screenshots";
