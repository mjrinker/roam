ALTER TYPE "public"."scan_trigger" ADD VALUE 'resume';--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "scan_incomplete" boolean DEFAULT false NOT NULL;