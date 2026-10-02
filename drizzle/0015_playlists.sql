CREATE TYPE "public"."playlist_role" AS ENUM('editor', 'sharer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."playlist_visibility" AS ENUM('private', 'server');--> statement-breakpoint
CREATE TABLE "playlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"title_id" uuid,
	"episode_id" uuid,
	"position" bigint NOT NULL,
	"added_by_viewer_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_items_one_target" CHECK (num_nonnulls("playlist_items"."title_id", "playlist_items"."episode_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "playlist_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"role" "playlist_role" NOT NULL,
	"granted_by_viewer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_viewer_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"visibility" "playlist_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_added_by_viewer_id_viewers_id_fk" FOREIGN KEY ("added_by_viewer_id") REFERENCES "public"."viewers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_members" ADD CONSTRAINT "playlist_members_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_members" ADD CONSTRAINT "playlist_members_viewer_id_viewers_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."viewers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_members" ADD CONSTRAINT "playlist_members_granted_by_viewer_id_viewers_id_fk" FOREIGN KEY ("granted_by_viewer_id") REFERENCES "public"."viewers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_owner_viewer_id_viewers_id_fk" FOREIGN KEY ("owner_viewer_id") REFERENCES "public"."viewers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_items_playlist_title_idx" ON "playlist_items" USING btree ("playlist_id","title_id") WHERE "playlist_items"."title_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_items_playlist_episode_idx" ON "playlist_items" USING btree ("playlist_id","episode_id") WHERE "playlist_items"."episode_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "playlist_items_title_idx" ON "playlist_items" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "playlist_items_episode_idx" ON "playlist_items" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "playlist_items_order_idx" ON "playlist_items" USING btree ("playlist_id","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_members_playlist_viewer_idx" ON "playlist_members" USING btree ("playlist_id","viewer_id");--> statement-breakpoint
CREATE INDEX "playlist_members_viewer_idx" ON "playlist_members" USING btree ("viewer_id");--> statement-breakpoint
CREATE INDEX "playlists_server_idx" ON "playlists" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "playlists_owner_idx" ON "playlists" USING btree ("owner_viewer_id");