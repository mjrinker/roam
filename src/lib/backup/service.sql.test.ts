/** Exporting a profile and importing a file: matched by TMDB id or name and year, only what the profile can see, never removing anything. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { episodes, labelItems, labels, ratings, watchlistItems, watchState } from "@/lib/db/schema";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { parseImport, buildExport } from "./format";
import { applyImport, exportProfile, type BackupScope } from "./service";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult = { locale: "en-US", maxAge: null, allowUnrated: true };

async function world(name: string) {
  const admin = await makeAccount(db, `${name}a`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `${name}m`);
  await joinServer(db, server.id, me.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const scope: BackupScope = { actor: { serverId: server.id, accountId: me.accountId, isAdmin: false }, viewer: adult, viewerId: me.viewer.id, serverId: server.id };
  return { server, me, movies, shows, scope };
}

describe("export then import", () => {
  it("carries watched, a half-watched position, ratings, labels and the watch list to another profile", async () => {
    const w = await world("rt");
    const heat = await makeTitle(db, w.movies.id, { kind: "movie", name: "Heat", year: 1995, tmdbId: 949 });
    const { show, episodes: eps } = await makeShow(db, w.shows.id, 3, { name: "Lost", year: 2004, tmdbId: 4607 });
    const [e1, e2] = eps;
    const v = w.me.viewer.id;
    await db.insert(watchState).values([{ viewerId: v, ownerKind: "title", ownerId: heat.id, finished: true }, { viewerId: v, ownerKind: "episode", ownerId: e1.id, finished: true }, { viewerId: v, ownerKind: "episode", ownerId: e2.id, positionSeconds: 600, durationSeconds: 2600 }]);
    await db.insert(ratings).values({ viewerId: v, ownerKind: "title", ownerId: heat.id, halfStars: 9 });
    const [label] = await db.insert(labels).values({ viewerId: v, name: "Date night", nameKey: "date night" }).returning();
    await db.insert(labelItems).values({ labelId: label.id, titleId: heat.id });
    await db.insert(watchlistItems).values({ viewerId: v, titleId: show.id });

    const file = buildExport(await exportProfile(db, w.scope), { profileName: "Ann", serverName: "S", now: new Date() });

    // Another profile on the same server (as after a move, or for a second household member).
    const other = await makeAccount(db, "rtother");
    await joinServer(db, w.server.id, other.accountId);
    const scope2: BackupScope = { ...w.scope, actor: { ...w.scope.actor, accountId: other.accountId }, viewerId: other.viewer.id };
    const parsed = parseImport(file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = await applyImport(db, scope2, parsed.data);
    expect(result).toMatchObject({ watched: 3, ratings: 1, labels: 1, watchlist: 1, notFound: { total: 0 } });
    const o = other.viewer.id;
    expect((await db.select().from(watchState).where(and(eq(watchState.viewerId, o), eq(watchState.ownerId, heat.id))))[0].finished).toBe(true);
    const half = (await db.select().from(watchState).where(and(eq(watchState.viewerId, o), eq(watchState.ownerId, e2.id))))[0];
    expect([half.finished, half.positionSeconds, half.durationSeconds]).toEqual([false, 600, 2600]);
    expect((await db.select().from(ratings).where(eq(ratings.viewerId, o)))[0].halfStars).toBe(9);
    const theirLabel = (await db.select().from(labels).where(eq(labels.viewerId, o)))[0];
    expect(theirLabel.name).toBe("Date night");
    expect((await db.select().from(labelItems).where(eq(labelItems.labelId, theirLabel.id))).map((i) => i.titleId)).toEqual([heat.id]);
    expect((await db.select().from(watchlistItems).where(eq(watchlistItems.viewerId, o))).map((i) => i.titleId)).toEqual([show.id]);
    // The original profile was not touched.
    expect((await db.select().from(episodes).where(eq(episodes.id, e1.id))).length).toBe(1);
  });
});

describe("matching a file from elsewhere", () => {
  it("matches by name and year (accents, case and & ignored, a year one off allowed), and lists what it can't find", async () => {
    const w = await world("match");
    const amelie = await makeTitle(db, w.movies.id, { kind: "movie", name: "Amélie", year: 2001 });
    const rocky = await makeTitle(db, w.movies.id, { kind: "movie", name: "Rock & Roll", year: 1999 });
    const parsed = parseImport("Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Amelie,2001,u,4\n2024-01-02,rock and roll,2000,u,5\n2024-01-03,Not Here,2010,u,3\n");
    if (!parsed.ok) throw new Error("parse");
    const result = await applyImport(db, w.scope, parsed.data);
    expect(result).toMatchObject({ watched: 2, ratings: 2, notFound: { total: 1, sample: ["Not Here (2010)"] } });
    const done = await db.select({ id: watchState.ownerId }).from(watchState).where(eq(watchState.viewerId, w.me.viewer.id));
    expect(done.map((d) => d.id).sort()).toEqual([amelie.id, rocky.id].sort());
  });

  it("won't guess between two films of the same name when the year doesn't settle it, and never touches what the profile can't see", async () => {
    const w = await world("amb");
    await makeTitle(db, w.movies.id, { kind: "movie", name: "Twin", year: 2000 });
    await makeTitle(db, w.movies.id, { kind: "movie", name: "Twin", year: 2010 });
    const restricted = await makeLibrary(db, w.server.id, "movies", "restricted");
    const hidden = await makeTitle(db, restricted.id, { kind: "movie", name: "Hidden", year: 2005 });
    const parsed = parseImport("Name,Year\nTwin,2005\nHidden,2005\nTwin,2010\n");
    if (!parsed.ok) throw new Error("parse");
    const result = await applyImport(db, w.scope, parsed.data);
    expect(result.watched).toBe(1); // only Twin (2010)
    expect(result.notFound.sample.sort()).toEqual(["Hidden (2005)", "Twin (2005)"]);
    expect(await db.select().from(watchState).where(and(eq(watchState.viewerId, w.me.viewer.id), eq(watchState.ownerId, hidden.id)))).toEqual([]);
  });

  it("never un-finishes a film, and a position doesn't replace a finished one", async () => {
    const w = await world("keep");
    const film = await makeTitle(db, w.movies.id, { kind: "movie", name: "Done", year: 2020, tmdbId: 5 });
    await db.insert(watchState).values({ viewerId: w.me.viewer.id, ownerKind: "title", ownerId: film.id, finished: true });
    const text = JSON.stringify({ format: "roam-profile", version: 1, watched: [{ ref: { kind: "movie", title: "Done", year: 2020, tmdbId: 5 }, finished: false, positionSeconds: 500, durationSeconds: 6000 }] });
    const parsed = parseImport(text);
    if (!parsed.ok) throw new Error("parse");
    await applyImport(db, w.scope, parsed.data);
    const [row] = await db.select().from(watchState).where(eq(watchState.ownerId, film.id));
    expect([row.finished, row.positionSeconds]).toEqual([true, 0]);
  });
});
