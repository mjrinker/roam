CREATE TABLE "artwork_images" (
	"hash" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artwork_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_artwork" ADD COLUMN "image_hash" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "sort_key" text;--> statement-breakpoint
ALTER TABLE "title_artwork" ADD CONSTRAINT "title_artwork_image_hash_artwork_images_hash_fk" FOREIGN KEY ("image_hash") REFERENCES "public"."artwork_images"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "title_artwork_image_idx" ON "title_artwork" USING btree ("image_hash");--> statement-breakpoint
-- Move every existing picture into the shared table (identical pictures collapse to one row) and point
-- the title rows at it. sha256() is built into Postgres 11+.
INSERT INTO "artwork_images" ("hash", "content_type", "bytes") SELECT encode(sha256("bytes"), 'hex'), "content_type", "bytes" FROM "title_artwork" ON CONFLICT ("hash") DO NOTHING;--> statement-breakpoint
UPDATE "title_artwork" SET "image_hash" = encode(sha256("bytes"), 'hex');
