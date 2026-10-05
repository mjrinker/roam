/** Shared artwork storage: identical pictures stored once, and removed with the last title that used them. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { artworkImages, titleArtwork, titles } from "@/lib/db/schema";
import { artworkOf, createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { imageHash, releaseArtwork, storeArtwork } from "./artwork-store";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

/** A distinct little JPEG per seed; every test uses its own seeds, since pictures are shared across the whole database. */
const jpeg = (seed: number) => ({ contentType: "image/jpeg" as const, bytes: Uint8Array.from([0xff, 0xd8, 0xff, seed, seed, seed]) });

async function tracks(n: number) {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "audio", "everyone");
  return Promise.all(Array.from({ length: n }, (_, i) => makeTitle(db, lib.id, { kind: "audiobook", boxFolderId: `file:${Math.random()}-${i}` })));
}
const imageRows = async (hashes: string[]) => (await db.select().from(artworkImages)).filter((r) => hashes.includes(r.hash));

describe("storeArtwork", () => {
  it("stores one copy of a picture however many titles use it, and points each poster at its own URL", async () => {
    const [a, b, c] = await tracks(3);
    for (const t of [a, b, c]) await storeArtwork(db, t.id, jpeg(10), "embedded");
    const hash = imageHash(jpeg(10).bytes);
    expect(await imageRows([hash])).toHaveLength(1);
    expect((await db.select().from(titleArtwork).where(eq(titleArtwork.imageHash, hash))).length).toBeGreaterThanOrEqual(3);
    for (const t of [a, b, c]) {
      const art = (await artworkOf(db, t.id))!;
      expect(Array.from(art.bytes)).toEqual(Array.from(jpeg(10).bytes));
      const [row] = await db.select().from(titles).where(eq(titles.id, t.id));
      expect(row.posterUrl).toContain(`/api/titles/${t.id}/artwork?v=`);
    }
  });

  it("replacing a title's picture drops the old image only if nothing else uses it", async () => {
    const [a, b] = await tracks(2);
    await storeArtwork(db, a.id, jpeg(20), "embedded");
    await storeArtwork(db, b.id, jpeg(20), "embedded");
    await storeArtwork(db, a.id, jpeg(21), "embedded"); // a moves on; b still uses A
    expect(await imageRows([imageHash(jpeg(20).bytes)])).toHaveLength(1);
    await storeArtwork(db, b.id, jpeg(21), "embedded"); // now nothing uses A
    expect(await imageRows([imageHash(jpeg(20).bytes)])).toHaveLength(0);
    expect(await imageRows([imageHash(jpeg(21).bytes)])).toHaveLength(1);
  });

  it("storing the same picture again changes nothing but the version", async () => {
    const [a] = await tracks(1);
    await storeArtwork(db, a.id, jpeg(30), "embedded");
    await storeArtwork(db, a.id, jpeg(30), "box");
    expect(await imageRows([imageHash(jpeg(30).bytes)])).toHaveLength(1);
    expect((await artworkOf(db, a.id))?.source).toBe("box");
  });
});

describe("releaseArtwork", () => {
  it("removes the pictures of the titles given, and an image only when its last user goes", async () => {
    const [a, b, c] = await tracks(3);
    await storeArtwork(db, a.id, jpeg(90), "embedded");
    await storeArtwork(db, b.id, jpeg(90), "embedded");
    await storeArtwork(db, c.id, jpeg(91), "embedded");
    await releaseArtwork(db, [a.id, c.id]);
    expect(await artworkOf(db, a.id)).toBeUndefined();
    expect(await artworkOf(db, c.id)).toBeUndefined();
    expect(await imageRows([imageHash(jpeg(90).bytes)])).toHaveLength(1); // b still has it
    expect(await imageRows([imageHash(jpeg(91).bytes)])).toHaveLength(0); // c was the only user
    await releaseArtwork(db, []); // nothing to do
    await releaseArtwork(db, [b.id]);
    expect(await imageRows([imageHash(jpeg(90).bytes)])).toHaveLength(0);
  });
});

describe("migration 0024/0025 keeps existing pictures", () => {
  it("moves legacy per-title pictures into the shared table, collapsing identical ones, and drops the old columns", async () => {
    const client = new PGlite();
    try {
      const folder = path.join(process.cwd(), "drizzle");
      const journal = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
      const run = async (tag: string) => client.exec(readFileSync(path.join(folder, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
      const before = journal.entries.map((e) => e.tag).filter((t) => t < "0024");
      for (const tag of before) await run(tag);

      // Legacy state: three titles with the old per-title bytes, two of them identical.
      await client.exec(`
        INSERT INTO profiles (id, email) VALUES ('00000000-0000-4000-8000-0000000000a1', 'a@x.dev');
        INSERT INTO servers (id, name, owner_id) VALUES ('00000000-0000-4000-8000-0000000000b1', 's', '00000000-0000-4000-8000-0000000000a1');
        INSERT INTO libraries (id, server_id, name, kind, box_folder_id) VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', 'l', 'video', 'f1');
        INSERT INTO titles (id, library_id, kind, name, box_folder_id) VALUES
          ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'movie', 't1', 'file:1'),
          ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c1', 'movie', 't2', 'file:2'),
          ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000c1', 'movie', 't3', 'file:3');
        INSERT INTO title_artwork (title_id, content_type, bytes, source) VALUES
          ('00000000-0000-4000-8000-0000000000d1', 'image/jpeg', '\\xffd8ff01', 'embedded'),
          ('00000000-0000-4000-8000-0000000000d2', 'image/jpeg', '\\xffd8ff01', 'embedded'),
          ('00000000-0000-4000-8000-0000000000d3', 'image/png', '\\x89504e47', 'box');`);

      await run("0024_artwork_images_and_sort_key");
      await run("0025_artwork_images_finish");

      const images = (await client.query<{ hash: string; content_type: string }>("SELECT hash, content_type FROM artwork_images ORDER BY content_type")).rows;
      expect(images).toHaveLength(2); // the two identical pictures became one
      const links = (await client.query<{ title_id: string; image_hash: string }>("SELECT title_id, image_hash FROM title_artwork ORDER BY title_id")).rows;
      expect(links).toHaveLength(3);
      expect(links[0].image_hash).toBe(links[1].image_hash);
      expect(links[2].image_hash).not.toBe(links[0].image_hash);
      expect(images.map((i) => i.hash).sort()).toEqual([...new Set(links.map((l) => l.image_hash))].sort());
      // The old columns are gone, and image_hash can no longer be null.
      const cols = (await client.query<{ column_name: string; is_nullable: string }>("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'title_artwork'")).rows;
      expect(cols.map((c) => c.column_name).sort()).toEqual(["image_hash", "source", "title_id", "updated_at"]);
      expect(cols.find((c) => c.column_name === "image_hash")?.is_nullable).toBe("NO");
    } finally {
      await client.close();
    }
  });
});
