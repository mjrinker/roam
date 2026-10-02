import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("pglite test database", () => {
  it("applies every migration, including the playlist tables", async () => {
    const res = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'playlist%' order by 1`
    );
    expect(res.rows.map((r) => (r as { table_name: string }).table_name)).toEqual([
      "playlist_items",
      "playlist_members",
      "playlists",
    ]);
  });
});
