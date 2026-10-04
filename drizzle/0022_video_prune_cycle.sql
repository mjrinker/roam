ALTER TABLE "libraries" ADD COLUMN "scan_cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "scan_cycle_clean" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "prune_missing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "last_seen_cycle" uuid;