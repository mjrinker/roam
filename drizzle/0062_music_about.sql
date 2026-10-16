CREATE TABLE "album_about" (
	"album_id" uuid PRIMARY KEY NOT NULL,
	"found" boolean DEFAULT false NOT NULL,
	"summary" text,
	"source_title" text,
	"source_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "album_about" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "artist_about" (
	"artist_id" uuid PRIMARY KEY NOT NULL,
	"found" boolean DEFAULT false NOT NULL,
	"summary" text,
	"source_title" text,
	"source_url" text,
	"similar" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_about" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "album_about" ADD CONSTRAINT "album_about_album_id_music_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."music_albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_about" ADD CONSTRAINT "artist_about_artist_id_music_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."music_artists"("id") ON DELETE cascade ON UPDATE no action;