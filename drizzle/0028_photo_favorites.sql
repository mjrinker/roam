CREATE TABLE "photo_favorites" (
	"viewer_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_favorites_viewer_id_title_id_pk" PRIMARY KEY("viewer_id","title_id")
);
--> statement-breakpoint
ALTER TABLE "photo_favorites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "photo_favorites" ADD CONSTRAINT "photo_favorites_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_favorites" ADD CONSTRAINT "photo_favorites_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_favorites_title_idx" ON "photo_favorites" USING btree ("title_id");