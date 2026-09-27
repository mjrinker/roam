ALTER TABLE "watch_state" DROP CONSTRAINT "watch_state_profile_id_profiles_id_fk";
--> statement-breakpoint
DROP INDEX "watch_state_profile_owner_idx";--> statement-breakpoint
ALTER TABLE "watch_state" ALTER COLUMN "viewer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "playback_rate";--> statement-breakpoint
ALTER TABLE "watch_state" DROP COLUMN "profile_id";