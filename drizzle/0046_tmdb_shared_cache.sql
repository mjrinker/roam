CREATE TABLE "tmdb_cast" (
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"name" text NOT NULL,
	"character" text,
	"photo_url" text,
	"position" integer NOT NULL,
	CONSTRAINT "tmdb_cast_kind_tmdb_id_person_id_pk" PRIMARY KEY("kind","tmdb_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "tmdb_crew" (
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"name" text NOT NULL,
	"job" text NOT NULL,
	"photo_url" text,
	"position" integer NOT NULL,
	CONSTRAINT "tmdb_crew_kind_tmdb_id_person_id_job_pk" PRIMARY KEY("kind","tmdb_id","person_id","job")
);
--> statement-breakpoint
CREATE TABLE "tmdb_entries" (
	"kind" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"season" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_at" timestamp with time zone,
	CONSTRAINT "tmdb_entries_kind_tmdb_id_season_pk" PRIMARY KEY("kind","tmdb_id","season")
);
--> statement-breakpoint
CREATE INDEX "tmdb_cast_person_idx" ON "tmdb_cast" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tmdb_crew_person_idx" ON "tmdb_crew" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tmdb_entries_fetched_idx" ON "tmdb_entries" USING btree ("fetched_at");
--> statement-breakpoint
-- The cast and crew each title had now live once per TMDB entry, shared by every server's copy of it.
INSERT INTO "tmdb_cast" ("kind", "tmdb_id", "person_id", "name", "character", "photo_url", "position")
SELECT DISTINCT ON (k, t.tmdb_id, c.person_id) k, t.tmdb_id, c.person_id, c.name, c.character, c.photo_url, c.position
FROM "title_cast" c
JOIN "titles" t ON t.id = c.title_id
CROSS JOIN LATERAL (SELECT CASE WHEN t.kind = 'show' THEN 'tv' ELSE 'movie' END AS k) kk
WHERE t.tmdb_id IS NOT NULL AND t.kind IN ('movie', 'show')
ORDER BY k, t.tmdb_id, c.person_id, c.position;
--> statement-breakpoint
INSERT INTO "tmdb_crew" ("kind", "tmdb_id", "person_id", "name", "job", "photo_url", "position")
SELECT DISTINCT ON (k, t.tmdb_id, c.person_id, c.job) k, t.tmdb_id, c.person_id, c.name, c.job, c.photo_url, c.position
FROM "title_crew" c
JOIN "titles" t ON t.id = c.title_id
CROSS JOIN LATERAL (SELECT CASE WHEN t.kind = 'show' THEN 'tv' ELSE 'movie' END AS k) kk
WHERE t.tmdb_id IS NOT NULL AND t.kind IN ('movie', 'show')
ORDER BY k, t.tmdb_id, c.person_id, c.job, c.position;
