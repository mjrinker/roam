CREATE TABLE "title_artwork" (
	"title_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "title_artwork" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "rating_ages" jsonb;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "folder_path" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "parent_folder_id" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "name_source" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "tags_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "title_artwork" ADD CONSTRAINT "title_artwork_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "titles_library_folder_idx" ON "titles" USING btree ("library_id","folder_path" text_pattern_ops);