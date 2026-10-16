CREATE TABLE "watchlist_items" (
	"viewer_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_viewer_id_title_id_pk" PRIMARY KEY("viewer_id","title_id")
);
--> statement-breakpoint
ALTER TABLE "watchlist_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watchlist_items_title_idx" ON "watchlist_items" USING btree ("title_id");