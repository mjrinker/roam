CREATE TABLE "storage_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"account_name" text,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"secrets_encrypted" text,
	"config" jsonb,
	"auth_status" "box_auth_status" DEFAULT 'disconnected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_connections" ADD CONSTRAINT "storage_connections_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_connections_server_idx" ON "storage_connections" USING btree ("server_id");
--> statement-breakpoint
-- Each server's existing Box login becomes a connection whose id is the server's id, so every Box id already stored keeps meaning it.
INSERT INTO "storage_connections" ("id", "server_id", "provider", "label", "access_token_encrypted", "refresh_token_encrypted", "token_expires_at", "auth_status")
SELECT "id", "id", 'box', 'Box', "box_access_token_encrypted", "box_refresh_token_encrypted", "box_token_expires_at", "box_auth_status"
FROM "servers"
WHERE "box_auth_status" <> 'disconnected' OR "box_access_token_encrypted" IS NOT NULL OR EXISTS (SELECT 1 FROM "libraries" WHERE "libraries"."server_id" = "servers"."id");
