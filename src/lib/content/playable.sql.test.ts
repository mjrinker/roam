/** Titles with nothing to play are left out of lists, rows and searches (their own page still opens). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { titles, watchlistItems } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, addEpisodeFile, type TestDb } from "@/lib/playlists/test-db";
import { libraryTitles, recentlyAdded, type TvScope } from "@/lib/tv/data";
import { tvSearch } from "@/lib/tv/search";
import { listWatchlist } from "@/lib/watchlist/queries";
import { evaluateRules, smartRulesSchema } from "@/lib/playlists/smart";
import { hasPlayableFile } from "./playable";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };

async function world() {
  const admin = await makeAccount(db, "padmin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "pmember");
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const books = await makeLibrary(db, server.id, "audiobooks", "everyone");
  const actor: LibraryActor = { serverId: server.id, accountId: member.accountId, isAdmin: false };
  const scope: TvScope = { actor, viewer: adult, viewerId: member.viewer.id };
  const made = {
    movie: await makeTitle(db, movies.id, { kind: "movie", name: "Has file" }, { files: true }),
    bareMovie: await makeTitle(db, movies.id, { kind: "movie", name: "No file" }, { files: false }),
    book: await makeTitle(db, books.id, { kind: "audiobook", name: "Book with file" }, { files: true }),
    bareBook: await makeTitle(db, books.id, { kind: "audiobook", name: "Book without" }, { files: false }),
    show: (await makeShow(db, shows.id, 2, { name: "Show with episodes" }, { files: true })).show,
    bareShow: (await makeShow(db, shows.id, 2, { name: "Show without" }, { files: false })).show,
    emptyShow: await makeTitle(db, shows.id, { kind: "show", name: "Show with no episodes" }, { files: false }),
  };
  return { server, member, movies, shows, books, scope, actor, ...made };
}

describe("hasPlayableFile", () => {
  it("is true for a movie or book with a file and a show with an episode that has one, and false for the rest", async () => {
    const w = await world();
    const rows = await db.select({ name: titles.name, ok: sql<boolean>`${hasPlayableFile(titles.id, titles.kind)}` }).from(titles).where(sql`${titles.libraryId} IN (${w.movies.id}, ${w.shows.id}, ${w.books.id})`);
    const ok = Object.fromEntries(rows.map((r) => [r.name, r.ok]));
    expect(ok).toEqual({ "Has file": true, "No file": false, "Book with file": true, "Book without": false, "Show with episodes": true, "Show without": false, "Show with no episodes": false });
  });
  it("is true as soon as one episode of a show has a file, and does not judge other kinds", async () => {
    const w = await world();
    const { show, episodes } = await makeShow(db, w.shows.id, 3, { name: "Partly there" }, { files: false });
    await addEpisodeFile(db, episodes[2].id);
    const photo = await makeTitle(db, w.movies.id, { kind: "photo", name: "A picture" }, { files: false });
    const rows = await db.select({ id: titles.id, ok: sql<boolean>`${hasPlayableFile(titles.id, titles.kind)}` }).from(titles).where(sql`${titles.id} IN (${show.id}, ${photo.id})`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.ok]))).toEqual({ [show.id]: true, [photo.id]: true });
  });
});

describe("what leaves them out", () => {
  it("a TV library list, and recently added", async () => {
    const w = await world();
    const movies = await libraryTitles(db, w.scope, w.movies.id, 1);
    expect(movies?.items.map((i) => i.name)).toEqual(["Has file"]);
    const shows = await libraryTitles(db, w.scope, w.shows.id, 1);
    expect(shows?.items.map((i) => i.name)).toEqual(["Show with episodes"]);
    const recent = (await recentlyAdded(db, w.scope, 50)).map((r) => r.name).sort();
    expect(recent).toEqual(["Book with file", "Has file", "Show with episodes"]);
  });

  it("TV search", async () => {
    const w = await world();
    const found = await tvSearch(db, w.scope, "file");
    expect(JSON.stringify(found)).toContain("Has file");
    expect(JSON.stringify(found)).toContain("Book with file");
    expect(JSON.stringify(found)).not.toContain("No file");
    expect(JSON.stringify(found)).not.toContain("Book without");
  });

  it("the watch list (the title stays on it, and comes back when a file does)", async () => {
    const w = await world();
    await db.insert(watchlistItems).values([w.movie, w.bareMovie, w.bareShow].map((t) => ({ viewerId: w.member.viewer.id, titleId: t.id })));
    const names = async () => (await listWatchlist(db, { actor: w.actor, viewer: adult, viewerId: w.member.viewer.id, serverId: w.server.id })).map((e) => e.name);
    expect(await names()).toEqual(["Has file"]);
    await db.insert((await import("@/lib/db/schema")).mediaFiles).values({ ownerKind: "title", ownerId: w.bareMovie.id, boxFileId: "later", filename: "later.mp4" });
    expect((await names()).sort()).toEqual(["Has file", "No file"]);
  });

  it("smart playlists", async () => {
    const w = await world();
    const rules = smartRulesSchema.parse({});
    const got = await evaluateRules(db, { rules, actor: w.actor, viewer: adult, viewerId: w.member.viewer.id });
    const ids = new Set(got.map((t) => ("titleId" in t ? t.titleId : t.episodeId)));
    expect([w.movie, w.book, w.show].every((t) => ids.has(t.id))).toBe(true);
    expect([w.bareMovie, w.bareBook, w.bareShow, w.emptyShow].some((t) => ids.has(t.id))).toBe(false);
  });
});
