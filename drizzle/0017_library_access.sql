CREATE TYPE "public"."library_access" AS ENUM('everyone', 'restricted');--> statement-breakpoint
CREATE TABLE "library_members" (
	"library_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"granted_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_members_library_id_account_id_pk" PRIMARY KEY("library_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "library_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Every library that exists today stays open to everyone: add the column with that default (which
-- backfills existing rows), then make NEW libraries fail closed.
ALTER TABLE "libraries" ADD COLUMN "access" "library_access" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "libraries" ALTER COLUMN "access" SET DEFAULT 'restricted';--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_id_server_idx" ON "libraries" USING btree ("id","server_id");--> statement-breakpoint
ALTER TABLE "library_members" ADD CONSTRAINT "library_members_granted_by_account_id_profiles_id_fk" FOREIGN KEY ("granted_by_account_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_members" ADD CONSTRAINT "library_members_library_server_fk" FOREIGN KEY ("library_id","server_id") REFERENCES "public"."libraries"("id","server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_members" ADD CONSTRAINT "library_members_server_account_fk" FOREIGN KEY ("server_id","account_id") REFERENCES "public"."server_members"("server_id","profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_members_account_idx" ON "library_members" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "library_members_granted_by_idx" ON "library_members" USING btree ("granted_by_account_id");
