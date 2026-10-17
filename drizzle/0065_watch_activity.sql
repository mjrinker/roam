CREATE TABLE "watch_activity" (
	"server_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"title_id" uuid NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "watch_activity_server_id_account_id_day_title_id_pk" PRIMARY KEY("server_id","account_id","day","title_id")
);
--> statement-breakpoint
ALTER TABLE "watch_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watch_activity" ADD CONSTRAINT "watch_activity_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_activity" ADD CONSTRAINT "watch_activity_account_id_profiles_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_activity" ADD CONSTRAINT "watch_activity_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_activity_server_day_idx" ON "watch_activity" USING btree ("server_id","day");