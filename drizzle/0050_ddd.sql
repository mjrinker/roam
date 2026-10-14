CREATE TABLE "ddd_items" (
	"key" text PRIMARY KEY NOT NULL,
	"ddd_item_id" integer,
	"missing" boolean DEFAULT false NOT NULL,
	"data" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ddd_access" text DEFAULT 'disabled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ddd_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row level security, deny-all like every other table (the app's own connection bypasses it; nobody else may read or change a row).
-- These ten earlier tables were created without it, which left them open to the public anon key.
ALTER TABLE "library_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "storage_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_cast" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_crew" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "title_extras" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tmdb_cast" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tmdb_crew" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tmdb_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_accounts" ENABLE ROW LEVEL SECURITY;
