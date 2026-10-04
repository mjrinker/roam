/** The columns and table video libraries rely on, on a real in-memory Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { libraries, titleArtwork, titles } from "@/lib/db/schema";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const library = await makeLibrary(db, server.id, "video", "everyone");
  const title = await makeTitle(db, library.id, { boxFolderId: `file:${Math.random()}` });
  return { library, title };
}

describe("video library schema", () => {
  it("accepts a library of the new kind with a library-level rating, and nothing else changes for other kinds", async () => {
    const { library } = await world();
    expect(library.kind).toBe("video");
    expect(library.ratingAges).toBeNull();
    await db.update(libraries).set({ ratingAges: { ANY: 13 } }).where(eq(libraries.id, library.id));
    const [row] = await db.select().from(libraries).where(eq(libraries.id, library.id));
    expect(row.ratingAges).toEqual({ ANY: 13 });
  });

  it("stores a file's place in the folder tree on its title, null for ordinary titles", async () => {
    const { library, title } = await world();
    expect(title.folderPath).toBeNull();
    expect(title.parentFolderId).toBeNull();
    expect(title.nameSource).toBeNull();
    await db
      .update(titles)
      .set({ folderPath: "Vacations/2019", parentFolderId: "12345", nameSource: "embedded", tagsAttemptedAt: new Date() })
      .where(eq(titles.id, title.id));
    const [row] = await db.select().from(titles).where(eq(titles.libraryId, library.id));
    expect(row).toMatchObject({ folderPath: "Vacations/2019", parentFolderId: "12345", nameSource: "embedded" });
  });

  it("round-trips image bytes exactly, and removes them with the title", async () => {
    const { title } = await world();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x80, 0xfe, 0xff, 0xd9]); // includes 0x00 and high bytes
    await db.insert(titleArtwork).values({ titleId: title.id, contentType: "image/jpeg", bytes, source: "embedded" });
    const [row] = await db.select().from(titleArtwork).where(eq(titleArtwork.titleId, title.id));
    // The in-memory test database hands back a Uint8Array where postgres-js hands back a Buffer;
    // code that reads artwork wraps with Buffer.from either way.
    expect(Buffer.from(row.bytes).equals(bytes)).toBe(true);
    await db.delete(titles).where(eq(titles.id, title.id));
    expect(await db.select().from(titleArtwork).where(eq(titleArtwork.titleId, title.id))).toHaveLength(0);
  });
});
