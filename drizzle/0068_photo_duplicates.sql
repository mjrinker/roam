ALTER TABLE "titles" ADD COLUMN "photo_hash" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "photo_hash_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "duplicate_of" uuid;--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_duplicate_of_titles_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."titles"("id") ON DELETE set null ON UPDATE no action;