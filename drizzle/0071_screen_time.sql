CREATE TABLE "screen_time" (
	"viewer_id" uuid NOT NULL,
	"day" text NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "screen_time_viewer_id_day_pk" PRIMARY KEY("viewer_id","day")
);
--> statement-breakpoint
ALTER TABLE "screen_time" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "screen_time_minutes" integer;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "quiet_from" integer;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "quiet_to" integer;--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "screen_time" ADD CONSTRAINT "screen_time_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;