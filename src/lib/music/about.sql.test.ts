/** About an artist or album: found once, kept, refreshed when old, never guessed, and only for libraries with lookups on. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { albumAbout, artistAbout, libraries, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { albumAboutFor, artistAboutFor, FOUND_TTL_MS, MISSING_TTL_MS, type AboutDeps } from "./about";
import type { MusicBrainzClient } from "./musicbrainz";
import type { WikipediaClient } from "./wikipedia";

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
  const admin = await makeAccount(db, `about${++n}`);
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  if (!lookups) await db.update(libraries).set({ musicLookup: false }).where(eq(libraries.id, lib.id));
  const actor: LibraryActor = { serverId: server.id, accountId: admin.accountId, isAdmin: true };
  const scope = { actor, viewer: adult };
  async function artist(name: string, mbid: string | null = null, withSong = true) {
    const [a] = await db.insert(musicArtists).values({ libraryId: lib.id, name, nameKey: name.toLowerCase().replace(/[^a-z0-9]+/g, ""), sortKey: name.toLowerCase(), mbid }).returning();
    const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: a.id, name: `${name} album`, nameKey: `${a.id}album`, mbid: null }).returning();
    if (withSong) await db.insert(titles).values({ libraryId: lib.id, kind: "audiobook", name: `${name} song`, boxFolderId: `s${a.id}`, albumId: al.id, ratingAges: null });
    return { ...a, albumId: al.id };
  }
  return { server, lib, scope, artist };
}

function fakes(over: { links?: Record<string, { wikidataId: string | null; wikipediaUrl: string | null } | null>; similar?: Record<string, { mbid: string; name: string; score: number }[]>; found?: string[]; search?: { id: string; name: string; score: number; type: string | null }[]; fail?: boolean } = {}) {
  const calls = { links: 0, search: 0, wiki: 0, similar: 0, group: 0 };
  const deps: AboutDeps & { calls: typeof calls } = {
    calls,
    mb: {
      searchReleases: async () => [], getRelease: async () => null, getFrontCover: async () => null,
      getArtistLinks: async (id) => (calls.links++, over.fail ? Promise.reject(new Error("down")) : (over.links?.[id] ?? { wikidataId: null, wikipediaUrl: `https://en.wikipedia.org/wiki/Artist_${id}` }) && { name: "x", ...(over.links?.[id] ?? { wikidataId: null, wikipediaUrl: `https://en.wikipedia.org/wiki/Artist_${id}` }) }),
      searchArtists: async () => (calls.search++, over.search ?? []),
      getReleaseGroupLinks: async (id) => (calls.group++, { name: "x", wikidataId: null, wikipediaUrl: `https://en.wikipedia.org/wiki/Album_${id}` }),
    } satisfies MusicBrainzClient,
    wiki: {
      englishTitle: async () => null,
      summary: async (lang, title) => (calls.wiki++, over.found && !over.found.some((f) => title.includes(f)) ? null : { title, extract: `About ${title}.`, url: `https://${lang}.wikipedia.org/wiki/${title}` }),
    } satisfies WikipediaClient,
    similar: { similarTo: async (id) => (calls.similar++, over.similar?.[id] ?? []) },
  };
  return deps;
}

describe("artistAboutFor", () => {
  it("gets the description and similar artists once, keeps them, and places the similar ones that are in the library", async () => {
    const w = await world();
    const main = await w.artist("Main", ID(1));
    const friend = await w.artist("Friend", ID(2));
    const byName = await w.artist("Namesake", null); // no id here, but the same name as a similar artist
    await w.artist("Hidden", ID(9), false); // in the library but has no songs to show
    const deps = fakes({ similar: { [ID(1)]: [{ mbid: ID(2), name: "Friend", score: 50 }, { mbid: ID(3), name: "Namesake", score: 80 }, { mbid: ID(4), name: "Stranger", score: 40 }, { mbid: ID(9), name: "Hidden", score: 30 }] } });
    const got = await artistAboutFor(db, w.scope, main.id, deps);
    expect(got).toMatchObject({ found: true, summary: `About Artist_${ID(1)}.`, sourceUrl: `https://en.wikipedia.org/wiki/Artist_${ID(1)}` });
    expect(got?.licenseUrl).toContain("creativecommons.org");
    expect(got?.similarInLibrary.map((a) => a.name)).toEqual(["Namesake", "Friend"]); // best match first
    expect(got?.similarElsewhere).toEqual(["Stranger"]); // not the one that is here but has nothing to show
    expect(friend.id).toBeTruthy();
    expect(byName.id).toBeTruthy();
    await artistAboutFor(db, w.scope, main.id, deps);
    expect(deps.calls).toMatchObject({ links: 1, wiki: 1, similar: 1 }); // the second time came from the kept copy
    expect((await db.select().from(artistAbout).where(eq(artistAbout.artistId, main.id)))[0].similar).toHaveLength(4);
  });

  it("asks again after a month when something was found, a week when nothing was, and not before", async () => {
    const w = await world();
    const a = await w.artist("Timed", ID(21));
    const t0 = new Date("2026-01-01T00:00:00Z");
    const deps = fakes();
    await artistAboutFor(db, w.scope, a.id, { ...deps, now: () => t0 });
    await artistAboutFor(db, w.scope, a.id, { ...deps, now: () => new Date(t0.getTime() + FOUND_TTL_MS - 1000) });
    expect(deps.calls.links).toBe(1);
    await artistAboutFor(db, w.scope, a.id, { ...deps, now: () => new Date(t0.getTime() + FOUND_TTL_MS + 1000) });
    expect(deps.calls.links).toBe(2);

    const none = await w.artist("Nothing", ID(22));
    const empty = fakes({ found: [] , links: { [ID(22)]: null } });
    const first = await artistAboutFor(db, w.scope, none.id, { ...empty, now: () => t0 });
    expect(first).toMatchObject({ found: false, summary: null });
    await artistAboutFor(db, w.scope, none.id, { ...empty, now: () => new Date(t0.getTime() + MISSING_TTL_MS - 1000) });
    expect(empty.calls.links).toBe(1);
    await artistAboutFor(db, w.scope, none.id, { ...empty, now: () => new Date(t0.getTime() + MISSING_TTL_MS + 1000) });
    expect(empty.calls.links).toBe(2);
  });

  it("finds an artist with no id only when one result is plainly the same artist, and never guesses between two", async () => {
    const w = await world();
    const sure = await w.artist("Exact Name");
    const found = await artistAboutFor(db, w.scope, sure.id, fakes({ search: [{ id: ID(31), name: "Exact Name", score: 100, type: "Group" }, { id: ID(32), name: "Exact Name Tribute", score: 95, type: "Group" }] }));
    expect(found?.found).toBe(true);
    const twins = await w.artist("Twin Name");
    const twinDeps = fakes({ search: [{ id: ID(33), name: "Twin Name", score: 100, type: "Person" }, { id: ID(34), name: "Twin Name", score: 98, type: "Group" }] });
    expect(await artistAboutFor(db, w.scope, twins.id, twinDeps)).toMatchObject({ found: false });
    expect(twinDeps.calls.links).toBe(0);
    const weak = await w.artist("Weak Name");
    expect(await artistAboutFor(db, w.scope, weak.id, fakes({ search: [{ id: ID(35), name: "Weak Name", score: 60, type: null }] }))).toMatchObject({ found: false });
  });

  it("does not remember a failure as 'nothing there', so it is tried again", async () => {
    const w = await world();
    const a = await w.artist("Flaky", ID(41));
    const down = fakes({ fail: true });
    expect(await artistAboutFor(db, w.scope, a.id, down)).toMatchObject({ found: false });
    expect(await db.select().from(artistAbout).where(eq(artistAbout.artistId, a.id))).toHaveLength(0);
    const up = fakes();
    expect(await artistAboutFor(db, w.scope, a.id, up)).toMatchObject({ found: true });
  });

  it("does nothing, and asks nobody, in a library with music lookups off", async () => {
    const w = await world(false);
    const a = await w.artist("Private", ID(51));
    const deps = fakes();
    expect(await artistAboutFor(db, w.scope, a.id, deps)).toBeNull();
    expect(deps.calls).toEqual({ links: 0, search: 0, wiki: 0, similar: 0, group: 0 });
    expect(await artistAboutFor(db, w.scope, "123e4567-e89b-42d3-a456-426614174000", deps)).toBeNull();
  });
});

describe("albumAboutFor", () => {
  it("looks up a matched album through its release group, keeps it, and does not look for one that is not matched", async () => {
    const w = await world();
    const a = await w.artist("Band", ID(61));
    await db.update(musicAlbums).set({ mbid: ID(62), matchStatus: "matched" }).where(eq(musicAlbums.id, a.albumId));
    const deps = fakes();
    const got = await albumAboutFor(db, a.albumId, deps);
    expect(got).toMatchObject({ found: true, summary: `About Album_${ID(62)}.` });
    await albumAboutFor(db, a.albumId, deps);
    expect(deps.calls.group).toBe(1);
    expect((await db.select().from(albumAbout).where(eq(albumAbout.albumId, a.albumId))).length).toBe(1);

    const b = await w.artist("Other", ID(63)); // album with no release id
    const d2 = fakes();
    expect(await albumAboutFor(db, b.albumId, d2)).toMatchObject({ found: false });
    expect(d2.calls.group).toBe(0);
    expect(await db.select().from(albumAbout).where(eq(albumAbout.albumId, b.albumId))).toHaveLength(0);
  });
});
