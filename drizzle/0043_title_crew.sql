CREATE TABLE "title_crew" (
	"title_id" uuid NOT NULL,
	"person_id" integer NOT NULL,
	"name" text NOT NULL,
	"job" text NOT NULL,
	"photo_url" text,
	"position" integer NOT NULL,
	CONSTRAINT "title_crew_title_id_person_id_job_pk" PRIMARY KEY("title_id","person_id","job")
);
--> statement-breakpoint
ALTER TABLE "title_crew" ADD CONSTRAINT "title_crew_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "title_crew_person_idx" ON "title_crew" USING btree ("person_id");