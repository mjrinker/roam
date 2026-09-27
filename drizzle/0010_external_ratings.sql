ALTER TABLE "titles" ADD COLUMN "imdb_id" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "imdb_rating" real;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "imdb_votes" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "rotten_tomatoes_score" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "metascore" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "external_ratings_attempted_at" timestamp with time zone;