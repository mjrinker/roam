CREATE TYPE "public"."viewer_role" AS ENUM('owner', 'admin', 'limited');--> statement-breakpoint
ALTER TABLE "viewers" ADD COLUMN "role" "viewer_role" DEFAULT 'limited' NOT NULL;
--> statement-breakpoint
-- Data backfill (hand-written). The account's original default profile
-- reuses the account's own id (see ensureDefaultViewer), so that's the
-- owner; any other profile created before this shipped becomes admin
-- (self-managing) rather than limited, so nobody who was already using a
-- second profile gets locked out of their own settings.
UPDATE "viewers" SET "role" = 'owner' WHERE "id" = "account_id";
UPDATE "viewers" SET "role" = 'admin' WHERE "id" != "account_id";
