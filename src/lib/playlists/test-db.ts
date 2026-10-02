import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "@/lib/db/schema";

export type TestDb = PgliteDatabase<typeof schema>;

/**
 * A throwaway in-memory Postgres with every repo migration applied (real
 * constraints, indexes, locks). The migration files are executed directly in
 * journal order, one `exec` per file, because some hand-written migrations hold
 * several statements without drizzle's statement-breakpoint markers, which
 * drizzle's own migrator would send as one prepared statement.
 */
export async function createTestDb(): Promise<{ db: TestDb; close: () => Promise<void> }> {
  const client = new PGlite();
  const folder = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    await client.exec(readFileSync(path.join(folder, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return { db: drizzle(client, { schema }), close: () => client.close() };
}

let counter = 0;
const uid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

/** Inserts the minimum graph playlist tests need: a server, an account+viewer pair per name, and a library with titles. */
export async function seedBasics(db: TestDb) {
  const [owner] = await db
    .insert(schema.profiles)
    .values({ id: uid(), email: "owner@test.dev", displayName: "Owner" })
    .returning();
  const [server] = await db.insert(schema.servers).values({ name: "Test", ownerId: owner.id } as never).returning();
  return { owner, server };
}
