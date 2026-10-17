CREATE TABLE "wishlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"title_key" text NOT NULL,
	"year" integer,
	"year_key" integer DEFAULT 0 NOT NULL,
	"creator" text,
	"tmdb_id" integer,
	"poster_url" text,
	"overview" text,
	"note" text,
	"requested_by" uuid,
	"status" text DEFAULT 'wanted' NOT NULL,
	"claimed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wishlist_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wishlist_votes" (
	"wish_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlist_votes_wish_id_account_id_pk" PRIMARY KEY("wish_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "wishlist_votes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_requested_by_profiles_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_claimed_by_profiles_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_votes" ADD CONSTRAINT "wishlist_votes_wish_id_wishlist_items_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."wishlist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_votes" ADD CONSTRAINT "wishlist_votes_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wishlist_items_unique_idx" ON "wishlist_items" USING btree ("server_id","kind","title_key","year_key");--> statement-breakpoint
CREATE INDEX "wishlist_items_server_idx" ON "wishlist_items" USING btree ("server_id","status");