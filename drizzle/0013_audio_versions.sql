ALTER TABLE "media_files" ALTER COLUMN "owner_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "codec_probed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "codec_probe_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "variant_of_media_file_id" uuid;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "remux_status" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "remux_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "remux_tier" integer;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "remux_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "remux_callback_token" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_variant_of_media_file_id_media_files_id_fk" FOREIGN KEY ("variant_of_media_file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_variant_of_idx" ON "media_files" USING btree ("variant_of_media_file_id");