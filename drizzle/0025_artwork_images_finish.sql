ALTER TABLE "title_artwork" ALTER COLUMN "image_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "title_artwork" DROP COLUMN "content_type";--> statement-breakpoint
ALTER TABLE "title_artwork" DROP COLUMN "bytes";