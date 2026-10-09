DROP INDEX "media_files_owner_part_idx";--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "version_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_owner_part_idx" ON "media_files" USING btree ("owner_kind","owner_id","version_label","part_index");