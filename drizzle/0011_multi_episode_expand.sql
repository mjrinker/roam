ALTER TABLE "media_files" ADD COLUMN "trim_start_seconds" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "trim_duration_seconds" double precision;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "trim_source" text;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_owner_file_idx" ON "media_files" USING btree ("owner_kind","owner_id","box_file_id");