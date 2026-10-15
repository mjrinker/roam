CREATE TABLE "track_lyrics" (
	"title_id" uuid PRIMARY KEY NOT NULL,
	"synced" text,
	"plain" text,
	"instrumental" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track_lyrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "track_lyrics" ADD CONSTRAINT "track_lyrics_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;