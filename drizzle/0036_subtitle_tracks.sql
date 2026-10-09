CREATE TABLE "subtitle_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid,
	"episode_id" uuid,
	"language" text NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"hearing_impaired" boolean DEFAULT false NOT NULL,
	"cues" jsonb NOT NULL,
	"cue_count" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subtitle_tracks_one_owner" CHECK (("subtitle_tracks"."title_id" IS NULL) <> ("subtitle_tracks"."episode_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_created_by_profiles_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subtitle_tracks_title_idx" ON "subtitle_tracks" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "subtitle_tracks_episode_idx" ON "subtitle_tracks" USING btree ("episode_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subtitle_tracks_title_external_idx" ON "subtitle_tracks" USING btree ("title_id","source","external_id") WHERE "subtitle_tracks"."external_id" IS NOT NULL AND "subtitle_tracks"."title_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subtitle_tracks_episode_external_idx" ON "subtitle_tracks" USING btree ("episode_id","source","external_id") WHERE "subtitle_tracks"."external_id" IS NOT NULL AND "subtitle_tracks"."episode_id" IS NOT NULL;