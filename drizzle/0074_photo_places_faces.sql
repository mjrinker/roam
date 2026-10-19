CREATE TABLE "photo_faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"w" real NOT NULL,
	"h" real NOT NULL,
	"score" real NOT NULL,
	"embedding" "bytea" NOT NULL,
	"person_id" uuid,
	"suggested_person_id" uuid,
	"suggested_score" real,
	"ignored" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_faces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "photo_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_people" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "place_name" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "place_source" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "faces_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "photo_faces" ADD CONSTRAINT "photo_faces_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_faces" ADD CONSTRAINT "photo_faces_person_id_photo_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."photo_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_faces" ADD CONSTRAINT "photo_faces_suggested_person_id_photo_people_id_fk" FOREIGN KEY ("suggested_person_id") REFERENCES "public"."photo_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_people" ADD CONSTRAINT "photo_people_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_faces_title_idx" ON "photo_faces" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "photo_faces_person_idx" ON "photo_faces" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "photo_faces_suggested_idx" ON "photo_faces" USING btree ("suggested_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_people_server_name_idx" ON "photo_people" USING btree ("server_id",lower("name"));