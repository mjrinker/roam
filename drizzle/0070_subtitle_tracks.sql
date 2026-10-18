CREATE TABLE "subtitle_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" "owner_kind" NOT NULL,
	"owner_id" uuid NOT NULL,
	"language" text,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"storage_file_id" text,
	"size_bytes" integer,
	"cues" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "subtitle_tracks_owner_idx" ON "subtitle_tracks" USING btree ("owner_kind","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subtitle_tracks_file_idx" ON "subtitle_tracks" USING btree ("owner_kind","owner_id","storage_file_id");