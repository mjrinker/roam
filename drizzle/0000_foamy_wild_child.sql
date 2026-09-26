CREATE TYPE "public"."box_auth_status" AS ENUM('disconnected', 'connected', 'needs_reauth');--> statement-breakpoint
CREATE TYPE "public"."library_kind" AS ENUM('movies', 'shows');--> statement-breakpoint
CREATE TYPE "public"."metadata_status" AS ENUM('pending', 'matched', 'manual', 'not_found');--> statement-breakpoint
CREATE TYPE "public"."owner_kind" AS ENUM('title', 'episode');--> statement-breakpoint
CREATE TYPE "public"."probe_status" AS ENUM('pending', 'ok', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scan_trigger" AS ENUM('manual', 'cron', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."title_kind" AS ENUM('movie', 'show');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text,
	"box_folder_id" text,
	"tmdb_id" integer,
	"overview" text,
	"still_url" text,
	"runtime_seconds" integer
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"token" text NOT NULL,
	"invited_by" uuid,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "library_kind" NOT NULL,
	"box_folder_id" text NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"last_scan_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "libraries_box_folder_id_unique" UNIQUE("box_folder_id")
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" "owner_kind" NOT NULL,
	"owner_id" uuid NOT NULL,
	"part_index" integer DEFAULT 0 NOT NULL,
	"box_file_id" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint,
	"duration_seconds" integer,
	"container" text,
	"video_codec" text,
	"audio_codec" text,
	"width" integer,
	"height" integer,
	"probe_status" "probe_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_files_box_file_id_unique" UNIQUE("box_file_id")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"trigger" "scan_trigger" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"titles_added" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"box_folder_id" text NOT NULL,
	CONSTRAINT "seasons_box_folder_id_unique" UNIQUE("box_folder_id")
);
--> statement-breakpoint
CREATE TABLE "server_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"box_access_token_encrypted" text,
	"box_refresh_token_encrypted" text,
	"box_token_expires_at" timestamp with time zone,
	"box_auth_status" "box_auth_status" DEFAULT 'disconnected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"kind" "title_kind" NOT NULL,
	"name" text NOT NULL,
	"year" integer,
	"box_folder_id" text NOT NULL,
	"tmdb_id" integer,
	"overview" text,
	"poster_url" text,
	"backdrop_url" text,
	"genres" jsonb DEFAULT '[]'::jsonb,
	"metadata_status" "metadata_status" DEFAULT 'pending' NOT NULL,
	"runtime_seconds" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "titles_box_folder_id_unique" UNIQUE("box_folder_id")
);
--> statement-breakpoint
CREATE TABLE "watch_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"owner_kind" "owner_kind" NOT NULL,
	"owner_id" uuid NOT NULL,
	"position_seconds" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer,
	"finished" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_profiles_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_state" ADD CONSTRAINT "watch_state_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_season_number_idx" ON "episodes" USING btree ("season_id","number");--> statement-breakpoint
CREATE INDEX "invites_server_idx" ON "invites" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "libraries_server_idx" ON "libraries" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_owner_part_idx" ON "media_files" USING btree ("owner_kind","owner_id","part_index");--> statement-breakpoint
CREATE INDEX "media_files_owner_idx" ON "media_files" USING btree ("owner_kind","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limit_buckets_profile_bucket_window_idx" ON "rate_limit_buckets" USING btree ("profile_id","bucket","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_title_number_idx" ON "seasons" USING btree ("title_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "server_members_server_profile_idx" ON "server_members" USING btree ("server_id","profile_id");--> statement-breakpoint
CREATE INDEX "server_members_profile_idx" ON "server_members" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "titles_library_idx" ON "titles" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "titles_name_idx" ON "titles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_state_profile_owner_idx" ON "watch_state" USING btree ("profile_id","owner_kind","owner_id");