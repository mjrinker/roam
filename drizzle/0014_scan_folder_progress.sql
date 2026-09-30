ALTER TABLE "libraries" ADD COLUMN "scan_folders_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "scan_folders_done" integer DEFAULT 0 NOT NULL;