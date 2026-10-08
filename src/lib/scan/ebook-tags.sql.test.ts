/** eBook libraries: titles, authors, series and covers read from EPUBs, PDFs left as their file names, Box thumbnails for PDFs. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { mediaFiles, titles } from "@/lib/db/schema";
import { artworkOf, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import type { StorageProvider } from "@/lib/storage/provider";
import { buildZip } from "@/lib/ebooks/test-zip";
import { EBOOKS_PROFILE } from "./tree-profile";
import { readTagsAndArtwork } from "./video-artwork";
import { syncVideoDirectory, unsupportedSummary } from "./video-library";
import { TEST_JPEG, rangeOf } from "./test-mp4";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const opf = (title: string) => `<package><metadata xmlns:dc="x"><dc:title>${title}</dc:title><dc:creator>Jane Author</dc:creator><dc:creator>Joe Co</dc:creator><dc:date>2001</dc:date><dc:description>&lt;p&gt;About it.&lt;/p&gt;</dc:description><meta name="calibre:series" content="The Saga"/><meta name="calibre:series_index" content="3"/><meta name="cover" content="c"/></metadata><manifest><item id="c" href="c.jpg" media-type="image/jpeg"/></manifest></package>`;
const epub = (title: string, withCover = true) =>
  buildZip([
    { name: "mimetype", data: "application/epub+zip", method: 0 },
    { name: "META-INF/container.xml", data: '<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: "content.opf", data: opf(title) },
    ...(withCover ? [{ name: "c.jpg", data: Uint8Array.from(TEST_JPEG) }] : []),
  ]);

let n = 0;
async function setup(files: { name: string; bytes: Uint8Array }[], thumbnail: "jpeg" | "none" = "jpeg") {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "ebooks", "everyone");
  const prefix = `ebk${++n}-`;
  await syncVideoDirectory(lib.id, "p", "Jane Author", files.map((f, i) => ({ id: `${prefix}${i}`, name: f.name, kind: "file" as const, sizeBytes: f.bytes.length })), null, EBOOKS_PROFILE);
  const bytesById = new Map(files.map((f, i) => [`${prefix}${i}`, f.bytes]));
  const provider = {
    listFolder: async () => [],
    getFolder: async () => null,
    getStreamingUrl: async () => ({ url: "", expiresAt: new Date() }),
    fetchByteRange: vi.fn(async (id: string, s: number, e: number) => rangeOf(bytesById.get(id)!)(s, e)),
    fetchThumbnail: vi.fn(async () => (thumbnail === "jpeg" ? { contentType: "image/jpeg" as const, bytes: Uint8Array.from(TEST_JPEG) } : null)),
  } satisfies StorageProvider;
  const rows = async () => Object.fromEntries((await db.select().from(titles).where(eq(titles.libraryId, lib.id))).map((t) => [t.boxFolderId, t]));
  return { lib, provider, key: (i: number) => `file:${prefix}${i}`, rows };
}
const run = (t: Awaited<ReturnType<typeof setup>>, errors: string[] = []) => readTagsAndArtwork(t.provider, t.lib.id, Date.now() + 60_000, errors, EBOOKS_PROFILE);

describe("eBook libraries", () => {
  it("make a title per book, ready at once (nothing to probe), named from the file until its tags are read", async () => {
    const t = await setup([{ name: "My Book.epub", bytes: epub("x") }, { name: "Paper.pdf", bytes: new Uint8Array(50) }]);
    const rows = await t.rows();
    expect(Object.values(rows).map((r) => [r.name, r.kind]).sort()).toEqual([["My Book", "ebook"], ["Paper", "ebook"]]);
    const files = await db.select().from(mediaFiles);
    expect(files.filter((f) => f.filename.endsWith(".epub") || f.filename.endsWith(".pdf")).every((f) => f.probeStatus === "ok")).toBe(true);
  });

  it("reads an EPUB: title, all authors, series and position, year, description and cover", async () => {
    const t = await setup([{ name: "book.epub", bytes: epub("The Real Title") }]);
    await run(t);
    const title = (await t.rows())[t.key(0)];
    expect(title).toMatchObject({ name: "The Real Title", nameSource: "embedded", authors: ["Jane Author", "Joe Co"], seriesName: "The Saga", seriesPosition: "3", year: 2001, overview: "About it." });
    const art = (await artworkOf(db, title.id))!;
    expect([art.source, Array.from(art.bytes)]).toEqual(["embedded", TEST_JPEG]);
    expect(title.posterUrl).toContain(`/api/titles/${title.id}/artwork`);
  });

  it("keeps a PDF's file name and takes Box's thumbnail as its cover", async () => {
    const t = await setup([{ name: "Some Paper.pdf", bytes: new Uint8Array(200) }]);
    await run(t);
    const title = (await t.rows())[t.key(0)];
    expect(title.name).toBe("Some Paper");
    const art = (await artworkOf(db, title.id))!;
    expect([art.source, Array.from(art.bytes)]).toEqual(["box", TEST_JPEG]);
  });

  it("reports a damaged EPUB and still lists it by file name, without losing the other books", async () => {
    const t = await setup([{ name: "Broken.epub", bytes: new Uint8Array(300).fill(7) }, { name: "Fine.epub", bytes: epub("Fine Book", false) }], "none");
    const errors: string[] = [];
    await run(t, errors);
    const rows = await t.rows();
    expect(rows[t.key(0)].name).toBe("Broken");
    expect(rows[t.key(1)].name).toBe("Fine Book");
    expect(errors.some((e) => e.includes("Broken.epub"))).toBe(true);
    expect(rows[t.key(1)].posterUrl).toBeNull();
  });

  it("counts the book formats it can't show and says so", async () => {
    const admin = await makeAccount(db, "u");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "ebooks", "everyone");
    const res = await syncVideoDirectory(lib.id, "p", "", ["a.epub", "b.mobi", "c.azw3", "d.cbz", "e.txt", "f.mp4"].map((name, i) => ({ id: `u${n}-${i}`, name, kind: "file" as const, sizeBytes: 10 })), null, EBOOKS_PROFILE);
    expect([res.added, res.unsupported]).toEqual([1, 4]);
    expect(unsupportedSummary(4, EBOOKS_PROFILE)).toContain("Roam shows .epub and .pdf");
  });
});
