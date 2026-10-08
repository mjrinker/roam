/** Searching from a TV: what it finds, and what it must never reveal. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessProfile } from "@/lib/content/access";
import { musicAlbums, musicArtists } from "@/lib/db/schema";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { TvScope } from "./data";
import { cleanQuery, SEARCH_MAX, tvSearch } from "./search";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid: AccessProfile = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const lib = (kind: Parameters<typeof makeLibrary>[2]) => makeLibrary(db, server.id, kind, access);
  const scope = (viewer = adult): TvScope => ({ actor: { serverId: server.id, accountId: member.accountId, isAdmin: false }, viewer, viewerId: member.viewer.id });
  return { server, lib, scope };
}

describe("cleanQuery", () => {
  it("trims, collapses spaces, drops control characters and limits the length", () => {
    expect(cleanQuery("  the   hobbit \n")).toBe("the hobbit");
    expect(cleanQuery("a\u0000b")).toBe("ab");
    expect(cleanQuery(null)).toBe("");
    expect(cleanQuery("x".repeat(500))).toHaveLength(SEARCH_MAX);
  });
});

describe("tvSearch", () => {
  it("finds titles by name, books by author, best match first, across the libraries the TV shows", async () => {
    const w = await world();
    await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "The Lord Film", year: 2001 });
    await makeTitle(db, (await w.lib("movies")).id, { kind: "movie", name: "Another Lord" });
    await makeTitle(db, (await w.lib("audiobooks")).id, { kind: "audiobook", name: "The Hobbit", authors: ["Lord Dunsany"] });
    await makeTitle(db, (await w.lib("audio")).id, { kind: "audiobook", name: "Lordly Talk" });
    const hits = await tvSearch(db, w.scope(), "lord");
    expect(hits[0].name).toBe("Lordly Talk"); // starts with the query
    expect(hits.map((h) => h.name).sort()).toEqual(["Another Lord", "Lordly Talk", "The Hobbit", "The Lord Film"]);
    expect(hits.find((h) => h.name === "The Hobbit")).toMatchObject({ meta: "Lord Dunsany", square: true, href: expect.stringMatching(/^\/book\//) });
    expect(hits.find((h) => h.name === "Lordly Talk")!.href).toMatch(/^\/listen\//);
  });
  it("matches wildcards literally, and an empty query finds nothing", async () => {
    const w = await world();
    const lib = await w.lib("movies");
    await makeTitle(db, lib.id, { kind: "movie", name: "100% Wolf" });
    await makeTitle(db, lib.id, { kind: "movie", name: "1000 Wolves" });
    expect((await tvSearch(db, w.scope(), "100%")).map((h) => h.name)).toEqual(["100% Wolf"]);
    expect(await tvSearch(db, w.scope(), "_")).toEqual([]);
    expect(await tvSearch(db, w.scope(), "   ")).toEqual([]);
  });
  it("finds an album by its name or its artist's, never shows songs or pictures, and opens the album", async () => {
    const w = await world();
    const music = await w.lib("music");
    const [artist] = await db.insert(musicArtists).values({ libraryId: music.id, name: "Queen", nameKey: "queen", sortKey: "queen" }).returning();
    const [album] = await db.insert(musicAlbums).values({ libraryId: music.id, artistId: artist.id, name: "A Night at the Opera", nameKey: "a night", year: 1975 }).returning();
    await makeTitle(db, music.id, { kind: "audiobook", name: "Bohemian Rhapsody", albumId: album.id, trackNumber: 1, posterUrl: "https://img/c.jpg" });
    await makeTitle(db, (await w.lib("photos")).id, { kind: "photo", name: "Queen concert", takenAt: new Date() });
    for (const q of ["queen", "opera"]) {
      const hits = await tvSearch(db, w.scope(), q);
      expect(hits, q).toEqual([{ href: `/album/${album.id}`, name: "A Night at the Opera", meta: "Queen · 1975", posterUrl: "https://img/c.jpg", square: true }]);
    }
    expect(await tvSearch(db, w.scope(), "rhapsody")).toEqual([]); // songs are reached through their album
  });
  it("hides what the age limit forbids, hidden libraries, other servers' content and an album with no visible songs", async () => {
    const w = await world();
    const movies = await w.lib("movies");
    await makeTitle(db, movies.id, { kind: "movie", name: "Cartoon Moon", ratingAges: { ANY: 0 } });
    await makeTitle(db, movies.id, { kind: "movie", name: "Thriller Moon", ratingAges: { ANY: 17 } });
    expect((await tvSearch(db, w.scope(kid), "moon")).map((h) => h.name)).toEqual(["Cartoon Moon"]);
    const music = await w.lib("music");
    const [artist] = await db.insert(musicArtists).values({ libraryId: music.id, name: "Moon Band", nameKey: "moon band", sortKey: "moon band" }).returning();
    const [album] = await db.insert(musicAlbums).values({ libraryId: music.id, artistId: artist.id, name: "Dark Side", nameKey: "dark side" }).returning();
    await makeTitle(db, music.id, { kind: "audiobook", name: "S", albumId: album.id, trackNumber: 1, ratingAges: { ANY: 17 } });
    expect((await tvSearch(db, w.scope(kid), "moon band")).map((h) => h.name)).toEqual([]);
    expect((await tvSearch(db, w.scope(), "moon band")).map((h) => h.name)).toEqual(["Dark Side"]);
    const hidden = await world("restricted");
    await makeTitle(db, (await hidden.lib("movies")).id, { kind: "movie", name: "Secret Moon" });
    expect(await tvSearch(db, hidden.scope(), "moon")).toEqual([]);
    const other = await world();
    await makeTitle(db, (await other.lib("movies")).id, { kind: "movie", name: "Their Moon" });
    expect((await tvSearch(db, w.scope(), "moon")).map((h) => h.name)).not.toContain("Their Moon");
  });
});
