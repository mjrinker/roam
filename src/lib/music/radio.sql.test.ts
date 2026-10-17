/** Radio from the database: who is in it, and who may hear what. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { libraries, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { artistOfSong, radioFor } from "./radio";
import type { AboutDeps } from "./about";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
let n = 0;

async function world(lookups = true) {
  const admin = await makeAccount(db, `radio${++n}`);
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  if (!lookups) await db.update(libraries).set({ musicLookup: false }).where(eq(libraries.id, lib.id));
  const scope = { actor: { serverId: server.id, accountId: admin.accountId, isAdmin: true } as LibraryActor, viewer: adult };
  async function artist(name: string, mbid: string, songCount = 6) {
    const [a] = await db.insert(musicArtists).values({ libraryId: lib.id, name, nameKey: name.toLowerCase().replace(/[^a-z0-9]+/g, ""), sortKey: name.toLowerCase(), mbid }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: a.id, name: `${name} album`, nameKey: `${a.id}album` }).returning();
    const ids: string[] = [];
    for (let i = 0; i < songCount; i++) {
      const [t] = await db.insert(titles).values({ libraryId: lib.id, kind: "audiobook", name: `${name} ${i}`, boxFolderId: `${a.id}-${i}`, albumId: al.id, trackNumber: i + 1 }).returning();
      ids.push(t.id);
    }
    return { ...a, songs: ids };
  }
  return { server, lib, scope, artist };
}

/** Fake outside services: the given artists are "similar" to every artist asked about. */
function deps(similar: { mbid: string; name: string; score: number }[]): AboutDeps {
  return {
    mb: { searchReleases: async () => [], getRelease: async () => null, getFrontCover: async () => null, searchArtists: async () => [], getReleaseGroupLinks: async () => null, getArtistLinks: async () => ({ name: "x", wikidataId: null, wikipediaUrl: null }) },
    wiki: { englishTitle: async () => null, summary: async () => null },
    similar: { similarTo: async () => similar },
  };
}

describe("radioFor", () => {
  it("mixes the seed artist with the similar artists that are in the library, and not with ones that are not alike", async () => {
    const w = await world();
    const seed = await w.artist("Seed", ID(1), 10);
    const near = await w.artist("Near", ID(2), 10);
    const near2 = await w.artist("Near Too", ID(3), 10);
    const near3 = await w.artist("Near Three", ID(4), 10);
    const near4 = await w.artist("Near Four", ID(5), 10);
    const far = await w.artist("Far", ID(6), 10);
    const sim = [near, near2, near3, near4].map((a, i) => ({ mbid: a.mbid!, name: a.name, score: 100 - i }));
    const radio = await radioFor(db, w.scope, { artistId: seed.id }, deps(sim));
    expect(radio?.artistName).toBe("Seed");
    expect(radio?.fromArtists).toBe(4);
    const all = new Map([seed, near, near2, near3, near4, far].flatMap((a) => a.songs.map((s) => [s, a.name] as const)));
    const who = new Set(radio?.ids.map((id) => all.get(id)));
    expect(who.has("Seed")).toBe(true);
    expect(who.has("Near")).toBe(true);
    expect(who.has("Far")).toBe(false); // alike artists were enough, so the rest of the library stays out
    expect(new Set(radio?.ids).size).toBe(radio?.ids.length);
  });

  it("fills out with the rest of the library when too few artists are alike (or the lookup is off)", async () => {
    const w = await world(false);
    const seed = await w.artist("Seed", ID(11), 5);
    const other = await w.artist("Other", ID(12), 5);
    const another = await w.artist("Another", ID(13), 5);
    const radio = await radioFor(db, w.scope, { artistId: seed.id }, deps([]));
    expect(radio?.fromArtists).toBe(2);
    const ids = new Set(radio?.ids);
    expect([...seed.songs, ...other.songs, ...another.songs].every((s) => ids.has(s))).toBe(true);
  });

  it("starts a song's radio with that song, and refuses a song that is not the artist's", async () => {
    const w = await world();
    const seed = await w.artist("Seed", ID(21), 8);
    const other = await w.artist("Other", ID(22), 8);
    const radio = await radioFor(db, w.scope, { artistId: seed.id, songId: seed.songs[3] }, deps([{ mbid: other.mbid!, name: "Other", score: 5 }]));
    expect(radio?.ids[0]).toBe(seed.songs[3]);
    expect(await radioFor(db, w.scope, { artistId: seed.id, songId: other.songs[0] }, deps([]))).toBeNull();
  });

  it("is null for an unknown artist and for one with nothing this viewer may hear", async () => {
    const w = await world();
    expect(await radioFor(db, w.scope, { artistId: "123e4567-e89b-42d3-a456-426614174000" }, deps([]))).toBeNull();
    const silent = await w.artist("Silent", ID(31), 0);
    expect(await radioFor(db, w.scope, { artistId: silent.id }, deps([]))).toBeNull();
    const kid = { ...w.scope, viewer: { locale: "en-US", maxAge: 7, allowUnrated: false } as AccessProfile };
    const seed = await w.artist("Unrated", ID(32), 3); // songs with no rating are hidden from a profile that blocks unrated
    expect(await radioFor(db, kid, { artistId: seed.id }, deps([]))).toBeNull();
  });
});

describe("artistOfSong", () => {
  it("is the artist of a song, and nothing for anything else", async () => {
    const w = await world();
    const a = await w.artist("Seed", ID(41), 2);
    expect(await artistOfSong(db, a.songs[0])).toBe(a.id);
    expect(await artistOfSong(db, "123e4567-e89b-42d3-a456-426614174000")).toBeNull();
  });
});
