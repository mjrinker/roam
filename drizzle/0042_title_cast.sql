CREATE TABLE "title_cast" (
	"title_id" uuid NOT NULL,
	"person_id" integer NOT NULL,
	"name" text NOT NULL,
	"character" text,
	"photo_url" text,
	"position" integer NOT NULL,
	CONSTRAINT "title_cast_title_id_person_id_pk" PRIMARY KEY("title_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cast_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "title_cast" ADD CONSTRAINT "title_cast_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "title_cast_person_idx" ON "title_cast" USING btree ("person_id");