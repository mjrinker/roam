/** "Up next": the next episode of each show being watched. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mediaFiles, watchState } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, type TestDb } from "@/lib/playlists/test-db";
import { ON_DECK_DAYS, onDeck } from "./on-deck";

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
const NOW = new Date("2026-10-15T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "shows", "everyone");
  const actor: LibraryActor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const viewerId = me.viewer.id;
  const files = async (ids: string[]) => {
    for (const id of ids) await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: id, boxFileId: `f${id}`, filename: "e.mp4" });
  };
  const finish = (episodeId: string, at: Date, finished = true, position = 100) =>
    db.insert(watchState).values({ viewerId, ownerKind: "episode", ownerId: episodeId, positionSeconds: position, durationSeconds: 100, finished, updatedAt: at });
  const ask = (viewer = adult) => onDeck(db, { actor, viewer, viewerId, now: NOW });
  const show = async (name: string, count = 4, over: Parameters<typeof makeShow>[3] = {}) => {
    const s = await makeShow(db, lib.id, count, { name, ...over });
    await files(s.episodes.map((e) => e.id));
    return s;
  };
  return { actor, viewerId, lib, server, me, finish, ask, show, files };
}

describe("up next", () => {
  it("is the episode after the last one finished, newest show first", async () => {
    const w = await world();
    const a = await w.show("Alpha");
    const b = await w.show("Bravo");
    await w.finish(a.episodes[0].id, daysAgo(5));
    await w.finish(b.episodes[1].id, daysAgo(1));
    const items = await w.ask();
    expect(items.map((i) => [i.showName, i.number])).toEqual([["Bravo", 3], ["Alpha", 2]]);
    expect(items[0].episodeId).toBe(b.episodes[2].id);
  });

  it("skips a show with nothing left, and goes on to the next season", async () => {
    const w = await world();
    const done = await w.show("Done", 2);
    await w.finish(done.episodes[0].id, daysAgo(2));
    await w.finish(done.episodes[1].id, daysAgo(2));
    expect(await w.ask()).toEqual([]);
    const two = await w.show("Two seasons", 1);
    const { seasons: seasonsTable, episodes: episodesTable } = await import("@/lib/db/schema");
    const [s2] = await db.insert(seasonsTable).values({ titleId: two.show.id, number: 2, boxFolderId: "s2-two" }).returning();
    const [e21] = await db.insert(episodesTable).values({ seasonId: s2.id, number: 1, name: "Premiere" }).returning();
    await w.files([e21.id]);
    await w.finish(two.episodes[0].id, daysAgo(1));
    expect((await w.ask()).map((i) => [i.showName, i.season, i.number])).toEqual([["Two seasons", 2, 1]]);
  });

  it("leaves a show alone while an episode of it is half-watched, and one nothing of which was finished lately", async () => {
    const w = await world();
    const half = await w.show("Half");
    await w.finish(half.episodes[0].id, daysAgo(3));
    await w.finish(half.episodes[1].id, daysAgo(1), false, 40);
    const stale = await w.show("Stale");
    await w.finish(stale.episodes[0].id, daysAgo(ON_DECK_DAYS + 1));
    const barely = await w.show("Barely");
    await w.finish(barely.episodes[0].id, daysAgo(ON_DECK_DAYS - 1));
    expect((await w.ask()).map((i) => i.showName)).toEqual(["Barely"]);
  });

  it("skips episodes without a file, and ones already finished out of order", async () => {
    const w = await world();
    const s = await makeShow(db, w.lib.id, 4, { name: "Gaps" });
    await w.files([s.episodes[0].id, s.episodes[2].id, s.episodes[3].id]); // episode 2 has no file
    await w.finish(s.episodes[0].id, daysAgo(4));
    await w.finish(s.episodes[2].id, daysAgo(9)); // watched ahead, earlier
    expect((await w.ask()).map((i) => i.number)).toEqual([4]);
  });

  it("is this profile's own, within its age limit, in libraries it can see, and limited in number", async () => {
    const w = await world();
    const other = await makeAccount(db, "other");
    await joinServer(db, w.server.id, other.accountId);
    const mine = await w.show("Mine", 3);
    await db.insert(watchState).values({ viewerId: other.viewer.id, ownerKind: "episode", ownerId: mine.episodes[0].id, positionSeconds: 1, durationSeconds: 1, finished: true, updatedAt: daysAgo(1) });
    expect(await w.ask()).toEqual([]); // somebody else's progress
    await w.finish(mine.episodes[0].id, daysAgo(1));
    expect(await w.ask(kid)).toEqual([]); // no rating, and unrated isn't allowed
    expect(await w.ask()).toHaveLength(1);
    const many = [];
    for (let i = 0; i < 5; i++) many.push(await w.show(`Show ${i}`, 2));
    for (const [i, s] of many.entries()) await w.finish(s.episodes[0].id, daysAgo(i + 2));
    expect(await onDeck(db, { actor: w.actor, viewer: adult, viewerId: w.viewerId, limit: 3, now: NOW })).toHaveLength(3);
    const hidden = await makeLibrary(db, w.server.id, "shows", "restricted");
    const secret = await makeShow(db, hidden.id, 2, { name: "Secret" });
    await w.files(secret.episodes.map((e) => e.id));
    await w.finish(secret.episodes[0].id, daysAgo(1));
    expect((await w.ask()).map((i) => i.showName)).not.toContain("Secret");
    void eq;
  });
});
