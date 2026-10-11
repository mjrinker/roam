CREATE TABLE "library_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"root_id" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_sources_root_id_unique" UNIQUE("root_id")
);
--> statement-breakpoint
ALTER TABLE "library_sources" ADD CONSTRAINT "library_sources_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_sources_library_idx" ON "library_sources" USING btree ("library_id");