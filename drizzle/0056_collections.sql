CREATE TABLE "collection_items" (
	"collection_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_collection_id_title_id_pk" PRIMARY KEY("collection_id","title_id")
);
--> statement-breakpoint
ALTER TABLE "collection_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"tmdb_collection_id" integer,
	"poster_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "collection_tmdb_id" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "collection_name" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "collection_poster_url" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "collection_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_items_title_idx" ON "collection_items" USING btree ("title_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_tmdb_idx" ON "collections" USING btree ("library_id","tmdb_collection_id");--> statement-breakpoint
CREATE INDEX "collections_library_idx" ON "collections" USING btree ("library_id");