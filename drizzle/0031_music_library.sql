ALTER TYPE "public"."library_kind" ADD VALUE 'music';--> statement-breakpoint
CREATE TABLE "music_albums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"year" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "music_albums" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "music_artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"sort_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "music_artists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "album_id" uuid;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "track_number" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "disc_number" integer;--> statement-breakpoint
ALTER TABLE "music_albums" ADD CONSTRAINT "music_albums_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_albums" ADD CONSTRAINT "music_albums_artist_id_music_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."music_artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_artists" ADD CONSTRAINT "music_artists_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "music_albums_artist_name_idx" ON "music_albums" USING btree ("artist_id","name_key");--> statement-breakpoint
CREATE INDEX "music_albums_library_idx" ON "music_albums" USING btree ("library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "music_artists_library_name_idx" ON "music_artists" USING btree ("library_id","name_key");--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_album_id_music_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."music_albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "titles_album_idx" ON "titles" USING btree ("album_id","disc_number","track_number");