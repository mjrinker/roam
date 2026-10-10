ALTER TYPE "public"."owner_kind" ADD VALUE 'extra';--> statement-breakpoint
CREATE TABLE "title_extras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"box_file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "title_extras" ADD CONSTRAINT "title_extras_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "title_extras_title_file_idx" ON "title_extras" USING btree ("title_id","box_file_id");--> statement-breakpoint
CREATE INDEX "title_extras_title_idx" ON "title_extras" USING btree ("title_id");