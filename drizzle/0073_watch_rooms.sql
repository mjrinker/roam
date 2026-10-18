CREATE TABLE "watch_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_kind" "owner_kind" NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"playing" boolean DEFAULT false NOT NULL,
	"position_seconds" real DEFAULT 0 NOT NULL,
	"rate" real DEFAULT 1 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"members" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watch_rooms" ADD CONSTRAINT "watch_rooms_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_rooms" ADD CONSTRAINT "watch_rooms_created_by_viewers_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_rooms_server_idx" ON "watch_rooms" USING btree ("server_id");