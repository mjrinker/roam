CREATE TABLE "tv_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"account_id" uuid,
	"device_label" text DEFAULT 'TV' NOT NULL,
	"location_hint" text,
	"ip_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tv_pairings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tv_pairings" ADD CONSTRAINT "tv_pairings_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tv_pairings_user_code_idx" ON "tv_pairings" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "tv_pairings_device_hash_idx" ON "tv_pairings" USING btree ("device_hash");--> statement-breakpoint
CREATE INDEX "tv_pairings_ip_idx" ON "tv_pairings" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "tv_pairings_account_idx" ON "tv_pairings" USING btree ("account_id");