/** Stopping in the credits counts as watched, so Continue Watching moves on and the next episode comes up under Up Next. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { episodes, profiles, seasons, viewers, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { onDeck } from "@/lib/watch/on-deck";
import { PATCH } from "./route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const save = (body: unknown) => PATCH(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const stateOf = async (viewerId: string, id: string) => (await db.select().from(watchState).where(and(eq(watchState.viewerId, viewerId), eq(watchState.ownerId, id))))[0];

async function world() {
  const admin = await makeAccount(db, "neadmin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "neme");
  await joinServer(db, server.id, me.accountId);
  const [account] = await db.select().from(profiles).where(eq(profiles.id, me.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, me.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  return { me, server, movies, shows, actor: { serverId: server.id, accountId: me.accountId, isAdmin: false } };
}

describe("a save near the end of a movie or episode", () => {
  it("marks an episode watched with under five minutes left, and Up Next offers the next one", async () => {
    const w = await world();
    const { show } = await makeShow(db, w.shows.id, 3, { name: "Show" }, { files: true });
    const eps = await db.select({ id: episodes.id, number: episodes.number }).from(episodes).innerJoin(seasons, eq(seasons.id, episodes.seasonId)).where(eq(seasons.titleId, show.id));
    const [e1, e2] = eps.sort((a, b) => a.number - b.number);
    await save({ ownerKind: "episode", ownerId: e1.id, positionSeconds: 2640, durationSeconds: 2700, finished: false }); // a minute left
    expect((await stateOf(w.me.viewer.id, e1.id)).finished).toBe(true);
    const next = await onDeck(db, { actor: w.actor, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.me.viewer.id });
    expect(next.map((n) => n.episodeId)).toEqual([e2.id]);
  });

  it("marks a movie watched with under five minutes left, but not with more, and never a short clip", async () => {
    const w = await world();
    const film = await makeTitle(db, w.movies.id, { kind: "movie", name: "Film" }, { files: true });
    await save({ ownerKind: "title", ownerId: film.id, positionSeconds: 5600, durationSeconds: 6000 }); // 400 s left
    expect((await stateOf(w.me.viewer.id, film.id)).finished).toBe(false);
    await save({ ownerKind: "title", ownerId: film.id, positionSeconds: 5800, durationSeconds: 6000 }); // 200 s left
    expect((await stateOf(w.me.viewer.id, film.id)).finished).toBe(true);
    const clip = await makeTitle(db, w.movies.id, { kind: "movie", name: "Clip" }, { files: true });
    await save({ ownerKind: "title", ownerId: clip.id, positionSeconds: 95, durationSeconds: 100 });
    expect((await stateOf(w.me.viewer.id, clip.id)).finished).toBe(false);
  });
});
