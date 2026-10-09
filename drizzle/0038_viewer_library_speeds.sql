CREATE TABLE "viewer_library_speeds" (
	"viewer_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"speed" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "viewer_library_speeds_viewer_id_library_id_pk" PRIMARY KEY("viewer_id","library_id")
);
--> statement-breakpoint
ALTER TABLE "viewer_library_speeds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "viewer_library_speeds" ADD CONSTRAINT "viewer_library_speeds_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viewer_library_speeds" ADD CONSTRAINT "viewer_library_speeds_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;