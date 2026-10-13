CREATE TABLE "platform_jobs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"provider" text NOT NULL,
	"account_key" text NOT NULL,
	"label" text NOT NULL,
	"first_connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "provider_accounts_provider_account_key_pk" PRIMARY KEY("provider","account_key")
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "is_platform_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- The accounts already connected are the start of the ledger.
INSERT INTO "provider_accounts" ("provider", "account_key", "label", "first_connected_at", "last_connected_at")
SELECT "provider", lower("account_name"), min("account_name"), min("created_at"), now()
FROM "storage_connections"
WHERE "account_name" IS NOT NULL AND "provider" <> 'box'
GROUP BY "provider", lower("account_name")
ON CONFLICT DO NOTHING;
