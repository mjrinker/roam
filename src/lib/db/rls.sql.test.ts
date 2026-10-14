/**
 * Every table is deny-all: row level security on (supabase/rls.sql plus the migrations), no policies. The app's own connection bypasses it; anyone else holding the public
 * Supabase key must not be able to read or change a row. A table created without it (as ten once were, including the one holding
 * storage sign-in tokens) fails here.
 */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("row level security", () => {
  it("is on for every table the migrations create, with no policies", async () => {
    const client = new PGlite();
    const folder = path.join(process.cwd(), "drizzle");
    const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    for (const { tag } of journal.entries) await client.exec(readFileSync(path.join(folder, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
    // The first tables get theirs from supabase/rls.sql, applied once to a new project; every later table must do it in its own migration.
    await client.exec(readFileSync(path.join(process.cwd(), "supabase/rls.sql"), "utf8"));
    const tables = await client.query<{ tablename: string; rowsecurity: boolean }>("select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename");
    expect(tables.rows.length).toBeGreaterThan(30);
    expect(tables.rows.filter((t) => !t.rowsecurity).map((t) => t.tablename)).toEqual([]);
    const policies = await client.query<{ tablename: string }>("select tablename from pg_policies where schemaname = 'public'");
    expect(policies.rows).toEqual([]);
    await client.close();
  }, 60_000);
});
